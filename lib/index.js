import path from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import * as mcpClient from "@deepseek-ai/dsh-mcp-client";
import {
  applyUnityProjectEnvironment,
  collectUnityProjectCandidates,
  identifyLiveBridge,
  projectConnectionProfiles,
  resolveBridgeTarget,
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
 *
 * 项目定位：DSH 是常驻服务，服务端进程的 cwd 与「当前在编辑哪个 Unity 项目」
 * 无关，所以插件不会只依赖 cwd，而是汇集多来源候选项目（显式配置、DSH 工作区
 * 登记表、sessions 目录名、cwd 寻根、同级目录扫描），交给服务端按 token 逐个
 * 试探握手——第一个被接受的就是活跃项目，换项目无需改配置。
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
   * 端口/地址；MCP_UNITY_PROJECT_PATHS / MCP_UNITY_SETTINGS_PATH /
   * MCP_UNITY_AUTH_TOKEN_PATH / MCP_UNITY_AUTH_TOKEN 控制项目与认证来源
   * （unity_status 同步读取）。
   */
  env: z.dict(String).default({}),
  /**
   * Unity 项目根目录（含 Assets/、ProjectSettings/ 的那一层）。
   * 一般无需配置：插件会从 DSH 工作区登记表、sessions 目录名、当前工作目录
   * 向上寻根以及同级目录等多个来源自动汇集候选项目，再由 token 握手识别
   * 活跃项目。显式配置只是把这个项目提到最高优先级。
   */
  unityProjectPath: z.string().default(""),
  /**
   * 额外的项目搜索目录（每个目录会向下扫描若干层找 Unity 项目）。
   * 用于项目不在 DSH 登记表里、也不在默认起点附近的场景。
   */
  unityProjectSearchPaths: z.array(z.string()).default([]),
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

  // 汇总候选 Unity 项目并翻译成子进程环境变量。Unity 1.5+ 网桥强制
  // HTTP Basic 认证，凭据是每项目一份的 Library/McpUnity/bridge-token；
  // 服务端会用候选列表逐个试探，因此这里不需要猜中"哪一个"。
  const candidates = collectUnityProjectCandidatesForConfig(config);
  applyUnityProjectEnvironment(env, candidates);

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
        "诊断 Unity 集成状态并识别活跃 Unity 项目：汇集候选项目（显式配置、DSH 工作区登记表、" +
        "会话目录、工作目录寻根、同级目录），逐个用其 bridge token 做真实 WebSocket 认证握手" +
        "（含 Basic Authorization），第一个被接受的就是当前开着的项目。" +
        "调用任何 mcp__unity__* 工具之前先调用本工具：handshake=connected 才代表工具就绪；" +
        "unauthorized 表示所有候选 token 都被拒（token 缺失/过期，或用 -projectPath 打开的项目在候选之外），" +
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
            /** 已识别的活跃项目（握手被接受的那个），未识别到时省略。 */
            unityProjectPath: { type: "string" },
            /** 参与识别的候选项目数。 */
            candidatesProbed: { type: "number", required: true },
            error: { type: "string" },
            configError: { type: "string" },
            toolNamespace: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: renderStatus(value) }],
      },
      timeoutMs: probeTimeoutMs * 2 * (1 + Math.min(candidates.length, MAX_PROBED_CANDIDATES)) + 1000,
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        // 与子进程同源：同一份环境变量 + 同一份候选项目列表 +
        // 同一份 vendored 配置解析器，因此探测目标与真实连接目标不会漂移。
        const environment = { ...process.env, ...env };
        // 主目标仍由 vendored 解析器给出（显式 env token / settings / 默认值），
        // 它同时负责把"显式配置写错了"这类问题报成 configError。
        const primary = await resolveBridgeTarget({
          environment,
          cwd: process.cwd(),
          modulePath: SERVER_ENTRY,
        });
        const profiles = projectConnectionProfiles(candidates, environment);
        // 显式 token 排在最前（用户意图优先），随后是候选项目。
        const targets = dedupeProfiles([
          {
            projectRoot: primary.settingsPath
              ? path.dirname(path.dirname(primary.settingsPath))
              : undefined,
            host: primary.host,
            port: primary.port,
            authToken: primary.authToken,
            explicit: primary.authTokenSource !== "none",
          },
          ...profiles,
        ]);

        // 逐个候选项目做真实握手：第一个被接受的就是活跃项目。
        const identification = await identifyLiveBridge(targets, {
          timeoutMs: probeTimeoutMs,
          limit: MAX_PROBED_CANDIDATES,
          signal: exec?.signal,
        });
        const fallback = identification.hostedBy ?? targets[0];
        const identified = identification.identified;
        const identifiedRoot = identified?.projectRoot;

        // 注意：工具结果必须整体是 lossless JSON——任何 undefined 属性值都会被
        // DSH 工具层判定非法（"value is not lossless JSON"）。可选字段仅在真有值时写入。
        // error 只承载传输/握手失败；配置解析失败单独放 configError。
        return {
          host: identified ? identified.host : fallback.host,
          port: identified ? identified.port : fallback.port,
          bridgeReachable: identification.reachable,
          handshake: identification.handshake.status,
          authenticated: identified !== undefined,
          ...(typeof identification.latencyMs === "number"
            ? { latencyMs: identification.latencyMs }
            : {}),
          ...(typeof identification.handshake.httpStatus === "number"
            ? { httpStatus: identification.handshake.httpStatus }
            : {}),
          authTokenSource: identifiedRoot
            ? `Unity project (${identifiedRoot})`
            : primary.authTokenSource,
          ...(identifiedRoot ? { unityProjectPath: identifiedRoot } : {}),
          candidatesProbed: identification.attempts.length,
          ...(typeof identification.handshake.error === "string"
            ? { error: identification.handshake.error }
            : {}),
          ...(typeof primary.error === "string" ? { configError: primary.error } : {}),
          toolNamespace: serverName,
        };
      },
    })
  );
}

/** unity_status 最多尝试的候选项目数（诊断工具的时延上限）。 */
const MAX_PROBED_CANDIDATES = 8;

/** 按 host:port:token 去重，保留先出现的（= 更高优先级）。 */
function dedupeProfiles(profiles) {
  const seen = new Set();
  const unique = [];
  for (const profile of profiles) {
    if (!profile) continue;
    // token 本身参与去重：同一端点上不同项目的 token 是不同的候选，
    // 不能因为"都有 token"就合并掉（否则第一个 401 之后就没得试了）。
    const key = `${profile.host}:${profile.port}:${profile.authToken || "<anonymous>"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(profile);
  }
  return unique;
}

/**
 * 汇总候选 Unity 项目：显式配置 > DSH 工作区登记表 > sessions 目录名 >
 * cwd 寻根 > 同级目录扫描。起点集合来自环境（DSH_HOME 决定登记表位置）。
 */
function collectUnityProjectCandidatesForConfig(config) {
  const startDirectories = [process.cwd()];
  const searchPaths = [];
  const configured = [];
  if (config.unityProjectPath) {
    configured.push(config.unityProjectPath);
  }
  for (const extra of config.unityProjectSearchPaths ?? []) {
    if (extra) searchPaths.push(extra);
  }
  return collectUnityProjectCandidates({
    configuredProjectPaths: configured,
    searchPaths,
    startDirectories,
    environment: process.env,
  });
}

function renderStatus(value) {
  const lines = [];
  const target = `${value.host}:${value.port}`;
  const probed =
    typeof value.candidatesProbed === "number"
      ? `（已尝试 ${value.candidatesProbed} 个候选项目）`
      : "";
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
    if (value.unityProjectPath) {
      lines.push(`活跃项目：${value.unityProjectPath}（由 token 握手识别，无需按项目配置）。`);
    }
  } else if (value.handshake === "unauthorized") {
    lines.push(
      `Unity 网桥 ${target} 可达（${value.latencyMs} ms），但认证被拒绝` +
        `${value.httpStatus ? `（HTTP ${value.httpStatus}）` : ""}${probed}——端口在监听，工具仍不可用。`
    );
    lines.push(
      "所有候选项目的 bridge token 都被拒。Unity 1.5+ 网桥要求 HTTP Basic 认证" +
        "（用户名 mcp-unity，密码为项目 token）：",
      "  1) 在 Unity 打开 Tools > MCP Unity > Server Window 确认 Authentication 为 Ready；",
      "  2) 若刚点过 Regenerate Authentication Token，重启 DSH 让客户端重新读取；",
      "  3) 若项目位于候选之外（例如 DSH 登记表里没有它），配置 unityProjectPath 或" +
        " env.MCP_UNITY_AUTH_TOKEN_PATH 指向 <项目>/Library/McpUnity/bridge-token。",
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
