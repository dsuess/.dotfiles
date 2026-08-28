import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireControllerLease, beginControllerStartup, stopStartedController } from "./client.mjs";

async function acquire(startup, name) {
  return acquireControllerLease({ startup, clientId: name });
}

test("controller publishes a private manifest, shares root leases, and frames helper results", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-srt-controller-"));
  fs.writeFileSync(path.join(workspace, "input.txt"), "controller result\n");
  const startup = beginControllerStartup({ launchDirectory: workspace });
  t.after(() => { stopStartedController(startup); fs.rmSync(workspace, { recursive: true, force: true }); });
  const first = await acquire(startup, "first");
  const second = await acquire(startup, "second");
  assert.equal(first.status.workspaceRoot, fs.realpathSync(workspace));
  assert.equal(first.status.sidecarId, null, "readiness must not create a Docker sidecar");
  const manifest = JSON.parse(fs.readFileSync(startup.manifestPath, "utf8"));
  assert.match(manifest.tokenDigest, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(manifest).includes(startup.token), false, "manifest never persists the token");
  const read = await first.client.readFile(path.join(workspace, "input.txt"));
  assert.equal(read.data.toString(), "controller result\n");
  await first.client.release();
  assert.equal((await second.client.status()).attachedRoots, 1);
  await second.client.release();
});

test("controller forwards ordinary secret values but strips control authority", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-srt-environment-"));
  const startup = beginControllerStartup({ launchDirectory: workspace });
  t.after(() => { stopStartedController(startup); fs.rmSync(workspace, { recursive: true, force: true }); });
  const attached = await acquire(startup, "environment");
  const chunks = [];
  await attached.client.exec(["/bin/bash", "-lc", "printf '%s|%s|%s|' \"$SYNTHETIC_SECRET\" \"${PI_SRT_ROUTING_TOKEN-unset}\" \"${SSH_AUTH_SOCK-unset}\"; if [ \"$PATH\" = request-path ]; then printf request-path; else printf controller-path; fi"], {
    cwd: workspace, env: { SYNTHETIC_SECRET: "raw-secret-value", PI_SRT_ROUTING_TOKEN: "must-not-cross", SSH_AUTH_SOCK: "/private/agent", PATH: "request-path" },
    onEvent: (stream, data) => { if (stream === "stdout") chunks.push(data); },
  });
  assert.equal(Buffer.concat(chunks).toString(), "raw-secret-value|||controller-path");
  await attached.client.release();
});

test("controller inherits its startup PATH, keeps Docker first, and confines user tools", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-srt-path-"));
  const workspaceBin = path.join(workspace, "bin");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-srt-home-"));
  for (const directory of [workspaceBin, path.join(home, ".local/bin"), path.join(home, ".local/share/uv/tools"), path.join(home, ".local/share/uv/python"), path.join(home, ".local/share/uv/credentials"), path.join(home, ".serena")]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(workspaceBin, "workspace-tool"), "#!/bin/sh\nprintf workspace-tool\n"); fs.chmodSync(path.join(workspaceBin, "workspace-tool"), 0o755);
  fs.writeFileSync(path.join(home, ".serena/serena_config.yml"), "project: generated-copy\n");
  const originalHome = process.env.HOME, originalPath = process.env.PATH;
  const inheritedPath = `${workspaceBin}:${originalPath}`;
  let startup;
  try {
    process.env.HOME = home;
    process.env.PATH = inheritedPath;
    startup = beginControllerStartup({ launchDirectory: workspace });
  } finally {
    process.env.HOME = originalHome;
    process.env.PATH = originalPath;
  }
  t.after(() => { stopStartedController(startup); fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });
  const output = execFileSync(process.execPath, [new URL("./client-cli.mjs", import.meta.url).pathname, "bash", Buffer.from(JSON.stringify(startup)).toString("base64"), workspace, "printf '%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n' \"$PATH\" \"$UV_TOOL_BIN_DIR\" \"$UV_TOOL_DIR\" \"$UV_PYTHON_INSTALL_DIR\" \"$(command -v workspace-tool)\" \"$(command -v docker)\" \"$(cat \"$HOME/.serena/serena_config.yml\")\"; if printf blocked > \"$UV_TOOL_DIR/write-test\"; then printf writable; else printf readonly; fi"], { encoding: "utf8" }).trimEnd().split("\n");
  assert.equal(output[0], `${path.dirname(output[5])}:${inheritedPath}`);
  assert.equal(output[1], fs.realpathSync(path.join(home, ".local/bin")));
  assert.equal(output[2], fs.realpathSync(path.join(home, ".local/share/uv/tools")));
  assert.equal(output[3], fs.realpathSync(path.join(home, ".local/share/uv/python")));
  assert.equal(output[4], path.join(workspaceBin, "workspace-tool"));
  assert.match(output[5], /\/docker$/);
  assert.equal(output[6], "project: generated-copy");
  assert.match(output.slice(7).join("\n"), /^readonly/);
});

test("controller cancels a process group on timeout", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-srt-timeout-"));
  const startup = beginControllerStartup({ launchDirectory: workspace });
  t.after(() => { stopStartedController(startup); fs.rmSync(workspace, { recursive: true, force: true }); });
  const attached = await acquire(startup, "timeout");
  const result = await attached.client.exec(["/bin/bash", "-lc", "trap '' TERM; sleep 10"], {
    cwd: workspace, timeoutMs: 50, maxOutputBytes: 1024,
  });
  assert.equal(result.cancelled, true);
  await attached.client.release();
});

test("controller gives Buildx writable state without making Docker configuration writable", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-srt-buildx-state-"));
  const startup = beginControllerStartup({ launchDirectory: workspace });
  t.after(() => { stopStartedController(startup); fs.rmSync(workspace, { recursive: true, force: true }); });
  const attached = await acquire(startup, "buildx-state");
  const chunks = [];
  const result = await attached.client.exec(["/bin/bash", "-lc", "printf '%s\\n%s\\n' \"$BUILDX_CONFIG\" \"$DOCKER_CONFIG\"; mkdir -p \"$BUILDX_CONFIG/state/nested\"; printf mutable > \"$BUILDX_CONFIG/state/nested/value\"; if printf tampered > \"$DOCKER_CONFIG/config.json\"; then printf config-writable; else printf config-protected; fi; printf '\\n'; if rm \"$DOCKER_CONFIG/cli-plugins/docker-buildx\"; then printf plugin-writable; else printf plugin-protected; fi"], {
    cwd: workspace, env: { BUILDX_CONFIG: path.join(workspace, "caller-selected-buildx") },
    onEvent: (stream, data) => { if (stream === "stdout") chunks.push(data); },
  });
  assert.equal(result.exitCode, 0);
  const [buildxConfig, dockerConfig, configResult, pluginResult] = Buffer.concat(chunks).toString().split("\n");
  assert.notEqual(buildxConfig, path.join(workspace, "caller-selected-buildx"));
  assert.notEqual(buildxConfig, dockerConfig);
  assert.ok(path.relative(startup.runtimeRoot, buildxConfig).startsWith(`..${path.sep}`), "Buildx state must be outside controller state");
  assert.equal(fs.statSync(buildxConfig).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(path.join(buildxConfig, "state/nested/value"), "utf8"), "mutable");
  assert.equal(fs.readFileSync(path.join(dockerConfig, "config.json"), "utf8"), "{}\n");
  assert.deepEqual(fs.readdirSync(path.join(dockerConfig, "cli-plugins")).sort(), ["docker-buildx", "docker-compose"]);
  assert.equal(configResult, "config-protected");
  assert.equal(pluginResult, "plugin-protected");
  await attached.client.release();
});
