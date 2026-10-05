// 回归测试：插件入口 apply() 的工具契约与 unity_status 行为。
//
// lib/index.js 依赖 DSH 运行时（@deepseek-ai/dsh-tools 等），这里用 test/stubs 里的
// 加载器钩子把它们换成最小替身，从而在无 DSH、无 Unity 的情况下验证：
// - 插件名/注入声明不变；
// - 候选项目（显式配置 / DSH 工作区登记表）会作为 MCP_UNITY_PROJECT_PATHS 注入子进程 env；
// - unity_status 用真实握手在多个候选项目里识别活跃项目，401 不再被当成「就绪」；
// - 工具返回值始终是 lossless JSON（DSH 的硬性要求）。
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { register } from "node:module";
import { startBridgeStub } from "./stubs/bridge-server.mjs";

register("./stubs/loader-hook.mjs", import.meta.url);
const { apply, name, inject } = await import("../lib/index.js");

const TOKEN = "0123456789abcdef".repeat(4);
const OTHER_TOKEN = "fedcba9876543210".repeat(4);

/**
 * apply() 读的是宿主进程的 process.env（DSH_HOME 决定工作区登记表位置，
 * MCP_UNITY_* 决定显式凭据），测试必须与之隔离，否则会读到开发机的真实环境。
 */
async function withIsolatedHostEnvironment(overrides, run) {
  const keys = [
    "DSH_HOME",
    "MCP_UNITY_PROJECT_PATHS",
    "MCP_UNITY_SETTINGS_PATH",
    "MCP_UNITY_AUTH_TOKEN_PATH",
    "MCP_UNITY_AUTH_TOKEN",
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  const next = { DSH_HOME: path.join(os.tmpdir(), "dsh-unity-plugin-no-home"), ...overrides };
  for (const key of keys) {
    if (next[key] === undefined) delete process.env[key];
    else process.env[key] = next[key];
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** 每个用例一个独立的项目父目录，避免同级目录扫描捡到别的临时目录。 */
async function makeProjectsParent() {
  return mkdtemp(path.join(os.tmpdir(), "dsh-unity-projects-"));
}

/** 造一个最小 Unity 项目：settings 的 Port 指向传入端口（一般是本地假网桥）。 */
async function makeProject(parent, name, { port, token = TOKEN } = {}) {
  const root = path.join(parent, name);
  await mkdir(path.join(root, "ProjectSettings"), { recursive: true });
  await mkdir(path.join(root, "Library", "McpUnity"), { recursive: true });
  await writeFile(path.join(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: x\n");
  await writeFile(
    path.join(root, "ProjectSettings", "McpUnitySettings.json"),
    JSON.stringify({ Port: port, Host: "127.0.0.1" })
  );
  await writeFile(path.join(root, "Library", "McpUnity", "bridge-token"), token);
  return root;
}

/** 假 DSH 主目录：把工作区登记成候选项目来源（updatedAt 决定优先级）。 */
async function makeDshHome(workspaces) {
  const home = await mkdtemp(path.join(os.tmpdir(), "dsh-home-"));
  await mkdir(path.join(home, "storages"), { recursive: true });
  const table = {};
  workspaces.forEach((workspace, index) => {
    table[`id-${index}`] = {
      path: workspace.path,
      title: path.basename(workspace.path),
      updatedAt: workspace.updatedAt ?? `2026-10-0${index + 1}T00:00:00.000Z`,
    };
  });
  await writeFile(
    path.join(home, "storages", "workspace.json"),
    JSON.stringify({ tables: { workspaces: table } })
  );
  return home;
}

/** 调用 apply() 并返回捕获到的子插件配置与工具定义。 */
function loadPlugin(config) {
  const tools = [];
  const plugins = [];
  const ctx = {
    plugin: (plugin, pluginConfig) => plugins.push({ plugin, pluginConfig }),
    tools: { register: (tool) => tools.push(tool) },
  };
  apply(ctx, config);
  return { tools, plugins };
}

function assertLosslessJson(value) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, "tool result must be lossless JSON");
}

test("plugin metadata is unchanged", () => {
  assert.equal(name, "unity-mcp");
  assert.deepEqual(inject, ["tools"]);
});

test("candidate Unity projects are injected into the server environment", async () => {
  const bridge = await startBridgeStub({ acceptedTokens: [TOKEN] });
  const parent = await makeProjectsParent();
  const root = await makeProject(parent, "Tea", { port: bridge.port });
  try {
    const { plugins, tools } = await withIsolatedHostEnvironment({}, () =>
      loadPlugin({ env: {}, unityProjectPath: root })
    );
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].pluginConfig.serverName, "unity");
    // 显式配置的项目排在候选列表最前
    assert.equal(plugins[0].pluginConfig.env.MCP_UNITY_PROJECT_PATHS.split(path.delimiter)[0], root);
    assert.equal(
      plugins[0].pluginConfig.env.MCP_UNITY_SETTINGS_PATH,
      path.join(root, "ProjectSettings", "McpUnitySettings.json")
    );
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "unity_status");
  } finally {
    await bridge.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("explicit env wins over the derived Unity project paths", async () => {
  const { plugins } = await withIsolatedHostEnvironment({}, () =>
    loadPlugin({
      env: { MCP_UNITY_PROJECT_PATHS: "C:/only/this" },
      unityProjectPath: process.cwd(),
    })
  );
  assert.equal(plugins[0].pluginConfig.env.MCP_UNITY_PROJECT_PATHS, "C:/only/this");
});

test("unity_status identifies the live project through the DSH workspace registry", async () => {
  // 关键场景：进程 cwd 不在任何 Unity 项目内（工作区是普通目录），
  // 活跃项目只能靠「候选项目 + token 握手」识别出来。
  const bridge = await startBridgeStub({ acceptedTokens: [TOKEN] });
  const parent = await makeProjectsParent();
  const stale = await makeProject(parent, "Hololaser", { port: bridge.port, token: OTHER_TOKEN });
  const live = await makeProject(parent, "Tea", { port: bridge.port, token: TOKEN });
  const workspace = await makeProjectsParent();
  const dshHome = await makeDshHome([
    { path: workspace, updatedAt: "2026-10-05T12:00:00.000Z" },
    { path: stale, updatedAt: "2026-10-05T11:00:00.000Z" },
    { path: live, updatedAt: "2026-10-04T00:00:00.000Z" },
  ]);
  try {
    const { tools } = await withIsolatedHostEnvironment({ DSH_HOME: dshHome }, () =>
      loadPlugin({ env: {}, unityProjectPath: "" })
    );
    const value = await tools[0].execute({}, {});
    assertLosslessJson(value);
    assert.equal(value.bridgeReachable, true);
    assert.equal(value.handshake, "connected");
    assert.equal(value.authenticated, true);
    assert.equal(value.httpStatus, 101);
    assert.equal(value.unityProjectPath, live);
    assert.equal(value.authTokenSource, `Unity project (${live})`);
    // stale 项目按最近使用排在前面会被先试（并被拒），随后才识别出 live
    assert.equal(value.candidatesProbed, 2);

    const rendered = tools[0].output.render({}, value)[0].text;
    assert.match(rendered, /就绪/);
    assert.match(rendered, new RegExp(live.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
  } finally {
    await bridge.close();
    await rm(parent, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    await rm(dshHome, { recursive: true, force: true });
  }
});

test("unity_status reports unauthorized instead of falsely ready on HTTP 401", async () => {
  const bridge = await startBridgeStub({ acceptedTokens: [OTHER_TOKEN] });
  const parent = await makeProjectsParent();
  const root = await makeProject(parent, "Tea", { port: bridge.port });
  try {
    const { tools } = await withIsolatedHostEnvironment({}, () =>
      loadPlugin({ env: {}, unityProjectPath: root })
    );
    const value = await tools[0].execute({}, {});
    assertLosslessJson(value);
    assert.equal(value.bridgeReachable, true);
    assert.equal(value.handshake, "unauthorized");
    assert.equal(value.authenticated, false);
    assert.equal(value.httpStatus, 401);

    const rendered = tools[0].output.render({}, value)[0].text;
    assert.doesNotMatch(rendered, /工具就绪/);
    assert.match(rendered, /认证被拒绝/);
    assert.match(rendered, /MCP_UNITY_AUTH_TOKEN/);
  } finally {
    await bridge.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("unity_status stays lossless JSON when the bridge port is closed", async () => {
  const bridge = await startBridgeStub({});
  const port = bridge.port;
  await bridge.close();
  const parent = await makeProjectsParent();
  const root = await makeProject(parent, "Tea", { port });
  try {
    const { tools } = await withIsolatedHostEnvironment({}, () =>
      loadPlugin({ env: {}, unityProjectPath: root })
    );
    const value = await tools[0].execute({}, {});
    assertLosslessJson(value);
    assert.equal(value.bridgeReachable, false);
    assert.equal(value.handshake, "unreachable");
    assert.equal(value.authenticated, false);
    assert.equal(typeof value.error, "string");
    assert.match(tools[0].output.render({}, value)[0].text, /不可达/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("an invalid explicit token path surfaces as a config error, not a crash", async () => {
  const { tools } = await withIsolatedHostEnvironment({}, () =>
    loadPlugin({ env: { MCP_UNITY_AUTH_TOKEN_PATH: "does/not/exist/bridge-token" } })
  );
  const value = await tools[0].execute({}, {});
  assertLosslessJson(value);
  assert.equal(value.authenticated, false);
  assert.match(value.configError, /Could not read/);
  assert.match(tools[0].output.render({}, value)[0].text, /连接配置解析失败/);
});
