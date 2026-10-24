// 回归测试：握手探测原语本身的行为。
//
// 这里用本地 net 服务器扮演 Unity 网桥（test/stubs/bridge-server.mjs），断言：
// 1) 握手请求带 Authorization: Basic mcp-unity:<token>（认证缺陷的根因）；
// 2) 不发送 Origin（带 Origin 的握手会被 Unity 拒绝）；
// 3) 401 不会被误判成「就绪」；101 必须带正确的 Sec-WebSocket-Accept。
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import {
  probeBridgeHandshake,
  probeTcp,
  resolveBridgeTarget,
  resolveUnityProjectRoot,
} from "../lib/bridge-probe.js";
import { startBridgeStub } from "./stubs/bridge-server.mjs";

const TOKEN = "abcdef0123456789".repeat(4);

test("handshake probe sends Basic auth and reports a real 101 upgrade as connected", async () => {
  const bridge = await startBridgeStub({ acceptedTokens: [TOKEN] });
  try {
    const result = await probeBridgeHandshake("127.0.0.1", bridge.port, {
      token: TOKEN,
      timeoutMs: 2000,
    });
    assert.equal(result.status, "connected");
    assert.equal(result.httpStatus, 101);

    const request = bridge.handshakes[0].raw;
    const expected = Buffer.from(`mcp-unity:${TOKEN}`, "utf8").toString("base64");
    assert.match(request, new RegExp(`Authorization: Basic ${expected}`));
    assert.match(request, /^GET \/McpUnity HTTP\/1\.1/m);
    assert.doesNotMatch(request, /^Origin:/im);
  } finally {
    await bridge.close();
  }
});

test("handshake probe reports 401 as unauthorized (never as ready)", async () => {
  const bridge = await startBridgeStub({ acceptedTokens: [TOKEN] });
  try {
    const result = await probeBridgeHandshake("127.0.0.1", bridge.port, { timeoutMs: 2000 });
    assert.equal(result.status, "unauthorized");
    assert.equal(result.httpStatus, 401);
    assert.doesNotMatch(bridge.handshakes[0].raw, /Authorization:/);
  } finally {
    await bridge.close();
  }
});

test("handshake probe flags a non-101 response as unexpected", async () => {
  const bridge = await startBridgeStub({ path: "/SomethingElse" });
  try {
    const result = await probeBridgeHandshake("127.0.0.1", bridge.port, { timeoutMs: 2000 });
    assert.equal(result.status, "unexpected");
    assert.equal(result.httpStatus, 501);
  } finally {
    await bridge.close();
  }
});

test("handshake probe rejects a 101 without a valid accept header", async () => {
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      socket.end(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: wrong\r\n\r\n"
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await probeBridgeHandshake("127.0.0.1", server.address().port, {
      timeoutMs: 2000,
    });
    assert.equal(result.status, "unexpected");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("tcp probe distinguishes a listening port from a closed one", async () => {
  const bridge = await startBridgeStub({});
  const port = bridge.port;
  try {
    const open = await probeTcp("127.0.0.1", port, 2000);
    assert.equal(open.ok, true);
  } finally {
    await bridge.close();
  }
  const closed = await probeTcp("127.0.0.1", port, 2000);
  assert.equal(closed.ok, false);
  assert.equal(typeof closed.error, "string");
});

test("resolveUnityProjectRoot prefers the configured path and otherwise walks up", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-unity-probe-"));
  try {
    await mkdir(path.join(root, "ProjectSettings"), { recursive: true });
    await writeFile(
      path.join(root, "ProjectSettings", "ProjectVersion.txt"),
      "m_EditorVersion: 6000.0.0f1\n"
    );
    await mkdir(path.join(root, "Assets", "Scripts"), { recursive: true });
    assert.equal(resolveUnityProjectRoot("", path.join(root, "Assets", "Scripts")), root);
    assert.equal(resolveUnityProjectRoot(root, path.join(os.tmpdir(), "elsewhere")), root);
    assert.equal(
      resolveUnityProjectRoot("", path.join(os.tmpdir(), "nowhere-unity")) === undefined,
      true
    );
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
      environment: { DSH_HOME: path.join(root, "no-dsh-home") },
    });
    assert.equal(target.port, 8123);
    assert.equal(target.authToken, TOKEN);
    assert.equal(target.error, undefined);

    const broken = await resolveBridgeTarget({
      cwd: root,
      modulePath: path.join(root, "Assets", "Editor", "server.js"),
      environment: {
        DSH_HOME: path.join(root, "no-dsh-home"),
        MCP_UNITY_AUTH_TOKEN_PATH: "does/not/exist",
      },
    });
    assert.equal(broken.authToken, "");
    assert.match(broken.error, /Could not read/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
