import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSrtPolicy } from "./srt-policy.mjs";
import { wrapCommandWithSandboxMacOS } from "@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-srt-policy-")));
  const home = path.join(root, "home"), workspace = path.join(home, "workspace"), controller = path.join(root, "controller"), broker = path.join(root, "broker"), tools = path.join(root, "tools");
  for (const item of [workspace, controller, broker, tools, path.join(home, ".local/bin"), path.join(home, ".local/share/uv/tools"), path.join(home, ".local/share/uv/python"), path.join(home, ".local/share/uv/credentials")]) fs.mkdirSync(item, { recursive: true });
  fs.writeFileSync(path.join(home, ".zshrc"), "safe\n");
  // Policy construction checks path identity, not socket liveness. Keep this
  // deterministic unit fixture independent of native socket-bind permissions.
  const socket = path.join(broker, "docker.sock"); fs.writeFileSync(socket, "");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { home, workspace, controller, tools, socket };
}
test("grants complete writes only to trusted roots and exact Unix sockets", async (t) => {
  const item = await fixture(t); const policy = buildSrtPolicy({ home: item.home, workspaceRoot: item.workspace, controllerRoot: item.controller, dockerSocket: item.socket, hostReadManifest: { files: [path.join(item.home, ".zshrc")], roots: [item.tools] } });
  assert(policy.filesystem.allowCompleteWorkspaceWrites.includes(policy.workspaceRoot));
  assert(!policy.filesystem.allowWrite.includes(policy.controllerRoot));
  for (const root of ["/opt/homebrew", "/usr/local", "/usr/bin", "/bin"]) assert(!policy.filesystem.allowWrite.includes(root), root);
  assert.equal(policy.enableWeakerNetworkIsolation, true);
  assert(policy.network.allowUnrestrictedIp); assert(policy.network.allowUnixSockets.includes(fs.realpathSync(item.socket)));
  assert.match(policy.generation, /^[0-9a-f]{64}$/);
});
test("macOS SRT profile adds only the intended trustd lookup when enabled", async (t) => {
  const item = await fixture(t);
  const policy = buildSrtPolicy({ home: item.home, workspaceRoot: item.workspace, controllerRoot: item.controller, dockerSocket: item.socket });
  const options = { command: "true", needsNetworkRestriction: true, allowUnrestrictedIp: true };
  const enabled = wrapCommandWithSandboxMacOS({ ...options, enableWeakerNetworkIsolation: policy.enableWeakerNetworkIsolation });
  const disabled = wrapCommandWithSandboxMacOS(options);
  assert.match(enabled, /\(allow mach-lookup \(global-name "com\.apple\.trustd\.agent"\)\)/);
  assert.doesNotMatch(disabled, /\(allow mach-lookup \(global-name "com\.apple\.trustd\.agent"\)\)/);
});
test("rejects protected grants and permits workspace children", async (t) => {
  const item = await fixture(t);
  fs.mkdirSync(path.join(item.workspace, "nested"));
  assert.throws(() => buildSrtPolicy({ home: item.home, workspaceRoot: item.workspace, controllerRoot: item.controller, dockerSocket: item.socket, grants: [{ path: item.home, access: "ro" }] }), /protected/);
  assert.ok(buildSrtPolicy({ home: item.home, workspaceRoot: item.workspace, controllerRoot: item.controller, dockerSocket: item.socket, grants: [{ path: path.join(item.workspace, "nested"), access: "rw" }] }).filesystem.allowWrite.includes(path.join(item.workspace, "nested")));
  assert.throws(() => buildSrtPolicy({ home: item.home, workspaceRoot: item.workspace, controllerRoot: item.controller, dockerSocket: item.socket, grants: [{ path: path.join(item.home, ".local"), access: "ro" }] }), /user-tool credential/);
  assert.throws(() => buildSrtPolicy({ home: item.home, workspaceRoot: item.workspace, controllerRoot: item.controller, dockerSocket: item.socket, grants: [{ path: path.join(item.home, ".local/share/uv"), access: "ro" }] }), /user-tool credential/);
});
test("keeps user-tool runtime roots read-only and excludes uv credentials", async (t) => {
  const item = await fixture(t);
  const bin = path.join(item.home, ".local/bin"), tools = path.join(item.home, ".local/share/uv/tools"), python = path.join(item.home, ".local/share/uv/python"), credentials = path.join(item.home, ".local/share/uv/credentials");
  const policy = buildSrtPolicy({ home: item.home, workspaceRoot: item.workspace, controllerRoot: item.controller, dockerSocket: item.socket, hostReadManifest: { files: [], roots: [bin, tools, python] } });
  for (const root of [bin, tools, python]) {
    const resolved = fs.realpathSync(root);
    assert(policy.filesystem.allowRead.includes(resolved), root);
    assert(!policy.filesystem.allowWrite.includes(resolved), root);
  }
  assert(!policy.filesystem.allowRead.includes(fs.realpathSync(credentials)));
  assert.throws(() => buildSrtPolicy({ home: item.home, workspaceRoot: item.workspace, controllerRoot: item.controller, dockerSocket: item.socket, hostReadManifest: { files: [], roots: [path.join(item.home, ".local")] } }), /user-tool credential/);
  assert.throws(() => buildSrtPolicy({ home: item.home, workspaceRoot: item.workspace, controllerRoot: item.controller, dockerSocket: item.socket, hostReadManifest: { files: [], roots: [path.join(item.home, ".local/share/uv")] } }), /user-tool credential/);
});

test("private session archives stay denied through folded Stow aliases and broad workspace reads", async (t) => {
  const item = await fixture(t);
  const agentTarget = path.join(item.workspace, "pi/agent");
  fs.mkdirSync(agentTarget, { recursive: true });
  fs.mkdirSync(path.join(item.home, ".pi"));
  fs.symlinkSync(agentTarget, path.join(item.home, ".pi/agent"));
  const policy = buildSrtPolicy({ home: item.home, workspaceRoot: item.workspace, controllerRoot: item.controller, dockerSocket: item.socket });
  for (const root of [path.join(item.home, ".pi/agent/session-archives"), path.join(fs.realpathSync(agentTarget), "session-archives")]) {
    assert.ok(policy.filesystem.denyRead.includes(root));
    assert.ok(policy.filesystem.denyWrite.includes(root));
    assert.ok(!policy.filesystem.allowRead.includes(root));
    assert.ok(!policy.filesystem.allowWrite.includes(root));
  }
});

test("Buzz credential is revalidated and read-only without granting adjacent keys", async (t) => {
  const item = await fixture(t), keys = path.join(item.home, ".config/buzz-bot/keys");
  fs.mkdirSync(keys, { recursive: true, mode: 0o700 });
  const key = path.join(keys, "daniel-suess-local.hex"), other = path.join(keys, "other.hex");
  fs.writeFileSync(key, "fixture", { mode: 0o600 }); fs.writeFileSync(other, "fixture", { mode: 0o600 });
  const options = { home: item.home, workspaceRoot: item.workspace, controllerRoot: item.controller, dockerSocket: item.socket, hostReadManifest: { buzzBotKey: key } };
  const policy = buildSrtPolicy(options);
  assert(policy.filesystem.denyRead.includes(fs.realpathSync(item.home)));
  assert(policy.filesystem.allowRead.includes(key)); assert(!policy.filesystem.allowRead.includes(keys)); assert(!policy.filesystem.allowRead.includes(other));
  assert(!policy.filesystem.allowWrite.includes(key)); assert(!policy.filesystem.allowWrite.includes(keys));
  fs.chmodSync(key, 0o644); assert.throws(() => buildSrtPolicy(options), /Buzz bot key is unsafe/);
  fs.unlinkSync(key); fs.symlinkSync(other, key); assert.throws(() => buildSrtPolicy(options), /Buzz bot key is unsafe/);
});
