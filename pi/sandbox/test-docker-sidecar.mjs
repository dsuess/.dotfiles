import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { REVIEWED_SHELL_TEMPLATE } from "./srt-compatibility-canary.mjs";
import { WorkspaceDockerSidecar, dockerSidecarInternals, validateSidecarInspect } from "./docker-sidecar.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sidecar-"));
  const workspace = path.join(root, "workspace"); const runtime = path.join(root, "runtime");
  fs.mkdirSync(workspace); fs.mkdirSync(runtime);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace, runtime, key: "a".repeat(64) };
}

function inspect(name, workspace) {
  return {
    id: "stable-sidecar-id", name, agent: "shell",
    image_digest: REVIEWED_SHELL_TEMPLATE.slice("docker.io/docker/sandbox-templates@".length),
    workspace, kits: [], secrets: [{ name: "mcpgateway", source: "uploaded" }], mcp_gateway: true,
    sessions: 0, network_policy: { scope: "global" }, cpus: 2, memory: "4g", ports: [],
  };
}

test("creates one validated, keyed sidecar and persists only its ownership contract", async (t) => {
  const item = fixture(t); let current = null; const commands = [];
  const sidecar = new WorkspaceDockerSidecar({
    workspaceKey: item.key, workspaceRoot: item.workspace, runtimeRoot: item.runtime, preflight: async () => {},
    sbx: async (args) => {
      commands.push(args);
      if (args[0] === "create") { current = inspect(`pi-srt-${item.key.slice(0, 24)}`, fs.realpathSync(item.workspace)); return { code: 0, stdout: "", stderr: "" }; }
      if (args[0] === "inspect") return current ? { code: 0, stdout: JSON.stringify(current), stderr: "" } : { code: 1, stdout: "", stderr: "missing" };
      throw new Error(`unexpected sbx command: ${args.join(" ")}`);
    },
  });
  const ownership = await sidecar.ensure();
  assert.equal(ownership.id, "stable-sidecar-id");
  assert.equal(ownership.appName, "pi-srt");
  assert.match(ownership.ownershipDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(commands[1].slice(0, 9), ["create", "--name", sidecar.name, "--cpus", "2", "--memory", "4g", "--template", REVIEWED_SHELL_TEMPLATE]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(item.runtime, "sidecar.json"), "utf8")).name, sidecar.name);
});

test("rejects capability and identity drift before it can be reused", (t) => {
  const item = fixture(t); const name = dockerSidecarInternals.safeWorkspaceName(item.key);
  const workspace = fs.realpathSync(item.workspace);
  assert.throws(() => validateSidecarInspect({ ...inspect(name, workspace), ports: [{ port: 80 }] }, { name, workspaceRoot: workspace, cpus: 2, memory: "4g" }), /unexpected published ports/);
  assert.throws(() => validateSidecarInspect({ ...inspect(name, workspace), skills: { shared: true } }, { name, workspaceRoot: workspace, cpus: 2, memory: "4g" }), /shared skills/);
  assert.throws(() => dockerSidecarInternals.safeWorkspaceName("bad"), /workspace key/);
});

test("resolves stable sidecar ID from dedicated-app inventory when inspect omits it", async (t) => {
  const item = fixture(t); const name = dockerSidecarInternals.safeWorkspaceName(item.key); const workspace = fs.realpathSync(item.workspace);
  const withoutId = inspect(name, workspace); delete withoutId.id;
  const sidecar = new WorkspaceDockerSidecar({
    workspaceKey: item.key, workspaceRoot: workspace, runtimeRoot: item.runtime, preflight: async () => {},
    sbx: async (args) => {
      if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify(withoutId), stderr: "" };
      if (args[0] === "ls") return { code: 0, stdout: JSON.stringify({ sandboxes: [{ name, id: "inventory-id", workspaces: [workspace] }] }), stderr: "" };
      throw new Error(`unexpected sbx command: ${args.join(" ")}`);
    },
  });
  assert.equal((await sidecar.inspect()).id, "inventory-id");
});
