#!/usr/bin/env node
// bridge-check.mjs — 在 DSH 之外复现 unity_status 的判定：
// 汇集候选 Unity 项目 → 逐个用其 token 做真实 WebSocket 握手 →
// 第一个被接受的就是当前打开的（活跃）项目。
//
// 用法：
//   node scripts/bridge-check.mjs                      # 自动发现（DSH 工作区登记表 + cwd 寻根 + 同级扫描）
//   node scripts/bridge-check.mjs --project <项目根>    # 把某个项目提到最高优先级
//   node scripts/bridge-check.mjs --search <目录>       # 额外搜索目录（可重复）
//
// 退出码：0 = 识别成功且握手通过；1 = 需要认证/端口异常/不可达。
import {
  applyUnityProjectEnvironment,
  collectUnityProjectCandidates,
  identifyLiveBridge,
  projectConnectionProfiles,
  probeTcp,
} from "../lib/bridge-probe.js";

function parseArgs(argv) {
  const args = { projects: [], searchPaths: [], timeoutMs: 2000 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--project") args.projects.push(argv[++i]);
    else if (argv[i] === "--search") args.searchPaths.push(argv[++i]);
    else if (argv[i] === "--timeout") args.timeoutMs = Number(argv[++i]);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const candidates = collectUnityProjectCandidates({
  configuredProjectPaths: args.projects,
  searchPaths: args.searchPaths,
  startDirectories: [process.cwd()],
  environment: process.env,
});

console.log(`cwd           : ${process.cwd()}`);
console.log(`dsh home      : ${process.env.DSH_HOME ?? "~/.dsh (fallback)"}`);
console.log(`candidates    : ${candidates.length}`);
for (const candidate of candidates) {
  console.log(
    `  [${candidate.source}] ${candidate.root}` +
      `${candidate.tokenPath ? " token=yes" : " token=NO"}` +
      `${candidate.hasSettings ? " settings=yes" : ""}`
  );
}

const env = applyUnityProjectEnvironment({ ...process.env }, candidates);
if (env.MCP_UNITY_PROJECT_PATHS) {
  console.log(`project paths : ${env.MCP_UNITY_PROJECT_PATHS}`);
}

if (candidates.length === 0) {
  console.log(
    "\n>>> 没有找到任何候选 Unity 项目：请确认 Unity 项目曾在本机打开过（DSH 工作区登记表），\n" +
      "    或用 --project <项目根> / --search <目录> 指定位置。"
  );
  process.exit(1);
}

const profiles = projectConnectionProfiles(candidates, process.env);
const tcp = await probeTcp(profiles[0].host, profiles[0].port, args.timeoutMs);
if (!tcp.ok) {
  console.log(
    `\n>>> 网桥不可达（${profiles[0].host}:${profiles[0].port}，${tcp.error}）：` +
      "Unity 编辑器未运行，或项目未安装 com.gamelovers.mcp-unity 网桥包。"
  );
  process.exit(1);
}
console.log(`tcp           : ok (${tcp.latencyMs} ms)`);

const identification = await identifyLiveBridge(profiles, { timeoutMs: args.timeoutMs });
for (const attempt of identification.attempts) {
  console.log(
    `  probe ${attempt.status}${attempt.httpStatus ? ` (HTTP ${attempt.httpStatus})` : ""} <- ${attempt.project ?? "?"}`
  );
}

if (identification.identified) {
  console.log(`\n>>> LIVE PROJECT IDENTIFIED: ${identification.identified.projectRoot}`);
  console.log("    (handshake accepted; no per-project configuration required)");
  process.exit(0);
}

if (identification.handshake.status === "unauthorized") {
  console.log(
    "\n>>> 所有候选 token 都被拒（Unity 1.5+ 网桥要求 bridge token）：" +
      "\n    在 Unity 打开 Tools > MCP Unity > Server Window 确认 Authentication 为 Ready；" +
      "\n    刚轮换过 token 就重启 MCP 客户端；项目不在候选里则用 --project / unityProjectPath 指定。"
  );
  process.exit(1);
}
console.log(`\n>>> 握手异常：${identification.handshake.status} ${identification.handshake.error ?? ""}`);
process.exit(1);
