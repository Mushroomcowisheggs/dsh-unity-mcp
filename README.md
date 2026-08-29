# dsh-unity-mcp

[中文](#简介) | 简体中文文档

让 DeepSeek Harness（DSH / DeepSeek 桌面助手）里的 AI Agent **直接操控 Unity 编辑器**：一键安装本插件后，Agent 即可获得 30+ 个 Unity 工具，覆盖游戏开发全流程。

本插件是 [CoderGamester/mcp-unity](https://github.com/CoderGamester/mcp-unity)（MIT）在 DeepSeek Harness 上的封装：内置 mcp-unity **1.4.0** 服务端，安装即用，无需手动编辑 `cordis.patch.yml`。

## 功能特性

- **零配置接入**：安装插件即自动注册 MCP 服务端，无需手写任何配置
- **30+ Unity 工具**：场景管理、GameObject 增删改查、组件/材质操作、Prefab、菜单执行、测试运行、控制台日志读取等
- **自动重连**：Unity 编辑器重启后自动恢复连接（指数退避，最多 10 次）
- **中文文档**：本 README 即完整使用说明

工具命名空间为 `unity`，Agent 内调用形如 `mcp__unity__create_scene`、`mcp__unity__update_game_object` 等。

## 环境要求

| 组件 | 要求 |
|------|------|
| DeepSeek Harness | DSH Desktop 或 DSH CLI（核心包 0.1.1-rc.2 及以上） |
| Unity | 2022.3 及以上（推荐 Unity 6） |
| Node.js | 无需单独安装（使用 Harness 自带运行时） |

## 安装

### 第 1 步：安装 DSH 插件

```bash
dsh plugin --profile web add git+https://github.com/thyeff/dsh-unity-mcp.git
```

或在 DSH 网页的插件市场（若已收录）中搜索 `dsh-unity-mcp` 安装。

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

   > 查看当前 Unity 场景的层级结构

   Agent 调用 `mcp__unity__get_scenes_hierarchy` 并返回场景树即为接入成功。

## 可选配置

在 profile 的 `cordis.patch.yml` 中可覆写本插件行为（一般无需配置）。本插件以 `id: unity-mcp` 插入，patch 需按 id 匹配：

```yaml
- id: unity-mcp
  config:
    serverName: unity          # MCP 工具命名空间，默认 unity
    toolCallTimeoutMs: 60000   # 单次工具调用超时，默认 60 秒
    env:                       # 传给服务端进程的额外环境变量
      MCP_UNITY_PORT: '8090'   # 自定义 Unity 网桥端口（默认 8090）
    reconnect:                 # 重连策略（默认指数退避，1s 起、30s 封顶、10 次）
      enabled: true
      maxAttempts: 10
```

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
A：Unity 编辑器没有打开，或项目未安装网桥包。网桥跑在编辑器进程里——**调用任何 Unity 工具前必须先打开 Unity 编辑器并加载项目**。

**Q：8090 端口被占用？**
A：关闭占用进程，或在 Unity 网桥设置中更换端口后，通过上面 `cordis.patch.yml` 的 `env` 传 `MCP_UNITY_PORT` 对应端口（以 mcp-unity 上游文档为准）。

**Q：如何确认 Agent 真的连上了 Unity？**
A：让 Agent 调用 `mcp__unity__get_scenes_hierarchy`；若返回了真实的场景层级（Main Camera 等）即连通。

**Q：与手动配置 `@deepseek-ai/dsh-mcp-client` 有何区别？**
A：效果相同。区别在于本插件内置服务端与默认配置，免去手写 patch；**注意不要同时保留手动配置的同名 `serverName`（unity）条目，否则插件加载会报命名空间冲突**——二选一即可。

## 开发与测试（Development & testing）

仓库自带烟雾测试：对安装副本（或源码 vendor）发起真实 stdio 握手，列出注册的 Unity 工具，用于快速验证服务端可用性与工具完整性。

```bash
# 基于源码 vendor 测试（不依赖已安装副本）
node scripts/smoke.mjs vendor

# 基于 DSH 中的安装副本测试（先确认已安装本插件）
node scripts/smoke.mjs
```

仓库 CI（`.github/workflows/ci.yml`）会校验 package.json、bundle 补丁、入口语法与打包内容。源码结构、升级内置服务端的方法见 [CONTRIBUTING.md](./CONTRIBUTING.md)，变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

## 工具清单（部分）

| 类别 | 工具示例 |
|------|---------|
| 场景 | create_scene / load_scene / save_scene / get_scenes_hierarchy |
| GameObject | update_game_object / execute_menu_item / select_game_object |
| 资产 | add_asset_to_scene / create_prefab / update_component |
| 质量 | run_tests / get_console_logs / send_console_log |

完整 30+ 工具以运行时注册为准，可在会话中问 Agent：「列出所有 unity 工具」。

## 许可证

- 本封装：[MIT](./LICENSE)
- 内置的 mcp-unity 服务端：[MIT](./vendor/mcp-unity-server/LICENSE.md) © 2024-2025 CoderGamester
- Unity 侧网桥包由上游仓库分发，随你的 Unity 项目安装

## 致谢

- [CoderGamester/mcp-unity](https://github.com/CoderGamester/mcp-unity) — 本插件封装的核心
- [DeepSeek Harness](https://github.com/anywhere-labs/deepseek-harness-desktop) — 插件宿主
