import net from "node:net";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import * as mcpClient from "@deepseek-ai/dsh-mcp-client";

/**
 * dsh-unity-mcp: DeepSeek Harness 插件封装。
 *
 * 加载时以子插件形式挂载官方 @deepseek-ai/dsh-mcp-client，将其指向内置的
 * mcp-unity 服务端（vendored，来自 CoderGamester/mcp-unity，MIT）。
 * 服务端通过 WebSocket 连接 Unity 编辑器内的 MCP Unity Bridge（默认 8090 端口），
 * 把 Unity 编辑器操作以 MCP 工具的形式暴露给 Agent。
 *
 * 另注册一个本地诊断工具 unity_status：以 TCP 探测网桥端口，让 Agent 在调用
 * mcp__unity__* 工具前先确认 Unity 编辑器在线，避免在 Unity 未运行时反复等待超时。
 */

const SERVER_ENTRY = fileURLToPath(
  new URL("../vendor/mcp-unity-server/build/index.js", import.meta.url)
);

/** Unity 网桥默认地址/端口，与 vendored 服务端的兜底值保持一致。 */
const DEFAULT_BRIDGE_HOST = "localhost";
const DEFAULT_BRIDGE_PORT = 8090;

export const name = "unity-mcp";

/** 需要工具注册服务：挂载 MCP 子客户端（其自身也声明 ['tools']）+ 注册 unity_status。 */
export const inject = ["tools"];

/**
 * 配置 schema（非法值在插件加载期直接报错，而不是带病运行）：
 * - toolCallTimeoutMs / probeTimeoutMs 必须为正数——超时非正的工具会被
 *   工具注册表拒绝，宁可在 schema 层拒绝整个配置也不悄悄注销工具；
 * - reconnect 各时间/次数参数同理由下限约束。
 */
export const Config = z.object({
  /** MCP 工具命名空间（默认 "unity"，工具名形如 mcp__unity__xxx）。 */
  serverName: z.string().default("unity"),
  /**
   * 传给服务端进程的额外环境变量。UNITY_PORT / UNITY_HOST 可覆盖网桥
   * 端口/地址，unity_status 的探测目标会同步读取这两个变量。
   */
  env: z.dict(String).default({}),
  /** 单次 MCP 工具调用超时（毫秒）。 */
  toolCallTimeoutMs: z.number().min(1).default(60000),
  /** unity_status 探测网桥的连接超时（毫秒）。 */
  probeTimeoutMs: z.number().min(100).default(2000),
  /** 重连策略（Unity 编辑器重启后自动恢复连接）。 */
  reconnect: z
    .object({
      enabled: z.boolean().default(true),
      initialDelayMs: z.number().min(1).default(1000),
      maxDelayMs: z.number().min(1).default(30000),
      maxAttempts: z.number().min(1).default(10),
    })
    .default({ enabled: true, initialDelayMs: 1000, maxDelayMs: 30000, maxAttempts: 10 }),
});

/**
 * @param ctx - cordis 上下文。
 * @param config - 经 Config schema 校验/补全后的配置。
 */
export function apply(ctx, config = {}) {
  const env = { ...(config.env ?? {}) };
  // 兜底：宿主若运行在 Electron 内，标记子进程为纯 Node 模式。
  if (process.versions.electron !== undefined) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }

  const serverName = config.serverName ?? "unity";
  const probeTimeoutMs = config.probeTimeoutMs ?? 2000;

  ctx.plugin(mcpClient, {
    transport: "stdio",
    serverName,
    command: config.nodePath ?? process.execPath,
    args: [SERVER_ENTRY],
    env,
    cwd: "",
    toolCallTimeoutMs: config.toolCallTimeoutMs ?? 60000,
    failOnStartupError: false,
    reconnect: {
      enabled: true,
      initialDelayMs: 1000,
      maxDelayMs: 30000,
      maxAttempts: 10,
      ...(config.reconnect ?? {}),
    },
  });

  // 网桥探测目标与 vendored 服务端同源：env.UNITY_HOST / env.UNITY_PORT 优先。
  // （服务端还会读 Unity 项目的 McpUnitySettings.json，探测覆盖不到该来源；
  //   探测结果会带上实际探测的 host/port，Agent 能看出目标是否需要调整。）
  const bridgeHost = nonEmptyString(env.UNITY_HOST) ?? DEFAULT_BRIDGE_HOST;
  const bridgePort = parsePort(env.UNITY_PORT) ?? DEFAULT_BRIDGE_PORT;

  ctx.tools.register(
    defineTool({
      name: "unity_status",
      description:
        "诊断 Unity 集成状态：TCP 探测 Unity 编辑器内 MCP 网桥（WebSocket）是否可达。" +
        "调用任何 mcp__unity__* 工具之前先调用本工具——Unity 编辑器未运行时网桥不可达，" +
        "直接调用其他工具只会等待超时。网桥不可达时请提示用户打开 Unity 编辑器" +
        "（项目需安装 com.gamelovers.mcp-unity 网桥包），在用户确认前不要重试。",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            host: { type: "string", required: true },
            port: { type: "number", required: true },
            bridgeReachable: { type: "boolean", required: true },
            latencyMs: { type: "number" },
            error: { type: "string" },
            toolNamespace: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: renderStatus(value) }],
      },
      timeoutMs: probeTimeoutMs + 1000,
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const probe = await probeTcp(bridgeHost, bridgePort, probeTimeoutMs, exec?.signal);
        // 注意：工具结果必须整体是 lossless JSON——任何 undefined 属性值都会被
        // DSH 工具层判定非法（"value is not lossless JSON"）。error/latencyMs
        // 仅在真有值时写入。
        return {
          host: bridgeHost,
          port: bridgePort,
          bridgeReachable: probe.ok,
          latencyMs: probe.latencyMs,
          ...(typeof probe.error === "string" ? { error: probe.error } : {}),
          toolNamespace: serverName,
        };
      },
    })
  );
}

/**
 * 与 vendored 服务端一致的环境变量端口解析：仅接受纯数字、1-65535，
 * 其余一律回退默认（不猜、不抛——探测工具的健壮性优先）。
 */
function parsePort(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return undefined;
  const n = Number(value.trim());
  return n >= 1 && n <= 65535 ? n : undefined;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 错误信息可读化：localhost 解析出多个地址全部失败时 Node 抛 AggregateError，
 * 其 message 为空——展开内层各地址的真实错误（去重）。 */
function describeError(err) {
  if (err && Array.isArray(err.errors) && err.errors.length > 0) {
    const parts = [...new Set(err.errors.map((e) => String((e && e.message) || e)))];
    if (parts.length > 0) return parts.join("; ");
  }
  return String((err && err.message) || err);
}

/**
 * TCP 探测：连接成功即视为网桥在线（MCP Unity Bridge 是 WebSocket 服务，
 * TCP 层可连即端口在监听）。永不 reject；失败原因放进结果的 error 字段。
 */
function probeTcp(host, port, timeoutMs, signal) {
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

function renderStatus(value) {
  const lines = [];
  if (value.bridgeReachable) {
    lines.push(
      `Unity 网桥 ${value.host}:${value.port} 可达（${value.latencyMs} ms）——Unity MCP 工具就绪。`
    );
  } else {
    lines.push(
      `Unity 网桥 ${value.host}:${value.port} 不可达${value.error ? `（${value.error}）` : ""}。`
    );
    lines.push(
      "Unity 编辑器可能未运行，或项目未安装 com.gamelovers.mcp-unity 网桥包。" +
        "请让用户打开 Unity 编辑器后再试；在此之前不要调用其他 mcp__unity__* 工具（只会等待超时）。"
    );
  }
  lines.push(`工具命名空间：mcp__${value.toolNamespace}__*`);
  return lines.join("\n");
}
