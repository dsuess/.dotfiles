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
  for (const item of [workspace, controller, broker, tools]) fs.mkdirSync(item, { recursive: true });
  fs.writeFileSync(path.join(home, ".zshrc"), "safe\n");
  const socket = path.join(broker, "docker.sock"), server = net.createServer(); await new Promise((resolve) => server.listen(socket, resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  return { home, workspace, controller, tools, socket };
}
test("grants complete writes only to trusted roots and exact Unix sockets", async (t) => {
  const item = await fixture(t); const policy = buildSrtPolicy({ home: item.home, workspaceRoot: item.workspace, controllerRoot: item.controller, dockerSocket: item.socket, hostReadManifest: { files: [path.join(item.home, ".zshrc")], roots: [item.tools] } });
  assert(policy.filesystem.allowCompleteWorkspaceWrites.includes(policy.workspaceRoot));
  assert(!policy.filesystem.allowWrite.includes(policy.controllerRoot));
  assert(policy.network.allowUnrestrictedIp); assert(policy.network.allowUnixSockets.includes(fs.realpathSync(item.socket)));
  assert.match(policy.generation, /^[0-9a-f]{64}$/);
});
test("rejects protected and overlapping grants", async (t) => {
  const item = await fixture(t);
  assert.throws(() => buildSrtPolicy({ home: item.home, workspaceRoot: item.workspace, controllerRoot: item.controller, dockerSocket: item.socket, grants: [{ path: item.home, access: "ro" }] }), /protected/);
  assert.throws(() => buildSrtPolicy({ home: item.home, workspaceRoot: item.workspace, controllerRoot: item.controller, dockerSocket: item.socket, grants: [{ path: item.workspace, access: "rw" }] }), /overlaps/);
});
