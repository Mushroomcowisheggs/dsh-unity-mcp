#!/usr/bin/env node
// smoke.mjs — 对 mcp-unity 服务端做一次真实 stdio 握手，列出注册的工具。
//
// 用法：
//   node scripts/smoke.mjs [manager]
//   manager = installed（默认）: 在祖先 node_modules 中查找 dsh-unity-mcp 的安装副本，
//             从该目录运行（如 DSH profile 根目录）时依赖可被正确解析。
//   manager = vendor           : 使用仓库源码 vendor/ 构建。注意——服务端依赖
//             （@modelcontextprotocol/sdk 等）在源码树中并不存在，须先满足依赖
//             才能运行（详见输出提示）。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const manager = process.argv[2] ?? "installed";

// 从当前目录向上找第一个包含目标路径的 node_modules。
function findInAncestors(relPattern) {
  let dir = resolve(".");
  while (true) {
    const candidate = resolve(dir, "node_modules", relPattern);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

const entry =
  manager === "vendor"
    ? resolve("vendor/mcp-unity-server/build/index.js")
    : findInAncestors("dsh-unity-mcp/vendor/mcp-unity-server/build/index.js");

if (!entry || !existsSync(entry)) {
  console.error(
    "smoke: server entry not found.\n" +
      (manager === "vendor"
        ? "  - repo build 缺少：vendor/mcp-unity-server/build/index.js\n"
        : "  - 请先在本 profile 安装 dsh-unity-mcp，然后从 profile 根目录运行：\n" +
            "    dsh plugin --profile web install <gh-user>/dsh-unity-mcp\n" +
            "    node <repo>/scripts/smoke.mjs\n")
  );
  process.exit(1);
}

const child = spawn(process.execPath, [entry], {
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
const pending = new Map();
let nextId = 1;

function onServerOutput(prefix, chunk) {
  process.stderr.write(`${prefix} ${chunk}`);
}

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const settled = pending.get(msg.id);
    if (settled) {
      pending.delete(msg.id);
      settled(msg);
    }
  }
});
child.stderr.on("data", (d) => onServerOutput("[server]", d));

function send(method, params = {}) {
  return new Promise((settle) => {
    const id = nextId++;
    pending.set(id, settle);
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
    );
  });
}

function timeout(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
  );
}

try {
  const init = await Promise.race([
    send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "dsh-unity-mcp-smoke", version: "1.0.0" },
    }),
    timeout(15000),
  ]);
  if (!init.result) throw new Error(`initialize failed: ${init.error?.message ?? "unknown"}`);
  await send("notifications/initialized");
  const listed = await send("tools/list");
  const names = (listed.result?.tools ?? []).map((t) => t.name);
  console.log(`smoke OK: ${names.length} tools via ${entry}`);
  console.log(names.join(", "));
  if (!names.length) process.exitCode = 1;
} catch (err) {
  console.error("smoke FAILED:", err.message);
  if (manager === "vendor" && /ERR_MODULE_NOT_FOUND|Cannot find package/.test(String(err))) {
    console.error(
      "  - vendor 构建缺少运行时依赖。请在 Node 可解析的位置满足依赖后再试：\n" +
        "    方式 A：安装到 profile 后从 profile 根目录跑默认模式（推荐）；\n" +
        "    方式 B：在仓库内 npm install 相关依赖再跑 vendor 模式。"
    );
  }
  process.exitCode = 1;
} finally {
  child.kill();
}