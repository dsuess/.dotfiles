import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { materializeTempCommand } from "./temp-command.mjs";
import { buildSrtPolicy } from "./srt-policy.mjs";

test("staged mktemp delegates creation and preserves explicit native arguments", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-temp-command-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const root = path.join(workspace, "private temp's root");
  fs.mkdirSync(root);
  const { executable } = materializeTempCommand(workspace, root);
  const run = (args, command = executable) => spawnSync(command, args, { cwd: workspace, env: { ...process.env, TMPDIR: "/unusable-temp-root" }, encoding: "utf8" });
  const prefix = process.platform === "darwin" ? "prefix" : "prefix.XXXXXX";
  for (const args of [[], ["-d"], ["-t", prefix], ["-dt", prefix], ["-u"], ["-qu"]]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    const created = result.stdout.trim();
    assert.equal(path.dirname(created), root);
    assert.match(path.basename(created), /^(tmp|prefix)\.[A-Za-z0-9]+$/);
    if (args.some((arg) => arg.includes("u"))) assert.equal(fs.existsSync(created), false);
    else {
      assert.equal(fs.statSync(created).isDirectory(), args.some((arg) => arg.includes("d")));
      fs.rmSync(created, { recursive: true });
    }
  }
  for (const args of [["explicit.XXXXXX"], [path.join(workspace, "absolute.XXXXXX")], ["-p", workspace], ["-p", workspace, "relative.XXXXXX"], ["--", "relative.XXXXXX"]]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    const created = result.stdout.trim();
    assert.equal(path.dirname(path.resolve(workspace, created)), workspace);
    fs.rmSync(path.resolve(workspace, created));
  }
  if (process.platform === "darwin") {
    const combined = run(["-t", "prefix", "explicit.XXXXXX"]);
    assert.equal(combined.status, 0, combined.stderr);
    const [implicit, explicit] = combined.stdout.trim().split("\n");
    assert.equal(path.dirname(implicit), root);
    assert.match(explicit, /^explicit\./);
    fs.rmSync(implicit); fs.rmSync(path.join(workspace, explicit));
  }
  for (const args of [["-z"], ["-t"], ["-p"], ["missing/bad-template"], ["-q", "missing/bad-template"], ["-p", "/no-such-directory", "file.XXXXXX"]]) {
    const actual = run(args), native = run(args, "/usr/bin/mktemp");
    assert.equal(actual.status, native.status, JSON.stringify(args));
    assert.equal(actual.stdout, native.stdout);
    const normalize = (value) => value.replace(/file\.[A-Za-z0-9]{6}/g, "file.XXXXXX");
    assert.equal(normalize(actual.stderr), normalize(native.stderr));
  }
  assert.equal(fs.statSync(executable).mode & 0o777, 0o500);
  assert.deepEqual(fs.readdirSync(root), []);
  materializeTempCommand(workspace, root);
  const restarted = run([]);
  assert.equal(restarted.status, 0, restarted.stderr);
  fs.rmSync(restarted.stdout.trim());
});

test("compatibility files receive read access, not controller write authority", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-temp-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), workspace = path.join(home, "workspace"), controller = path.join(root, "controller"), temp = path.join(root, "temp"), socket = path.join(root, "docker.sock");
  for (const directory of [workspace, controller, temp]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(socket, "");
  const staged = materializeTempCommand(controller, temp);
  const policy = buildSrtPolicy({ home, workspaceRoot: workspace, controllerRoot: controller, dockerSocket: socket, generatedRoots: [temp], toolFiles: [staged.directory, staged.executable] });
  for (const file of [staged.directory, staged.executable]) {
    assert(policy.filesystem.allowRead.includes(fs.realpathSync(file)));
    assert(!policy.filesystem.allowWrite.includes(fs.realpathSync(file)));
  }
  assert.deepEqual([...new Set(policy.filesystem.allowWrite.map((value) => fs.realpathSync(value)))].sort(), [workspace, temp].map((value) => fs.realpathSync(value)).sort());
  assert(!policy.filesystem.allowWrite.includes("/tmp"));
  assert(!policy.filesystem.allowWrite.includes("/var/folders"));
  assert(policy.filesystem.denyWrite.includes(fs.realpathSync(controller)));
});
