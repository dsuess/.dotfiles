import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { WorkspaceApprovalStore, readWorkspaceServers, createWorkspaceApproval } from "./workspace-approval.mjs";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-approval-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), cwd = path.join(root, "workspace");
  fs.mkdirSync(home); fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  const file = path.join(cwd, ".pi/mcp.json");
  const write = (servers = { fixture: { command: "node", args: ["fixture.js"], env: { SECRET: "private-value", A: "a" } } }) => fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }));
  write();
  const store = new WorkspaceApprovalStore(home);
  const ctx = { cwd, isProjectTrusted: () => true, hasUI: true, mode: "tui", ui: { confirm: async () => true, notify() {} } };
  return { root, home, cwd, file, write, store, ctx, read: () => readWorkspaceServers(ctx) };
}

test("approval persists privately without config edits, aliases match but children and siblings do not", async (t) => {
  const f = fixture(t), before = fs.readFileSync(f.file, "utf8");
  await f.store.approve(f.read());
  assert.equal(new WorkspaceApprovalStore(f.home).matching(f.read()).length, 1);
  const alias = path.join(f.root, "alias"); fs.symlinkSync(f.cwd, alias);
  assert.equal(f.store.matching(readWorkspaceServers({ ...f.ctx, cwd: alias })).length, 1);
  for (const name of ["child", "../sibling"]) {
    const cwd = path.resolve(f.cwd, name); fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.copyFileSync(f.file, path.join(cwd, ".pi/mcp.json"));
    assert.equal(f.store.matching(readWorkspaceServers({ ...f.ctx, cwd })).length, 0);
  }
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.equal(fs.statSync(f.store.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.store.directory).mode & 0o777, 0o700);
  const state = fs.readFileSync(f.store.file, "utf8");
  assert.ok(!state.includes("private-value")); assert.ok(!state.includes("fixture.js"));
});

test("launch fingerprints ignore ordering, but bind every launch field and enabled additions", async (t) => {
  const f = fixture(t); await f.store.approve(f.read());
  f.write({ fixture: { env: { A: "a", SECRET: "private-value" }, args: ["fixture.js"], command: "node" } });
  assert.equal(f.store.matching(f.read()).length, 1);
  for (const change of [{ command: "other" }, { args: ["other.js"] }, { env: { A: "changed" } }, { cwd: f.home }]) {
    f.write({ fixture: { command: "node", args: ["fixture.js"], env: { SECRET: "private-value", A: "a" }, ...change } });
    assert.equal(f.store.matching(f.read()).length, 0);
  }
  f.write({ extra: { command: "node", enabled: false } }); await f.store.approve(f.read());
  f.write({ extra: { command: "node" } }); assert.equal(f.store.matching(f.read()).length, 0);
});

test("untrusted and empty projects do not prompt; cancellation and print cannot approve", async (t) => {
  const f = fixture(t); let prompts = 0;
  f.ctx.ui.confirm = async () => { prompts++; return false; };
  const approval = createWorkspaceApproval({ store: f.store });
  await approval.initialize({ ...f.ctx, isProjectTrusted: () => false }); assert.equal(prompts, 0);
  await approval.initialize({ ...f.ctx, mode: "print" }); assert.equal(prompts, 0);
  await approval.initialize(f.ctx); await approval.initialize(f.ctx); assert.equal(prompts, 1);
  assert.equal(fs.existsSync(f.store.file), false);
  await approval.initialize(f.ctx, true); assert.equal(prompts, 2);
  f.write({}); await approval.initialize(f.ctx, true); assert.equal(prompts, 2);
});

test("confirmation hides env and arguments, rechecks changes, and restart skips prompting", async (t) => {
  const f = fixture(t); let prompts = 0;
  f.ctx.ui.confirm = async (_title, message) => {
    prompts++; assert.ok(!message.includes("private-value")); assert.ok(!message.includes("fixture.js"));
    f.write({ changed: { command: "node" } }); return true;
  };
  const approval = createWorkspaceApproval({ store: f.store });
  await approval.initialize(f.ctx); assert.equal(fs.existsSync(f.store.file), false);
  assert.match(approval.status(), /configuration changed/);
  f.ctx.ui.confirm = async () => { prompts++; return true; };
  await approval.initialize(f.ctx, true); assert.equal(approval.load().servers.length, 1);
  const restart = createWorkspaceApproval({ store: new WorkspaceApprovalStore(f.home) });
  await restart.initialize(f.ctx); assert.equal(prompts, 2);
  const admitted = restart.load().servers[0]; await f.store.revoke(f.cwd);
  assert.throws(() => restart.validate(admitted), /approval or configuration changed/);
  await f.store.approve(f.read()); assert.throws(() => restart.validate(admitted), /approval or configuration changed/);
});

test("parallel store instances serialize saves without losing unrelated workspaces", async (t) => {
  const f = fixture(t);
  const snapshots = Array.from({ length: 8 }, (_, index) => ({ ...f.read(), workspace: path.join(f.root, `workspace-${index}`) }));
  await Promise.all(snapshots.map((snapshot) => new WorkspaceApprovalStore(f.home).approve(snapshot)));
  assert.equal(Object.keys(f.store.read().workspaces).length, 8);
});

test("malformed state and symlink targets fail closed and are never replaced", async (t) => {
  const f = fixture(t); await f.store.approve(f.read());
  fs.writeFileSync(f.store.file, '{"version":2,"workspaces":{}}');
  assert.throws(() => f.store.read(), /malformed/);
  await assert.rejects(f.store.approve(f.read()), /malformed/);
  fs.rmSync(f.store.file); const target = path.join(f.root, "target"); fs.writeFileSync(target, "do not change");
  fs.symlinkSync(target, f.store.file);
  assert.throws(() => f.store.read(), /unsafe/); await assert.rejects(f.store.approve(f.read()), /unsafe/);
  assert.equal(fs.readFileSync(target, "utf8"), "do not change");
  fs.rmSync(f.store.file); fs.rmdirSync(f.store.directory); fs.symlinkSync(f.root, f.store.directory);
  assert.throws(() => f.store.read(), /unsafe/);
});

test("server-map key reordering during confirmation does not change launch authority", async (t) => {
  const f = fixture(t);
  const one = { command: "node", args: ["one"] }, two = { command: "node", args: ["two"] };
  f.write({ one, two });
  f.ctx.ui.confirm = async () => { f.write({ two, one }); return true; };
  const approval = createWorkspaceApproval({ store: f.store });
  await approval.initialize(f.ctx);
  assert.equal(f.store.matching(f.read()).length, 2);
});

test("independent processes serialize atomic approval updates", async (t) => {
  const f = fixture(t);
  const module = new URL("./workspace-approval.mjs", import.meta.url).href;
  await Promise.all(Array.from({ length: 6 }, (_, index) => new Promise((resolve, reject) => {
    const snapshot = { workspace: path.join(f.root, `process-${index}`), servers: [] };
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import {WorkspaceApprovalStore} from ${JSON.stringify(module)};await new WorkspaceApprovalStore(${JSON.stringify(f.home)}).approve(${JSON.stringify(snapshot)});`], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", (bytes) => { stderr += bytes; });
    child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  assert.equal(Object.keys(f.store.read().workspaces).length, 6);
});

test("config changes during store lock wait cannot commit approval", async (t) => {
  const f = fixture(t); f.store.checkDirectory(true);
  const lock = path.join(f.store.directory, "lock"); fs.mkdirSync(lock, { mode: 0o700 });
  const approval = createWorkspaceApproval({ store: f.store });
  const saving = approval.initialize(f.ctx);
  await new Promise((resolve) => setTimeout(resolve, 30));
  f.write({ changed: { command: "other" } }); fs.rmdirSync(lock);
  await saving;
  assert.equal(fs.existsSync(f.store.file), false);
  assert.match(approval.status(), /configuration changed before saving/);
});

test("FIFO configuration, unsafe parent permissions, and parent symlinks fail closed", async (t) => {
  const f = fixture(t);
  fs.rmSync(f.file);
  assert.equal(spawnSync("mkfifo", [f.file]).status, 0);
  assert.throws(f.read, /invalid or oversized file/);
  f.store.checkDirectory(true); fs.chmodSync(path.join(f.home, ".pi"), 0o777);
  assert.throws(() => f.store.read(), /unsafe approval directory/);
  fs.chmodSync(path.join(f.home, ".pi"), 0o700);
  fs.rmdirSync(f.store.directory); fs.rmdirSync(path.join(f.home, ".pi"));
  fs.symlinkSync(f.root, path.join(f.home, ".pi"));
  await assert.rejects(f.store.approve({ workspace: f.cwd, servers: [] }), /unsafe approval directory/);
});

for (const config of [{ url: "https://example.com" }, { command: "node", oauth: {} }, { command: "node", env: { KEY: "!echo secret" } }, { command: "node", args: ["${HOST}"] }, { command: "node", env: { KEY: "$(command)" } }, { command: "node", unknown: true }]) {
  test(`unsupported config fails closed: ${JSON.stringify(config)}`, (t) => {
    const f = fixture(t); f.write({ bad: config });
    assert.throws(f.read, /Routed MCP approval denied/);
  });
}
