import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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

test("lexical and canonical workspace/controller aliases and home ancestors are excluded", (t) => {
  const item = fixture(t);
  for (const key of ["workspaceRoot", "controllerRoot"]) {
    const alias = path.join(item.root, `${key}-alias`); fs.symlinkSync(item.options[key], alias);
    checkBoth(item, [{ path: alias, access: "rw" }], /workspace|controller/);
    const child = path.join(item.options[key], "child"); fs.mkdirSync(child);
    checkBoth(item, [{ path: child, access: "ro" }], /workspace|controller/);
  }
  checkBoth(item, [{ path: item.root, access: "ro" }], /protected/);
  checkBoth(item, [{ path: path.parse(item.root).root, access: "rw" }], /protected/);
});

test("bounds, directory-only scope, and lexical/canonical overlaps apply to policy and saved config", (t) => {
  const item = fixture(t), child = path.join(item.shared, "child"), alias = path.join(item.root, "alias");
  fs.mkdirSync(child); fs.symlinkSync(item.shared, alias);
  for (const grants of [
    [{ path: item.shared, access: "ro" }, { path: alias, access: "rw" }],
    [{ path: alias, access: "ro" }, { path: child, access: "rw" }],
    [{ path: item.shared, access: "rw" }, { path: child, access: "ro" }],
  ]) checkBoth(item, grants, /duplicate or overlapping/);
  for (const value of ["", "relative", "~user/path", "a".repeat(4097), `${item.shared}\0`, `${item.shared}\n`]) checkBoth(item, [{ path: value, access: "ro" }], /path/);
  checkBoth(item, [{ path: item.options.dockerSocket, access: "rw" }], /not a directory/);
  checkBoth(item, Array.from({ length: 33 }, () => ({ path: item.shared, access: "ro" })), /bounded/);
  checkBoth(item, Array.from({ length: 33 }, (_, index) => ({ path: item.shared, access: index < 16 ? "ro" : "rw" })), /bounded/);
  assert.throws(() => validateFilesystemGrants([{ path: item.shared, access: "execute" }], item.options), /ro or rw/);
});

test("policy refuses a stale validated grant after a symlink moves", (t) => {
  const item = fixture(t), alias = path.join(item.root, "alias"), replacement = path.join(item.root, "replacement");
  fs.mkdirSync(replacement); fs.symlinkSync(item.shared, alias);
  const grants = validateFilesystemGrants([{ path: alias, access: "ro" }], item.options);
  fs.unlinkSync(alias); fs.symlinkSync(replacement, alias);
  assert.throws(() => buildSrtPolicy({ ...item.options, grants }), /symlink target changed/);
});
