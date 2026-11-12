import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync as requireSpawn } from "node:child_process";
import { validateFilesystemConfiguration, validateFilesystemGrants } from "./filesystem-grants.mjs";
import { buildSrtPolicy } from "./srt-policy.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-grant-validation-"));
  const home = path.join(root, "home"), workspaceRoot = path.join(root, "workspace"), controllerRoot = path.join(root, "controller"), shared = path.join(root, "shared");
  for (const dir of [home, workspaceRoot, controllerRoot, shared]) fs.mkdirSync(dir);
  const dockerSocket = path.join(root, "docker.sock"); fs.writeFileSync(dockerSocket, "");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, shared, options: { home, workspaceRoot, controllerRoot, dockerSocket } };
}
function checkBoth(item, grants, pattern) {
  const config = { version: 1, filesystem: { readOnly: grants.filter((g) => g.access === "ro").map((g) => g.path), readWrite: grants.filter((g) => g.access === "rw").map((g) => g.path) } };
  assert.throws(() => validateFilesystemConfiguration(config, item.options), pattern);
  assert.throws(() => buildSrtPolicy({ ...item.options, grants }), pattern);
}

test("saved and direct policy grants use the same credential/runtime exclusions", (t) => {
  const item = fixture(t);
  for (const part of [".pi", ".codex", ".sbx", ".aws", ".azure", ".docker", ".gcp", ".kube", ".ssh", ".config/gcloud", ".config/azure", ".config/gh", ".local/bin", "Library/Application Support/com.docker.sandboxes"]) {
    const dir = path.join(item.home, part); fs.mkdirSync(dir, { recursive: true });
    for (const access of ["ro", "rw"]) checkBoth(item, [{ path: dir, access }], /credential|protected/);
  }
  checkBoth(item, [{ path: path.join(item.home, ".config"), access: "ro" }], /credential|protected/);
  const alias = path.join(item.root, "credential-alias"); fs.symlinkSync(path.join(item.home, ".ssh"), alias);
  checkBoth(item, [{ path: alias, access: "rw" }], /credential|protected/);
});

test("canonical targets of protected symlinks remain ungrantable outside home", (t) => {
  const item = fixture(t), secret = path.join(item.root, "credentials"), ordinary = path.join(item.root, "ordinary");
  fs.mkdirSync(secret); fs.mkdirSync(ordinary);
  fs.symlinkSync(secret, path.join(item.home, ".ssh"));
  fs.symlinkSync(secret, path.join(ordinary, "alias"));
  checkBoth(item, [{ path: secret, access: "ro" }], /credential|protected/);
  checkBoth(item, [{ path: path.join(ordinary, "alias"), access: "rw" }], /credential|protected/);
  const runtime = path.join(item.root, "runtime"); fs.mkdirSync(runtime);
  fs.mkdirSync(path.join(item.home, ".pi")); fs.symlinkSync(runtime, path.join(item.home, ".pi", "agent"));
  checkBoth(item, [{ path: runtime, access: "rw" }], /credential|protected/);
});

test("workspace aliases are allowed while controller aliases and home ancestors are excluded", (t) => {
  const item = fixture(t);
  for (const key of ["workspaceRoot", "controllerRoot"]) {
    const alias = path.join(item.root, `${key}-alias`); fs.symlinkSync(item.options[key], alias);
    if (key === "controllerRoot") checkBoth(item, [{ path: alias, access: "rw" }], /controller/);
    else assert.equal(validateFilesystemGrants([{ path: alias, access: "rw" }], item.options)[0].canonicalPath, fs.realpathSync(item.options.workspaceRoot));
    const child = path.join(item.options[key], "child"); fs.mkdirSync(child);
    if (key === "controllerRoot") checkBoth(item, [{ path: child, access: "ro" }], /controller/);
    else assert.equal(validateFilesystemGrants([{ path: child, access: "ro" }], item.options)[0].canonicalPath, fs.realpathSync(child));
  }
  checkBoth(item, [{ path: item.root, access: "ro" }], /protected/);
  checkBoth(item, [{ path: path.parse(item.root).root, access: "rw" }], /protected/);
});

test("bounds and lexical/canonical overlaps apply to policy and saved config", (t) => {
  const item = fixture(t), child = path.join(item.shared, "child"), alias = path.join(item.root, "alias");
  fs.mkdirSync(child); fs.symlinkSync(item.shared, alias);
  for (const grants of [
    [{ path: alias, access: "ro" }, { path: child, access: "rw" }],
    [{ path: item.shared, access: "rw" }, { path: child, access: "ro" }],
  ]) checkBoth(item, grants, /overlapping/);
  for (const value of ["", "relative", "~user/path", "a".repeat(4097), `${item.shared}\0`, `${item.shared}\n`]) checkBoth(item, [{ path: value, access: "ro" }], /path/);
  checkBoth(item, Array.from({ length: 33 }, () => ({ path: item.shared, access: "ro" })), /bounded/);
  checkBoth(item, Array.from({ length: 33 }, (_, index) => ({ path: item.shared, access: index < 16 ? "ro" : "rw" })), /bounded/);
  assert.throws(() => validateFilesystemGrants([{ path: item.shared, access: "execute" }], item.options), /ro or rw/);
});

test("identical canonical folders retain entries and union alias authority deterministically", (t) => {
  const item = fixture(t), alias = path.join(item.root, "alias");
  fs.symlinkSync(item.shared, alias);
  const entries = [{ path: alias, access: "ro" }, { path: item.shared, access: "rw" }];
  const grants = validateFilesystemGrants(entries, item.options);
  assert.equal(grants.length, 2);
  const policy = buildSrtPolicy({ ...item.options, grants });
  for (const dir of [alias, fs.realpathSync(item.shared)]) {
    assert(policy.filesystem.allowRead.includes(dir));
    assert(policy.filesystem.allowWrite.includes(dir));
    assert(!policy.filesystem.allowCompleteWorkspaceWrites.includes(dir));
  }
  assert.equal(new Set(policy.filesystem.allowWrite).size, policy.filesystem.allowWrite.length);
  assert.equal(buildSrtPolicy({ ...item.options, grants: [...grants].reverse().concat(grants) }).generation, policy.generation);
});

test("workspace matches preserve derived writes and all safety exclusions", (t) => {
  const item = fixture(t), alias = path.join(item.root, "workspace-alias");
  fs.symlinkSync(item.options.workspaceRoot, alias);
  for (const access of ["ro", "rw"]) {
    const config = { version: 1, filesystem: { readOnly: access === "ro" ? [alias] : [], readWrite: access === "rw" ? [alias] : [] } };
    const grants = validateFilesystemConfiguration(config, item.options);
    const policy = buildSrtPolicy({ ...item.options, grants });
    assert(policy.filesystem.allowWrite.includes(fs.realpathSync(item.options.workspaceRoot)));
    assert(policy.filesystem.allowWrite.includes(alias));
    const direct = buildSrtPolicy({ ...item.options, grants: [{ path: item.options.workspaceRoot, access }] });
    assert.equal(direct.generation, buildSrtPolicy(item.options).generation);
  }
  const secret = path.join(item.home, ".ssh"); fs.mkdirSync(secret);
  checkBoth({ ...item, options: { ...item.options, workspaceRoot: secret } }, [{ path: secret, access: "rw" }, { path: secret, access: "ro" }], /credential|protected/);
  // A protected lexical alias stays forbidden even when its target is the workspace.
  fs.symlinkSync(item.options.workspaceRoot, path.join(item.home, ".aws"));
  checkBoth(item, [{ path: item.options.workspaceRoot, access: "ro" }, { path: path.join(item.home, ".aws"), access: "rw" }], /credential|protected/);
  const parent = path.join(item.root, "parent"), workspace = path.join(parent, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  assert.equal(validateFilesystemGrants([{ path: parent, access: "rw" }], { ...item.options, workspaceRoot: workspace })[0].canonicalPath, fs.realpathSync(parent));
});

test("policy refuses a stale validated grant after a symlink moves", (t) => {
  const item = fixture(t), alias = path.join(item.root, "alias"), replacement = path.join(item.root, "replacement");
  fs.mkdirSync(replacement); fs.symlinkSync(item.shared, alias);
  const grants = validateFilesystemGrants([{ path: item.shared, access: "rw" }, { path: alias, access: "ro" }], item.options);
  fs.unlinkSync(alias); fs.symlinkSync(replacement, alias);
  assert.throws(() => buildSrtPolicy({ ...item.options, grants }), /symlink target changed/);
});

test("configured Git identity requires a private regular file directly in the agent directory", (t) => {
  const item = fixture(t), agent = path.join(item.home, ".ssh/agent");
  fs.mkdirSync(agent, { recursive: true });
  const key = path.join(agent, "id_ed25519"); fs.writeFileSync(key, "key", { mode: 0o600 });
  const config = (value) => ({ version: 1, filesystem: { readOnly: [], readWrite: [] }, git: value });
  assert.deepEqual(validateFilesystemConfiguration(config({ sshIdentityFile: "~/.ssh/agent/id_ed25519" }), item.options), []);
  const outside = path.join(item.home, ".ssh/id_ed25519"); fs.writeFileSync(outside, "key", { mode: 0o600 });
  fs.symlinkSync(outside, path.join(agent, "escape"));
  fs.writeFileSync(path.join(agent, "s.socket"), "key", { mode: 0o600 });
  fs.writeFileSync(path.join(agent, "permissive"), "key", { mode: 0o644 });
  fs.mkdirSync(path.join(agent, "nested")); fs.writeFileSync(path.join(agent, "nested/key"), "key", { mode: 0o600 });
  for (const value of [outside, "~/.ssh/agent/escape", "~/.ssh/agent/s.socket", "~/.ssh/agent/permissive", "~/.ssh/agent/nested", "~/.ssh/agent/nested/key", "relative", "~/.ssh/agent/missing"]) {
    assert.throws(() => validateFilesystemConfiguration(config({ sshIdentityFile: value }), item.options), undefined, value);
  }
  assert.throws(() => validateFilesystemConfiguration(config({ sshIdentityFile: key, extra: true }), item.options));
  assert.throws(() => validateFilesystemConfiguration(config({}), item.options));
  assert.throws(() => validateFilesystemConfiguration({ ...config({ sshIdentityFile: key }), extra: true }, item.options));
});

test("file grants compose exact aliases and reject overlaps, protected paths, and patterns", (t) => {
  const item = fixture(t), file = path.join(item.shared, "config file"), alias = path.join(item.root, "file-alias");
  fs.writeFileSync(file, "fixture"); fs.symlinkSync(file, alias);
  const grants = validateFilesystemGrants([{ path: alias, access: "ro" }, { path: file, access: "rw" }], item.options);
  assert.equal(grants[0].targetType, "file");
  const policy = buildSrtPolicy({ ...item.options, grants });
  for (const target of [alias, fs.realpathSync(file)]) {
    assert(policy.filesystem.allowRead.includes(target));
    assert(policy.filesystem.allowWrite.includes(target));
    assert(!policy.filesystem.allowCompleteWorkspaceWrites.includes(target));
  }
  assert(!policy.filesystem.allowRead.includes(item.shared));
  assert(!policy.filesystem.allowWrite.includes(item.shared));
  checkBoth(item, [{ path: item.shared, access: "ro" }, { path: file, access: "rw" }], /overlapping/);
  const workspaceFile = path.join(item.options.workspaceRoot, "file"); fs.writeFileSync(workspaceFile, "x");
  assert.equal(validateFilesystemGrants([{ path: workspaceFile, access: "ro" }], item.options)[0].targetType, "file");
  const secret = path.join(item.home, ".ssh", "key"); fs.mkdirSync(path.dirname(secret)); fs.writeFileSync(secret, "synthetic");
  checkBoth(item, [{ path: secret, access: "ro" }], /credential|protected/);
  for (const character of ["*", "?", "[", "]"]) {
    const patterned = path.join(item.shared, `file${character}`), patternedAlias = path.join(item.root, `alias-${character}`);
    fs.writeFileSync(patterned, "x"); fs.symlinkSync(file, patternedAlias);
    checkBoth(item, [{ path: patternedAlias, access: "ro" }], /pattern/);
    const cleanAlias = path.join(item.root, `clean-${character.charCodeAt(0)}`); fs.symlinkSync(patterned, cleanAlias);
    checkBoth(item, [{ path: cleanAlias, access: "rw" }], /pattern/);
  }
});

test("file snapshots allow regular replacement but reject type changes and special files", (t) => {
  const item = fixture(t), file = path.join(item.shared, "file"), alias = path.join(item.root, "alias");
  fs.writeFileSync(file, "first"); fs.symlinkSync(file, alias);
  const grants = validateFilesystemGrants([{ path: alias, access: "ro" }, { path: file, access: "rw" }], item.options);
  fs.unlinkSync(file); fs.writeFileSync(file, "replacement");
  assert.deepEqual(validateFilesystemGrants(grants, item.options), grants);
  fs.unlinkSync(file); fs.mkdirSync(file);
  assert.throws(() => validateFilesystemGrants(grants, item.options), /target type changed/);
  assert.throws(() => buildSrtPolicy({ ...item.options, grants }), /target type changed/);
  if (process.platform !== "win32") {
    const fifo = path.join(item.root, "fifo");
    const result = requireSpawn("mkfifo", [fifo]);
    if (result.status === 0) checkBoth(item, [{ path: fifo, access: "ro" }], /regular file or directory/);
  }
});
