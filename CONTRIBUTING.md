# Contributing

感谢你考虑为 `dsh-unity-mcp` 贡献 :tada: — Thanks for considering contributing to `dsh-unity-mcp`!

## 本地开发（Development）

插件结构：

```
dsh-unity-mcp/
├── lib/index.js            # DSH 插件入口，挂载 mcp-client → vendored 服务端
├── cordis.patch.yml        # dsh.bundle 补丁，自动注册入口
├── vendor/mcp-unity-server/  # 内置 mcp-unity 服务端（上游 MIT）
└── scripts/smoke.mjs       # 从 node_modules 实际安装副本做 stdio 握手测试
```

从本目录安装到本地 profile 做集成验证：

```bash
# node 需在 PATH 中；DSH_HOME 指向你的 harness 目录
dsh plugin --profile web remove dsh-unity-mcp
dsh plugin --profile web install "file:./"
```

## 升级内置服务端（Upgrading the vendored server）

1. 从上游 [CoderGamester/mcp-unity](https://github.com/CoderGamester/mcp-unity) 拉取最新构建到
   `vendor/mcp-unity-server/build/`，并同步 `vendor/mcp-unity-server/LICENSE.md`。
2. 如有新运行时依赖，同步更新 `package.json` 的 `dependencies`。
3. 在 CHANGELOG 记一笔，`npm run smoke:install` 验证工具清单。
4. bump 版本并打新 Release。

## 提交流程（Contributing flow）

1. 新建分支提交改动，遵循 [Conventional Commits](https://www.conventionalcommits.org/)。
2. 确保 `npm ci` 后的 CI 步骤全部通过（见 `.github/workflows/ci.yml`，本地可手动跑同样命令）。
3. 开 PR，给出动机与验证方式（本地安装测试 / 烟雾测试输出）。

## 行为准则（Code of Conduct）

简单一条：对事不对人。就事论事，尊重他人时间。