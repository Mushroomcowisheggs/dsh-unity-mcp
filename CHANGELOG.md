# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

（暂无计划项）

## [1.1.1] - 2026-10-24

本仓库在上游 [`thyeff/dsh-unity-mcp`](https://github.com/thyeff/dsh-unity-mcp) **v1.1.0**
之上的第一个补丁发布，包含三项修复：DSH 0.2 兼容、Unity 网桥认证、Unity 项目自动发现。

### Fixed

- **Unity 网桥的 HTTP Basic 认证从未发送（工具全部失败的根因）**。vendored 服务端的
  WebSocket 握手只发了 `X-Client-Name`，从不发 `Authorization`，被 Unity 1.5+
  网桥以 `401 Unauthorized` 拒绝；客户端随后指数退避重试到
  `Max reconnection attempts reached`，此后每次工具调用都表现为
  `MCP error -32001: Request timed out`（超时是二次症状，根因在第一次握手）。
  现按上游 mcp-unity 1.5.0 的实现移植：
  - `unityConnectionConfig.js`：新增 `authToken` 解析——`MCP_UNITY_AUTH_TOKEN`
    → `MCP_UNITY_AUTH_TOKEN_PATH` → 已发现 Unity 项目的
    `Library/McpUnity/bridge-token`，并回传来源 `authTokenSource`；
  - `unityConnection.js`：握手带 `Authorization: Basic base64("mcp-unity:<token>")`；
    用 `unexpected-response` 捕获 401/403 并作为**终态认证错误**上报，不再重连刷屏；
    URL 路径 `/McpUnity` 与「不发送 Origin」保持原样（两者本来就是对的）；
  - `utils/errors.js` + `mcpUnity.js`：新增 `AUTHENTICATION` 错误类型与
    `startupError`，认证失败后每次工具调用立刻抛出可读原因，而不是等到超时。
  - 与上游不同的一处取舍：**找不到 token 不算致命错误**（认证特性之前的老网桥
    没有 token 文件），只警告并按无认证连接；真正要求认证的网桥会在 401 时
    得到明确指引。显式配置的 token/路径非法时仍然立刻报错。
- **`unity_status` 假阳性**。上游实现只做 TCP 探测，端口在监听就报「就绪」；
  但网桥在 HTTP 层先接受 TCP、再在握手阶段 401 断开——「能连上」与「能用」之间有鸿沟。
  现在 `unity_status` 会完成一次**真实的 WebSocket 认证握手**（101 +
  `Sec-WebSocket-Accept` 校验），只有 `handshake=connected` 才报就绪；401 明确报
  「认证被拒绝」并给出配置指引。零新增依赖（`node:net` + `node:crypto` 手写握手，
  不引入 `ws`）。
- **Unity 项目自动发现失败（修好认证后暴露的独立缺陷）**。认证代码已能读取 token 并
  发送 `Authorization`，但**取不到 token**：项目定位的起点只有 `process.cwd()`，而 DSH 是
  常驻服务 + 全局 profile，服务端进程的工作目录不在任何 Unity 项目内，向上寻根必然失败；
  失败后静默降级为「无 token」，于是握手仍被 401 拒绝（表现为 `authTokenSource: none`）。
  token 是每项目一份的，所以「配死一个项目路径」在多项目机器上必然失效。现在：
  - 候选项目来自**多来源**，按优先级汇总，并**刻意收紧范围**（只保留确实是 Unity 项目的
    路径，总量有上限）：显式配置（`unityProjectPath` / `unityProjectSearchPaths`）→
    DSH 侧来源（先读 `$DSH_HOME/sessions/` 目录名——只读目录名，不解析元数据存储；
    没有命中才回退读工作区登记表 `$DSH_HOME/storages/workspace.json`，只取
    `path`/`updatedAt`；两个来源都只收含 `ProjectSettings/ProjectVersion.txt` 的项目，
    **最多各 3 个**）→ 起点目录向上寻根 → 同级目录扫描（每父目录最多 3 个）。
    `discoverUnityProjects: false` 可完全关闭 DSH 侧来源。
  - **token 从不经环境变量传递**：环境变量只带候选项目**路径**
    （`MCP_UNITY_PROJECT_PATHS`），服务端再各自去读该项目自己的
    `Library/McpUnity/bridge-token`。普通工作区（代码库、文档目录）既不会成为候选，
    也不会出现在该环境变量里。
  - 服务端**逐个尝试**候选的端口（读它自己的 `McpUnitySettings.json`）与 token，
    **第一个握手被接受的就是活跃项目**并固定下来；全部候选都被拒 → 终态
    `authentication_error`，错误信息列出尝试过的项目。Unity 换项目（旧 token 不再被
    接受）时会自动重新识别，无需重启 DSH。
  - `unity_status` 用同一套候选做真实握手，输出 `authTokenSource: Unity project (<路径>)`
    与 `unityProjectPath`（已识别项目）、`candidatesProbed`（尝试了几个候选）。
- **实现细节修正**：settings 里的 `Port` 是数字而 `UNITY_PORT` 是字符串，候选端口解析
  原本只认字符串（导致候选项目一律回退默认端口）；`ws` 的 `onerror` 属性收到的是
  `ErrorEvent`（errno 在 `event.error.code` 上），原先按 `err.code` 读取导致
  「连不上就换下一个候选」的判断永不生效。
- 多个候选时的失败语义收窄：只有明确的终态才结束 `connect()`（全部候选被拒、达到重连
  上限），中途某个候选失败不再让调用方看到假失败。
- `docs/troubleshooting.md` 症状 1 把端口环境变量写成 `MCP_UNITY_PORT`
  （实际为 `UNITY_PORT`；上游 v1.1.0 已在 README 修正但此处漏改）。

### Changed

- **DSH peer declaration is now `>=0.1.1-rc.2 <=0.2.0-rc.2`** for both
  `@deepseek-ai/dsh-tools` (peer) and `@deepseek-ai/dsh-mcp-client`
  (dependency), replacing `^0.1.1-rc.2`. One build now loads on the older 0.1.x
  runtimes **and** the current `0.2.0-rc.2`; the plugin is not split into two
  releases, and no version exemption is needed.
- Why the old declaration failed: on the 0.x line a caret resolves to
  `>=0.1.1-rc.2 <0.2.0-0`, so `^0.1.1-rc.2` never admitted `0.2.0-rc.2` and DSH
  rejected the plugin with `incompatible-version`. (semver's prerelease tuple
  rule means it also rejected `0.1.7-rc.2`, not just 0.2.x.)
- Why the upper bound is an inclusive `<=0.2.0-rc.2` rather than `<0.3.0-0` or
  `<1.0.0`: `0.2.0-rc.2` is the current release (`dist-tag next`), and an open
  upper bound silently admits newer ones — `<0.3.0-0` already admits the
  published `0.2.1-alpha.1`. Closing the range at the current version keeps the
  declaration to old + current, with nothing above current.
- The lower bound stays at `0.1.1-rc.2` (what the plugin originally shipped
  against) so existing 0.1.x users keep loading.

### Added

- 插件配置 `unityProjectPath`（高优先级项目提示）、`unityProjectSearchPaths`
  （额外搜索目录）与 `discoverUnityProjects`（默认 `true`；`false` 时完全不读 DSH 工作区
  数据，只用显式配置 + 工作目录 + 搜索目录）。
- `MCP_UNITY_PROJECT_PATHS`（服务端环境变量，路径分隔符分隔的候选项目根目录；
  只含路径，绝不含 token）。
- `lib/bridge-probe.js`：零依赖探测原语（项目定位、与子进程同源的配置解析、TCP 探测、
  真实握手），`unity_status` 与命令行脚本共用同一套判定。
- `scripts/bridge-check.mjs`：在 DSH 之外复现同一判定（候选项目、逐个握手结果、
  识别出的活跃项目）。
- `McpUnity.getConnectionStats()` 与 `UnityConnection.getStats()` 增加
  `identifiedProject`（已识别项目的来源标签，绝不含 token 本身）。
- 测试：`node --test test/`（40 个用例）覆盖 token 优先级与失败语义、握手探测
  （必须发送 `Authorization`、必须不发送 `Origin`、401 不得判为就绪）、项目发现
  （sessions 目录名还原含带连字符路径、登记表回退、普通工作区被排除、候选上限、
  `discoverUnityProjects:false`、同级扫描兜底）、`apply()` 的工具契约与 lossless JSON
  约束，以及服务端连接层（第二个候选才被接受、全部被拒 → 终态且不重连、换项目后自动
  重新识别）。CI 增加 `ws` 装配、测试与「认证头 + 候选发现仍在」的守卫。

### Verified

- `defineTool`（`parameters: {}`、`output.schema` / `output.render`、`timeoutMs`、
  `isConcurrencySafe`、`execute(args, exec)`）、`ctx.tools.register`、`Config`
  schemastery schema，以及 `@deepseek-ai/dsh-mcp-client` 的完整配置面
  （`transport`/`serverName`/`command`/`args`/`env`/`cwd`/`toolCallTimeoutMs`/
  `failOnStartupError`/`reconnect`）在 DSH 0.2.0-rc.2 上均原样加载并通过校验。
- 版本范围用 DSH 自己的 `semver` 与相同选项
  （`semver.satisfies(rt, range, { includePrerelease: true })`）对 npm 上**全部 31 个
  已发布版本**扫过：`0.1.1-rc.2` 到 `0.2.0-rc.2` 全部通过（20 个），
  **高于 `0.2.0-rc.2` 的一个都不通过**（`0.2.1-alpha.1` 被拒）。
- `unity_status` 的 `output.schema` 仍使用 author-DSL 的逐属性 `required: true` 写法
  （编译为对象级 `required: [...]`）。**不要**改成对象级 `required` 数组，
  author DSL 会以 `JsonSchemaError` 拒绝。
- 真实环境（Unity 编辑器内 `com.gamelovers.mcp-unity` 1.5.0，网桥 127.0.0.1:8090；
  进程 cwd 为 `G:\Custom Projects\dsh`，**不在**任何 Unity 项目内，且**不配置**任何
  `unityProjectPath` / `MCP_UNITY_AUTH_TOKEN*`）：
  - 修复后 `get_scene_info` 返回真实场景数据；无 token / 错误 token 时立刻返回
    `authentication_error`，且不再产生重连风暴；
  - `unity_status` 三态在真实网桥上验证：项目 token → `connected`；无 token →
    `unauthorized`（HTTP 401）；错误 token → `unauthorized`；
  - `node scripts/bridge-check.mjs` 从会话工作区里识别出当时的活跃项目并输出
    `LIVE PROJECT IDENTIFIED: <项目根>`；清空候选列表后同一调用返回
    `authentication_error`；
  - 期间在 Unity 里换了项目（token 与场景内容都随之变化），识别结果随之改变，
    说明「识别」不是缓存或猜测。
- `node --test test/` 40 个用例全部通过。
- vendored 服务端的版本号仍标注 1.4.0（构建产物未整体升级），认证部分为 1.5.0
  实现的定向移植。

### Known limitation

- `apply()` does not keep the disposer returned by `ctx.tools.register()`, so on
  an HMR/patch reload the previous `unity_status` registration may not be torn
  down. Not a regression (identical behaviour in 1.1.0) and not an upgrade
  blocker; a restart loads cleanly.

## [1.1.0] - 2026-09-03

### Added

- Local diagnostic tool `unity_status`: TCP-probes the Unity bridge (host/port
  resolved from `UNITY_HOST`/`UNITY_PORT` env, default `localhost:8090`) before
  the agent calls any `mcp__unity__*` tool, so a closed Unity editor is detected
  in ~2 s instead of a 60 s tool-call timeout. Returns structured status with
  latency and an actionable hint; probe timeout configurable via `probeTimeoutMs`.
- Config schema (`Config` via `@deepseek-ai/schemastery`): `toolCallTimeoutMs`,
  `probeTimeoutMs`, and reconnect timing/attempts are validated at load time —
  invalid values (e.g. non-positive timeouts) fail loudly instead of silently
  unregistering tools.

### Fixed

- README documented the bridge port env var as `MCP_UNITY_PORT`; the vendored
  mcp-unity server actually reads `UNITY_PORT` (and `UNITY_HOST`). Docs and
  examples corrected (v1.0.0).

## [1.0.0] - 2026-08-28

### Added

- Bundled vendored [mcp-unity](https://github.com/CoderGamester/mcp-unity) 1.4.0 server (MIT)
  under `vendor/mcp-unity-server/`.
- Automatic registration of a `unity`-namespaced MCP client via
  `@deepseek-ai/dsh-mcp-client`, mounted through a `dsh.bundle` patch — install the
  plugin and the 34 Unity tools are ready, no manual profile editing.
- Auto-reconnect with exponential backoff (1s → 30s, up to 10 attempts) when the
  Unity editor (bridge) is restarted.
- Configurable Unity bridge port through `config.env.MCP_UNITY_PORT` (env passthrough
  to the vendored server, default 8090).
- Full Chinese documentation in `README.md`, covering install, the Unity-side UPM
  bridge package, config overrides, and troubleshooting.
- MIT license with upstream attribution for the vendored server.
