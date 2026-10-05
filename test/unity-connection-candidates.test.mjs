// 回归测试：服务端连接层在多个候选项目之间的"识别"行为。
//
// 这是第二缺陷在服务端的一半：插件把候选项目列表交给服务端后，服务端必须
// 逐个尝试，第一个被网桥接受的 token 就是活跃项目；全部被拒才是终态认证错误。
//
// 依赖真实的 ws 客户端（vendored 服务端 import 'ws'）：本机 node_modules 已复制
// ws；CI 里先 `npm install --no-save ws`。若仍不可用则跳过而不是误报失败。
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { startBridgeStub } from "./stubs/bridge-server.mjs";

const TOKEN_A = "11".repeat(32);
const TOKEN_B = "22".repeat(32);

async function loadConnection() {
  try {
    const connection = await import(
      "../vendor/mcp-unity-server/build/unity/unityConnection.js"
    );
    const errors = await import("../vendor/mcp-unity-server/build/utils/errors.js");
    return { UnityConnection: connection.UnityConnection, ErrorType: errors.ErrorType };
  } catch {
    return undefined;
  }
}

const loaded = await loadConnection();
const connectionTest = loaded ? test : test.skip;
const skipNote = loaded ? "" : " (skipped: dependency 'ws' is not installed)";

const quietLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

/** 一个没有监听者的本地端口，用于模拟"该项目没开 Unity"。 */
async function reserveDeadPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function collectErrors(connection) {
  const errors = [];
  connection.on("error", (error) => errors.push(error));
  return errors;
}

connectionTest(`identifies the live project by walking candidate tokens${skipNote}`, async () => {
  const { UnityConnection, ErrorType } = loaded;
  const bridge = await startBridgeStub({ acceptedTokens: [TOKEN_B] });
  const deadPort = await reserveDeadPort();
  const connection = new UnityConnection(quietLogger, {
    host: "127.0.0.1",
    port: deadPort,
    requestTimeout: 1000,
    connectTimeout: 1500,
    heartbeatInterval: 0,
    candidates: [
      { host: "127.0.0.1", port: deadPort, authToken: TOKEN_A, source: "project-a" },
      { host: "127.0.0.1", port: bridge.port, authToken: TOKEN_B, source: "project-b" },
    ],
  });
  const errors = collectErrors(connection);
  try {
    await connection.connect();
    assert.equal(connection.isConnected, true);
    assert.equal(connection.connectionState, "connected");
    assert.equal(connection.getStats().identifiedProject, "project-b");
    const tokens = bridge.handshakes.map((handshake) => handshake.token);
    assert.ok(tokens.includes(TOKEN_B), "the accepted candidate token must reach the bridge");
    // 走到第二个候选成功：不该出现认证终态错误（也不该重连刷屏）
    assert.equal(
      errors.filter((error) => error.type === ErrorType.AUTHENTICATION).length,
      0,
      "walking candidates must not surface an authentication error"
    );
    assert.equal(connection.getStats().reconnectAttempt, 0);
  } finally {
    connection.disconnect("test over");
    await bridge.close();
  }
});

connectionTest(`reports a terminal authentication error when no candidate is accepted${skipNote}`, async () => {
  const { UnityConnection, ErrorType } = loaded;
  const bridge = await startBridgeStub({ acceptedTokens: ["33".repeat(32)] });
  const connection = new UnityConnection(quietLogger, {
    host: "127.0.0.1",
    port: bridge.port,
    requestTimeout: 1000,
    connectTimeout: 1500,
    heartbeatInterval: 0,
    maxReconnectAttempts: 5,
    candidates: [
      { host: "127.0.0.1", port: bridge.port, authToken: TOKEN_A, source: "project-a" },
      { host: "127.0.0.1", port: bridge.port, authToken: TOKEN_B, source: "project-b" },
    ],
  });
  const errors = collectErrors(connection);
  try {
    await assert.rejects(() => connection.connect());
    assert.equal(connection.connectionState, "disconnected");
    const authenticationError = errors.find((error) => error.type === ErrorType.AUTHENTICATION);
    assert.ok(authenticationError, "an authentication error must be reported");
    assert.match(authenticationError.message, /project-a/);
    assert.match(authenticationError.message, /project-b/);
    // 终态：不再重连刷屏
    assert.equal(connection.getStats().reconnectAttempt, 0);
    assert.equal(bridge.handshakes.length, 2, "each candidate is tried exactly once");
  } finally {
    connection.disconnect("test over");
    await bridge.close();
  }
});

connectionTest(`re-identifies the project after Unity switches to another one${skipNote}`, async () => {
  const { UnityConnection } = loaded;
  const bridge = await startBridgeStub({ acceptedTokens: [TOKEN_A] });
  const connection = new UnityConnection(quietLogger, {
    host: "127.0.0.1",
    port: bridge.port,
    requestTimeout: 1000,
    connectTimeout: 1500,
    heartbeatInterval: 0,
    candidates: [
      { host: "127.0.0.1", port: bridge.port, authToken: TOKEN_A, source: "project-a" },
      { host: "127.0.0.1", port: bridge.port, authToken: TOKEN_B, source: "project-b" },
    ],
  });
  collectErrors(connection);
  try {
    await connection.connect();
    assert.equal(connection.getStats().identifiedProject, "project-a");

    // 用户在 Unity 里换项目：旧 token 不再被接受（同一个端口，新的项目 token）
    bridge.acceptedTokens.clear();
    bridge.acceptedTokens.add(TOKEN_B);
    connection.forceReconnect();
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(connection.isConnected, true);
    assert.equal(connection.getStats().identifiedProject, "project-b");
  } finally {
    connection.disconnect("test over");
    await bridge.close();
  }
});
