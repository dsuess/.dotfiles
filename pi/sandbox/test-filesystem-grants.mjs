import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadFilesystemGrants } from "./filesystem-grants.mjs";
import { buildSrtPolicy } from "./srt-policy.mjs";
import { sourceDigest } from "./capability.mjs";
import { clientInternals } from "./client.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-filesystem-grants-"));
  const home = path.join(root, "home"), workspace = path.join(root, "workspace"), controller = path.join(root, "controller"), broker = path.join(root, "broker");
  const shared = path.join(root, "shared"), config = path.join(root, "config.json"), socket = path.join(broker, "docker.sock");
  for (const directory of [home, workspace, controller, broker, shared]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(socket, "");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function load(value) { fs.writeFileSync(config, JSON.stringify(value)); return loadFilesystemGrants({ configPath: config, home, workspaceRoot: workspace, controllerRoot: controller }); }
  return { root, home, workspace, controller, shared, socket, load };
}
function config(readOnly = [], readWrite = []) { return { version: 1, filesystem: { readOnly, readWrite } }; }

test("loads strict home-relative grants and retains a Stow-style lexical alias", (t) => {
  const item = fixture(t);
  fs.symlinkSync(item.shared, path.join(item.home, ".agents"));
  const grants = item.load(config(["~/.agents"]));
  const lexical = path.join(fs.realpathSync(item.home), ".agents"), canonical = fs.realpathSync(item.shared);
  assert.deepEqual(grants, [{ path: lexical, canonicalPath: canonical, access: "ro" }]);
  const policy = buildSrtPolicy({ home: item.home, workspaceRoot: item.workspace, controllerRoot: item.controller, dockerSocket: item.socket, grants });
  assert(policy.filesystem.allowRead.includes(lexical));
  assert(policy.filesystem.allowRead.includes(canonical));
  assert(!policy.filesystem.allowWrite.includes(lexical));
});

test("read-write grants imply read and write without workspace-write exceptions", (t) => {
  const item = fixture(t);
  const grants = item.load(config([], [item.shared]));
  const policy = buildSrtPolicy({ home: item.home, workspaceRoot: item.workspace, controllerRoot: item.controller, dockerSocket: item.socket, grants });
  assert(policy.filesystem.allowRead.includes(item.shared));
  assert(policy.filesystem.allowWrite.includes(item.shared));
  assert(!policy.filesystem.allowCompleteWorkspaceWrites.includes(item.shared));
});

test("configuration bytes do not replace the controller, while protocol source still does", (t) => {
  const sources = clientInternals.controllerSourceFiles;
  assert.equal(sources.some((file) => file.endsWith(`${path.sep}config.json`)), false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-digest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configCopy = path.join(root, "config.json");
  fs.writeFileSync(configCopy, "{}\n");
  const before = sourceDigest(sources);
  fs.appendFileSync(configCopy, "\n");
  assert.equal(sourceDigest(sources), before);
  const protocol = sources.find((file) => file.endsWith(`${path.sep}protocol.mjs`));
  const codeCopy = path.join(root, "protocol.mjs");
  fs.copyFileSync(protocol, codeCopy);
  const files = sources.map((file) => file === protocol ? codeCopy : file);
  const codeBefore = sourceDigest(files);
  fs.appendFileSync(codeCopy, "\n");
  assert.notEqual(sourceDigest(files), codeBefore);
});

test("fails closed for missing, malformed, duplicate, overlapping, and unsafe grants", (t) => {
  const item = fixture(t);
  assert.throws(() => loadFilesystemGrants({ configPath: path.join(item.root, "missing.json"), home: item.home, workspaceRoot: item.workspace, controllerRoot: item.controller }), /missing/);
  assert.throws(() => item.load({ version: 1, filesystem: { readOnly: [] }, extra: true }), /invalid shape/);
  assert.throws(() => item.load(config(["relative"])), /absolute or home-relative/);
  assert.throws(() => item.load(config([item.shared, item.shared])), /duplicate or overlapping/);
  assert.throws(() => item.load(config([item.shared], [item.shared])), /duplicate or overlapping/);
  assert.throws(() => item.load(config([item.root])), /protected|workspace|controller/);
  assert.throws(() => item.load(config([item.workspace])), /workspace/);
  assert.throws(() => item.load(config([item.controller])), /controller/);
  assert.throws(() => item.load(config([path.join(item.home, ".ssh")])), /directory does not exist|credential/);
  fs.mkdirSync(path.join(item.home, ".ssh"));
  assert.throws(() => item.load(config([path.join(item.home, ".ssh")])), /credential/);
  assert.throws(() => item.load(config([path.join(item.root, "missing")])), /does not exist/);
});
