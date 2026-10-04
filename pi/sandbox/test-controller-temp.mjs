import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireControllerLease, beginControllerStartup, stopStartedController } from "./client.mjs";

test("controller confines temporary creation and protects compatibility code", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-srt-temp-"));
  const originalTmp = process.env.TMPDIR;
  let startup, client;
  t.after(async () => {
    try { if (client) await client.release(); }
    finally {
      if (startup) stopStartedController(startup);
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
  try {
    process.env.TMPDIR = workspace;
    startup = beginControllerStartup({ launchDirectory: workspace });
  } finally {
    if (originalTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmp;
  }
  ({ client } = await acquireControllerLease({ startup, clientId: "temp" }));
  const run = async (command, shellFlag = "-c") => {
    const stdout = [], stderr = [];
    const result = await client.exec(["/bin/bash", shellFlag, command], {
      cwd: workspace, env: { TMPDIR: workspace, PATH: "/unusable-path" },
      onEvent: (stream, data) => (stream === "stdout" ? stdout : stderr).push(data),
    });
    return { ...result, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
  };
  const root = path.join("/tmp", `pi-srt-${process.getuid()}`, "g", startup.workspaceKey, String(startup.generation), "tmp");
  const executable = path.join(startup.runtimeRoot, `generation-${startup.generation}`, "temp-bin", "mktemp");
  for (const shellFlag of ["-c", "-lc"]) {
    const result = await run('set -e; printf "%s\\n%s\\n" "$TMPDIR" "$(command -v mktemp)"; mktemp; mktemp -d; mktemp -t prefix; mktemp -dt prefix', shellFlag);
    assert.equal(result.exitCode, 0, result.stderr);
    const [tmp, command, ...created] = result.stdout.trim().split("\n");
    assert.equal(tmp, root);
    assert.equal(command, executable);
    for (const pathname of created) {
      assert.equal(path.dirname(pathname), root);
      assert.equal((await client.stat(pathname)).isDirectory, fs.statSync(pathname).isDirectory());
    }
    await client.writeFile(created[0], Buffer.from("cross-operation"));
    assert.equal((await client.readFile(created[0])).data.toString(), "cross-operation");
    for (const pathname of created) {
      const cleanup = await run(`rm -rf -- ${JSON.stringify(pathname)}`);
      assert.equal(cleanup.exitCode, 0, cleanup.stderr);
      assert.equal(fs.existsSync(pathname), false);
    }
  }
  const node = await run(`${JSON.stringify(process.execPath)} -e 'const fs=require("node:fs"),os=require("node:os"),path=require("node:path"); const p=fs.mkdtempSync(path.join(os.tmpdir(),"node-")); console.log(p); fs.rmdirSync(p)'`);
  assert.equal(node.exitCode, 0, node.stderr);
  assert.equal(path.dirname(node.stdout.trim()), root);
  const targets = [executable, path.join(path.dirname(executable), "write-probe"), path.join(startup.runtimeRoot, "write-probe")];
  if (process.platform === "darwin") targets.push(path.join(execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim(), "pi-isolation-probe"));
  for (const target of targets) {
    const denied = await run(`printf tampered > ${JSON.stringify(target)}`);
    assert.notEqual(denied.exitCode, 0, target);
  }
  const replacement = await run(`rm ${JSON.stringify(executable)}`);
  assert.notEqual(replacement.exitCode, 0);
  assert.equal((await run("mktemp -u")).exitCode, 0, "protected command remains executable");
});
