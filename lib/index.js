import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import * as mcpClient from "@deepseek-ai/dsh-mcp-client";
import {
  applyUnityProjectEnvironment,
  probeBridgeHandshake,
  probeTcp,
  resolveBridgeTarget,
  resolveUnityProjectRoot,
} from "./bridge-probe.js";

/**
 * dsh-unity-mcp: DeepSeek Harness 插件封装。
 *
 * 加载时以子插件形式挂载官方 @deepseek-ai/dsh-mcp-client，将其指向内置的
 * mcp-unity 服务端（vendored，来自 CoderGamester/mcp-unity，MIT）。
 * 服务端通过 WebSocket 连接 Unity 编辑器内的 MCP Unity Bridge（默认 8090 端口），
 * 把 Unity 编辑器操作以 MCP 工具的形式暴露给 Agent。
 *
 * 另注册一个本地诊断工具 unity_status：以 TCP 探测 + 真实 WebSocket 认证握手
 * （含 Authorization 头）确认网桥真的可用。只看 TCP 会把「能连上但握手被 401 拒绝」
 * 误报成就绪——v1.2.0 及更早即为此假阳性所困。
 */

const SERVER_ENTRY = fileURLToPath(
  new URL("../vendor/mcp-unity-server/build/index.js", import.meta.url)
);

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
   * 端口/地址；MCP_UNITY_SETTINGS_PATH / MCP_UNITY_AUTH_TOKEN_PATH /
   * MCP_UNITY_AUTH_TOKEN 控制 Unity 项目的认证来源（unity_status 同步读取）。
   */
  env: z.dict(String).default({}),
  /**
   * Unity 项目根目录（含 Assets/、ProjectSettings/ 的那一层）。
   * 留空时从当前工作目录向上自动探测 ProjectSettings/ProjectVersion.txt；
   * 探测到后自动把 ProjectSettings/McpUnitySettings.json 与
   * Library/McpUnity/bridge-token 注入上面的 env（已显式配置的环境变量优先）。
   */
  unityProjectPath: z.string().default(""),
  /** 单次 MCP 工具调用超时（毫秒）。 */
  toolCallTimeoutMs: z.number().min(1).default(60000),
  /** unity_status 探测网桥的连接/握手超时（毫秒）。 */
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

  // Unity 项目位置：显式配置优先，否则从工作目录向上探测。
  // 解析出的项目路径用于补齐认证/settings 环境变量——Unity 1.5+ 网桥强制
  // HTTP Basic 认证，凭据来自 <项目>/Library/McpUnity/bridge-token。
  const unityProjectRoot = resolveUnityProjectRoot(config.unityProjectPath, process.cwd());
  applyUnityProjectEnvironment(env, unityProjectRoot);

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

  ctx.tools.register(
    defineTool({
      name: "unity_status",
      description:
        "诊断 Unity 集成状态：先 TCP 探测 Unity 编辑器内 MCP 网桥（WebSocket），" +
        "再做一次真实 WebSocket 认证握手（含 Basic Authorization），确认网桥不仅端口在监听、" +
        "而且认证通过、可以收发 MCP 请求。调用任何 mcp__unity__* 工具之前先调用本工具：" +
        "handshake=connected 才代表工具就绪；unauthorized 表示缺少或过期 bridge token" +
        "（Unity 菜单 Tools > MCP Unity > Server Window 可复制/重新生成），" +
        "此时不要反复调用其他 mcp__unity__* 工具（只会报认证失败或超时）。",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            host: { type: "string", required: true },
            port: { type: "number", required: true },
            bridgeReachable: { type: "boolean", required: true },
            /** connected | unauthorized | unexpected | error | unreachable */
            handshake: { type: "string", required: true },
            authenticated: { type: "boolean", required: true },
            latencyMs: { type: "number" },
            httpStatus: { type: "number" },
            authTokenSource: { type: "string", required: true },
            unityProjectPath: { type: "string" },
            error: { type: "string" },
            configError: { type: "string" },
            toolNamespace: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: renderStatus(value) }],
      },
      timeoutMs: probeTimeoutMs * 2 + 1000,
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        // 与子进程同源：同一份环境变量 + 同一份 vendored 配置解析器，
        // 因此探测目标与真实连接目标不会漂移。
        const environment = { ...process.env, ...env };
        const target = await resolveBridgeTarget({
          environment,
          cwd: process.cwd(),
          modulePath: SERVER_ENTRY,
        });

        const tcp = await probeTcp(target.host, target.port, probeTimeoutMs, exec?.signal);
        let handshake = "unreachable";
        let httpStatus;
        let handshakeError;
        if (tcp.ok) {
          const result = await probeBridgeHandshake(target.host, target.port, {
            token: target.authToken,
            timeoutMs: probeTimeoutMs,
            signal: exec?.signal,
          });
          handshake = result.status;
          httpStatus = result.httpStatus;
          handshakeError = result.error;
        }

        // 注意：工具结果必须整体是 lossless JSON——任何 undefined 属性值都会被
        // DSH 工具层判定非法（"value is not lossless JSON"）。可选字段仅在真有值时写入。
        // error 只承载传输/握手失败；配置解析失败单独放 configError，
        // 免得「端口没开」被一条 token 路径错误顶掉。
        const transportError = typeof tcp.error === "string" ? tcp.error : handshakeError;
        return {
          host: target.host,
          port: target.port,
          bridgeReachable: tcp.ok,
          handshake,
          authenticated: handshake === "connected",
          ...(typeof tcp.latencyMs === "number" ? { latencyMs: tcp.latencyMs } : {}),
          ...(typeof httpStatus === "number" ? { httpStatus } : {}),
          authTokenSource: target.authTokenSource,
          ...(unityProjectRoot ? { unityProjectPath: unityProjectRoot } : {}),
          ...(typeof transportError === "string" ? { error: transportError } : {}),
          ...(typeof target.error === "string" ? { configError: target.error } : {}),
          toolNamespace: serverName,
        };
      },
    })
  );
}

function renderStatus(value) {
  const lines = [];
  const target = `${value.host}:${value.port}`;
  if (!value.bridgeReachable) {
    lines.push(`Unity 网桥 ${target} 不可达${value.error ? `（${value.error}）` : ""}。`);
    lines.push(
      "Unity 编辑器可能未运行，或项目未安装 com.gamelovers.mcp-unity 网桥包。" +
        "请让用户打开 Unity 编辑器后再试；在此之前不要调用其他 mcp__unity__* 工具（只会等待超时）。"
    );
  } else if (value.handshake === "connected") {
    lines.push(
      `Unity 网桥 ${target} 可达（${value.latencyMs} ms），WebSocket 认证握手成功——Unity MCP 工具就绪。`
    );
  } else if (value.handshake === "unauthorized") {
    lines.push(
      `Unity 网桥 ${target} 可达（${value.latencyMs} ms），但认证被拒绝` +
        `${value.httpStatus ? `（HTTP ${value.httpStatus}）` : ""}——端口在监听，工具仍不可用。`
    );
    lines.push(
      `当前 bridge token 来源：${value.authTokenSource}。Unity 1.5+ 网桥要求 HTTP Basic 认证` +
        "（用户名 mcp-unity，密码为项目 token）。请在 Unity 中打开 Tools > MCP Unity > Server Window，" +
        "复制 token 后配置本插件的 env.MCP_UNITY_AUTH_TOKEN，或配置 env.MCP_UNITY_AUTH_TOKEN_PATH /" +
        "unityProjectPath 指向该项目（token 文件位于 <项目>/Library/McpUnity/bridge-token）。" +
        "修复前不要调用其他 mcp__unity__* 工具（会直接报认证失败）。"
    );
  } else if (value.handshake === "unexpected") {
    lines.push(
      `Unity 网桥 ${target} 可达（${value.latencyMs} ms），但 WebSocket 握手返回异常` +
        `${value.httpStatus ? `（HTTP ${value.httpStatus}）` : ""}${value.error ? `：${value.error}` : "。"}`
    );
    lines.push(
      "该端口在监听，但 /McpUnity 端点没有正常升级为 WebSocket——可能是别的程序占用了该端口，" +
        "或 Unity 网桥未启动。请确认端口未被占用，并在 Unity 里重启网桥（Tools > MCP Unity > Server Window）。"
    );
  } else {
    lines.push(
      `Unity 网桥 ${target} 可达（${value.latencyMs} ms），但 WebSocket 握手未完成` +
        `${value.error ? `（${value.error}）` : ""}。`
    );
    lines.push("请确认 Unity 编辑器仍在前台运行，然后重试 unity_status。");
  }
  lines.push(`工具命名空间：mcp__${value.toolNamespace}__*`);
  if (value.configError) {
    lines.push(`⚠️ 连接配置解析失败：${value.configError}`);
  }
  return lines.join("\n");
}
