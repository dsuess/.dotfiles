import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readReviewedSerena, validateReviewedEntry, SERENA_PROFILE, SERENA_TOOLS } from "./serena-profile.mjs";

function fixture(t) {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "serena-profile-")));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const config = { command: ".dev/run-serena-mcp.sh", args: ["pi"], env: { SERENA_USAGE_REPORTING: "false" }, exposure: "deferred", toolExposure: Object.fromEntries(SERENA_TOOLS.map((name) => [name, "direct"])) };
  const files = { ".pi/mcp.json": JSON.stringify({ mcpServers: { serena: config } }), ".dev/run-serena-mcp.sh": "reviewed launcher", ".dev/install-serena.sh": "reviewed checker", ".pi/serena-context.yml": "reviewed context" };
  const fingerprints = {};
  for (const [name, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true });
    fs.writeFileSync(path.join(workspace, name), bytes);
    fingerprints[name] = createHash("sha256").update(bytes).digest("hex");
  }
  const profile = { ...SERENA_PROFILE, workspace, fingerprints };
  const context = { cwd: workspace, projectTrusted: true };
  const entry = readReviewedSerena(context, profile);
  return { workspace, config, profile, context, entry };
}

test("reviewed configuration exposes only nine exact tools without discovery", (t) => {
  const { context, profile, entry, workspace } = fixture(t);
  assert.equal(entry.config.exposure, "hidden");
  assert.deepEqual(Object.keys(entry.config.toolExposure), [...SERENA_TOOLS]);
  assert.deepEqual(validateReviewedEntry(entry, workspace, profile), { argv: [path.join(workspace, profile.command), "pi"], cwd: workspace, env: { SERENA_USAGE_REPORTING: "false" } });
  assert.throws(() => readReviewedSerena({ ...context, projectTrusted: false }, profile), /not trusted/);
  assert.throws(() => readReviewedSerena({ ...context, cwd: path.dirname(workspace) }, profile), /worktree/);
});

test("same-name extension registrations, HTTP, launch drift, and env commands are rejected", (t) => {
  const { entry, workspace, profile } = fixture(t);
  for (const patch of [
    { name: "arbitrary" }, { scope: "extension" }, { source: "/other/.pi/mcp.json" },
    { config: { ...entry.config, type: "http", url: "https://example.com" } },
    { config: { ...entry.config, args: ["pi", "--extra"] } },
    { config: { ...entry.config, command: "/bin/sh" } },
    { config: { ...entry.config, env: { SERENA_USAGE_REPORTING: "!touch /tmp/unsafe" } } },
    { config: { ...entry.config, env: { SERENA_USAGE_REPORTING: "${VALUE}" } } },
    { config: { ...entry.config, cwd: "/other" } },
    { config: { ...entry.config, toolExposure: { "*": "direct" } } },
    { config: { ...entry.config, toolExposure: { execute_shell_command: "direct" } } },
  ]) assert.throws(() => validateReviewedEntry({ ...entry, ...patch }, workspace, profile), /admission denied/);
});

test("every reviewed file fingerprint and canonical identity is rechecked", (t) => {
  const { context, profile, workspace } = fixture(t);
  for (const relative of Object.keys(profile.fingerprints)) {
    const pathname = path.join(workspace, relative), bytes = fs.readFileSync(pathname);
    fs.appendFileSync(pathname, "drift");
    assert.throws(() => readReviewedSerena(context, profile), /content changed/);
    fs.writeFileSync(pathname, bytes);
    const relocated = `${pathname}.relocated`;
    fs.renameSync(pathname, relocated);
    fs.symlinkSync(relocated, pathname); // Test-only provenance spoof.
    assert.throws(() => readReviewedSerena(context, profile), /identity changed/);
    fs.unlinkSync(pathname); fs.renameSync(relocated, pathname);
  }
  assert.equal(readReviewedSerena(context, profile).name, "serena");
});

test("real approved Visonic launch inputs still match the reviewed profile", () => {
  const entry = readReviewedSerena({ cwd: SERENA_PROFILE.workspace, projectTrusted: true });
  assert.equal(entry.name, "serena");
  assert.equal(Object.keys(entry.config.toolExposure).length, 9);
});
