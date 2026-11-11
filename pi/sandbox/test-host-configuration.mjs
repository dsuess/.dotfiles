import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverGitConfigOrigins, findCanonicalExecutable, resolveGitHubToken, resolveHostReadManifest, resolveUserToolRuntime, sanitizedFixedEnvironment, validateAdditionalHostPath } from "./host-configuration.mjs";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-host-config-"))), home = path.join(root, "home"), tools = path.join(root, "tools"), workspace = path.join(root, "workspace");
  for (const dir of [home, tools, workspace, path.join(home, ".config/gh"), path.join(home, ".config/uv"), path.join(home, ".ssh"), path.join(home, ".pi"), path.join(home, ".local/bin"), path.join(home, ".local/share/uv/tools"), path.join(home, ".local/share/uv/python"), path.join(home, ".local/share/uv/credentials")]) fs.mkdirSync(dir, { recursive: true });
  for (const file of [".zshrc", ".gitconfig", ".config/gh/hosts.yml", ".config/uv/uv.toml", ".ssh/config", ".ssh/id_ed25519"]) fs.writeFileSync(path.join(home, file), "safe\n");
  const gh = path.join(tools, "gh"); fs.writeFileSync(gh, "#!/bin/sh\n"); fs.chmodSync(gh, 0o755); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return { home, tools, workspace, gh };
}
test("exposes reviewed configuration but not GH credential storage or private keys", (t) => {
  const item = fixture(t), manifest = resolveHostReadManifest({ home: item.home, toolRoots: [item.tools] });
  assert(manifest.files.includes(path.join(item.home, ".ssh/config"))); assert(!manifest.files.includes(path.join(item.home, ".ssh/id_ed25519"))); assert(!manifest.files.includes(path.join(item.home, ".config/gh/hosts.yml"))); assert.equal(findCanonicalExecutable("gh", [item.tools]), item.gh);
  assert.deepEqual(resolveUserToolRuntime({ home: item.home }), {
    bin: path.join(item.home, ".local/bin"), toolDir: path.join(item.home, ".local/share/uv/tools"), pythonInstallDir: path.join(item.home, ".local/share/uv/python"),
  });
  for (const root of [".local/bin", ".local/share/uv/tools", ".local/share/uv/python"]) assert(manifest.roots.includes(path.join(item.home, root)), root);
  assert(!manifest.roots.includes(path.join(item.home, ".local"))); assert(!manifest.roots.includes(path.join(item.home, ".local/share/uv/credentials")));
  assert.throws(() => validateAdditionalHostPath(item.home, "ro", { home: item.home, workspaceRoot: item.workspace }), /overlaps|non-grantable/);
  assert.throws(() => validateAdditionalHostPath(path.join(item.home, ".local/share/uv/credentials"), "ro", { home: item.home, workspaceRoot: item.workspace }), /non-grantable/);
});
test("uses one fixed host gh call and never applies token masking", async () => {
  const token = "github_pat_abcdefghijklmnopqrstuvwxyz0123456789"; let seen;
  assert.equal(await resolveGitHubToken({ ghPath: "/reviewed/gh", environment: { PATH: "/reviewed", HOME: "/home/test", GH_TOKEN: "secret", SSH_AUTH_SOCK: "/agent" }, execFile: async (_file, args, options) => { seen = { args, options }; return { stdout: `${token}\n` }; } }), token);
  assert.deepEqual(seen.args, ["auth", "token", "--hostname", "github.com"]); assert.equal(seen.options.env.GH_TOKEN, undefined); assert.equal(seen.options.env.SSH_AUTH_SOCK, undefined); assert.deepEqual(sanitizedFixedEnvironment({ PATH: "/x", HOME: "/h", DOCKER_HOST: "x" }), { PATH: "/x", HOME: "/h" });
});
test("discovers canonical Git includes", async (t) => { const item = fixture(t), included = path.join(item.home, "included"); fs.writeFileSync(included, "[user]\n"); assert.deepEqual(await discoverGitConfigOrigins({ gitPath: "/git", execFile: async () => ({ stdout: `file:${included}\0x\t1\0` }) }), [included]); });

test("Buzz runtime grants only fixed, safe existing paths", (t) => {
  const { home, tools } = fixture(t);
  const skill = path.join(home, "src/slack-bridge/buzz/skills/buzz-bot");
  const keys = path.join(home, ".config/buzz-bot/keys"), key = path.join(keys, "daniel-suess-local.hex");
  const cli = path.join(tools, "buzz");
  let manifest = resolveHostReadManifest({ home, buzzCliPath: cli });
  assert.equal(manifest.buzzBotKey, null); assert(!manifest.roots.includes(skill)); assert(!manifest.files.includes(cli));
  fs.mkdirSync(skill, { recursive: true }); fs.mkdirSync(keys, { recursive: true, mode: 0o700 });
  fs.writeFileSync(key, "fixture", { mode: 0o600 }); fs.writeFileSync(path.join(keys, "other.hex"), "fixture", { mode: 0o600 });
  fs.writeFileSync(cli, "fixture", { mode: 0o755 });
  manifest = resolveHostReadManifest({ home, buzzCliPath: cli });
  assert.equal(manifest.buzzBotKey, key); assert(manifest.roots.includes(skill)); assert(manifest.files.includes(cli));
  assert(!manifest.roots.includes(keys)); assert(!manifest.files.includes(path.join(keys, "other.hex")));
  fs.chmodSync(key, 0o644); assert.equal(resolveHostReadManifest({ home }).buzzBotKey, null);
  fs.chmodSync(key, 0o600); fs.chmodSync(keys, 0o755); assert.equal(resolveHostReadManifest({ home }).buzzBotKey, null);
  fs.chmodSync(keys, 0o700); fs.unlinkSync(key); fs.symlinkSync(path.join(keys, "other.hex"), key);
  assert.equal(resolveHostReadManifest({ home }).buzzBotKey, null);
  fs.unlinkSync(key); fs.renameSync(keys, `${keys}-target`); fs.symlinkSync(`${keys}-target`, keys);
  assert.equal(resolveHostReadManifest({ home }).buzzBotKey, null);
  fs.unlinkSync(cli); fs.symlinkSync(path.join(tools, "gh"), cli);
  assert(!resolveHostReadManifest({ home, buzzCliPath: cli }).files.includes(cli));
  fs.rmSync(skill, { recursive: true }); fs.symlinkSync(tools, skill);
  assert(!resolveHostReadManifest({ home }).roots.includes(tools));
});
