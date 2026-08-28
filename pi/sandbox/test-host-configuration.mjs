import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverGitConfigOrigins, findCanonicalExecutable, resolveGitHubToken, resolveHostReadManifest, sanitizedFixedEnvironment, validateAdditionalHostPath } from "./host-configuration.mjs";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-host-config-"))), home = path.join(root, "home"), tools = path.join(root, "tools"), workspace = path.join(root, "workspace");
  for (const dir of [home, tools, workspace, path.join(home, ".config/gh"), path.join(home, ".config/uv"), path.join(home, ".ssh"), path.join(home, ".pi")]) fs.mkdirSync(dir, { recursive: true });
  for (const file of [".zshrc", ".gitconfig", ".config/gh/hosts.yml", ".config/uv/uv.toml", ".ssh/config", ".ssh/id_ed25519"]) fs.writeFileSync(path.join(home, file), "safe\n");
  const gh = path.join(tools, "gh"); fs.writeFileSync(gh, "#!/bin/sh\n"); fs.chmodSync(gh, 0o755); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return { home, tools, workspace, gh };
}
test("exposes reviewed configuration but not GH credential storage or private keys", (t) => {
  const item = fixture(t), manifest = resolveHostReadManifest({ home: item.home, toolRoots: [item.tools] });
  assert(manifest.files.includes(path.join(item.home, ".ssh/config"))); assert(!manifest.files.includes(path.join(item.home, ".ssh/id_ed25519"))); assert(!manifest.files.includes(path.join(item.home, ".config/gh/hosts.yml"))); assert.equal(findCanonicalExecutable("gh", [item.tools]), item.gh);
  assert.throws(() => validateAdditionalHostPath(item.home, "ro", { home: item.home, workspaceRoot: item.workspace }), /overlaps|non-grantable/);
});
test("uses one fixed host gh call and never applies token masking", async () => {
  const token = "github_pat_abcdefghijklmnopqrstuvwxyz0123456789"; let seen;
  assert.equal(await resolveGitHubToken({ ghPath: "/reviewed/gh", environment: { PATH: "/reviewed", HOME: "/home/test", GH_TOKEN: "secret", SSH_AUTH_SOCK: "/agent" }, execFile: async (_file, args, options) => { seen = { args, options }; return { stdout: `${token}\n` }; } }), token);
  assert.deepEqual(seen.args, ["auth", "token", "--hostname", "github.com"]); assert.equal(seen.options.env.GH_TOKEN, undefined); assert.equal(seen.options.env.SSH_AUTH_SOCK, undefined); assert.deepEqual(sanitizedFixedEnvironment({ PATH: "/x", HOME: "/h", DOCKER_HOST: "x" }), { PATH: "/x", HOME: "/h" });
});
test("discovers canonical Git includes", async (t) => { const item = fixture(t), included = path.join(item.home, "included"); fs.writeFileSync(included, "[user]\n"); assert.deepEqual(await discoverGitConfigOrigins({ gitPath: "/git", execFile: async () => ({ stdout: `file:${included}\0x\t1\0` }) }), [included]); });
