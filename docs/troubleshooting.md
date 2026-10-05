# Unity 桥接排障手册（Troubleshooting: Unity bridge）

本页补充 README 的 FAQ，给出 mcp-unity 桥接侧（Unity 编辑器内）的具体排障步骤。
所有结论都可以用同一套判定验证：DSH 里调 `unity_status`，或在仓库里跑
`node scripts/bridge-check.mjs`（列出候选项目 + 每个候选的握手结果 + 识别出的活跃项目）。

## 症状 0（最常见）：`unity_status` 说端口可达，但所有工具都失败

表现有两代：

1. v1.2.0 及更早：首次 `Error: Max reconnection attempts reached`，之后全是
   `Error: MCP error -32001: Request timed out`。
2. v1.3.0：不再超时，但**立即**报 `HTTP 401`，且 `unity_status` 显示
   `authTokenSource: none`。

**根因**（两个独立缺陷，v1.3.0 / v1.4.0 分别修掉）：

- **认证缺陷**：Unity 网桥（`com.gamelovers.mcp-unity` 1.5.0+）在 WebSocket 握手阶段要求
  HTTP Basic 认证（用户名 `mcp-unity`，密码为项目 token）。网桥在 HTTP 层**先接受 TCP
  连接、再在握手阶段回 401 并断开**，所以「端口能连」与「能用」是两回事；旧客户端从不
  发送 `Authorization` 头，于是被反复拒绝、重连到上限，之后所有调用都表现为超时。
- **发现缺陷**：DSH 是常驻服务 + 全局 profile，服务端进程的工作目录不在任何 Unity 项目内；
  旧逻辑只从 `cwd` 向上找项目，找不到就静默降级为「无 token」，于是握手仍被 401 拒绝。
  token 是**每项目一份**的，所以「配死一个项目路径」在多项目机器上必然失效。

排查：

- [ ] 本插件已升级到 **v1.4.0+**（发送 `Authorization` + 多来源候选 + token 握手识别活跃项目）
- [ ] `unity_status` 返回 `handshake=connected`，且给出 `unityProjectPath`（识别出的项目）
- [ ] 若是 `unauthorized (HTTP 401)`：
  - [ ] 看输出的候选来源与 `candidatesProbed`——候选为空说明项目不在任何已知位置
  - [ ] Unity 里打开 **Tools > MCP Unity > Server Window**，确认 Authentication 为 `Ready`
  - [ ] 刚点过「Regenerate Authentication Token」→ **重启 MCP 客户端**（DSH 重启）
  - [ ] 项目确实不在候选里 → 配 `config.unityProjectPath`（或
        `env.MCP_UNITY_AUTH_TOKEN_PATH: '<项目>/Library/McpUnity/bridge-token'`）
- [ ] 修改配置后 DSH 需重启，服务端才会重新读取 token
- [ ] 工具调用若报 `authentication_error`，说明流程已正确，只差凭据/发现——不要再靠重试

## 症状 1：`get_scenes_hierarchy` 返回空 / 工具总是「连接失败」

- [ ] 确认 Unity 编辑器**已打开且加载了项目**（网桥跑在编辑器进程内，关着 ⇒ 必然失败）
- [ ] 确认项目已装入网桥包：`Packages/manifest.json` 含 `com.gamelovers.mcp-unity`
- [ ] 确认网桥已启动监听：编辑器内菜单 **Tools > MCP Unity > Server Window**（或自动启动）
- [ ] 确认端口是 8090（默认）；被占用时换端口，并同步改插件 `config.env.UNITY_PORT`
      （`unity_status` 会探测该端口）
- [ ] `unity_status` 报 `handshake=unexpected (HTTP 501/… )`？该端口被别的程序占用了，
      或 `/McpUnity` 端点没起来——换端口或重启网桥

## 症状 2：工具列表里根本没有 unity 工具

- [ ] DSH 已安装本插件（`dsh plugin list --profile web` 可见）
- [ ] 未与手动配置的 `serverName: unity` 冲突（二选一，不要并存）
- [ ] harness 启动后等 10~20s（服务端自动拉起 + 握手）
- [ ] 若仍无：从 profile 根目录跑 `node <repo>/scripts/smoke.mjs`，看服务端本身能不能 handshake

## 症状 3：某工具能连通但报参数错误

- [ ] 先调用 `get_scene_info` 或 `get_console_logs`，用真实字段再回填参数（工具 schema 很严格）
- [ ] 有怀疑时用 `batch_execute` 组合多条只读命令一次诊断

## 症状 4：插件加载时报命名空间冲突

- [ ] 移除 profile `cordis.patch.yml` 中手写的 mcp-unity/`serverName: unity` 条目，交由插件接管
- [ ] 重启 harness

## 症状 5：识别到的项目不是当前开着的那个

- [ ] `unity_status` 的 `unityProjectPath` 不对时：当前项目可能不在候选里（例如 Unity 用
      `-projectPath` 打开、且该项目从未在 DSH 里作为工作区出现过）
- [ ] 用 `config.unityProjectPath` 明确指向当前项目（它会排在候选最前）
- [ ] `node scripts/bridge-check.mjs` 会列出候选顺序与每个候选的握手结果，便于定位

## 兜底

- 先跑 `node --test test/`（判定逻辑回归，36 用例）+ `node scripts/bridge-check.mjs`
  （真实网桥），再看 harness 日志（`$DSH_HOME` 的 logs 目录）
- 所有 Unity 侧问题，看编辑器 Console（运行/编辑均有红色报错会显示）
