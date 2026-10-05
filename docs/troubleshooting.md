# Unity 桥接排障手册（Troubleshooting: Unity bridge）

本页补充 README 的 FAQ，给出 mcp-unity 桥接侧（Unity 编辑器内）的具体排障步骤。
所有结论都可以用同一套判定验证：DSH 里调 `unity_status`，或在仓库里跑
`node scripts/bridge-check.mjs --project <Unity 项目根>`（打印 token 来源 + 真实握手结果）。

## 症状 0（最常见）：`unity_status` 说端口可达，但所有工具都失败

表现通常是两段式：

1. 首次调用报 `Error: Max reconnection attempts reached`
2. 之后每次调用稳定报 `Error: MCP error -32001: Request timed out`

**根因**：Unity 网桥（`com.gamelovers.mcp-unity` 1.5.0+）在 WebSocket 握手阶段要求
HTTP Basic 认证（用户名 `mcp-unity`，密码为项目 token）。网桥在 HTTP 层**先接受 TCP 连接、
再在握手阶段回 401 并断开**，所以「端口能连」与「能用」是两回事；旧客户端（≤ v1.2.0）
从不发送 `Authorization` 头，于是被反复拒绝、重连到上限，之后所有调用都表现为超时。

排查：

- [ ] 本插件已升级到 **v1.3.0+**（该版本发送 `Authorization` 并做真实握手）
- [ ] `unity_status` 返回 `handshake=connected`；若是 `unauthorized (HTTP 401)`：
  - [ ] Unity 里打开 **Tools > MCP Unity > Server Window**，确认 Authentication 为 `Ready`
  - [ ] 复制 token，或让插件自动读取：配置 `config.unityProjectPath`
        （或 `env.MCP_UNITY_AUTH_TOKEN_PATH: '<项目>/Library/McpUnity/bridge-token'`）
  - [ ] 刚点过「Regenerate Authentication Token」的话，**重启 MCP 客户端**（DSH 重启）后重试
- [ ] 修改配置后 DSH 需重启，服务端才会重新读取 token
- [ ] 工具调用若报 `authentication_error`，说明流程已正确，只差 token 配置——不要再靠重试

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

## 兜底

- 先跑 `node --test test/`（判定逻辑回归）+ `node scripts/bridge-check.mjs --project <项目根>`
  （真实网桥），再看 harness 日志（`$DSH_HOME` 的 logs 目录）
- 所有 Unity 侧问题，看编辑器 Console（运行/编辑均有红色报错会显示）
