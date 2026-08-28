# Security

## 报告漏洞（Reporting a vulnerability）

请**不要**在公开的 Issues 中报告安全漏洞。请直接发送邮件到维护者邮箱（见 GitHub 资料主页），或使用 GitHub 的 Private vulnerability reporting 功能（仓库 → Settings → Security）。

请包含：

- 复现步骤与影响范围
- 受影响版本
- 你建议的修复方向（如有）

我们会在 7 天内确认并尽快修复，修复后在 CHANGELOG 与 Release notes 中致谢（如需匿名请注明）。

## 已知安全提示

- 本插件通过 stdio 在本地拉起 mcp-unity 服务端，仅监听 Unity 编辑器内的本地桥接端口（默认 8090）。请勿将桥接端口暴露到公网。
- 插件配置（如自定义 `env`）会以明文进入 DSH 配置，请勿在其中放置密钥或长期凭证。
- 内置服务端来自上游 MIT 项目，出现上游安全通告时请及时升级 `vendor/mcp-unity-server/build`。