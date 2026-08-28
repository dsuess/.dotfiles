import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSrtPolicy } from "./srt-policy.mjs";

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-srt-policy-"));
  const home = path.join(root, "home"), workspace = path.join(home, "workspace"), controller = path.join(root, "controller"), broker = path.join(root, "broker"), tools = path.join(root, "tools");
  for (const item of [workspace, controller, broker, tools, path.join(home, ".local/bin"), path.join(home, ".local/share/uv/tools"), path.join(home, ".local/share/uv/python"), path.join(home, ".local/share/uv/credentials")]) fs.mkdirSync(item, { recursive: true });
  fs.writeFileSync(path.join(home, ".zshrc"), "safe\n");
  const socket = path.join(broker, "docker.sock"), server = net.createServer(); await new Promise((resolve) => server.listen(socket, resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  return { home, workspace, controller, tools, socket };
}
test("grants complete writes only to trusted roots and exact Unix sockets", async (t) => {
  const item = await fixture(t); const policy = buildSrtPolicy({ home: item.home, workspaceRoot: item.workspace, controllerRoot: item.controller, dockerSocket: item.socket, hostReadManifest: { files: [path.join(item.home, ".zshrc")], roots: [item.tools] } });
  assert(policy.filesystem.allowCompleteWorkspaceWrites.includes(policy.workspaceRoot));
  assert(!policy.filesystem.allowWrite.includes(policy.controllerRoot));
  for (const root of ["/opt/homebrew", "/usr/local", "/usr/bin", "/bin"]) assert(!policy.filesystem.allowWrite.includes(root), root);
  assert(policy.network.allowUnrestrictedIp); assert(policy.network.allowUnixSockets.includes(fs.realpathSync(item.socket)));
  assert.match(policy.generation, /^[0-9a-f]{64}$/);
});
test("rejects protected and overlapping grants", async (t) => {
  const item = await fixture(t);
  assert.throws(() => buildSrtPolicy({ home: item.home, workspaceRoot: item.workspace, controllerRoot: item.controller, dockerSocket: item.socket, grants: [{ path: item.home, access: "ro" }] }), /protected/);
  assert.throws(() => buildSrtPolicy({ home: item.home, workspaceRoot: item.workspace, controllerRoot: item.controller, dockerSocket: item.socket, grants: [{ path: item.workspace, access: "rw" }] }), /overlaps/);
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
