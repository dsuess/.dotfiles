import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { buildSrtPolicy } from "./srt-policy.mjs";

// A synthetic HOME permits a broad-workspace test without granting the real HOME.
test("broad workspace and descendants cannot read, write or relocate routed approval state", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-approval-")));
  const home = path.join(root, "home"), controller = path.join(root, "controller"), broker = path.join(root, "broker");
  const approval = path.join(home, ".pi/routed-mcp/approvals.json"), socket = path.join(broker, "docker.sock");
  for (const directory of [path.dirname(approval), controller, broker]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(approval, "private-authority"); fs.writeFileSync(socket, "");
  const alias = path.join(home, "approval-alias"); fs.symlinkSync(approval, alias);
  const script = path.join(home, "probe.cjs");
  fs.writeFileSync(script, `const fs=require('node:fs'),{execFileSync}=require('node:child_process');
const probe=(approval,alias,pi)=>{
 const output={}; for(const [name,target] of Object.entries({approval,alias})){
  try{fs.readFileSync(target);output[name+'Read']='ESCAPED'}catch(e){output[name+'Read']=e.code}
  try{fs.writeFileSync(target,'tampered');output[name+'Write']='ESCAPED'}catch(e){output[name+'Write']=e.code}
 }
 try{fs.renameSync(pi,pi+'-moved');output.rename='ESCAPED'}catch(e){output.rename=e.code}
 return output;
};
const [approval,alias,pi]=process.argv.slice(2);
const child=JSON.parse(execFileSync(process.execPath,['-e','const fs=require("node:fs");const probe='+probe.toString()+';console.log(JSON.stringify(probe(...process.argv.slice(1))))',approval,alias,pi],{encoding:'utf8'}));
fs.writeFileSync('ordinary-workspace-write','allowed');console.log(JSON.stringify({child,parent:probe(approval,alias,pi)}));`);
  let initialized = false;
  const originalCwd = process.cwd();
  t.after(async () => { process.chdir(originalCwd); if (initialized) await SandboxManager.reset(); fs.rmSync(root, { recursive: true, force: true }); });
  process.chdir(home);
  const policy = buildSrtPolicy({ home, workspaceRoot: home, controllerRoot: controller, dockerSocket: socket });
  await SandboxManager.initialize(policy, async () => true); initialized = true;
  const command = [process.execPath, script, approval, alias, path.join(home, ".pi")].map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" ");
  const wrapped = await SandboxManager.wrapWithSandbox(command, "sh");
  const result = spawnSync("/bin/sh", ["-lc", wrapped], { cwd: home, encoding: "utf8", env: { HOME: home, PATH: process.env.PATH, TMPDIR: os.tmpdir() } });
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  for (const processEvidence of [evidence.parent, evidence.child]) for (const outcome of Object.values(processEvidence)) assert.match(outcome, /^(EPERM|EACCES)$/);
  assert.equal(fs.readFileSync(approval, "utf8"), "private-authority");
  assert.equal(fs.readFileSync(path.join(home, "ordinary-workspace-write"), "utf8"), "allowed");
});
