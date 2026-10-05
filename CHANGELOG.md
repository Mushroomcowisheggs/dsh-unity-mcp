# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

（暂无计划项）

## [1.2.0] - 2026-10-05

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
- No source changes were required: `lib/index.js` was verified against DSH
  0.2.0-rc.2 unchanged (see below).

### Verified

- `defineTool` (`parameters: {}`, `output.schema` / `output.render`, `timeoutMs`,
  `isConcurrencySafe`, `execute(args, exec)`), `ctx.tools.register`, the
  `Config` schemastery schema, and the full `@deepseek-ai/dsh-mcp-client` config
  surface (`transport`/`serverName`/`command`/`args`/`env`/`cwd`/
  `toolCallTimeoutMs`/`failOnStartupError`/`reconnect`) all load and validate
  unchanged on DSH 0.2.0-rc.2.
- Range behaviour checked against DSH's own `semver` with the same options DSH
  uses (`semver.satisfies(rt, range, { includePrerelease: true })`), swept over
  **all 31 versions published on npm**: `0.1.1-rc.2` through `0.2.0-rc.2` pass
  (20 versions), and **nothing above `0.2.0-rc.2` passes** — in particular
  `0.2.1-alpha.1` is rejected.
- The per-property `required: true` form used in `unity_status`'s
  `output.schema` is still the correct author-DSL dialect on 0.2.0 and compiles
  to the raw `required: ["host", "port", "bridgeReachable", "toolNamespace"]`.
  Do **not** rewrite it to an object-level `required: [...]` array — the author
  DSL rejects that with `JsonSchemaError`.

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