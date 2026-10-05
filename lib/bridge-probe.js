/**
 * bridge-probe.js — 网桥诊断与 Unity 项目发现原语（零第三方依赖）。
 *
 * 两个独立问题在这里合流：
 *
 * 1. **认证**：Unity 1.5+ 网桥要求 HTTP Basic 认证，token 是每项目一份的
 *    `<项目>/Library/McpUnity/bridge-token`。只看 status 码不够——
 *    必须校验 `Sec-WebSocket-Accept`（websocket-sharp 的响应行为多变）。
 * 2. **项目定位**：DSH 是常驻服务 + 全局 profile，服务端进程的 cwd 与
 *    「当前在编辑哪个 Unity 项目」无关，从 cwd 向上找项目必然失败。
 *    同一个端口上同时只有一个网桥在监听，因此活跃项目可以**被识别**，
 *    而不必被配置：枚举候选项目 → 逐个用其 token 做真实握手 →
 *    第一个被接受的就是活跃项目。
 *
 * 候选来源（按优先级）：
 *   A. 显式配置（unityProjectPath / unityProjectSearchPaths）
 *   B. DSH 自己的工作区登记表 `$DSH_HOME/storages/workspace.json`
 *      （内含所有工作区的绝对路径，按最近使用排序——其中就有 Unity 项目）
 *   C. `$DSH_HOME/sessions/<编码路径>` 目录名（登记表不可用时的兜底）
 *   D. 各起点目录向上寻根 + 已发现项目的同级目录扫描（传统用法兜底）
 */
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
const TOKEN_PATTERN = /^[0-9a-fA-F]{64}$/;

/** 扫描时跳过的目录名（大而无用，或是构建产物）。 */
const SKIPPED_DIRECTORY_NAMES = new Set([
  "node_modules", ".git", ".svn", ".hg", ".vs", ".idea", ".vscode",
  "Library", "Temp", "obj", "bin", "Build", "Builds", "Logs", "UserSettings",
  "$RECYCLE.BIN", "System Volume Information", "Windows", "Program Files",
  "Program Files (x86)", "ProgramData", "AppData",
]);

// ---------------------------------------------------------------------------
// Unity 项目发现
// ---------------------------------------------------------------------------

/**
 * 解析单个 Unity 项目根目录：显式配置优先；否则从起点目录向上找
 * ProjectSettings/ProjectVersion.txt（Unity 项目的可靠标志）。
 */
export function resolveUnityProjectRoot(configuredPath, startDirectory = process.cwd()) {
  const configured = nonEmptyString(configuredPath);
  if (configured) {
    return path.resolve(configured);
  }
  return walkUpToUnityProject(startDirectory);
}

function walkUpToUnityProject(startDirectory) {
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

/** DSH 主目录：优先环境变量，退回 ~/.dsh。 */
export function resolveDshHome(environment = process.env) {
  const configured = nonEmptyString(environment.DSH_HOME);
  if (configured) return path.resolve(configured);
  const home =
    nonEmptyString(environment.USERPROFILE) ?? nonEmptyString(environment.HOME) ?? os.homedir();
  return home ? path.join(home, ".dsh") : undefined;
}

/**
 * 读取 DSH 工作区登记表里的绝对路径（按最近使用倒序）。
 * 这是"宿主层"信息的只读替代品：DSH 没有把工作区路径传给插件，
 * 但它把每个工作区记在 storages/workspace.json 里。
 * 解析失败（编码/结构变化）一律返回空数组，绝不抛。
 */
export function readDshWorkspacePaths(environment = process.env) {
  const dshHome = resolveDshHome(environment);
  if (!dshHome) return [];
  const registryPath = path.join(dshHome, "storages", "workspace.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(registryPath, "utf-8"));
  } catch {
    return [];
  }
  const workspaces = parsed?.tables?.workspaces;
  if (!workspaces || typeof workspaces !== "object") return [];
  return Object.values(workspaces)
    .filter((entry) => entry && typeof entry.path === "string" && entry.path.trim())
    .map((entry) => ({
      path: path.resolve(entry.path),
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .map((entry) => entry.path);
}

/**
 * `$DSH_HOME/sessions/<编码路径>` 目录名 → 绝对路径。
 * 编码规则：非 `[A-Za-z0-9._-]` 字符转成 `~XXXX`（大写十六进制），
 * 路径分隔符与盘符冒号都写成 `-`，整体包在 `--…--` 中。因为 `-` 同时
 * 表示分隔符和字面连字符（有歧义），这里用"逐段在文件系统上验证"的
 * 深度优先展开来还原，展开不出来的直接丢弃。
 */
export function decodeDshSessionDirectoryName(encodedName) {
  const match = /^--(.*)--$/.exec(encodedName);
  if (!match) return undefined;
  const body = match[1];
  const chars = [];
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === "~") {
      const hex = body.slice(i + 1, i + 5);
      if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return undefined;
      chars.push(String.fromCharCode(Number.parseInt(hex, 16)));
      i += 4;
    } else {
      chars.push(body[i]);
    }
  }
  const driveMatch = /^([A-Za-z])-(.*)$/.exec(chars.join(""));
  if (!driveMatch) return undefined;
  const root = `${driveMatch[1].toUpperCase()}:\\`;
  let budget = 64; // 展开节点上限，避免病态目录名拖慢插件加载

  function expand(prefix, remaining) {
    if (budget <= 0) return undefined;
    budget -= 1;
    if (!remaining) {
      return existsSync(prefix) ? prefix : undefined;
    }
    // 依次尝试把下一个 `-` 当作分隔符；都不行时把整段当作最后一级目录名
    for (let i = 0; i < remaining.length; i += 1) {
      if (remaining[i] !== "-") continue;
      const segment = remaining.slice(0, i);
      const rest = remaining.slice(i + 1);
      if (!segment) continue;
      const candidate = path.join(prefix, segment);
      if (existsSync(candidate)) {
        const resolved = expand(candidate, rest);
        if (resolved) return resolved;
      }
    }
    const candidate = path.join(prefix, remaining);
    return existsSync(candidate) ? candidate : undefined;
  }

  return expand(root, driveMatch[2]);
}

/** 读取 `$DSH_HOME/sessions/` 下的工作区路径（登记表不可用时的兜底来源）。 */
export function readDshSessionWorkspacePaths(environment = process.env) {
  const dshHome = resolveDshHome(environment);
  if (!dshHome) return [];
  const sessionsRoot = path.join(dshHome, "sessions");
  let entries;
  try {
    entries = readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const decoded = decodeDshSessionDirectoryName(entry.name);
    if (!decoded) continue;
    let mtime = 0;
    try {
      mtime = statSync(path.join(sessionsRoot, entry.name)).mtimeMs;
    } catch {
      /* 保留 0：只影响排序 */
    }
    found.push({ path: decoded, mtime });
  }
  return found
    .sort((a, b) => b.mtime - a.mtime)
    .map((entry) => entry.path);
}

function describeProject(root, source) {
  const settingsPath = path.join(root, SETTINGS_RELATIVE_PATH);
  const tokenPath = path.join(root, TOKEN_RELATIVE_PATH);
  const token = readTokenFile(tokenPath);
  return {
    root,
    source,
    hasMarker: existsSync(path.join(root, PROJECT_MARKER_RELATIVE_PATH)),
    hasSettings: existsSync(settingsPath),
    tokenPath: token ? tokenPath : undefined,
    authToken: token ?? "",
    settingsPath: existsSync(settingsPath) ? settingsPath : undefined,
  };
}

function readTokenFile(tokenPath) {
  try {
    const token = readFileSync(tokenPath, "utf-8").trim();
    return TOKEN_PATTERN.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 收集候选 Unity 项目（按优先级排序，已去重）。
 *
 * options:
 * - configuredProjectPaths: 显式项目根（最高优先级）
 * - searchPaths: 额外搜索目录（会扫描其下若干层）
 * - startDirectories: 向上寻根的起点（cwd 等）
 * - environment: 读取 DSH_HOME 等
 * - scanDepth / maxScannedDirectories / maxCandidates: 扫描上限（防拖慢插件加载）
 */
export function collectUnityProjectCandidates(options = {}) {
  const environment = options.environment ?? process.env;
  const scanDepth = options.scanDepth ?? 3;
  const state = {
    scanned: 0,
    limit: options.maxScannedDirectories ?? 600,
  };
  const maxCandidates = options.maxCandidates ?? 12;
  const candidates = [];
  const seen = new Set();

  const addProject = (root, source) => {
    if (!root || candidates.length >= maxCandidates) return;
    const resolved = path.resolve(root);
    const key = resolved.toLowerCase();
    if (seen.has(key)) return;
    const project = describeProject(resolved, source);
    if (!project.hasMarker && !project.hasSettings && !project.tokenPath) return;
    seen.add(key);
    candidates.push(project);
  };

  // A. 显式配置
  for (const configured of options.configuredProjectPaths ?? []) {
    const resolved = nonEmptyString(configured);
    if (!resolved) continue;
    const absolute = path.resolve(resolved);
    if (existsSync(path.join(absolute, PROJECT_MARKER_RELATIVE_PATH))) {
      addProject(absolute, "configured");
    } else {
      scanForProjects(absolute, scanDepth, state, (found) => addProject(found, "configured-search"));
    }
  }

  // B/C. DSH 工作区登记表（含所有 Unity 项目）与 sessions 目录名
  for (const workspace of readDshWorkspacePaths(environment)) {
    addProject(workspace, "dsh-workspace");
  }
  for (const workspace of readDshSessionWorkspacePaths(environment)) {
    addProject(workspace, "dsh-session");
  }

  // 显式搜索目录
  for (const searchPath of options.searchPaths ?? []) {
    const resolved = nonEmptyString(searchPath);
    if (!resolved) continue;
    scanForProjects(path.resolve(resolved), scanDepth, state, (found) =>
      addProject(found, "search-path")
    );
  }

  // D. 起点向上寻根
  for (const start of options.startDirectories ?? []) {
    const resolved = nonEmptyString(start);
    if (!resolved) continue;
    addProject(walkUpToUnityProject(resolved), "start-directory");
  }

  // D2. 已发现项目的同级目录（多项目机器的传统用法兜底）
  const parents = new Set();
  for (const project of candidates) {
    parents.add(path.dirname(project.root));
  }
  for (const start of options.startDirectories ?? []) {
    const resolved = nonEmptyString(start);
    if (resolved) parents.add(path.dirname(path.resolve(resolved)));
  }
  for (const parent of parents) {
    forEachChildDirectory(parent, (child) => {
      if (existsSync(path.join(child, PROJECT_MARKER_RELATIVE_PATH))) {
        addProject(child, "sibling");
      }
    });
  }

  // 排序：有 token 的项目优先（活跃网桥几乎总有 token 文件），
  // 其次按来源优先级（显式配置 > DSH 最近使用 > 扫描发现）。
  const sourceWeight = {
    configured: 0,
    "configured-search": 1,
    "dsh-workspace": 2,
    "dsh-session": 3,
    "search-path": 4,
    "start-directory": 5,
    sibling: 6,
  };
  return candidates
    .map((project, index) => ({ project, index }))
    .sort((a, b) => {
      const tokenDiff = (b.project.tokenPath ? 1 : 0) - (a.project.tokenPath ? 1 : 0);
      if (tokenDiff !== 0) return tokenDiff;
      const weightDiff =
        (sourceWeight[a.project.source] ?? 9) - (sourceWeight[b.project.source] ?? 9);
      if (weightDiff !== 0) return weightDiff;
      return a.index - b.index;
    })
    .map((entry) => entry.project);
}

function scanForProjects(root, depth, state, onFound) {
  if (!root || depth < 0 || !isDirectory(root)) return;
  const stack = [{ directory: root, depth: 0 }];
  while (stack.length > 0) {
    const { directory, depth: currentDepth } = stack.pop();
    if (state.scanned >= state.limit) return;
    state.scanned += 1;
    if (existsSync(path.join(directory, PROJECT_MARKER_RELATIVE_PATH))) {
      onFound(directory);
      continue; // 项目内不再深入（Assets/Library 很大，且不会有嵌套项目）
    }
    if (currentDepth >= depth) continue;
    forEachChildDirectory(directory, (child) => {
      stack.push({ directory: child, depth: currentDepth + 1 });
    });
  }
}

function forEachChildDirectory(directory, visit) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
    visit(path.join(directory, entry.name));
  }
}

function isDirectory(candidate) {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 把候选项目翻译成 vendored 服务端认识的环境变量：
 * - `MCP_UNITY_PROJECT_PATHS`：候选项目根目录（按优先级，路径分隔符分隔）。
 *   服务端会逐个尝试其端口/token，第一个握手通过的就是活跃项目——
 *   所以换项目不需要改任何配置。
 * - `MCP_UNITY_SETTINGS_PATH`：首选项目的 settings（决定主端口/超时）。
 * 已显式配置的环境变量一律不覆盖。
 */
export function applyUnityProjectEnvironment(env, candidates = []) {
  const usable = candidates.filter((project) => project.hasSettings || project.tokenPath);
  if (usable.length === 0) return env;
  if (env.MCP_UNITY_PROJECT_PATHS === undefined) {
    env.MCP_UNITY_PROJECT_PATHS = usable.map((project) => project.root).join(path.delimiter);
  }
  const primary = usable[0];
  if (env.MCP_UNITY_SETTINGS_PATH === undefined && primary.settingsPath) {
    env.MCP_UNITY_SETTINGS_PATH = primary.settingsPath;
  }
  return env;
}

/** 候选项目 → 连接档案（host/port/token），沿用与服务端相同的默认值规则。 */
export function projectConnectionProfiles(candidates, environment = process.env) {
  const fallbackHost = nonEmptyString(environment.UNITY_HOST) ?? DEFAULT_HOST;
  const fallbackPort = parsePort(environment.UNITY_PORT) ?? DEFAULT_PORT;
  return candidates.map((project) => {
    const settings = readProjectSettings(project.settingsPath);
    return {
      projectRoot: project.root,
      source: project.source,
      host: nonEmptyString(settings?.Host) ?? fallbackHost,
      // McpUnitySettings.json 里的 Port 是数字，环境变量里是字符串，两者都要接受
      port: coercePort(settings?.Port) ?? fallbackPort,
      authToken: project.authToken,
      tokenPath: project.tokenPath,
    };
  });
}

function readProjectSettings(settingsPath) {
  if (!settingsPath) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 识别活跃项目：按优先级逐个用候选 token 做真实握手，第一个被接受的就是它。
 * 永不 reject；返回尝试记录，便于 unity_status 给出可追溯的诊断。
 */
export async function identifyLiveBridge(profiles, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2000;
  const limit = options.limit ?? profiles.length;
  const attempts = [];
  let lastStatus = "unreachable";
  let lastHttpStatus;
  let lastError;
  let reachable = false;
  let latencyMs;
  for (const profile of profiles.slice(0, limit)) {
    const tcp = await probeTcp(profile.host, profile.port, timeoutMs, options.signal);
    if (latencyMs === undefined && tcp.ok) latencyMs = tcp.latencyMs;
    if (!tcp.ok) {
      lastStatus = "unreachable";
      lastError = tcp.error;
      attempts.push({ project: profile.projectRoot, status: "unreachable" });
      continue;
    }
    reachable = true;
    const handshake = await probeBridgeHandshake(profile.host, profile.port, {
      token: profile.authToken,
      timeoutMs,
      signal: options.signal,
    });
    lastStatus = handshake.status;
    lastHttpStatus = handshake.httpStatus;
    lastError = handshake.error;
    attempts.push({
      project: profile.projectRoot,
      status: handshake.status,
      httpStatus: handshake.httpStatus,
    });
    if (handshake.status === "connected") {
      return {
        identified: profile,
        handshake,
        attempts,
        reachable,
        latencyMs,
        hostedBy: profiles[0],
      };
    }
  }
  return {
    identified: undefined,
    handshake: {
      status: profiles.length === 0 ? "unreachable" : lastStatus,
      httpStatus: lastHttpStatus,
      error: lastError,
    },
    attempts,
    reachable,
    latencyMs,
    hostedBy: profiles[0],
  };
}

// ---------------------------------------------------------------------------
// 探测原语
// ---------------------------------------------------------------------------

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

/** 与 vendored 服务端一致：仅接受纯数字 1-65535（环境变量形式）。 */
function parsePort(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return undefined;
  const n = Number(value.trim());
  return n >= 1 && n <= 65535 ? n : undefined;
}

/** settings JSON 中的端口是数字，环境变量中是字符串——两者都接受。 */
function coercePort(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 1 && value <= 65535 ? value : undefined;
  }
  return parsePort(value);
}
