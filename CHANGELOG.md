# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

（暂无计划项）

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