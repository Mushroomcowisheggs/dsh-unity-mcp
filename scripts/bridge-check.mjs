#!/usr/bin/env node
// bridge-check.mjs — 在 DSH 之外复现 unity_status 的判定：
// TCP 探测 + 真实 WebSocket 握手（带 Basic 认证），并打印 token 来源。
//
// 用法：
//   node scripts/bridge-check.mjs                     # 自动探测当前工作目录上方的 Unity 项目
//   node scripts/bridge-check.mjs --project <项目根>   # 指定 Unity 项目（含 Assets/、ProjectSettings/）
//
// 退出码：0 = 握手成功；1 = 需要认证/端口异常/不可达（把上面第一行文字给用户或 issue 即可）。
import path from "node:path";
import {
  applyUnityProjectEnvironment,
  probeBridgeHandshake,
  probeTcp,
  resolveBridgeTarget,
  resolveUnityProjectRoot,
} from "../lib/bridge-probe.js";

function parseArgs(argv) {
  const args = { project: undefined, timeoutMs: 2000 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--project") args.project = argv[++i];
    else if (argv[i] === "--timeout") args.timeoutMs = Number(argv[++i]);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const projectRoot = resolveUnityProjectRoot(args.project ?? "", process.cwd());
const environment = applyUnityProjectEnvironment({ ...process.env }, projectRoot);

console.log(`unity project : ${projectRoot ?? "(not found — pass --project <path>)"}`);

const target = await resolveBridgeTarget({
  environment,
  cwd: process.cwd(),
  modulePath: process.argv[1],
});

console.log(`endpoint      : ws://${target.host}:${target.port}/McpUnity`);
console.log(`token source  : ${target.authTokenSource}`);
console.log(`token length  : ${target.authToken ? target.authToken.length : 0}`);
if (target.error) console.log(`config error  : ${target.error}`);

const tcp = await probeTcp(target.host, target.port, args.timeoutMs);
if (!tcp.ok) {
  console.log(`tcp           : FAILED (${tcp.error})`);
  console.log("\n>>> 网桥不可达：Unity 编辑器未运行，或项目未安装 com.gamelovers.mcp-unity 网桥包。");
  process.exit(1);
}
console.log(`tcp           : ok (${tcp.latencyMs} ms)`);

const handshake = await probeBridgeHandshake(target.host, target.port, {
  token: target.authToken,
  timeoutMs: args.timeoutMs,
});
console.log(
  `handshake     : ${handshake.status}` +
    `${handshake.httpStatus ? ` (HTTP ${handshake.httpStatus})` : ""}` +
    `${handshake.error ? ` — ${handshake.error}` : ""}`
);

if (handshake.status === "connected") {
  console.log("\n>>> OK：网桥可达且认证通过，MCP 工具应可正常调用。");
  process.exit(0);
}
if (handshake.status === "unauthorized") {
  console.log(
    "\n>>> 认证被拒（Unity 1.5+ 网桥要求 bridge token）：" +
      "\n    在 Unity 打开 Tools > MCP Unity > Server Window 复制 token，" +
      "\n    然后设置 MCP_UNITY_AUTH_TOKEN，或把 MCP_UNITY_AUTH_TOKEN_PATH 指向" +
      "\n    <项目>/Library/McpUnity/bridge-token，再重启 MCP 客户端。"
  );
  process.exit(1);
}
console.log("\n>>> 握手异常：确认 /McpUnity 端点未被其它程序占用，并在 Unity 里重启网桥。");
process.exit(1);
