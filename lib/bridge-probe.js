/**
 * bridge-probe.js — 网桥诊断原语（零依赖，除 Node 内置模块外只依赖 vendored 服务端）。
 *
 * 为什么需要真实握手：TCP 能连 ≠ 能用。Unity 网桥在 HTTP 层先接受 TCP 连接，
 * 再在 WebSocket 握手阶段校验 HTTP Basic 认证；缺 token 时回 401 并断开。
 * 只看「端口是否监听」会把这种被拒的连接误报成「就绪」（v1.2.0 的假阳性）。
 * 这里发送与真实客户端完全一致的握手请求（含 Authorization），
 * 用 101 + Sec-WebSocket-Accept 校验判定「真的可用」。
 *
 * 依赖边界：`resolveBridgeTarget` 复用 vendored 服务端的配置解析器
 * （只 import node:fs / node:path），因此插件进程与子进程看到的是同一份
 * host/port/token 解析结果，不会出现「探测通过但服务端连不上」的偏差。
 */
import net from "node:net";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolveUnityConnectionConfig } from "../vendor/mcp-unity-server/build/unity/unityConnectionConfig.js";

/** RFC 6455 的固定 GUID，用于校验 Sec-WebSocket-Accept。 */
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** 与 Unity 侧 McpUnityAuthentication.Username 一致。 */
const BRIDGE_AUTH_USERNAME = "mcp-unity";

const DEFAULT_HOST = "localhost";
const DEFAULT_PORT = 8090;
const SETTINGS_RELATIVE_PATH = path.join("ProjectSettings", "McpUnitySettings.json");
const TOKEN_RELATIVE_PATH = path.join("Library", "McpUnity", "bridge-token");
const PROJECT_MARKER_RELATIVE_PATH = path.join("ProjectSettings", "ProjectVersion.txt");

/**
 * 解析插件应当探测/配置的 Unity 项目根目录。
 * 显式配置优先；否则从起点目录向上找 ProjectSettings/ProjectVersion.txt
 * （Unity 项目的可靠标志；McpUnitySettings.json 只有在打开过网桥窗口后才存在）。
 */
export function resolveUnityProjectRoot(configuredPath, startDirectory = process.cwd()) {
  const configured = nonEmptyString(configuredPath);
  if (configured) {
    return path.resolve(configured);
  }
  let directory = path.resolve(startDirectory);
  for (let depth = 0; depth < 32; depth += 1) {
    if (existsSync(path.join(directory, PROJECT_MARKER_RELATIVE_PATH))) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
}

/**
 * 把 Unity 项目位置翻译成 vendored 服务端认识的两个环境变量
 * （与 Unity 侧 Tools > MCP Unity > Server Window 生成的客户端配置同源）。
 * 已显式配置的环境变量优先，绝不覆盖；文件不存在时不注入
 * （老版本网桥没有 token 文件，不应因此报认证错误）。
 */
export function applyUnityProjectEnvironment(env, projectRoot) {
  if (!projectRoot) return env;
  const settingsPath = path.join(projectRoot, SETTINGS_RELATIVE_PATH);
  const tokenPath = path.join(projectRoot, TOKEN_RELATIVE_PATH);
  if (env.MCP_UNITY_SETTINGS_PATH === undefined && existsSync(settingsPath)) {
    env.MCP_UNITY_SETTINGS_PATH = settingsPath;
  }
  if (env.MCP_UNITY_AUTH_TOKEN_PATH === undefined && existsSync(tokenPath)) {
    env.MCP_UNITY_AUTH_TOKEN_PATH = tokenPath;
  }
  return env;
}

/**
 * 用 vendored 服务端的解析器解析探测目标；解析失败也不抛，
 * 而是回退到环境变量/默认值并把原因放进 error（诊断工具永不 reject）。
 */
export async function resolveBridgeTarget(options = {}) {
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const notes = [];
  const logger = {
    info: (message) => notes.push(String(message)),
    warn: (message) => notes.push(String(message)),
  };
  try {
    const config = await resolveUnityConnectionConfig(logger, {
      cwd,
      environment,
      modulePath: options.modulePath,
    });
    return {
      host: config.host,
      port: config.port,
      authToken: config.authToken,
      authTokenSource: config.authTokenSource,
      settingsPath: config.settingsPath,
      notes,
      error: undefined,
    };
  } catch (error) {
    return {
      host: nonEmptyString(environment.UNITY_HOST) ?? DEFAULT_HOST,
      port: parsePort(environment.UNITY_PORT) ?? DEFAULT_PORT,
      authToken: "",
      authTokenSource: "none",
      settingsPath: undefined,
      notes,
      error: describeError(error),
    };
  }
}

/**
 * TCP 探测：连接成功即端口在监听。永不 reject。
 */
export function probeTcp(host, port, timeoutMs, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const start = Date.now();
    const socket = net.connect({ host, port });
    const onAbort = () => settle(false, "aborted");
    const timer = setTimeout(
      () => settle(false, `connect timeout after ${timeoutMs} ms`),
      timeoutMs
    );
    function settle(ok, error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, latencyMs: Date.now() - start, error });
    }
    socket.once("connect", () => settle(true, undefined));
    socket.once("error", (err) => settle(false, describeError(err)));
    if (signal) {
      if (signal.aborted) {
        settle(false, "aborted");
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * 真实 WebSocket 握手探测（HTTP 层手写，无需 ws 依赖）。
 *
 * 返回 status：
 * - "connected"   101 且 Sec-WebSocket-Accept 校验通过 —— 网桥真的可用
 * - "unauthorized" 401/403 —— 认证被拒（缺 token / token 过期）
 * - "unexpected"  其它状态码 —— 路径或服务不对（例如 501 Not Implemented）
 * - "error"       连接/超时/解析失败
 * 永不 reject。
 */
export function probeBridgeHandshake(host, port, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2000;
  const signal = options.signal;
  const token = nonEmptyString(options.token);
  return new Promise((resolve) => {
    let settled = false;
    let raw = "";
    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1")
      .update(key + WEBSOCKET_GUID)
      .digest("base64");
    const socket = net.connect({ host, port });
    const onAbort = () => finish("error", { error: "aborted" });
    const timer = setTimeout(
      () => finish("error", { error: `handshake timeout after ${timeoutMs} ms` }),
      timeoutMs
    );

    function finish(status, extra) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      socket.destroy();
      resolve({ status, ...extra });
    }

    socket.once("connect", () => {
      const headers = [
        "GET /McpUnity HTTP/1.1",
        `Host: ${host}:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "X-Client-Name: dsh-unity-status",
      ];
      // 不发送 Origin：ws 客户端默认也不发，Unity 网桥会拒绝带 Origin 的握手。
      if (token) {
        headers.push(
          `Authorization: Basic ${Buffer.from(`${BRIDGE_AUTH_USERNAME}:${token}`, "utf8").toString("base64")}`
        );
      }
      socket.write(headers.join("\r\n") + "\r\n\r\n");
    });
    socket.on("data", (chunk) => {
      raw += chunk.toString("latin1");
      const headerEnd = raw.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const head = raw.slice(0, headerEnd);
      const statusMatch = /^HTTP\/1\.[01] (\d{3})/.exec(head);
      const httpStatus = statusMatch ? Number(statusMatch[1]) : undefined;
      if (httpStatus === 101) {
        const accept = /^sec-websocket-accept:\s*(.+)$/im.exec(head);
        if (accept && accept[1].trim() === expectedAccept) {
          finish("connected", { httpStatus });
        } else {
          finish("unexpected", {
            httpStatus,
            error: "101 response without a valid Sec-WebSocket-Accept header",
          });
        }
        return;
      }
      if (httpStatus === 401 || httpStatus === 403) {
        finish("unauthorized", { httpStatus });
        return;
      }
      finish("unexpected", {
        httpStatus,
        error: statusMatch ? undefined : "could not parse the HTTP status line",
      });
    });
    socket.once("error", (err) => finish("error", { error: describeError(err) }));

    if (signal) {
      if (signal.aborted) {
        finish("error", { error: "aborted" });
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** 聚合多地址（localhost 解析出 IPv4+IPv6）失败时的可读错误。 */
export function describeError(err) {
  if (err && Array.isArray(err.errors) && err.errors.length > 0) {
    const parts = [...new Set(err.errors.map((e) => String((e && e.message) || e)))];
    if (parts.length > 0) return parts.join("; ");
  }
  return String((err && err.message) || err);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 与 vendored 服务端一致：仅接受纯数字 1-65535。 */
function parsePort(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return undefined;
  const n = Number(value.trim());
  return n >= 1 && n <= 65535 ? n : undefined;
}
