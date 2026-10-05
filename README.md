# dsh-unity-mcp

> **让 DSH 里的 AI Agent 直接操控 Unity 编辑器** —— 安装即用，34 个工具覆盖游戏开发全流程。
> One-shot integration that gives DSH agents direct control over the Unity Editor.

简体中文文档 · [功能特性](#功能特性) · [安装](#安装) · [进阶玩法](#进阶与-dsh-mcp-lens-渐进披露搭配省-token) · [常见问题](#常见问题faq)

让 DeepSeek Harness（DSH）里的 AI Agent **直接操控 Unity 编辑器**：一键安装本插件后，Agent 即可获得 34 个 Unity 工具，覆盖游戏开发全流程。

本插件是 [CoderGamester/mcp-unity](https://github.com/CoderGamester/mcp-unity)（MIT）在 DeepSeek Harness 上的封装：内置 mcp-unity **1.4.0** 服务端（并**定向移植了 1.5.0 的网桥认证**，见[认证与活跃项目识别](#认证与活跃项目识别v14)），安装即用，无需手动编辑 `cordis.patch.yml`。

## 工作原理

```
DSH Agent ──MCP(stdio)──> dsh-unity-mcp ──> 内置 mcp-unity 服务端 ──TCP :8090──> Unity 网桥包（编辑器进程内）
```

DSH 侧安装本插件、Unity 侧在项目里安装网桥包（`com.gamelovers.mcp-unity`），中间链路全部自动建立，无需手动配置。

## 三步上手（TL;DR）

1. `dsh plugin --profile web add git+https://github.com/Mushroomcowisheggs/dsh-unity-mcp.git`
2. Unity 项目的 `Packages/manifest.json` 加入网桥包（详见[安装](#安装)）
3. 打开 Unity 编辑器，对 Agent 说：「查看当前场景层级」

## 功能特性

- **零配置接入**：安装插件即自动注册 MCP 服务端，无需手写任何配置
- **34 个 Unity 工具**：场景管理、GameObject 增删改查、组件/材质操作、Prefab、菜单执行、测试运行、控制台日志读取等
- **认证握手（v1.3）**：Unity 1.5+ 网桥要求 HTTP Basic 认证（项目 token）；客户端带上 `Authorization` 头，认证失败立即报明确原因而不是无限重连
- **活跃项目识别（v1.4）**：不依赖工作目录——汇集 DSH 工作区登记表/会话目录/寻根/同级扫描得到的候选项目，逐个用其 token 真实握手，**第一个被接受的就是当前打开的项目**；换项目无需改配置
- **网桥诊断（v1.1，v1.3 升级为真握手）**：本地工具 `unity_status` 先探后调——TCP 探测 + **真实 WebSocket 认证握手**，并回报识别出的项目；Unity 未启动、端口被占用、认证被拒都能秒级分辨，不再干等 60 秒超时
- **配置校验（v1.1）**：超时等数值配置带 schema 校验，非法值在加载期直接报错，不会悄悄注销工具
- **自动重连**：Unity 编辑器重启后自动恢复连接（指数退避，最多 10 次）；认证失败属终态错误，不会重连刷屏
- **兼容 DSH 0.2（v1.2）**：放宽 DSH 核心包的 peer 版本范围，0.1.x 与 0.2.0-rc.2 均免豁免直接加载
- **中文文档**：本 README 即完整使用说明

工具命名空间为 `unity`，Agent 内调用形如 `mcp__unity__create_scene`、`mcp__unity__update_gameobject` 等；另有本地诊断工具 `unity_status`（不带 mcp__ 前缀）。

## 环境要求

| 组件 | 要求 |
|------|------|
| DeepSeek Harness | DSH Desktop 或 DSH CLI（核心包 `>=0.1.1-rc.2 <=0.2.0-rc.2`，即 0.1.1-rc.2 起至当前最新版 0.2.0-rc.2） |
| Unity | 2022.3 及以上（推荐 Unity 6） |
| Node.js | 无需单独安装（使用 Harness 自带运行时） |

## 安装

### 第 1 步：安装 DSH 插件

```bash
dsh plugin --profile web add git+https://github.com/Mushroomcowisheggs/dsh-unity-mcp.git
```

或在 DSH 网页的插件市场（若已收录）中搜索 `dsh-unity-mcp` 安装。

> **一份构建同时兼容旧版与当前版**：v1.1.0 的 peer 写成 `^0.1.1-rc.2`，而 semver 的 caret 在 0.x 上只解析为 `>=0.1.1-rc.2 <0.2.0-0`，
> 永远进不了 `0.2.0-rc.2`，因此 DSH 会以 `incompatible-version` 拒绝加载（提示可用 `dsh plugin allow-version` 授予豁免）。
> v1.2.0 改为 `>=0.1.1-rc.2 <=0.2.0-rc.2`：**从 0.1.1-rc.2 一直到当前最新版 0.2.0-rc.2 都能加载，无需任何版本豁免**。
> 上界用包含式 `<=0.2.0-rc.2` 而不是开放的 `<0.3.0-0` —— 后者会把已发布的 `0.2.1-alpha.1` 一并放行，等于替还没验证的新版背书。

### 第 2 步：在 Unity 项目中安装网桥包

打开你的 Unity 项目根目录下的 `Packages/manifest.json`，在 `dependencies` 中加入：

```json
{
  "dependencies": {
    "com.gamelovers.mcp-unity": "https://github.com/CoderGamester/mcp-unity.git"
  }
}
```

保存后回到 Unity 编辑器，等待包解析完成（也可以通过 Package Manager → Add package from git URL 粘贴同样的地址）。

### 第 3 步：验证

1. 确保 Unity 编辑器已打开且加载了项目（网桥运行在编辑器进程内，监听 **8090** 端口）
2. 在 DSH 中新建会话，对 Agent 说：

   > 先检查 Unity 网桥状态，再看当前场景层级

   Agent 先调 `unity_status`：`handshake=connected`（TCP 可达 + 认证握手成功）才代表工具就绪；
   再调 `mcp__unity__get_scenes_hierarchy` 返回场景树。

> **Unity 1.5+ 需要 bridge token，且一般不需要你配置**：网桥从 1.5.0 起要求 HTTP Basic
> 认证（用户名 `mcp-unity`，密码是项目 token `<项目>/Library/McpUnity/bridge-token`）。
> 插件会汇集多个来源的候选 Unity 项目，逐个用其 token 做真实握手，**第一个被接受的就是
> 当前打开的项目**——换项目无需改任何配置。详见
> [认证与活跃项目识别](#认证与活跃项目识别v14)。

## 认证与活跃项目识别（v1.4）

Unity 侧网桥（`com.gamelovers.mcp-unity` **1.5.0 及以上**）在 WebSocket 握手阶段校验 HTTP
Basic 认证：用户名固定 `mcp-unity`，密码是每个项目独有的 64 位十六进制 token，存放在
`<Unity 项目根>/Library/McpUnity/bridge-token`（`Library/` 通常不进版本控制，因此每个项目
各自一份）。缺 token 时网桥回 `401 Unauthorized` 并断开。

难点不在「发认证头」，而在**知道当前开的是哪个项目**：DSH 是常驻服务 + 全局 profile，
服务端进程的工作目录不在任何 Unity 项目内，单靠 `cwd` 向上找项目必然失败。而同一个端口上
同时只有一个网桥在监听——所以活跃项目可以被**识别**，不必被**配置**：

1. **汇集候选项目**（按优先级）：`unityProjectPath` / `unityProjectSearchPaths` →
   DSH 工作区登记表 `$DSH_HOME/storages/workspace.json`（记录所有工作区绝对路径，按最近
   使用排序）→ `$DSH_HOME/sessions/<编码路径>` 目录名 → 工作目录向上寻根 → 已发现项目的
   同级目录与搜索目录（有深度/数量上限，不会拖慢插件加载）。
2. **逐个试探**：每个候选用自己的 `ProjectSettings/McpUnitySettings.json`（端口）与
   `Library/McpUnity/bridge-token`（凭据）握手；第一个被接受的即活跃项目，并固定下来
   （Unity 换项目、旧 token 被拒时会自动重新识别）。
3. **显式配置优先**：`MCP_UNITY_AUTH_TOKEN` / `MCP_UNITY_AUTH_TOKEN_PATH` 永远排在最前，
   适合 CI 或临时排查。

因此**通常什么都不用配**：只要该项目在本机用 DSH 打开过（进入过工作区登记表），或工作目录
本身/其同级目录里有 Unity 项目，就能自动识别。多项目机器同样无需按项目切换配置。

只有在项目既不在登记表里、也不在常见位置时才需要显式指定：

```yaml
# profile 的 cordis.patch.yml
- id: unity-mcp
  config:
    unityProjectPath: 'G:/Custom Projects/GamesProjects/UnityProjects/Tea'  # 高优先级提示（可选）
    # unityProjectSearchPaths: ['G:/Custom Projects/GamesProjects']         # 额外搜索目录（可选）
    # env:
    #   MCP_UNITY_AUTH_TOKEN_PATH: 'G:/.../Tea/Library/McpUnity/bridge-token'  # 或者直接给 token
```

Unity 侧的对应信息在编辑器菜单 **Tools > MCP Unity > Server Window**：能看到 token 文件
路径、复制 token、重新生成 token（重新生成后必须重启 MCP 客户端）。

在 DSH 之外快速自检（打印候选项目、逐个握手结果、识别出的活跃项目）：

```bash
node scripts/bridge-check.mjs
node scripts/bridge-check.mjs --project <Unity 项目根>
```

## 可选配置

在 profile 的 `cordis.patch.yml` 中可覆写本插件行为（一般无需配置）。本插件以 `id: unity-mcp` 插入，patch 需按 id 匹配：

```yaml
- id: unity-mcp
  config:
    serverName: unity              # MCP 工具命名空间，默认 unity
    unityProjectPath: ''           # 可选：把某个 Unity 项目提到最高优先级
    unityProjectSearchPaths: []    # 可选：额外搜索目录（每个目录向下扫若干层找 Unity 项目）
    toolCallTimeoutMs: 60000       # 单次工具调用超时，默认 60 秒（必须 > 0）
    probeTimeoutMs: 2000           # unity_status 探测/握手的超时，默认 2 秒（必须 ≥ 100）
    env:                           # 传给服务端进程的额外环境变量
      UNITY_PORT: '8090'           # 自定义 Unity 网桥端口（默认 8090，unity_status 同步探测此端口）
      UNITY_HOST: 'localhost'      # 自定义网桥地址（默认 localhost）
      # 认证/项目来源（一般无需手写，插件会自动注入 MCP_UNITY_PROJECT_PATHS）：
      # MCP_UNITY_AUTH_TOKEN: '<64 位十六进制 token>'          # 显式 token（优先级最高）
      # MCP_UNITY_AUTH_TOKEN_PATH: '<项目>/Library/McpUnity/bridge-token'
      # MCP_UNITY_PROJECT_PATHS: '<项目A>;<项目B>'              # 候选项目列表（服务端逐个试探）
      # MCP_UNITY_SETTINGS_PATH: '<项目>/ProjectSettings/McpUnitySettings.json'
    reconnect:                     # 重连策略（默认指数退避，1s 起、30s 封顶、10 次）
      enabled: true
      maxAttempts: 10
```

非法值（如 `toolCallTimeoutMs: 0`）会在插件加载期被 schema 直接拒绝并报错，而不是让工具静默失效。

> patch 是 profile 的 `cordis.patch.yml` 顶层列表（不要包在 `patches:` 里）；示例中的 `serverName` 等均可省略，省略即用默认值。

## 进阶：与 dsh-mcp-lens 渐进披露搭配（省 token）

默认安装后，34 个 Unity 工具会以 `mcp__unity__*` 常驻在每个请求的工具清单里——方便，但对 token 敏感的长对话是一笔持续的「常驻税」。

如果在意成本，可以用渐进披露 MCP 网关 **dsh-mcp-lens**（`mcp_search` / `mcp_call` 两个工具）接管 unity 服务端：模型面从 34 个工具收敛到 2 个，**用到才披露精确 schema**（约省 95% 的相关 schema 字节）。此时**不再安装本插件作为 bundle**（避免与 mcp-lens 双重注册同名工具），仅把本仓库的 vendored 服务端作为依赖保留：

```yaml
# profile 的 cordis.patch.yml
- id: mcp-lens
  config:
    servers:
      - name: unity
        transport: stdio
        command: <DSH 自带 node 的可执行路径，如 D:\...\resources\app\node_modules\node\bin\node.exe>
        args:
          - <本插件 vendored 服务端路径：.../node_modules/dsh-unity-mcp/vendor/mcp-unity-server/build/index.js>
        env:
          ELECTRON_RUN_AS_NODE: '1'
    cachePath: !!js dshHomePath('mcp-lens/catalog.json')
    allowTools:
      - 'unity/*'
```

两种方式二选一：
- **直连（本插件默认）**：零配置、工具即用，适合不在乎 token 或 Unity 工具用得频繁的场景
- **渐进披露（mcp-lens）**：常驻 2 工具，适合长对话/多 MCP server、Unity 工具低频使用的场景

## 常见问题（FAQ）

**Q：工具调用报错「连接失败 / ECONNREFUSED」？**
A：Unity 编辑器没有打开，或项目未安装网桥包。网桥跑在编辑器进程里——**调用任何 Unity 工具前必须先打开 Unity 编辑器并加载项目**。让 Agent 先调 `unity_status` 探测，网桥不可达时它会直接告诉你原因，不必靠超时试错。

**Q：`unity_status` 说端口可达，但所有工具都失败 / 报 `Max reconnection attempts reached`，随后是 `MCP error -32001: Request timed out`？**
A：这是 **Unity 1.5+ 网桥的认证问题**（v1.3.0 已修）：端口在监听 ≠ 握手能通过。网桥会先接受 TCP 连接，再在 WebSocket 握手阶段校验项目 token，缺 token 就回 `401` 并断开；旧版客户端（≤ v1.2.0）从不发送 `Authorization` 头，于是每次握手都被拒、重连到上限，之后所有调用都表现为超时。升级到 **v1.3.0+** 即可，届时：

- `unity_status` 会做真实握手，直接报 `handshake=unauthorized (HTTP 401)` 而不是「就绪」；
- 插件会自动读取 Unity 项目的 token（见[认证与活跃项目识别](#认证与活跃项目识别v14)）；
- 配置好之前，工具调用会立刻返回 `authentication_error`（含修复指引），不会再让你等超时。

**Q：升级到 v1.3.0 后不再超时了，但报 `HTTP 401`，`unity_status` 显示 `authTokenSource: none`？**
A：这是**第二个独立缺陷**（v1.4.0 已修）：认证代码已经会发 `Authorization`，但**取不到 token**——旧逻辑只会从 `process.cwd()` 向上找 Unity 项目，而 DSH 是常驻服务，进程工作目录不在任何 Unity 项目里，找不到就静默降级成「无 token」。v1.4.0 起改为**多来源候选 + token 握手识别活跃项目**（DSH 工作区登记表、会话目录、寻根、同级扫描），**无需按项目配置**，换项目也不用改配置。升级后 `unity_status` 会给出 `authTokenSource: Unity project (<路径>)` 与 `unityProjectPath`。

**Q：`authentication_error`：Unity rejected the bridge authentication (HTTP 401)？**
A：新版（v1.4.0+）先确认「项目是否在候选里」：`unity_status` 的 `candidatesProbed` 与 `unityProjectPath` 会告诉你试过几个候选、识别出了哪个。若候选为空或都没被接受：

- 在 Unity 里打开 **Tools > MCP Unity > Server Window**，确认 Authentication 为 `Ready`；
- 若刚点过「Regenerate Authentication Token」，请**重启 MCP 客户端**（DSH 重启）让新 token 生效；
- 项目不在候选里时，用 `unityProjectPath`（或 `env.MCP_UNITY_AUTH_TOKEN_PATH`）显式指定，
  或先用 `node scripts/bridge-check.mjs` 查看发现结果。

**Q：8090 端口被占用？**
A：关闭占用进程，或在 Unity 网桥设置中更换端口后，通过上面 `cordis.patch.yml` 的 `env` 传 `UNITY_PORT` 对应端口（`unity_status` 会同步探测该端口；服务端亦会读 Unity 项目的 `ProjectSettings/McpUnitySettings.json`，以 mcp-unity 上游文档为准）。

**Q：如何确认 Agent 真的连上了 Unity？**
A：让 Agent 调用 `mcp__unity__get_scenes_hierarchy`；若返回了真实的场景层级（Main Camera 等）即连通。

**Q：与手动配置 `@deepseek-ai/dsh-mcp-client` 有何区别？**
A：效果相同。区别在于本插件内置服务端与默认配置，免去手写 patch；**注意不要同时保留手动配置的同名 `serverName`（unity）条目，否则插件加载会报命名空间冲突**——二选一即可。

**Q：加载时报 `skipping profile bundle "dsh-unity-mcp"` 或 `incompatible-version`？**
A：这是 peer 声明的版本与运行时不匹配，**不是代码坏了**。v1.1.0 及更早写作 `^0.1.1-rc.2`，在 0.2.x 运行时上会被拒绝；请升级到 v1.2.0 及以上（支持范围 `>=0.1.1-rc.2 <=0.2.0-rc.2`）。若你的 DSH 比 0.2.0-rc.2 更新，插件会主动拒绝加载 —— 这时请提 issue，而不是硬开豁免。若暂时无法升级，可对**确切版本对**授予豁免（会破坏应用或损坏数据，不推荐）：

```bash
dsh plugin --profile web allow-version dsh-unity-mcp@1.1.0 --dsh-version 0.2.0-rc.2 --accept-risk
```

## 开发与测试（Development & testing）

```bash
# 单元/回归测试（node:test；36 个用例）
node --test test/

# 在 DSH 之外检查真实网桥：候选发现 + 逐个握手 + 识别活跃项目（本机已开 Unity 时最直观）
node scripts/bridge-check.mjs
node scripts/bridge-check.mjs --project <Unity 项目根>

# 烟雾测试：对安装副本（或源码 vendor）发起真实 stdio 握手，列出注册的 Unity 工具
node scripts/smoke.mjs vendor   # 基于源码 vendor
node scripts/smoke.mjs          # 基于 DSH 中的安装副本（先确认已安装本插件）
```

`test/` 覆盖四类回归：

- vendored 配置解析：token 优先级（`MCP_UNITY_AUTH_TOKEN` → `..._PATH` → 项目）、
  显式配置写错时的失败语义、`MCP_UNITY_PROJECT_PATHS` 候选构造与去重；
- 握手探测：必须发 `Authorization`、必须不发 `Origin`、401 不得判为就绪；
- 项目发现：DSH 工作区登记表、`sessions/<编码路径>` 还原（含带连字符的真实路径）、
  同级目录兜底、候选 env 注入、token 试探识别活跃项目；
- 服务端连接层：第一个候选失败后换下一个候选、全部被拒 → 终态认证错误且不重连、
  Unity 换项目后自动重新识别（后三个用例需要 `ws`，CI 会先把 `ws` 装进工作区）。

仓库 CI（`.github/workflows/ci.yml`）会跑测试并校验 package.json、bundle 补丁、入口语法、
「认证头 + 候选发现」是否仍然存在与打包内容。源码结构、升级内置服务端的方法见
[CONTRIBUTING.md](./CONTRIBUTING.md)，变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

## 工具清单（部分）

| 类别 | 工具示例 |
|------|---------|
| 场景 | create_scene / load_scene / save_scene / get_scenes_hierarchy |
| GameObject | update_gameobject / select_gameobject / move_gameobject |
| 资产 | add_asset_to_scene / create_prefab / update_component |
| 质量 | run_tests / get_console_logs / send_console_log |

完整 34 个工具以运行时注册为准，可在会话中问 Agent：「列出所有 unity 工具」。

## 许可证

- 本封装：[MIT](./LICENSE)
- 内置的 mcp-unity 服务端：[MIT](./vendor/mcp-unity-server/LICENSE.md) © 2024-2025 CoderGamester
- Unity 侧网桥包由上游仓库分发，随你的 Unity 项目安装

## 致谢

- [CoderGamester/mcp-unity](https://github.com/CoderGamester/mcp-unity) — 本插件封装的核心
- [DeepSeek Harness](https://github.com/anywhere-labs/deepseek-harness-desktop) — 插件宿主
- [thyeff/dsh-unity-mcp](https://github.com/thyeff/dsh-unity-mcp) — 上游仓库；本仓库为其 fork，新增 DSH 0.2.x 兼容（v1.2.0）
