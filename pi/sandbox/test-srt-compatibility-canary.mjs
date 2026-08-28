import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAllowAllPolicy,
  assertAppAuthenticated,
  assertCanarySandbox,
  assertEmptyMcpRegistry,
  assertStableSbxVersion,
  REVIEWED_SHELL_TEMPLATE,
  fixedSpawnEnvironment,
  MANUAL_LOGIN_COMMAND,
  piSbxArgs,
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
  assert.throws(() => assertCanarySandbox({ ...inspect, mcp_gateway: false }, "/tmp/workspace"), /MCP gateway/);
  assert.throws(() => assertCanarySandbox({ ...inspect, secrets: [...inspect.secrets, { name: "unexpected", source: "uploaded" }] }, "/tmp/workspace"), /unexpected secrets/);
  assert.throws(() => assertCanarySandbox({ ...inspect, image_digest: "sha256:wrong" }, "/tmp/workspace"), /template digest/);
});

test("requires an empty Pi-app MCP registry and unrestricted app policy", () => {
  assert.doesNotThrow(() => assertEmptyMcpRegistry({ gateway: { local: true }, servers: [] }));
  assert.throws(() => assertEmptyMcpRegistry({ servers: [{ name: "host-command" }] }), /remain empty/);
  const allowAll = { rules: [{ scope: "global", resource_type: "network", decision: "allow", resources: ["**"] }] };
  assert.doesNotThrow(() => assertAllowAllPolicy(allowAll));
  assert.throws(() => assertAllowAllPolicy({ rules: [] }), /allow-all/);
  assert.throws(() => assertAllowAllPolicy({ rules: [...allowAll.rules, { resource_type: "network", decision: "deny", resources: ["blocked.example"] }] }), /deny rule/);
});

test("requires the exact reviewed RC and explicit Pi-app authentication", () => {
  const exact = "a6d7101a6c48908b39af0dad0103a2700c85ee4d";
  assert.deepEqual(assertStableSbxVersion(`sbx version: v0.42.0-rc1 ${exact}`), { version: "0.42.0-rc1", commit: exact });
  assert.throws(() => assertStableSbxVersion("sbx version: v0.42.1 a6d7101a6c48908b39af0dad0103a2700c85ee4d"), /exact reviewed/);
  assert.throws(() => assertStableSbxVersion("sbx version: v0.42.0-rc1 b6d7101a6c48908b39af0dad0103a2700c85ee4d"), /exact reviewed/);
  assert.throws(() => assertAppAuthenticated({ code: 1, stdout: "", stderr: "ERROR: Not authenticated to Docker" }), new RegExp(MANUAL_LOGIN_COMMAND));
  assert.doesNotThrow(() => assertAppAuthenticated({ code: 1, stdout: "", stderr: "daemon not reachable" }));
});
