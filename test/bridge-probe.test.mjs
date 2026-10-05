// 回归测试：插件侧网桥诊断（真实 WebSocket 握手探测）。
//
// 这里用本地 net 服务器扮演 Unity 网桥，断言三件事：
// 1) 握手请求带 Authorization: Basic mcp-unity:<token>（本次修复的根因）；
// 2) 不发送 Origin（带 Origin 的握手会被 Unity 拒绝）；
// 3) 401 不会被误判成「就绪」（v1.2.0 的假阳性）。
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import {
  applyUnityProjectEnvironment,
  probeBridgeHandshake,
  probeTcp,
  resolveBridgeTarget,
  resolveUnityProjectRoot,
} from "../lib/bridge-probe.js";

const TOKEN = "abcdef0123456789".repeat(4);
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** 本地假网桥：把收到的握手请求交给 handler 决定怎么回应。 */
async function startStubBridge(handler) {
  const requests = [];
  const server = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      const request = chunk.toString("latin1");
      requests.push(request);
      handler(socket, request);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function acceptFor(request) {
  const key = /^sec-websocket-key:\s*(.+)$/im.exec(request)?.[1].trim();
  return createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64");
}

test("handshake probe sends Basic auth and reports a real 101 upgrade as connected", async () => {
  const bridge = await startStubBridge((socket, request) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptFor(request)}\r\n\r\n`
    );
  });
  try {
    const result = await probeBridgeHandshake("127.0.0.1", bridge.port, {
      token: TOKEN,
      timeoutMs: 2000,
    });
    assert.equal(result.status, "connected");
    assert.equal(result.httpStatus, 101);

    const request = bridge.requests[0];
    const expected = Buffer.from(`mcp-unity:${TOKEN}`, "utf8").toString("base64");
    assert.match(request, new RegExp(`Authorization: Basic ${expected}`));
    assert.match(request, /^GET \/McpUnity HTTP\/1\.1/m);
    assert.doesNotMatch(request, /^Origin:/im);
  } finally {
    await bridge.close();
  }
});

test("handshake probe reports 401 as unauthorized (never as ready)", async () => {
  const bridge = await startStubBridge((socket) => {
    socket.write(
      "HTTP/1.1 401 Unauthorized\r\n" +
        'Server: websocket-sharp/1.0\r\nWWW-Authenticate: Basic realm="MCP Unity"\r\n\r\n'
    );
  });
  try {
    const result = await probeBridgeHandshake("127.0.0.1", bridge.port, { timeoutMs: 2000 });
    assert.equal(result.status, "unauthorized");
    assert.equal(result.httpStatus, 401);
    assert.doesNotMatch(bridge.requests[0], /Authorization:/);
  } finally {
    await bridge.close();
  }
});

test("handshake probe flags a non-101 response as unexpected", async () => {
  const bridge = await startStubBridge((socket) => {
    socket.write("HTTP/1.1 501 Not Implemented\r\nServer: websocket-sharp/1.0\r\n\r\n");
  });
  try {
    const result = await probeBridgeHandshake("127.0.0.1", bridge.port, { timeoutMs: 2000 });
    assert.equal(result.status, "unexpected");
    assert.equal(result.httpStatus, 501);
  } finally {
    await bridge.close();
  }
});

test("handshake probe also rejects a 101 without a valid accept header", async () => {
  const bridge = await startStubBridge((socket) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: wrong\r\n\r\n"
    );
  });
  try {
    const result = await probeBridgeHandshake("127.0.0.1", bridge.port, { timeoutMs: 2000 });
    assert.equal(result.status, "unexpected");
  } finally {
    await bridge.close();
  }
});

test("tcp probe distinguishes a listening port from a closed one", async () => {
  const bridge = await startStubBridge(() => {});
  try {
    const open = await probeTcp("127.0.0.1", bridge.port, 2000);
    assert.equal(open.ok, true);
  } finally {
    await bridge.close();
  }
  const closedPort = bridge.port;
  const closed = await probeTcp("127.0.0.1", closedPort, 2000);
  assert.equal(closed.ok, false);
  assert.equal(typeof closed.error, "string");
});

test("resolveUnityProjectRoot prefers the configured path and otherwise walks up", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-unity-probe-"));
  try {
    await mkdir(path.join(root, "ProjectSettings"), { recursive: true });
    await writeFile(path.join(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0.0f1\n");
    await mkdir(path.join(root, "Assets", "Scripts"), { recursive: true });
    assert.equal(
      resolveUnityProjectRoot("", path.join(root, "Assets", "Scripts")),
      root
    );
    assert.equal(resolveUnityProjectRoot(root, path.join(os.tmpdir(), "elsewhere")), root);
    assert.equal(resolveUnityProjectRoot("", path.join(os.tmpdir(), "nowhere-unity")) === undefined, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applyUnityProjectEnvironment injects settings/token paths without overriding explicit env", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-unity-env-"));
  try {
    await mkdir(path.join(root, "ProjectSettings"), { recursive: true });
    await mkdir(path.join(root, "Library", "McpUnity"), { recursive: true });
    await writeFile(path.join(root, "ProjectSettings", "McpUnitySettings.json"), "{}");
    await writeFile(path.join(root, "Library", "McpUnity", "bridge-token"), TOKEN);

    const env = applyUnityProjectEnvironment({}, root);
    assert.equal(env.MCP_UNITY_SETTINGS_PATH, path.join(root, "ProjectSettings", "McpUnitySettings.json"));
    assert.equal(env.MCP_UNITY_AUTH_TOKEN_PATH, path.join(root, "Library", "McpUnity", "bridge-token"));

    const explicit = applyUnityProjectEnvironment(
      { MCP_UNITY_AUTH_TOKEN_PATH: "C:/custom/token" },
      root
    );
    assert.equal(explicit.MCP_UNITY_AUTH_TOKEN_PATH, "C:/custom/token");

    const empty = await mkdtemp(path.join(os.tmpdir(), "dsh-unity-env-empty-"));
    assert.deepEqual(applyUnityProjectEnvironment({}, empty), {});
    await rm(empty, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveBridgeTarget resolves the same token the server would use", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-unity-target-"));
  try {
    await mkdir(path.join(root, "ProjectSettings"), { recursive: true });
    await mkdir(path.join(root, "Library", "McpUnity"), { recursive: true });
    await writeFile(
      path.join(root, "ProjectSettings", "McpUnitySettings.json"),
      JSON.stringify({ Port: 8123 })
    );
    await writeFile(path.join(root, "Library", "McpUnity", "bridge-token"), TOKEN);

    const target = await resolveBridgeTarget({
      cwd: root,
      modulePath: path.join(root, "Assets", "Editor", "server.js"),
      environment: {},
    });
    assert.equal(target.port, 8123);
    assert.equal(target.authToken, TOKEN);
    assert.equal(target.error, undefined);

    const broken = await resolveBridgeTarget({
      cwd: root,
      modulePath: path.join(root, "Assets", "Editor", "server.js"),
      environment: { MCP_UNITY_AUTH_TOKEN_PATH: "does/not/exist" },
    });
    assert.equal(broken.authToken, "");
    assert.match(broken.error, /Could not read/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
