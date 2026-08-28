import { fileURLToPath } from "node:url";
import * as mcpClient from "@deepseek-ai/dsh-mcp-client";

/**
 * dsh-unity-mcp: DeepSeek Harness 插件封装。
 *
 * 加载时以子插件形式挂载官方 @deepseek-ai/dsh-mcp-client，将其指向内置的
 * mcp-unity 服务端（vendored，来自 CoderGamester/mcp-unity，MIT）。
 * 服务端通过 WebSocket 连接 Unity 编辑器内的 MCP Unity Bridge（默认 8090 端口），
 * 把 Unity 编辑器操作以 MCP 工具的形式暴露给 Agent。
 */

const SERVER_ENTRY = fileURLToPath(
  new URL("../vendor/mcp-unity-server/build/index.js", import.meta.url)
);

export const name = "unity-mcp";

/** 本插件自身无额外服务依赖；子插件 dsh-mcp-client 会自行声明 ['tools']。 */
export const inject = [];

/**
 * @param ctx - cordis 上下文。
 * @param config - 可选配置：
 *   - serverName: MCP 工具命名空间（默认 "unity"，工具名形如 mcp__unity__xxx）
 *   - env: 传给服务端进程的额外环境变量
 *   - toolCallTimeoutMs: 单次工具调用超时（默认 60000）
 *   - reconnect: 重连策略覆写 { enabled, initialDelayMs, maxDelayMs, maxAttempts }
 */
export function apply(ctx, config = {}) {
  const env = { ...(config.env ?? {}) };
  // 兜底：宿主若运行在 Electron 内，标记子进程为纯 Node 模式。
  if (process.versions.electron !== undefined) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }

  ctx.plugin(mcpClient, {
    transport: "stdio",
    serverName: config.serverName ?? "unity",
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
}
