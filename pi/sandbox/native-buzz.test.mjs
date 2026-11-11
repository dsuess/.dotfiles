import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { resolveHostReadManifest } from "./host-configuration.mjs";
import { buildSrtPolicy } from "./srt-policy.mjs";

test("native sandbox permits only the reviewed Buzz key and denies key writes", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-buzz-")));
  const home = path.join(root, "home"), workspace = path.join(root, "workspace"), controller = path.join(root, "controller"), broker = path.join(root, "broker");
  const keys = path.join(home, ".config/buzz-bot/keys"), key = path.join(keys, "daniel-suess-local.hex"), other = path.join(keys, "other.hex");
  for (const dir of [keys, workspace, controller, broker]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(key, "fixture", { mode: 0o600 }); fs.writeFileSync(other, "fixture", { mode: 0o600 });
  const bin = path.join(home, "bin"), cliBin = path.join(home, ".local/bin"), skill = path.join(home, "src/slack-bridge/buzz/skills/buzz-bot/scripts");
  for (const dir of [bin, cliBin, skill]) fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(fileURLToPath(new URL("../../bin/buzz-bot", import.meta.url)), path.join(bin, "buzz-bot"));
  fs.writeFileSync(path.join(skill, "buzz-bot"), `import os, pathlib, subprocess, sys\nkey = pathlib.Path(os.environ['BUZZ_BOT_KEY_DIR']) / 'daniel-suess-local.hex'\nenv = dict(os.environ, FIXTURE_KEY_OK=str(key.read_text() == 'fixture'))\nsubprocess.run(['buzz', *sys.argv[1:]], env=env, check=True)\n`);
  fs.writeFileSync(path.join(cliBin, "buzz"), '#!/bin/sh\n[ "$FIXTURE_KEY_OK" = True ] || exit 1\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  const socket = path.join(broker, "docker.sock"); fs.writeFileSync(socket, "");
  let initialized = false; const originalCwd = process.cwd();
  t.after(async () => { process.chdir(originalCwd); if (initialized) await SandboxManager.reset(); fs.rmSync(root, { recursive: true, force: true }); });
  process.chdir(workspace);
  const policy = buildSrtPolicy({ home, workspaceRoot: workspace, controllerRoot: controller, dockerSocket: socket, hostReadManifest: resolveHostReadManifest({ home }) });
  await SandboxManager.initialize(policy, async () => true); initialized = true;
  const probe = `const fs=require('node:fs'); const [key,other]=process.argv.slice(1); const result={};
for(const [name,target] of Object.entries({key,other})) { try { fs.readFileSync(target); result[name]='allowed'; } catch(e) { result[name]=e.code; } }
try { fs.writeFileSync(key,'changed'); result.write='allowed'; } catch(e) { result.write=e.code; }
console.log(JSON.stringify(result));`;
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const wrapped = await SandboxManager.wrapWithSandbox([process.execPath, "-e", probe, key, other].map(quote).join(" "), "sh");
  const result = spawnSync("/bin/sh", ["-lc", wrapped], { cwd: workspace, encoding: "utf8", env: { HOME: workspace, PATH: process.env.PATH, TMPDIR: os.tmpdir() } });
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.key, "allowed"); assert.match(evidence.other, /^(EPERM|EACCES)$/); assert.match(evidence.write, /^(EPERM|EACCES)$/);
  assert.equal(fs.readFileSync(key, "utf8"), "fixture");
  if (fs.existsSync("/opt/homebrew/bin/python3.14")) {
    const command = ["buzz-bot", "as", "daniel-suess-local", "messages", "get", "a b"].map(quote).join(" ");
    const routed = await SandboxManager.wrapWithSandbox(command, "sh");
    const launch = spawnSync("/bin/sh", ["-c", routed], { cwd: workspace, encoding: "utf8", env: { HOME: workspace, PATH: `${bin}:${cliBin}:${process.env.PATH}`, TMPDIR: os.tmpdir() } });
    assert.equal(launch.status, 0, launch.stderr);
    assert.equal(launch.stdout, "as\ndaniel-suess-local\nmessages\nget\na b\n");
  }
});
