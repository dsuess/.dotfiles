import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFilesystemConfigurationService } from "./filesystem-configuration.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-service-"));
  const home = path.join(root, "home"), workspaceRoot = path.join(root, "workspace"), controllerRoot = path.join(root, "controller");
  const shared = path.join(root, "shared space"), agents = path.join(root, "agents"), target = path.join(root, "dotfiles-config.json"), configPath = path.join(home, "config.json");
  for (const dir of [home, workspaceRoot, controllerRoot, shared, agents]) fs.mkdirSync(dir);
  fs.symlinkSync(agents, path.join(home, ".agents"));
  fs.writeFileSync(target, JSON.stringify({ version: 1, filesystem: { readOnly: ["~/.agents"], readWrite: [] } }, null, 2) + "\n", { mode: 0o640 });
  fs.symlinkSync(target, configPath);
  const options = { configPath, home, workspaceRoot, controllerRoot };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, shared, agents, target, configPath, options, service: createFilesystemConfigurationService(options) };
}

test("add, change access, and remove round-trip through a Stow target without changing directory modes", async (t) => {
  const item = fixture(t), mode = fs.statSync(item.shared).mode;
  const original = item.service.read();
  assert.equal(item.service.list().revision, original.revision);
  const added = await item.service.commit(item.service.prepare({ type: "add", access: "ro", path: item.shared }, original));
  assert.notEqual(added.revision, original.revision);
  assert.equal(fs.readlinkSync(item.configPath), item.target);
  assert.deepEqual(added.config.filesystem.readOnly, ["~/.agents", item.shared]);
  const changed = await item.service.commit(item.service.prepare({ type: "add", access: "rw", path: item.shared }, added));
  assert.deepEqual(changed.config.filesystem.readOnly, ["~/.agents"]);
  assert.deepEqual(changed.config.filesystem.readWrite, [item.shared]);
  const removed = await item.service.commit(item.service.prepare({ type: "remove", path: item.shared }, changed));
  assert.deepEqual(removed.config, original.config);
  assert.equal(fs.statSync(item.shared).mode, mode);
  assert.equal(fs.statSync(item.target).mode & 0o777, 0o640);
  assert(Object.isFrozen(removed.grants));
  assert.deepEqual(fs.readdirSync(item.root).filter((name) => name.includes(".lock") || name.includes(".tmp")), []);
});

test("invalid changes and stale revisions preserve saved bytes", async (t) => {
  const item = fixture(t), original = item.service.read(), bytes = fs.readFileSync(item.target);
  for (const change of [
    { type: "add", access: "ro", path: "relative" },
    { type: "add", access: "rw", path: path.join(item.root, "missing") },
    { type: "add", access: "bad", path: item.shared },
    { type: "add", access: "ro", path: item.home },
    { type: "remove", path: item.shared },
  ]) assert.throws(() => item.service.prepare(change, original));
  assert.deepEqual(fs.readFileSync(item.target), bytes);
  const stale = item.service.prepare({ type: "add", access: "ro", path: item.shared }, original);
  await item.service.commit(item.service.prepare({ type: "remove", path: "~/.agents" }, original));
  const saved = fs.readFileSync(item.target);
  await assert.rejects(item.service.commit(stale), { code: "CONFIG_CONFLICT" });
  assert.deepEqual(fs.readFileSync(item.target), saved);
});

test("malformed and oversized configuration fails closed", (t) => {
  const item = fixture(t);
  fs.writeFileSync(item.target, "{not json");
  assert.throws(() => item.service.read(), /invalid JSON/);
  fs.writeFileSync(item.target, " ".repeat(300_000));
  assert.throws(() => item.service.read(), /bounded|too large/);
});

test("reads remain bounded if a file grows after stat, and reject non-files", (t) => {
  const item = fixture(t), read = fs.readSync;
  let grew = false;
  fs.readSync = (...args) => {
    if (!grew) { grew = true; fs.appendFileSync(item.target, " ".repeat(300_000)); }
    return read(...args);
  };
  try { assert.throws(() => item.service.read(), /too large/); }
  finally { fs.readSync = read; }
  fs.unlinkSync(item.configPath); fs.symlinkSync(item.shared, item.configPath);
  assert.throws(() => item.service.read(), /regular file/);
});

test("grant symlink retargeting, deployment retargeting, and replaced target fail before commit", async (t) => {
  const item = fixture(t), alias = path.join(item.root, "alias");
  fs.symlinkSync(item.shared, alias);
  const candidate = item.service.prepare({ type: "add", access: "rw", path: alias });
  const bytes = fs.readFileSync(item.target);
  fs.unlinkSync(alias); fs.symlinkSync(item.agents, alias);
  await assert.rejects(item.service.commit(candidate), /changed|overlapping/);
  assert.deepEqual(fs.readFileSync(item.target), bytes);
  fs.unlinkSync(alias); fs.symlinkSync(item.shared, alias);
  const anotherTarget = path.join(item.root, "another.json"); fs.writeFileSync(anotherTarget, bytes);
  fs.unlinkSync(item.configPath); fs.symlinkSync(anotherTarget, item.configPath);
  await assert.rejects(item.service.commit(candidate), { code: "CONFIG_CONFLICT" });
  assert.deepEqual(fs.readFileSync(item.target), bytes);
  assert.deepEqual(fs.readFileSync(anotherTarget), bytes);
  fs.unlinkSync(item.configPath); fs.symlinkSync(item.target, item.configPath);
  const replacement = path.join(item.root, "replacement.json"); fs.writeFileSync(replacement, bytes); fs.renameSync(replacement, item.target);
  await assert.rejects(item.service.commit(candidate), { code: "CONFIG_CONFLICT" });
  assert.deepEqual(fs.readFileSync(item.target), bytes);
});

test("lock contention leaves the original intact and lock ownership untouched", async (t) => {
  const item = fixture(t), candidate = item.service.prepare({ type: "add", access: "ro", path: item.shared });
  const before = fs.readFileSync(item.target), lock = `${fs.realpathSync(item.target)}.lock`;
  fs.writeFileSync(lock, "other owner\n");
  const service = createFilesystemConfigurationService({ ...item.options, lockTimeoutMs: 40 });
  await assert.rejects(service.commit(candidate), { code: "CONFIG_LOCKED" });
  assert.deepEqual(fs.readFileSync(item.target), before);
  assert.equal(fs.readFileSync(lock, "utf8"), "other owner\n");
});

test("an atomic replacement failure preserves bytes, modes, and the Stow link", async (t) => {
  const item = fixture(t), candidate = item.service.prepare({ type: "add", access: "ro", path: item.shared });
  const before = fs.readFileSync(item.target), mode = fs.statSync(item.target).mode;
  const rename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error("simulated rename failure"), { code: "EIO" }); };
  try { await assert.rejects(item.service.commit(candidate), /simulated rename failure/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(item.target), before);
  assert.equal(fs.statSync(item.target).mode, mode);
  assert.equal(fs.readlinkSync(item.configPath), item.target);
  assert(!fs.readdirSync(item.root).some((name) => name.endsWith(".lock") || name.endsWith(".tmp")));
});

test("the final precommit check catches Stow and grant retargeting during the write", async (t) => {
  const item = fixture(t), alias = path.join(item.root, "alias"), anotherTarget = path.join(item.root, "another.json");
  fs.symlinkSync(item.shared, alias);
  const before = fs.readFileSync(item.target); fs.writeFileSync(anotherTarget, before);
  for (const retarget of [
    () => { fs.unlinkSync(item.configPath); fs.symlinkSync(anotherTarget, item.configPath); },
    () => { fs.unlinkSync(alias); fs.symlinkSync(item.options.controllerRoot, alias); },
  ]) {
    const candidate = item.service.prepare({ type: "add", access: "rw", path: alias });
    const sync = fs.fsyncSync;
    fs.fsyncSync = (fd) => { sync(fd); retarget(); };
    try { await assert.rejects(item.service.commit(candidate), /changed|controller/); }
    finally { fs.fsyncSync = sync; }
    assert.deepEqual(fs.readFileSync(item.target), before);
    assert.deepEqual(fs.readFileSync(anotherTarget), before);
    assert(!fs.readdirSync(item.root).some((name) => name.endsWith(".lock") || name.endsWith(".tmp")));
    fs.unlinkSync(item.configPath); fs.symlinkSync(item.target, item.configPath);
  }
});

test("access changes and removal through a canonical alias preserve the saved Stow spelling", async (t) => {
  const item = fixture(t);
  const upgraded = await item.service.commit(item.service.prepare({ type: "add", access: "rw", path: item.agents }));
  assert.deepEqual(upgraded.config.filesystem.readWrite, ["~/.agents"]);
  const removed = await item.service.commit(item.service.prepare({ type: "remove", path: item.agents }, upgraded));
  assert.deepEqual(removed.config.filesystem, { readOnly: [], readWrite: [] });
});

test("independent processes with one expected revision cannot both commit", async (t) => {
  const item = fixture(t);
  const moduleUrl = new URL("./filesystem-configuration.mjs", import.meta.url).href;
  const source = `import { createFilesystemConfigurationService } from ${JSON.stringify(moduleUrl)};
    const service = createFilesystemConfigurationService(JSON.parse(process.argv[1]));
    const candidate = service.prepare({type:'add', access:process.argv[2], path:process.argv[3]});
    console.log('ready');
    process.stdin.once('data', async () => {
      try { await service.commit(candidate); console.log('committed'); }
      catch (error) { console.log(error.code); }
    });`;
  const children = ["ro", "rw"].map((access) => spawn(process.execPath, ["--input-type=module", "-e", source, JSON.stringify(item.options), access, item.shared], { stdio: ["pipe", "pipe", "pipe"] }));
  t.after(() => children.forEach((child) => child.kill()));
  const outputs = children.map(() => "");
  await Promise.all(children.map((child, index) => new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.on("data", (chunk) => { outputs[index] += chunk; if (outputs[index].includes("ready")) resolve(); });
    child.once("exit", (code) => { if (!outputs[index].includes("ready")) reject(new Error(`child exited ${code} before ready`)); });
  })));
  const finished = children.map((child) => new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`))); }));
  children.forEach((child) => child.stdin.end("commit\n"));
  await Promise.all(finished);
  assert.equal(outputs.filter((output) => output.includes("committed")).length, 1);
  assert.equal(outputs.filter((output) => output.includes("CONFIG_CONFLICT")).length, 1);
  assert.equal(item.service.read().grants.length, 2);
});
