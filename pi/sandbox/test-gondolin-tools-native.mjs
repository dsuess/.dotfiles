import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureGondolinImage } from "./build-gondolin-image.mjs";
import { ensureControllerLease } from "./client.mjs";

const piRoot = process.env.PI_PACKAGE_ROOT || "/opt/homebrew/Cellar/pi-coding-agent/0.84.2/libexec/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${piRoot}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": `${piRoot}/dist/index.js`,
  "@earendil-works/pi-tui": `${piRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`,
  "@earendil-works/pi-ai": `${piRoot}/node_modules/@earendil-works/pi-ai/dist/index.js`,
  typebox: `${piRoot}/node_modules/typebox/build/index.mjs`,
} });
const { registerSandboxTools } = await jiti.import(
  new URL("../agent/extensions/gondolin-sandbox/tools.ts", import.meta.url).pathname,
);

function settings() {
  return {
    version: 1,
    externalMounts: [],
    network: {
      mode: "public-http",
      allowedHosts: [],
      allowWebSockets: false,
      tcpMappings: [],
    },
  };
}

test("all seven Pi replacements execute through one native controller VM", { timeout: 180_000 }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-gondolin-tools-native-")));
  const workspace = path.join(root, "workspace");
  const settingsPath = path.join(root, "settings.json");
  fs.mkdirSync(workspace);
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings(), null, 2)}\n`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const image = await ensureGondolinImage({ verbose: false });
  const lease = await ensureControllerLease({
    launchDirectory: workspace,
    settingsPath,
    cacheRoot: path.join(root, "cache"),
    runtimeRoot: path.join(root, "runtime"),
    imageDir: image.imageDir,
    heartbeatIntervalMs: 100,
    startTimeoutMs: 150_000,
  });
  t.after(() => lease.client.release().catch(() => {}));

  const tools = new Map();
  registerSandboxTools(
    { registerTool: (definition) => tools.set(definition.name, definition) },
    { cwd: workspace, getClient: () => lease.client },
  );
  const execute = (name, params, signal) =>
    tools.get(name).execute(`${name}-native`, params, signal, undefined, { cwd: workspace });

  await execute("write", { path: "sample.txt", content: "alpha\nbeta\n" });
  const read = await execute("read", { path: "sample.txt" });
  assert.match(read.content[0].text, /alpha\nbeta/);

  await execute("edit", {
    path: "sample.txt",
    edits: [{ oldText: "beta", newText: "gamma" }],
  });
  assert.equal(fs.readFileSync(path.join(workspace, "sample.txt"), "utf8"), "alpha\ngamma\n");

  const listed = await execute("ls", { path: "." });
  assert.match(listed.content[0].text, /sample\.txt/);
  const grep = await execute("grep", { pattern: "gamma", path: "." });
  assert.match(grep.content[0].text, /sample\.txt:2: gamma/);
  const found = await execute("find", { pattern: "*.txt", path: "." });
  assert.match(found.content[0].text, /^sample\.txt/m);

  const bash = await execute("bash", { command: "printf bash-ok; printf err-ok >&2" });
  assert.match(bash.content[0].text, /bash-ok/);
  assert.match(bash.content[0].text, /err-ok/);
  const rtk = await execute("bash", { command: "rtk --version" });
  assert.match(rtk.content[0].text, /rtk/i);

  const status = await lease.client.status();
  assert.equal(status.vmId, lease.status.vmId);
  assert.equal(status.attachedRoots, 1);
});
