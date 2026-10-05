// 回归测试：插件入口 apply() 的工具契约与 unity_status 行为。
//
// lib/index.js 依赖 DSH 运行时（@deepseek-ai/dsh-tools 等），这里用 test/stubs 里的
// 加载器钩子把它们换成最小替身，从而在无 DSH、无 Unity 的情况下验证：
// - 插件名/注入声明不变；
// - unityProjectPath（或自动探测）会把 McpUnitySettings.json / bridge-token 注入子进程 env；
// - unity_status 用真实握手判定就绪，401 不再被当成「就绪」；
// - 工具返回值始终是 lossless JSON（DSH 的硬性要求）。
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { register } from "node:module";

register("./stubs/loader-hook.mjs", import.meta.url);
const { apply, name, inject } = await import("../lib/index.js");

const TOKEN = "0123456789abcdef".repeat(4);
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** 临时 Unity 项目：settings 的 Port 指向本地假网桥，便于走完 execute 全流程。 */
async function makeProject(port) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-unity-plugin-"));
  await mkdir(path.join(root, "ProjectSettings"), { recursive: true });
  await mkdir(path.join(root, "Library", "McpUnity"), { recursive: true });
  await writeFile(
    path.join(root, "ProjectSettings", "McpUnitySettings.json"),
    JSON.stringify({ Port: port, Host: "127.0.0.1" })
  );
  await writeFile(path.join(root, "Library", "McpUnity", "bridge-token"), TOKEN);
  return root;
}

async function startStubBridge(handler) {
  const requests = [];
  const server = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      requests.push(chunk.toString("latin1"));
      handler(socket, requests[requests.length - 1]);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function upgrade(socket, request) {
  const key = /^sec-websocket-key:\s*(.+)$/im.exec(request)[1].trim();
  const accept = createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
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

test("unityProjectPath injects the Unity settings and bridge token into the server env", async () => {
  const bridge = await startStubBridge(upgrade);
  const root = await makeProject(bridge.port);
  try {
    const { plugins, tools } = loadPlugin({ env: {}, unityProjectPath: root });
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].pluginConfig.serverName, "unity");
    assert.equal(
      plugins[0].pluginConfig.env.MCP_UNITY_SETTINGS_PATH,
      path.join(root, "ProjectSettings", "McpUnitySettings.json")
    );
    assert.equal(
      plugins[0].pluginConfig.env.MCP_UNITY_AUTH_TOKEN_PATH,
      path.join(root, "Library", "McpUnity", "bridge-token")
    );
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "unity_status");
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit env wins over the derived Unity project paths", async () => {
  const { plugins } = loadPlugin({
    env: { MCP_UNITY_AUTH_TOKEN_PATH: "C:/custom/token" },
    unityProjectPath: process.cwd(),
  });
  assert.equal(plugins[0].pluginConfig.env.MCP_UNITY_AUTH_TOKEN_PATH, "C:/custom/token");
});

test("unity_status reports ready only after a real authenticated handshake", async () => {
  const bridge = await startStubBridge(upgrade);
  const root = await makeProject(bridge.port);
  try {
    const { tools } = loadPlugin({ env: {}, unityProjectPath: root });
    const value = await tools[0].execute({}, {});
    assertLosslessJson(value);
    assert.equal(value.bridgeReachable, true);
    assert.equal(value.handshake, "connected");
    assert.equal(value.authenticated, true);
    assert.equal(value.httpStatus, 101);
    assert.equal(value.port, bridge.port);
    assert.equal(value.toolNamespace, "unity");
    assert.equal(value.unityProjectPath, root);
    assert.match(value.authTokenSource, /MCP_UNITY_AUTH_TOKEN_PATH|Unity project/);
    // 握手请求确实带了 Basic 认证
    const expected = Buffer.from(`mcp-unity:${TOKEN}`, "utf8").toString("base64");
    assert.match(bridge.requests[0], new RegExp(`Authorization: Basic ${expected}`));

    const rendered = tools[0].output.render({}, value);
    assert.equal(rendered[0].type, "text");
    assert.match(rendered[0].text, /就绪/);
    assert.match(rendered[0].text, /mcp__unity__\*/);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("unity_status reports unauthorized instead of falsely ready on HTTP 401", async () => {
  const bridge = await startStubBridge((socket) => {
    socket.write(
      "HTTP/1.1 401 Unauthorized\r\nServer: websocket-sharp/1.0\r\n" +
        'WWW-Authenticate: Basic realm="MCP Unity"\r\n\r\n'
    );
  });
  const root = await makeProject(bridge.port);
  try {
    const { tools } = loadPlugin({ env: {}, unityProjectPath: root });
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
    await rm(root, { recursive: true, force: true });
  }
});

test("unity_status stays lossless JSON when the bridge port is closed", async () => {
  const bridge = await startStubBridge(upgrade);
  const port = bridge.port;
  await bridge.close();
  const root = await makeProject(port);
  try {
    const { tools } = loadPlugin({ env: {}, unityProjectPath: root });
    const value = await tools[0].execute({}, {});
    assertLosslessJson(value);
    assert.equal(value.bridgeReachable, false);
    assert.equal(value.handshake, "unreachable");
    assert.equal(value.authenticated, false);
    assert.equal(typeof value.error, "string");
    assert.match(tools[0].output.render({}, value)[0].text, /不可达/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an invalid explicit token path surfaces as a config error, not a crash", async () => {
  const { tools } = loadPlugin({
    env: { MCP_UNITY_AUTH_TOKEN_PATH: "does/not/exist/bridge-token" },
  });
  const value = await tools[0].execute({}, {});
  assertLosslessJson(value);
  assert.equal(value.authenticated, false);
  assert.match(value.configError, /Could not read/);
  assert.match(tools[0].output.render({}, value)[0].text, /连接配置解析失败/);
});
