// 回归测试：vendored 服务端的连接配置解析（认证 token 是本次修复的核心）。
// 只依赖 node:test / node:assert 与临时目录，不需要 Unity 或任何第三方依赖。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveUnityConnectionConfig } from "../vendor/mcp-unity-server/build/unity/unityConnectionConfig.js";

const TOKEN = "0123456789abcdef".repeat(4);
const silentLogger = { info() {}, warn() {} };
const collectingLogger = (messages) => ({
  info: (m) => messages.push(String(m)),
  warn: (m) => messages.push(String(m)),
});

async function makeUnityProject({ settings, token } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-unity-mcp-"));
  await mkdir(path.join(root, "ProjectSettings"), { recursive: true });
  if (settings !== undefined) {
    await writeFile(
      path.join(root, "ProjectSettings", "McpUnitySettings.json"),
      typeof settings === "string" ? settings : JSON.stringify(settings),
      "utf8"
    );
  }
  if (token !== undefined) {
    await mkdir(path.join(root, "Library", "McpUnity"), { recursive: true });
    await writeFile(path.join(root, "Library", "McpUnity", "bridge-token"), token, "utf8");
  }
  return root;
}

test("discovers settings and the project bridge token from the Unity project", async () => {
  const root = await makeUnityProject({
    settings: { Port: 8123, Host: "127.0.0.1", RequestTimeoutSeconds: 20 },
    token: `${TOKEN}\n`,
  });
  try {
    const messages = [];
    const config = await resolveUnityConnectionConfig(collectingLogger(messages), {
      cwd: root,
      modulePath: path.join(root, "Assets", "Editor", "server.js"),
      environment: {},
    });
    assert.equal(config.port, 8123);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.requestTimeout, 20000);
    assert.equal(config.authToken, TOKEN);
    assert.match(config.authTokenSource, /Unity project/);
    assert.ok(messages.some((m) => m.includes("authentication token")));
    // 日志绝不能泄露 token 本身
    assert.ok(!messages.some((m) => m.includes(TOKEN)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("connects without authentication when the project has no token file", async () => {
  const root = await makeUnityProject({ settings: { Port: 8090 } });
  try {
    const messages = [];
    const config = await resolveUnityConnectionConfig(collectingLogger(messages), {
      cwd: root,
      modulePath: path.join(root, "Assets", "Editor", "server.js"),
      environment: {},
    });
    assert.equal(config.authToken, "");
    assert.equal(config.authTokenSource, "none");
    assert.ok(messages.some((m) => m.includes("No Unity bridge authentication token")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ignores a malformed project token instead of failing the connection", async () => {
  const root = await makeUnityProject({ settings: { Port: 8090 }, token: "not-a-token" });
  try {
    const messages = [];
    const config = await resolveUnityConnectionConfig(collectingLogger(messages), {
      cwd: root,
      modulePath: path.join(root, "Assets", "Editor", "server.js"),
      environment: {},
    });
    assert.equal(config.authToken, "");
    assert.ok(messages.some((m) => m.includes("malformed")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prefers MCP_UNITY_AUTH_TOKEN over project discovery", async () => {
  const root = await makeUnityProject({ settings: { Port: 8090 }, token: "f".repeat(64) });
  try {
    const config = await resolveUnityConnectionConfig(silentLogger, {
      cwd: root,
      modulePath: path.join(root, "Assets", "Editor", "server.js"),
      environment: { MCP_UNITY_AUTH_TOKEN: ` ${TOKEN} ` },
    });
    assert.equal(config.authToken, TOKEN);
    assert.equal(config.authTokenSource, "MCP_UNITY_AUTH_TOKEN");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an explicitly configured but invalid MCP_UNITY_AUTH_TOKEN", async () => {
  await assert.rejects(
    () =>
      resolveUnityConnectionConfig(silentLogger, {
        cwd: process.cwd(),
        modulePath: path.join(process.cwd(), "server.js"),
        environment: { MCP_UNITY_AUTH_TOKEN: "short" },
      }),
    (error) => {
      assert.equal(error.type, "authentication_error");
      assert.match(error.message, /64 hexadecimal/);
      return true;
    }
  );
});

test("reads MCP_UNITY_AUTH_TOKEN_PATH relative to the working directory", async () => {
  const root = await makeUnityProject({ token: TOKEN });
  try {
    const config = await resolveUnityConnectionConfig(silentLogger, {
      cwd: root,
      modulePath: path.join(root, "server.js"),
      environment: { MCP_UNITY_AUTH_TOKEN_PATH: "Library/McpUnity/bridge-token" },
    });
    assert.equal(config.authToken, TOKEN);
    assert.match(config.authTokenSource, /MCP_UNITY_AUTH_TOKEN_PATH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails loudly when an explicitly configured token file is unreadable", async () => {
  const root = await makeUnityProject({});
  try {
    await assert.rejects(
      () =>
        resolveUnityConnectionConfig(silentLogger, {
          cwd: root,
          modulePath: path.join(root, "server.js"),
          environment: { MCP_UNITY_AUTH_TOKEN_PATH: "Library/McpUnity/missing-token" },
        }),
      (error) => {
        assert.equal(error.type, "authentication_error");
        assert.match(error.message, /Could not read/);
        return true;
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("falls back to defaults without a Unity project and warns about the missing token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-unity-mcp-empty-"));
  try {
    const messages = [];
    const config = await resolveUnityConnectionConfig(collectingLogger(messages), {
      cwd: root,
      modulePath: path.join(root, "server.js"),
      environment: {},
    });
    assert.equal(config.port, 8090);
    assert.equal(config.host, "localhost");
    assert.equal(config.requestTimeout, 10000);
    assert.equal(config.authToken, "");
    assert.equal(config.authTokenSource, "none");
    assert.ok(messages.some((m) => m.includes("MCP_UNITY_AUTH_TOKEN")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
