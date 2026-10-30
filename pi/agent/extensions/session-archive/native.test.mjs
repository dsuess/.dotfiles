import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { buildSrtPolicy } from "../../../sandbox/srt-policy.mjs";

const { SandboxManager } = await import(pathToFileURL(new URL("../../../sandbox/node_modules/@anthropic-ai/sandbox-runtime/dist/index.js", import.meta.url).pathname));

test("native SRT blocks private archives at folded Stow and home aliases despite broad workspace access", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-archive-")));
  const home = path.join(root, "home"), controller = path.join(root, "controller"), broker = path.join(root, "broker");
  const target = path.join(home, "dotfiles/pi/agent"), alias = path.join(home, ".pi/agent");
  const archive = path.join(target, "session-archives/secret.txt");
  for (const dir of [path.dirname(archive), path.dirname(alias), controller, broker]) fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(target, alias); fs.writeFileSync(archive, "private history");
  const socket = path.join(broker, "docker.sock"); fs.writeFileSync(socket, "");
  const script = path.join(home, "probe.cjs");
  fs.writeFileSync(script, `const fs=require('node:fs');const out={};for(const name of process.argv.slice(2)){for(const op of ['read','write']){try{if(op==='read')fs.readFileSync(name);else fs.writeFileSync(name,'BAD');out[name+op]='ALLOWED';}catch(e){out[name+op]=e.code;}}}fs.writeFileSync('ordinary','allowed');console.log(JSON.stringify(out));`);
  let initialized = false;
  t.after(async () => { if (initialized) await SandboxManager.reset(); fs.rmSync(root, { recursive: true, force: true }); });
  const policy = buildSrtPolicy({ home, workspaceRoot: home, controllerRoot: controller, dockerSocket: socket });
  await SandboxManager.initialize(policy, async () => true); initialized = true;
  const command = [process.execPath, script, archive, path.join(alias, "session-archives/secret.txt")].map((s) => `'${s.replaceAll("'", "'\\''")}'`).join(" ");
  const wrapped = await SandboxManager.wrapWithSandbox(command, "sh");
  const result = spawnSync("/bin/sh", ["-c", wrapped], { cwd: home, encoding: "utf8", env: { HOME: home, PATH: process.env.PATH, TMPDIR: os.tmpdir() } });
  assert.equal(result.status, 0, result.stderr);
  for (const outcome of Object.values(JSON.parse(result.stdout))) assert.match(outcome, /^(EPERM|EACCES)$/);
  assert.equal(fs.readFileSync(archive, "utf8"), "private history");
  assert.equal(fs.readFileSync(path.join(home, "ordinary"), "utf8"), "allowed");
});
