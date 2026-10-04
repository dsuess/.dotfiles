import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClientPolicies } from "../../../sandbox/client-policy.mjs";
import { ControllerClient } from "../../../sandbox/client.mjs";
import { createFilesystemConfigurationService } from "../../../sandbox/filesystem-configuration.mjs";
import { buildSrtPolicy } from "../../../sandbox/srt-policy.mjs";
import { createClientPolicyService, retainReloadPolicy, takeReloadPolicy } from "./policy-service.mjs";
import { createPiJiti } from "../../../test-helpers.mjs";
const jiti = await createPiJiti(import.meta.url);
const { ConversationMode } = await jiti.import(new URL("./mode-state.ts", import.meta.url).pathname);

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trusted-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), workspaceRoot = path.join(root, "workspace"), controllerRoot = path.join(root, "controller"), configPath = path.join(root, "config.json"), dockerSocket = path.join(root, "docker.sock");
  for (const directory of [home, workspaceRoot, controllerRoot, path.join(home, ".agents"), path.join(home, "shared")]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ version: 1, filesystem: { readOnly: ["~/.agents"], readWrite: [] } }));
  fs.writeFileSync(dockerSocket, "fixture");
  const options = { home, workspaceRoot, controllerRoot, configPath };
  const configuration = createFilesystemConfigurationService(options);
  const policies = new ClientPolicies({ configuration, validation: options, buildPolicy: (grants) => buildSrtPolicy({ ...options, grants, dockerSocket }) });
  const calls = [], published = [];
  let failPrepare = false, failActivate = false, failAfterActivate = false;
  const makeClient = async () => {
    const connection = {};
    const client = Object.create(ControllerClient.prototype);
    client.request = async (method, params) => {
      calls.push(method);
      if (method === "status") return { result: policies.status(connection) };
      if (method === "policy.prepare") {
        if (failPrepare) throw new Error("preparation failed");
        return { result: policies.prepare(connection, params) };
      }
      if (method === "policy.activate") {
        if (failActivate) throw new Error("activation failed");
        const result = policies.activate(connection, params.preparation, params.revision);
        if (failAfterActivate) throw new Error("activation acknowledgement lost");
        return { result };
      }
      throw new Error(method);
    };
    await client.status();
    return { client, connection };
  };
  const { client, connection } = await makeClient();
  const sibling = await makeClient();
  const mode = new ConversationMode(), ctx = { isIdle: () => true };
  const control = { atIdle: (ctx, action) => mode.atIdle(ctx.isIdle, action), blockSandbox: (reason) => mode.blockSandbox(reason) };
  const committed = { ...configuration, async commit(candidate) { calls.push("disk.commit"); return configuration.commit(candidate); } };
  const service = createClientPolicyService({ client, configuration: committed, control, publish: (next) => { published.push(next); } });
  return { root, home, configPath, ctx, mode, service, configuration, client, connection, sibling, policies, makeClient, control, calls, published,
    failPrepare: (value) => { failPrepare = value; }, failActivate: (value) => { failActivate = value; }, failAfterActivate: (value) => { failAfterActivate = value; },
  };
}

test("trusted actions prepare before disk commit, activate current client, and leave siblings pending refresh", async (t) => {
  const f = await fixture(t), original = await f.sibling.client.status();
  f.calls.length = 0;
  const added = await f.service.addGrant("rw", "~/shared", f.ctx);
  assert.deepEqual(f.calls.slice(0, 3), ["policy.prepare", "disk.commit", "policy.activate"]);
  assert.equal(added.savedRevision, added.effectiveRevision);
  assert.equal(added.refreshNeeded, false);
  assert.equal(f.published.length, 1);
  assert.equal((await f.sibling.client.status()).effectiveRevision, original.effectiveRevision);
  assert.equal((await f.sibling.client.status()).refreshNeeded, true);
  const later = await f.makeClient();
  assert.equal((await later.client.status()).effectiveRevision, added.savedRevision);
  const readonly = await f.service.addGrant("ro", "~/shared", f.ctx);
  assert.equal(readonly.filesystemGrants.find((grant) => grant.path.endsWith("/shared")).access, "ro");
  assert.equal(f.policies.capture(f.connection).policy.filesystem.allowWrite.includes(path.join(f.home, "shared")), false);
  const removed = await f.service.removeGrant("~/shared", f.ctx);
  assert.deepEqual(removed.filesystemGrants, [{ path: fs.realpathSync(path.join(f.home, ".agents")), access: "ro" }]);
  assert.ok(f.policies.capture(f.connection).policy.filesystem.allowWrite.includes(path.join(f.root, "workspace")));
});

test("invalid preparation, validation, and stale commit leave saved/effective policy unchanged", async (t) => {
  const f = await fixture(t), before = await f.service.status(), bytes = fs.readFileSync(f.configPath);
  await assert.rejects(f.service.addGrant("rw", "~/.ssh", f.ctx), /credential|exist/);
  f.failPrepare(true);
  await assert.rejects(f.service.addGrant("rw", "~/shared", f.ctx), /preparation failed/);
  f.failPrepare(false);
  assert.deepEqual(fs.readFileSync(f.configPath), bytes);
  assert.equal((await f.service.status()).effectiveRevision, before.effectiveRevision);
  assert.equal(f.mode.snapshot().blockedReason, null);
  const originalPrepare = f.client.preparePolicy.bind(f.client);
  f.client.preparePolicy = async (candidate) => {
    const prepared = await originalPrepare(candidate);
    fs.appendFileSync(f.configPath, "\n");
    return prepared;
  };
  await assert.rejects(f.service.addGrant("rw", "~/shared", f.ctx), { code: "CONFIG_CONFLICT" });
  assert.equal((await f.service.status()).effectiveRevision, before.effectiveRevision);
  assert.equal(JSON.parse(fs.readFileSync(f.configPath)).filesystem.readWrite.length, 0);
  await f.mode.run(async (mode) => assert.equal(mode, "on"));
});

for (const failure of ["before activation", "after activation acknowledgement"]) {
  test(`saved-success/${failure} failure reports mismatch and blocks until successful refresh`, async (t) => {
    const f = await fixture(t), before = await f.service.status();
    if (failure === "before activation") f.failActivate(true);
    else f.failAfterActivate(true);
    await assert.rejects(f.service.addGrant("rw", "~/shared", f.ctx), (error) => error.code === "SAVED_POLICY_NOT_ACTIVE" && error.savedRevision !== error.effectiveRevision && /Saved.*activation.*blocked.*reload/s.test(error.message));
    const mismatch = await f.service.status();
    assert.notEqual(mismatch.savedRevision, before.savedRevision);
    assert.equal(mismatch.effectiveRevision, before.effectiveRevision, "reports only last confirmed authority");
    assert.equal(mismatch.refreshNeeded, true);
    assert.match(mismatch.blockedReason, /activation/);
    await assert.rejects(f.mode.run(async () => {}), /blocked/);
    await assert.rejects(f.service.verify(), /activation/);
    assert.equal((await f.sibling.client.status()).effectiveRevision, before.effectiveRevision);
    f.failActivate(false); f.failAfterActivate(false);
    const refreshed = await f.service.reloadGrants(f.ctx);
    assert.equal(refreshed.savedRevision, refreshed.effectiveRevision);
    assert.equal(refreshed.refreshNeeded, false);
    await f.service.verify();
    await f.mode.run(async (mode) => assert.equal(mode, "on"));
  });
}

test("explicit refresh failure remains closed without changing effective grants; status is still readable", async (t) => {
  const f = await fixture(t), before = await f.service.status();
  fs.writeFileSync(f.configPath, "invalid json");
  await assert.rejects(f.service.reloadGrants(f.ctx), /blocked.*refreshed/);
  const next = await f.service.status();
  assert.equal(next.effectiveRevision, before.effectiveRevision);
  assert.equal(next.savedRevision, null);
  assert.equal(next.refreshNeeded, true);
  await assert.rejects(f.mode.run(async () => {}), /blocked/);
  await f.mode.switchMode("off", () => true, async () => {});
  await f.mode.run(async (mode) => assert.equal(mode, "off"), "explicit off remains a separate authority choice");
});

test("grant actions reject active operations, including off-mode operations, without saving", async (t) => {
  const f = await fixture(t), before = fs.readFileSync(f.configPath);
  const reservation = f.mode.reserve();
  await assert.rejects(f.service.addGrant("rw", "~/shared", f.ctx), /idle/);
  await assert.rejects(f.service.reloadGrants(f.ctx), /idle/);
  assert.deepEqual(fs.readFileSync(f.configPath), before);
  await reservation.run(async () => {});
  await f.mode.switchMode("off", () => true, async () => {});
  const off = f.mode.reserve();
  await assert.rejects(f.service.removeGrant("~/.agents", f.ctx), /idle/);
  await off.run(async () => {});
});

test("reload-only trusted retention restores old snapshots and mismatch blocks; replacement conversations load defaults", async (t) => {
  const f = await fixture(t), manager = {};
  const old = f.service.retention();
  retainReloadPolicy(manager, "reload", old);
  await f.service.addGrant("rw", "~/shared", f.ctx);
  const replacement = await f.makeClient();
  const retained = takeReloadPolicy(manager, "reload");
  assert.equal(retained, old);
  const replacementService = createClientPolicyService({ client: replacement.client, configuration: f.configuration, control: f.control });
  await replacementService.restore(retained);
  assert.equal((await replacementService.status()).effectiveRevision, old.effective.revision);
  assert.equal((await replacementService.status()).refreshNeeded, true);
  const blocked = { ...retained, blockedReason: "Saved revocation not confirmed; reload saved grants" };
  await replacementService.restore(blocked);
  await assert.rejects(replacementService.verify(), /revocation/);
  for (const reason of ["new", "resume", "fork", "quit", "startup"]) {
    retainReloadPolicy(manager, "reload", old);
    assert.equal(takeReloadPolicy(manager, reason), undefined);
    assert.equal(takeReloadPolicy(manager, "reload"), undefined);
  }
  retainReloadPolicy(manager, "reload", old);
  assert.equal(takeReloadPolicy({}, "reload"), undefined, "another conversation or child cannot select a snapshot");
  retainReloadPolicy(manager, "quit", old);
  assert.equal(takeReloadPolicy(manager, "reload"), undefined);
});
