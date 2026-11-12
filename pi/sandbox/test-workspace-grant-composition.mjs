import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClientPolicies } from "./client-policy.mjs";
import { createFilesystemConfigurationService } from "./filesystem-configuration.mjs";
import { validateFilesystemConfiguration, validateFilesystemGrants } from "./filesystem-grants.mjs";
import { buildSrtPolicy } from "./srt-policy.mjs";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workspace-grants-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), parent = path.join(home, "src"), workspaceRoot = path.join(parent, "polez"), outside = path.join(home, "other"), controllerRoot = path.join(root, "controller"), dockerSocket = path.join(root, "docker.sock"), configPath = path.join(root, "config.json");
  for (const dir of [workspaceRoot, outside, controllerRoot]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dockerSocket, "fixture");
  const options = { home, workspaceRoot, controllerRoot, dockerSocket, configPath };
  return { root, home, parent, workspaceRoot, outside, options, configPath };
}
function config(readOnly = [], readWrite = []) { return { version: 1, filesystem: { readOnly, readWrite } }; }

test("saved src parent composes with workspace without widening read-only authority", (t) => {
  const f = fixture(t), alias = path.join(f.root, "src-alias"); fs.symlinkSync(f.parent, alias);
  for (const access of ["ro", "rw"]) {
    const saved = config(access === "ro" ? ["~/src"] : [], access === "rw" ? ["~/src"] : []);
    const grants = validateFilesystemConfiguration(saved, f.options);
    const policy = buildSrtPolicy({ ...f.options, grants });
    assert(policy.filesystem.allowRead.includes(f.parent));
    assert.equal(policy.filesystem.allowWrite.includes(f.parent), access === "rw");
    assert(policy.filesystem.allowWrite.includes(f.workspaceRoot));
    assert(!policy.filesystem.allowCompleteWorkspaceWrites.includes(f.parent));
    const aliasPolicy = buildSrtPolicy({ ...f.options, grants: [{ path: alias, access }] });
    assert.equal(aliasPolicy.filesystem.allowWrite.includes(alias), access === "rw");
  }
});

test("workspace child directory and file aliases inherit workspace writes only there", (t) => {
  const f = fixture(t), dir = path.join(f.workspaceRoot, "child"), file = path.join(f.workspaceRoot, "file"), workspaceAlias = path.join(f.root, "workspace-alias");
  fs.mkdirSync(dir); fs.writeFileSync(file, "fixture"); fs.symlinkSync(f.workspaceRoot, workspaceAlias);
  for (const [target, type] of [[dir, "directory"], [file, "file"]]) {
    const alias = path.join(f.root, `alias-${type}`); fs.symlinkSync(target, alias);
    const grants = validateFilesystemGrants([{ path: alias, access: "ro" }], f.options);
    assert.equal(grants[0].targetType, type);
    const policy = buildSrtPolicy({ ...f.options, grants });
    for (const spelling of [target, alias]) {
      assert(policy.filesystem.allowRead.includes(spelling));
      assert(policy.filesystem.allowWrite.includes(spelling));
      assert(!policy.filesystem.allowCompleteWorkspaceWrites.includes(spelling));
    }
    const lexicalChild = path.join(workspaceAlias, path.basename(target));
    const lexicalPolicy = buildSrtPolicy({ ...f.options, grants: [{ path: lexicalChild, access: "ro" }] });
    assert(lexicalPolicy.filesystem.allowWrite.includes(lexicalChild));
    const external = buildSrtPolicy({ ...f.options, workspaceRoot: f.outside, grants });
    for (const spelling of [target, alias]) {
      assert(external.filesystem.allowRead.includes(spelling));
      assert(!external.filesystem.allowWrite.includes(spelling));
    }
  }
});

test("workspace overlap never bypasses protected paths or saved-grant overlap checks", (t) => {
  const f = fixture(t), secret = path.join(f.home, ".ssh"), secretChild = path.join(secret, "child");
  fs.mkdirSync(secretChild, { recursive: true });
  for (const [workspaceRoot, target] of [[f.home, secret], [secret, secret], [secret, secretChild]]) {
    assert.throws(() => validateFilesystemGrants([{ path: target, access: "ro" }], { ...f.options, workspaceRoot }), /credential|protected/);
  }
  const alias = path.join(f.home, ".aws"); fs.symlinkSync(f.workspaceRoot, alias);
  assert.throws(() => validateFilesystemGrants([{ path: alias, access: "rw" }], f.options), /credential|protected/);
  fs.unlinkSync(alias);
  const child = path.join(f.workspaceRoot, "child"); fs.mkdirSync(child);
  assert.throws(() => validateFilesystemGrants([{ path: f.parent, access: "rw" }, { path: child, access: "ro" }], f.options), /overlapping/);
  assert.throws(() => validateFilesystemGrants([{ path: f.options.controllerRoot, access: "rw" }], { ...f.options, workspaceRoot: f.options.controllerRoot }), /controller/);
});

test("startup, edits and refresh preserve saved authority and client snapshots", async (t) => {
  const f = fixture(t), child = path.join(f.workspaceRoot, "child"), alias = path.join(f.root, "child-alias");
  fs.mkdirSync(child); fs.symlinkSync(child, alias);
  const originalBytes = Buffer.from(JSON.stringify(config(["~/src"])) + "\n"); fs.writeFileSync(f.configPath, originalBytes);
  const configuration = createFilesystemConfigurationService(f.options);
  const policies = new ClientPolicies({ configuration, validation: f.options, buildPolicy: (grants) => buildSrtPolicy({ ...f.options, grants }) });
  const first = {}, sibling = {}, initial = policies.capture(first), siblingInitial = policies.capture(sibling);
  assert.deepEqual(fs.readFileSync(f.configPath), originalBytes);
  assert(initial.policy.filesystem.allowWrite.includes(f.workspaceRoot));
  assert(!initial.policy.filesystem.allowWrite.includes(f.parent));
  async function apply(change) {
    const candidate = configuration.prepare(change), prepared = policies.prepare(first, candidate);
    const saved = await configuration.commit(candidate); policies.activate(first, prepared.preparation, saved.revision);
    return saved;
  }
  await apply({ type: "add", path: f.outside, access: "rw" });
  assert.deepEqual(configuration.read().config.filesystem, { readOnly: ["~/src"], readWrite: [f.outside] });
  await apply({ type: "remove", path: f.outside });
  assert.deepEqual(configuration.read().config.filesystem.readOnly, ["~/src"]);
  // Remove the parent before adding a child: non-identical saved grants remain disjoint.
  await apply({ type: "remove", path: "~/src" });
  await apply({ type: "add", path: alias, access: "ro" });
  assert(policies.capture(first).policy.filesystem.allowWrite.includes(alias));
  assert.equal(policies.capture(sibling), siblingInitial);
  assert.deepEqual(configuration.read().config.filesystem.readOnly, [alias]);
  await apply({ type: "remove", path: child });
  assert(policies.capture(first).policy.filesystem.allowWrite.includes(f.workspaceRoot));
  assert.deepEqual(policies.capture(sibling).configuration.config.filesystem.readOnly, ["~/src"]);
  const saved = configuration.read(), refresh = policies.prepare(sibling, saved);
  policies.activate(sibling, refresh.preparation, saved.revision);
  assert.deepEqual(policies.capture(sibling).configuration.config.filesystem.readOnly, []);
  assert(policies.capture(sibling).policy.filesystem.allowWrite.includes(f.workspaceRoot));
});
