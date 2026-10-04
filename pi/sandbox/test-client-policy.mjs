import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClientPolicies } from "./client-policy.mjs";
import { createFilesystemConfigurationService } from "./filesystem-configuration.mjs";
import { buildSrtPolicy } from "./srt-policy.mjs";
import { ControllerClient, clientInternals } from "./client.mjs";
import { validateRequest, makeRequest } from "./protocol.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "client-policies-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), workspaceRoot = path.join(root, "workspace"), controllerRoot = path.join(root, "controller");
  for (const directory of [home, workspaceRoot, controllerRoot, path.join(home, ".agents"), path.join(home, "shared"), path.join(root, "generated")]) fs.mkdirSync(directory, { recursive: true });
  const configPath = path.join(root, "config.json"), dockerSocket = path.join(root, "docker.sock");
  fs.writeFileSync(configPath, JSON.stringify({ version: 1, filesystem: { readOnly: ["~/.agents"], readWrite: [] } }));
  fs.writeFileSync(dockerSocket, "socket fixture");
  const validation = { configPath, home, workspaceRoot, controllerRoot };
  const configuration = createFilesystemConfigurationService(validation);
  const buildPolicy = (grants) => buildSrtPolicy({ ...validation, dockerSocket, grants, generatedRoots: [path.join(root, "generated")] });
  const policies = new ClientPolicies({ configuration, validation, buildPolicy });
  return { root, home, configPath, workspaceRoot, controllerRoot, configuration, policies, buildPolicy };
}

async function change(f, connection, access) {
  const candidate = f.configuration.prepare({ type: access ? "add" : "remove", access, path: "~/shared" });
  const prepared = f.policies.prepare(connection, candidate);
  const saved = await f.configuration.commit(candidate);
  f.policies.activate(connection, prepared.preparation, saved.revision);
  return saved;
}

test("connection snapshots isolate lease siblings and new clients load edited defaults", async (t) => {
  const f = fixture(t), first = {}, sibling = {};
  const original = f.policies.capture(first), other = f.policies.capture(sibling);
  assert.equal(original.policy.generation, other.policy.generation);
  const saved = await change(f, first, "rw");
  const current = f.policies.capture(first);
  assert.notEqual(current.policy.generation, original.policy.generation);
  assert.equal(f.policies.capture(sibling), other, "a sibling on the same root lease retains its snapshot");
  assert.equal(f.policies.status(sibling).refreshNeeded, true);
  assert.equal(f.policies.status(first).refreshNeeded, false);
  const later = {};
  assert.equal(f.policies.status(later).effectiveRevision, saved.revision);
  assert.equal(f.policies.capture(later).policy.generation, current.policy.generation);
  assert.deepEqual(current.policy.network, original.policy.network, "filesystem transitions never change network/broker authority");
  assert.deepEqual(current.policy.filesystem.allowCompleteWorkspaceWrites, original.policy.filesystem.allowCompleteWorkspaceWrites);
  assert.ok(current.policy.filesystem.allowRead.includes(path.join(f.home, ".agents")));
  assert.ok(current.policy.filesystem.allowWrite.includes(f.workspaceRoot));
  assert.ok(Object.isFrozen(current.policy.filesystem.allowWrite));
  assert.equal(f.policies.status(first).preparation, undefined, "status exposes no activation capability");
});

test("complete profiles handle rw-to-ro and removal while captured operations retain their authority", async (t) => {
  const f = fixture(t), first = {}, sibling = {};
  f.policies.capture(sibling);
  await change(f, first, "rw");
  const running = f.policies.capture(first), grant = path.join(f.home, "shared");
  assert.ok(running.policy.filesystem.allowWrite.includes(grant));
  await change(f, first, "ro");
  const readonly = f.policies.capture(first);
  assert.ok(readonly.policy.filesystem.allowRead.includes(grant));
  assert.equal(readonly.policy.filesystem.allowWrite.includes(grant), false);
  assert.ok(running.policy.filesystem.allowWrite.includes(grant), "already-started Bash/helper policy is unchanged");
  assert.throws(() => f.policies.capture(first, running.policy.generation), { code: "stale_generation" });
  await change(f, first);
  const removed = f.policies.capture(first);
  assert.equal(removed.policy.filesystem.allowRead.includes(grant), false);
  assert.equal(removed.policy.filesystem.allowWrite.includes(grant), false);
  assert.ok(removed.policy.filesystem.allowWrite.includes(f.workspaceRoot));
  const refresh = f.policies.prepare(sibling, f.configuration.read());
  f.policies.activate(sibling, refresh.preparation, f.configuration.read().revision);
  assert.equal(f.policies.status(sibling).refreshNeeded, false);
});

test("opaque preparations cannot be selected by siblings and aliases are revalidated before activation/operation", (t) => {
  const f = fixture(t), first = {}, other = {};
  const shared = path.join(f.home, "shared"), alias = path.join(f.home, "alias");
  fs.symlinkSync(shared, alias);
  const candidate = f.configuration.prepare({ type: "add", access: "rw", path: alias });
  const prepared = f.policies.prepare(first, candidate);
  assert.throws(() => f.policies.activate(other, prepared.preparation, candidate.revision), { code: "invalid_preparation" });
  f.policies.activate(first, prepared.preparation, candidate.revision);
  fs.unlinkSync(alias);
  fs.mkdirSync(path.join(f.home, ".ssh"));
  fs.symlinkSync(path.join(f.home, ".ssh"), alias);
  assert.throws(() => f.policies.capture(first), /credential|protected/);
  assert.throws(() => f.policies.prepare(first, candidate), /credential|protected/);
});

test("reload can restore its complete prior snapshot without accepting malformed saved defaults", (t) => {
  const f = fixture(t), first = {};
  const old = f.policies.capture(first).configuration;
  fs.writeFileSync(f.configPath, "invalid json");
  const replacement = {};
  const prepared = f.policies.prepare(replacement, old);
  f.policies.activate(replacement, prepared.preparation, old.revision);
  assert.deepEqual(f.policies.capture(replacement).configuration, old);
  assert.equal(f.policies.status(replacement).refreshNeeded, true);
  assert.match(f.policies.status(replacement).savedError, /invalid JSON/);
  assert.throws(() => f.policies.capture({}), /invalid JSON/);
});

test("configuration bytes are excluded from controller replacement identity; code/dependency files remain", () => {
  const sources = clientInternals.controllerSourceFiles;
  assert.equal(sources.some((file) => path.basename(file) === "config.json"), false);
  for (const name of ["controller.mjs", "protocol.mjs", "client-policy.mjs", "filesystem-grants.mjs", "filesystem-configuration.mjs", "srt-policy.mjs", "apply-srt-workspace-write-patch.mjs", "package-lock.json"]) assert.ok(sources.some((file) => path.basename(file) === name), name);
  assert.equal(new Set(sources).size, sources.length);
});

test("policy RPCs are bounded complete snapshots and operation env cannot select a context", () => {
  const auth = "a".repeat(64), revision = "b".repeat(64);
  const prepare = { config: { version: 1, filesystem: { readOnly: [], readWrite: [] } }, grants: [], revision };
  assert.equal(validateRequest(makeRequest(1, "policy.prepare", auth, prepare)).params, prepare);
  assert.throws(() => validateRequest(makeRequest(1, "policy.prepare", auth, { ...prepare, config: { ...prepare.config, network: {} } })), /unknown key/);
  assert.throws(() => validateRequest(makeRequest(1, "policy.prepare", auth, { ...prepare, grants: Array(33).fill({}) })), /bounded/);
  assert.throws(() => validateRequest(makeRequest(1, "policy.activate", auth, { preparation: auth, revision, context: auth })), /unknown key/);
  assert.throws(() => validateRequest(makeRequest(1, "exec", auth, { argv: ["echo"], cwd: "/workspace", env: {}, timeoutMs: 1, maxOutputBytes: 1, policyGeneration: auth, policyContext: auth })), /unknown key/);
});

test("client validates preparation before commit and atomically updates its effective generation after activation", async () => {
  const client = Object.create(ControllerClient.prototype), revision = "b".repeat(64);
  const saved = { config: { version: 1, filesystem: { readOnly: [], readWrite: [] } }, grants: [], revision };
  client.request = async () => ({ result: {} });
  await assert.rejects(client.preparePolicy(saved), /invalid policy preparation/);
  const prepared = { preparation: "c".repeat(64), policyGeneration: createHash("sha256").update("profile").digest("hex") };
  client.request = async (method, params) => {
    if (method === "policy.prepare") { assert.deepEqual(params, saved); return { result: prepared }; }
    assert.deepEqual(params, { preparation: prepared.preparation, revision });
    return { result: { policyGeneration: prepared.policyGeneration, effectiveRevision: revision } };
  };
  assert.deepEqual(await client.preparePolicy(saved), prepared);
  await client.activatePolicy(prepared, saved);
  assert.equal(client.policyGeneration, prepared.policyGeneration);
  assert.equal(client.effectiveSnapshot, saved);
});
