// 回归测试：插件的 Unity 项目发现（多来源）+ 活跃项目识别。
//
// 覆盖第二缺陷：服务端进程的 cwd 不在任何 Unity 项目内时，
// 仍必须找到候选项目并用 token 握手识别出活跃项目。
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import {
  applyUnityProjectEnvironment,
  collectUnityProjectCandidates,
  decodeDshSessionDirectoryName,
  identifyLiveBridge,
  projectConnectionProfiles,
  readDshSessionWorkspacePaths,
  readDshWorkspacePaths,
} from "../lib/bridge-probe.js";
import { startBridgeStub } from "./stubs/bridge-server.mjs";

const TOKEN_A = "a1b2c3d4".repeat(8);
const TOKEN_B = "0f9e8d7c".repeat(8);

/** 造一个最小 Unity 项目目录（marker + settings + 可选 token）。 */
async function makeUnityProject(root, { name, port, token } = {}) {
  const projectRoot = name ? path.join(root, name) : root;
  await mkdir(path.join(projectRoot, "ProjectSettings"), { recursive: true });
  await writeFile(
    path.join(projectRoot, "ProjectSettings", "ProjectVersion.txt"),
    "m_EditorVersion: 2022.3.62f3\n"
  );
  if (port !== undefined) {
    await writeFile(
      path.join(projectRoot, "ProjectSettings", "McpUnitySettings.json"),
      JSON.stringify({ Port: port, Host: "127.0.0.1" })
    );
  }
  if (token) {
    await mkdir(path.join(projectRoot, "Library", "McpUnity"), { recursive: true });
    await writeFile(path.join(projectRoot, "Library", "McpUnity", "bridge-token"), token);
  }
  return projectRoot;
}

/** 造一个假 DSH 主目录：storages/workspace.json + sessions/<编码名>。 */
async function makeDshHome(workspaces = []) {
  const home = await mkdtemp(path.join(os.tmpdir(), "dsh-home-"));
  await mkdir(path.join(home, "storages"), { recursive: true });
  await mkdir(path.join(home, "sessions"), { recursive: true });
  const table = {};
  workspaces.forEach((workspace, index) => {
    table[`id-${index}`] = {
      path: workspace.path,
      title: workspace.title ?? path.basename(workspace.path),
      updatedAt: workspace.updatedAt ?? `2026-10-0${index + 1}T00:00:00.000Z`,
    };
  });
  await writeFile(
    path.join(home, "storages", "workspace.json"),
    JSON.stringify({ unit: { name: "workspace", version: 2 }, tables: { workspaces: table } })
  );
  return home;
}

/** DSH 的 sessions 目录名编码：非 [A-Za-z0-9._-] → ~XXXX，分隔符 → -。 */
function encodeSessionDirectoryName(absolutePath) {
  const body = `${absolutePath[0]}-${absolutePath.slice(3)}`;
  return `--${body.replace(/[^A-Za-z0-9._-]|[~]/g, (char) => {
    if (char === "~") return "~007E";
    return `~${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
  })}--`;
}

test("reads workspace paths from the DSH registry, most recent first", async () => {
  const older = await makeUnityProject(await mkdtemp(path.join(os.tmpdir(), "proj-old-")));
  const newer = await makeUnityProject(await mkdtemp(path.join(os.tmpdir(), "proj-new-")));
  const home = await makeDshHome([
    { path: older, updatedAt: "2026-09-01T00:00:00.000Z" },
    { path: newer, updatedAt: "2026-10-05T00:00:00.000Z" },
  ]);
  try {
    const paths = readDshWorkspacePaths({ DSH_HOME: home });
    assert.deepEqual(paths, [newer, older]);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(older, { recursive: true, force: true });
    await rm(newer, { recursive: true, force: true });
  }
});

test("decodes DSH session directory names, including paths with literal dashes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-session-decode-"));
  try {
    await mkdir(path.join(root, "libreoffice-document-converter-fix"), { recursive: true });
    await mkdir(path.join(root, "Unity Projects", "Tea"), { recursive: true });
    const withDashes = path.join(root, "libreoffice-document-converter-fix");
    const withSpaces = path.join(root, "Unity Projects", "Tea");
    assert.equal(decodeDshSessionDirectoryName(encodeSessionDirectoryName(withDashes)), withDashes);
    assert.equal(decodeDshSessionDirectoryName(encodeSessionDirectoryName(withSpaces)), withSpaces);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads session workspace paths from DSH_HOME/sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-session-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "dsh-home-"));
  try {
    await mkdir(path.join(root, "Unity Projects", "Tea"), { recursive: true });
    await mkdir(path.join(home, "sessions"), { recursive: true });
    const project = path.join(root, "Unity Projects", "Tea");
    await mkdir(path.join(home, "sessions", encodeSessionDirectoryName(project)), { recursive: true });
    assert.deepEqual(readDshSessionWorkspacePaths({ DSH_HOME: home }), [project]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("collects candidates from the DSH registry even when cwd is outside any project", async () => {
  const gamesRoot = await mkdtemp(path.join(os.tmpdir(), "games-"));
  const tea = await makeUnityProject(path.join(gamesRoot, "UnityProjects"), {
    name: "Tea",
    port: 8090,
    token: TOKEN_A,
  });
  const hololaser = await makeUnityProject(path.join(gamesRoot, "UnityProjects"), {
    name: "Hololaser",
    port: 8091,
    token: TOKEN_B,
  });
  const dshWorkspace = await mkdtemp(path.join(os.tmpdir(), "workspace-dsh-"));
  const home = await makeDshHome([
    { path: hololaser, updatedAt: "2026-09-20T00:00:00.000Z" },
    { path: dshWorkspace, updatedAt: "2026-10-05T12:00:00.000Z" },
    { path: tea, updatedAt: "2026-10-05T11:00:00.000Z" },
  ]);
  try {
    const candidates = collectUnityProjectCandidates({
      configuredProjectPaths: [],
      startDirectories: [dshWorkspace],
      environment: { DSH_HOME: home },
    });
    const roots = candidates.map((candidate) => candidate.root);
    assert.ok(roots.includes(tea), "Tea should be discovered through the DSH registry");
    assert.ok(roots.includes(hololaser), "Hololaser should be discovered through the DSH registry");
    // 活跃项目的候选排序：DSH 最近使用 + 有 token 的项目优先
    assert.equal(roots[0], tea);
    const teaCandidate = candidates.find((candidate) => candidate.root === tea);
    assert.equal(teaCandidate.tokenPath, path.join(tea, "Library", "McpUnity", "bridge-token"));
    assert.equal(teaCandidate.authToken, TOKEN_A);
  } finally {
    await rm(gamesRoot, { recursive: true, force: true });
    await rm(dshWorkspace, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("falls back to sibling scanning when no DSH home exists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "siblings-"));
  const gamesRoot = path.join(root, "GamesProjects");
  const workspace = path.join(root, "some-workspace");
  const tea = await makeUnityProject(path.join(gamesRoot, "UnityProjects"), {
    name: "Tea",
    port: 8090,
    token: TOKEN_A,
  });
  try {
    await mkdir(workspace, { recursive: true });
    const candidates = collectUnityProjectCandidates({
      startDirectories: [workspace],
      searchPaths: [gamesRoot],
      environment: { DSH_HOME: path.join(root, "missing-home") },
    });
    assert.deepEqual(candidates.map((candidate) => candidate.root), [tea]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applyUnityProjectEnvironment publishes the candidate list without overriding explicit env", async () => {
  const gamesRoot = await mkdtemp(path.join(os.tmpdir(), "env-candidates-"));
  const tea = await makeUnityProject(path.join(gamesRoot, "UnityProjects"), {
    name: "Tea",
    port: 8090,
    token: TOKEN_A,
  });
  const hololaser = await makeUnityProject(path.join(gamesRoot, "UnityProjects"), {
    name: "Hololaser",
    port: 8091,
    token: TOKEN_B,
  });
  try {
    const candidates = collectUnityProjectCandidates({
      searchPaths: [gamesRoot],
      environment: { DSH_HOME: path.join(gamesRoot, "no-dsh-home") },
    });
    const env = applyUnityProjectEnvironment({}, candidates);
    assert.equal(env.MCP_UNITY_PROJECT_PATHS, [tea, hololaser].join(path.delimiter));
    assert.equal(env.MCP_UNITY_SETTINGS_PATH, path.join(tea, "ProjectSettings", "McpUnitySettings.json"));

    const explicit = applyUnityProjectEnvironment(
      { MCP_UNITY_PROJECT_PATHS: "C:/only/this" },
      candidates
    );
    assert.equal(explicit.MCP_UNITY_PROJECT_PATHS, "C:/only/this");
  } finally {
    await rm(gamesRoot, { recursive: true, force: true });
  }
});

test("identifies the live project by probing candidate tokens in order", async () => {
  const gamesRoot = await mkdtemp(path.join(os.tmpdir(), "identify-"));
  const stale = await makeUnityProject(path.join(gamesRoot, "UnityProjects"), {
    name: "Hololaser",
    port: 8090,
    token: TOKEN_B,
  });
  const live = await makeUnityProject(path.join(gamesRoot, "UnityProjects"), {
    name: "Tea",
    port: 8090,
    token: TOKEN_A,
  });
  const bridge = await startBridgeStub({ acceptedTokens: [TOKEN_A] });
  try {
    await writeFile(
      path.join(stale, "ProjectSettings", "McpUnitySettings.json"),
      JSON.stringify({ Port: bridge.port, Host: "127.0.0.1" })
    );
    await writeFile(
      path.join(live, "ProjectSettings", "McpUnitySettings.json"),
      JSON.stringify({ Port: bridge.port, Host: "127.0.0.1" })
    );
    const candidates = collectUnityProjectCandidates({
      configuredProjectPaths: [stale, live],
      startDirectories: [gamesRoot],
      // 隔离：不要读到开发机上真实的 ~/.dsh 工作区登记表
      environment: { DSH_HOME: path.join(gamesRoot, "no-dsh-home") },
    });
    const profiles = projectConnectionProfiles(candidates, {});
    const identification = await identifyLiveBridge(profiles, { timeoutMs: 2000 });
    assert.equal(identification.identified?.projectRoot, live);
    assert.equal(identification.handshake.status, "connected");
    // stale 项目先被尝试并被拒，然后才是 live 项目
    assert.deepEqual(
      identification.attempts.map((attempt) => [attempt.project, attempt.status]),
      [
        [stale, "unauthorized"],
        [live, "connected"],
      ]
    );
  } finally {
    await bridge.close();
    await rm(gamesRoot, { recursive: true, force: true });
  }
});

test("identifyLiveBridge reports unauthorized when no candidate token is accepted", async () => {
  // 项目放在独立父目录下：同级目录扫描只会看到它自己，断言才不会被环境噪声影响
  const parent = await mkdtemp(path.join(os.tmpdir(), "identify-fail-"));
  const project = await makeUnityProject(parent, { name: "Tea", token: TOKEN_A });
  const bridge = await startBridgeStub({ acceptedTokens: [TOKEN_B] });
  try {
    await writeFile(
      path.join(project, "ProjectSettings", "McpUnitySettings.json"),
      JSON.stringify({ Port: bridge.port, Host: "127.0.0.1" })
    );
    const candidates = collectUnityProjectCandidates({
      configuredProjectPaths: [project],
      environment: { DSH_HOME: path.join(parent, "no-dsh-home") },
    });
    assert.equal(candidates.length, 1, "only the configured project should be a candidate");
    const identification = await identifyLiveBridge(projectConnectionProfiles(candidates, {}), {
      timeoutMs: 2000,
    });
    assert.equal(identification.identified, undefined);
    assert.equal(identification.handshake.status, "unauthorized");
    assert.equal(identification.handshake.httpStatus, 401);
    assert.equal(identification.reachable, true);
  } finally {
    await bridge.close();
    await rm(parent, { recursive: true, force: true });
  }
});
