import assert from "node:assert/strict";
import test from "node:test";

import {
  formatVmInventory,
  getVmInventory,
  runGondolinier,
} from "./gondolinier.mjs";

function output() {
  let value = "";
  return {
    write(chunk) { value += chunk; },
    value() { return value; },
  };
}

function storageHarness(rowsByVm = {}, failingVm = null) {
  const calls = [];
  const releases = [];
  const manifests = Object.keys(rowsByVm).map((vmId, index) => ({
    vmId,
    workspaceKey: `${index}`.repeat(64),
    workspaceRoot: `/work/${vmId}`,
  }));
  return {
    manifests,
    calls,
    releases,
    async acquireController(manifest) {
      return {
        client: {
          async exec(argv, options) {
            calls.push([manifest.vmId, argv]);
            if (manifest.vmId === failingVm && argv[2] === "df") throw new Error("inspection failed");
            if (argv[2] === "df") options.onEvent("stdout", Buffer.from(rowsByVm[manifest.vmId]));
            return { exitCode: 0 };
          },
          async release() { releases.push(manifest.vmId); },
        },
      };
    },
  };
}

const NOW = Date.parse("2026-08-23T12:00:00Z");
const STORAGE_ROWS = [
  { Type: "Images", Size: "2.00GB", Reclaimable: "1.50GB (75%)", Active: "1" },
  { Type: "Containers", Size: "600MB", Reclaimable: "500MB (83%)", Active: "1" },
  { Type: "Local Volumes", Size: "3.00GB", Reclaimable: "2.00GB (67%)", Active: "2" },
  { Type: "Build Cache", Size: "300MB", Reclaimable: "250MB (83%)", Active: "0" },
].map(JSON.stringify).join("\n");

test("gondolinier vm list shows only connectable sessions and maps Pi workspaces", async () => {
  const inventory = await getVmInventory({
    now: NOW,
    listSessions: async () => [
      { id: "stale", pid: 10, alive: false, createdAt: "2026-08-23T11:00:00Z" },
      { id: "other", pid: 11, alive: true, createdAt: "2026-08-23T11:59:30Z", label: "other-vm" },
      { id: "pi-vm", pid: 12, alive: true, createdAt: "2026-08-23T10:00:00Z", label: "pi:abc" },
      { id: "bad", pid: 0, alive: true, createdAt: "2026-08-23T10:00:00Z" },
    ],
    manifests: [{ vmId: "pi-vm", workspaceRoot: "/work/project" }],
  });
  assert.deepEqual(inventory, [
    { id: "other", pid: 11, age: "30s", label: "other-vm", workspace: "-" },
    { id: "pi-vm", pid: 12, age: "2h", label: "pi:abc", workspace: "/work/project" },
  ]);
  assert.match(formatVmInventory(inventory), /^VM ID  PID  AGE  LABEL     WORKSPACE/m);
  assert.match(formatVmInventory(inventory), /pi-vm  12   2h   pi:abc    \/work\/project/);
});

test("gondolinier image build forces reusable image assembly without starting a VM", async () => {
  const stdout = output();
  const calls = [];
  assert.equal(
    await runGondolinier(["image", "build"], {
      stdout,
      async buildImage(options) {
        calls.push(options);
        return { imageDir: "/cache/image", spec: { digest: "a".repeat(64) } };
      },
    }),
    0,
  );
  assert.deepEqual(calls, [{ force: true, verbose: true }]);
  assert.match(stdout.value(), /Image rebuilt and verified: \/cache\/image \(a{64}\)/);

  const help = output();
  assert.equal(await runGondolinier(["image", "--help"], { stdout: help, stderr: output() }), 0);
  assert.equal(help.value(), "Usage: gondolinier image build\n");
});

test("gondolinier vm list reports an empty inventory and command help", async () => {
  const stdout = output();
  const stderr = output();
  assert.equal(await runGondolinier(["vm", "list"], { stdout, stderr, listSessions: async () => [], manifests: [] }), 0);
  assert.equal(stdout.value(), "No Gondolin VMs are running.\n");
  assert.equal(stderr.value(), "");

  const help = output();
  assert.equal(await runGondolinier(["vm", "--help"], { stdout: help, stderr }), 0);
  assert.equal(help.value(), "Usage: gondolinier vm list\n");
});

test("gondolinier storage list aggregates Docker categories and warns about active volumes", async () => {
  const harness = storageHarness({ one: STORAGE_ROWS, two: STORAGE_ROWS });
  const stdout = output();
  assert.equal(await runGondolinier(["storage", "list"], { stdout, ...harness }), 0);
  assert.match(stdout.value(), /Images       3.00 GB/);
  assert.match(stdout.value(), /Containers   1.00 GB/);
  assert.match(stdout.value(), /Volumes      4.00 GB/);
  assert.match(stdout.value(), /Build cache  0.50 GB/);
  assert.match(stdout.value(), /Total        8.50 GB/);
  assert.match(stdout.value(), /WARNING: 4 active volumes \(2.00 GB\) will be preserved by purge/);
  assert.deepEqual(harness.releases.sort(), ["one", "two"]);
});

test("gondolinier storage purge defaults to no and prunes only after confirmation", async () => {
  const declined = storageHarness({ one: STORAGE_ROWS });
  const declinedOutput = output();
  await runGondolinier(["storage", "purge"], {
    stdout: declinedOutput,
    confirm: async () => false,
    ...declined,
  });
  assert.match(declinedOutput.value(), /Reclaimable Docker storage:/);
  assert.match(declinedOutput.value(), /Purge cancelled/);
  assert.equal(declined.calls.filter(([, argv]) => argv[2] === "prune").length, 0);

  const confirmed = storageHarness({ one: STORAGE_ROWS, two: STORAGE_ROWS });
  const confirmedOutput = output();
  await runGondolinier(["storage", "purge"], {
    stdout: confirmedOutput,
    confirm: async () => true,
    ...confirmed,
  });
  assert.equal(confirmed.calls.filter(([, argv]) => argv[2] === "prune").length, 2);
  assert.match(confirmedOutput.value(), /Reclaimable Docker storage purged/);
});

test("gondolinier storage purge skips an empty preview and aborts all deletion after inspection failure", async () => {
  const empty = storageHarness({ one: "" });
  const emptyOutput = output();
  await runGondolinier(["storage", "purge"], {
    stdout: emptyOutput,
    confirm: async () => { throw new Error("must not prompt"); },
    ...empty,
  });
  assert.match(emptyOutput.value(), /No reclaimable Docker storage found/);

  const failed = storageHarness({ one: STORAGE_ROWS, two: STORAGE_ROWS }, "two");
  await assert.rejects(
    () => runGondolinier(["storage", "purge"], { stdout: output(), confirm: async () => true, ...failed }),
    /inspection failed/,
  );
  assert.equal(failed.calls.filter(([, argv]) => argv[2] === "prune").length, 0);
  assert.deepEqual(failed.releases.sort(), ["one", "two"]);
});
