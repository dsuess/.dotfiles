import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertAllowAllPolicy,
  assertAppAuthenticated,
  assertCanarySandbox,
  assertEmptyMcpRegistry,
  dialPiDockerPing,
  REVIEWED_SHELL_TEMPLATE,
  fixedSpawnEnvironment,
  MANUAL_LOGIN_COMMAND,
  piSbxArgs,
  sbxVersionDiagnostic,
} from "./srt-compatibility-canary.mjs";

test("uses only the fixed Pi app namespace and strips ambient authority", () => {
  assert.deepEqual(piSbxArgs(["exec", "-i", "pi-workspace", "docker", "system", "dial-stdio"]), [
    "--app-name", "pi-srt", "exec", "-i", "pi-workspace", "docker", "system", "dial-stdio",
  ]);
  assert.throws(() => piSbxArgs(["ls\0"]), /invalid/);
  assert.deepEqual(fixedSpawnEnvironment({ PATH: "/reviewed", HOME: "/home/test", SSH_AUTH_SOCK: "/agent", SBX_FOO: "x", DOCKER_HOST: "x", GH_TOKEN: "x", PI_PROJECT: "x" }), {
    PATH: "/reviewed", HOME: "/home/test",
  });
});

test("accepts only the user-approved MCP gateway and rejects other sidecar drift", () => {
  const digest = REVIEWED_SHELL_TEMPLATE.slice("docker.io/docker/sandbox-templates@".length);
  const inspect = { agent: "shell", image_digest: digest, workspace: "/tmp/workspace", kits: [], secrets: [{ name: "mcpgateway", source: "uploaded" }], mcp_gateway: true, sessions: 0, network_policy: { scope: "global" } };
  assert.doesNotThrow(() => assertCanarySandbox(inspect, "/tmp/workspace"));
  assert.throws(() => assertCanarySandbox({ ...inspect, agent: "coding-agent" }, "/tmp/workspace"), /shell agent/);
  assert.throws(() => assertCanarySandbox({ ...inspect, mcp_gateway: false }, "/tmp/workspace"), /MCP gateway/);
  assert.throws(() => assertCanarySandbox({ ...inspect, kits: ["host-kit"] }, "/tmp/workspace"), /kits are forbidden/);
  assert.throws(() => assertCanarySandbox({ ...inspect, secrets: [...inspect.secrets, { name: "unexpected", source: "uploaded" }] }, "/tmp/workspace"), /unexpected secrets/);
  assert.throws(() => assertCanarySandbox({ ...inspect, sessions: 1 }, "/tmp/workspace"), /unexpected session/);
  assert.throws(() => assertCanarySandbox({ ...inspect, workspace: "/tmp/other" }, "/tmp/workspace"), /workspace mount/);
  assert.throws(() => assertCanarySandbox({ ...inspect, image_digest: "sha256:wrong" }, "/tmp/workspace"), /template digest/);
  assert.throws(() => assertCanarySandbox({ ...inspect, network_policy: { scope: "sandbox" } }, "/tmp/workspace"), /app-global policy/);
});

test("requires an empty Pi-app MCP registry and unrestricted app policy", () => {
  assert.doesNotThrow(() => assertEmptyMcpRegistry({ gateway: { local: true }, servers: [] }));
  assert.throws(() => assertEmptyMcpRegistry({ servers: [{ name: "host-command" }] }), /remain empty/);
  const allowAll = { rules: [{ scope: "global", resource_type: "network", decision: "allow", resources: ["**"] }] };
  assert.doesNotThrow(() => assertAllowAllPolicy(allowAll));
  assert.throws(() => assertAllowAllPolicy({ rules: [] }), /allow-all/);
  assert.throws(() => assertAllowAllPolicy({ rules: [...allowAll.rules, { resource_type: "network", decision: "deny", resources: ["blocked.example"] }] }), /deny rule/);
});

test("accepts sbx release drift but still requires command availability and Pi-app authentication", () => {
  assert.equal(sbxVersionDiagnostic({
    code: 0, stdout: "sbx version: v0.42.0-rc1 (legacy-build)\n", stderr: "",
  }), "sbx version: v0.42.0-rc1 (legacy-build)");
  assert.equal(sbxVersionDiagnostic({
    code: 0, stdout: "Docker Sandboxes v0.50.3 (build newer-release)\n", stderr: "",
  }), "Docker Sandboxes v0.50.3 (build newer-release)");
  assert.throws(() => sbxVersionDiagnostic({ code: 1, stdout: "", stderr: "unknown command: version" }), /sbx version failed/);
  assert.throws(() => sbxVersionDiagnostic({ code: 0, stdout: "", stderr: "" }), /no diagnostic output/);
  assert.throws(() => assertAppAuthenticated({ code: 1, stdout: "", stderr: "ERROR: Not authenticated to Docker" }), new RegExp(MANUAL_LOGIN_COMMAND));
  assert.throws(() => assertAppAuthenticated({
    code: 1, stdout: "", stderr: "401 Unauthorized: no valid user session found",
  }), new RegExp(MANUAL_LOGIN_COMMAND));
  assert.doesNotThrow(() => assertAppAuthenticated({ code: 1, stdout: "", stderr: "daemon not reachable" }));
});

function fakeSbxExecutable(t, stdout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sbx-dial-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "sbx");
  fs.writeFileSync(executable, [
    `#!${process.execPath}`,
    "process.stdin.resume();",
    `process.stdin.on(\"end\", () => process.stdout.write(${JSON.stringify(stdout)}));`,
    "",
  ].join("\n"));
  fs.chmodSync(executable, 0o755);
  return executable;
}

test("Docker Engine dial rejects stdout contamination and missing protocol fields", async (t) => {
  const response = "HTTP/1.1 200 OK\r\nAPI-Version: 1.47\r\nContent-Length: 2\r\n\r\nOK";
  await assert.doesNotReject(() => dialPiDockerPing("pi-srt-canary", {
    executable: fakeSbxExecutable(t, response),
  }));
  await assert.rejects(() => dialPiDockerPing("pi-srt-canary", {
    executable: fakeSbxExecutable(t, `sandbox ready\n${response}`),
  }), /stdout was contaminated/);
  await assert.rejects(() => dialPiDockerPing("pi-srt-canary", {
    executable: fakeSbxExecutable(t, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK"),
  }), /omitted API-Version/);
});
