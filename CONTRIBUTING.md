# Contributing

感谢你考虑为 `dsh-unity-mcp` 贡献 :tada: — Thanks for considering contributing to `dsh-unity-mcp`!

## 本地开发（Development）

插件结构：

```
dsh-unity-mcp/
├── lib/index.js            # DSH 插件入口，挂载 mcp-client → vendored 服务端
├── lib/bridge-probe.js     # unity_status 的探测原语（项目定位 / 配置解析 / TCP / 真实握手）
├── cordis.patch.yml        # dsh.bundle 补丁，自动注册入口
├── vendor/mcp-unity-server/  # 内置 mcp-unity 服务端（上游 MIT + 认证移植，见下）
├── test/                   # node:test 回归测试（node --test test/）
└── scripts/smoke.mjs       # 从 node_modules 实际安装副本做 stdio 握手测试
```

从本目录安装到本地 profile 做集成验证：

```bash
# node 需在 PATH 中；DSH_HOME 指向你的 harness 目录
dsh plugin --profile web remove dsh-unity-mcp
dsh plugin --profile web install "file:./"
```

## 升级内置服务端（Upgrading the vendored server）

> ⚠️ **vendored 目录里有本仓库的补丁，整体覆盖会丢**：`unityConnection.js`
> 发送 `Authorization: Basic`、按候选项目逐个试探（`tryNextCandidate` / 候选列表）、
> `unityConnectionConfig.js` 解析 `bridge-token` 与 `MCP_UNITY_PROJECT_PATHS` 候选、
> `utils/errors.js` 的 `AUTHENTICATION`、`mcpUnity.js` 的 `startupError` 与候选透传，
> 是上游 1.5.0 认证实现 + 本仓库的「活跃项目识别」扩展（见 CHANGELOG v1.3.0 / v1.4.0）。
> 升级时要么选择已经包含这些实现的版本，要么把补丁重新应用一遍；CI 有一步专门校验
> 它们还在（`.github/workflows/ci.yml` → "vendored server still sends bridge
> authentication and walks candidates"）。
>
> 另外 `lib/bridge-probe.js` 里的项目发现（DSH 工作区登记表 / sessions 目录名 /
> 同级扫描）是**本仓库独有**的代码，不在 vendored 目录里，升级 vendored 不会影响它，
> 但也别把它当成上游行为。

1. 从上游 [CoderGamester/mcp-unity](https://github.com/CoderGamester/mcp-unity) 拉取最新构建到
   `vendor/mcp-unity-server/build/`，并同步 `vendor/mcp-unity-server/LICENSE.md`。
2. 如有新运行时依赖，同步更新 `package.json` 的 `dependencies`。
3. 确认补丁仍在（`node --test test/` + CI 的 vendored 步骤），
   或在真实 Unity 上跑 `node scripts/bridge-check.mjs` 确认能识别活跃项目并握手成功。
4. 在 CHANGELOG 记一笔，`npm run smoke:install` 验证工具清单。
5. bump 版本并打新 Release。

## 提交流程（Contributing flow）

1. 新建分支提交改动，遵循 [Conventional Commits](https://www.conventionalcommits.org/)。
2. 确保 `npm ci` 后的 CI 步骤全部通过（见 `.github/workflows/ci.yml`，本地可手动跑同样命令）。
3. 开 PR，给出动机与验证方式（本地安装测试 / 烟雾测试输出）。

## 行为准则（Code of Conduct）

简单一条：对事不对人。就事论事，尊重他人时间。