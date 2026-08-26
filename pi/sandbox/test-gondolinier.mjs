import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  formatVmInventory,
  getVmInventory,
  inspectHostImageCache,
  removeStaleImageGenerations,
  runGondolinier,
} from "./gondolinier.mjs";

const CURRENT = "a".repeat(64);
const ACTIVE = "b".repeat(64);
const STALE = "c".repeat(64);
const MALFORMED = "d".repeat(64);

function output() {
  let value = "";
  return {
    write(chunk) { value += chunk; },
    value() { return value; },
  };
}

async function withCache(run) {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gondolinier-test-"));
  try {
    return await run({ cacheRoot, currentImageGeneration: CURRENT });
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
}

function imagePath(cacheRoot, generation) {
  return path.join(cacheRoot, "images", generation);
}

function makeImage(cacheRoot, generation, files = {}) {
  const dir = imagePath(cacheRoot, generation);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "pi-image.json"), JSON.stringify({ digest: generation }));
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), contents);
  }
  return dir;
}

function treeAllocatedBytes(entryPath) {
  const stat = fs.lstatSync(entryPath);
  if (!stat.isDirectory()) return stat.blocks * 512;
  return stat.blocks * 512 + fs.readdirSync(entryPath)
    .reduce((total, name) => total + treeAllocatedBytes(path.join(entryPath, name)), 0);
}

function storageHarness(rowsByVm = {}, failingVm = null) {
  const calls = [];
  const releases = [];
  const manifests = Object.keys(rowsByVm).map((vmId, index) => ({
    vmId,
    imageGeneration: `${index}`.repeat(64),
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

test("host image inventory classifies current, live, stale, malformed, symlink, and hard-link entries", async () => {
  await withCache(async ({ cacheRoot, currentImageGeneration }) => {
    const current = makeImage(cacheRoot, CURRENT, { "current.bin": Buffer.alloc(8192) });
    const active = makeImage(cacheRoot, ACTIVE, { "active.bin": Buffer.alloc(4096) });
    const stale = makeImage(cacheRoot, STALE);
    fs.linkSync(path.join(current, "current.bin"), path.join(stale, "shared-current.bin"));
    const malformed = imagePath(cacheRoot, MALFORMED);
    fs.mkdirSync(malformed, { recursive: true });
    fs.writeFileSync(path.join(malformed, "pi-image.json"), "not json");
    fs.writeFileSync(path.join(malformed, "preserve.bin"), Buffer.alloc(4096));
    fs.writeFileSync(path.join(cacheRoot, "images", "not-a-generation"), "preserve");
    const outside = path.join(cacheRoot, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "outside.bin"), Buffer.alloc(4096));
    fs.symlinkSync(outside, path.join(cacheRoot, "images", "outside-link"));

    const inventory = inspectHostImageCache({ cacheRoot, currentImageGeneration, manifests: [{ imageGeneration: ACTIVE }] });
    assert.deepEqual(inventory.currentEntries.map((entry) => entry.name), [CURRENT]);
    assert.deepEqual(inventory.activeEntries.map((entry) => entry.name), [ACTIVE]);
    assert.deepEqual(inventory.staleEntries.map((entry) => entry.name), [STALE]);
    assert.deepEqual(inventory.unrecognizedEntries.map((entry) => entry.name).sort(), [MALFORMED, "not-a-generation", "outside-link"]);
    assert.ok(inventory.protectedBytes > 0);
    assert.ok(inventory.staleBytes > 0);
    assert.ok(inventory.unrecognizedBytes >= 0);
    // The stale tree names a hard-linked current file, but that allocation is protected.
    assert.ok(inventory.staleBytes < treeAllocatedBytes(stale));
    assert.equal(fs.existsSync(path.join(outside, "outside.bin")), true);
  });
});

test("host image inventory treats missing cache as empty and honors the cache-root override", async () => {
  await withCache(async ({ cacheRoot, currentImageGeneration }) => {
    assert.equal(inspectHostImageCache({ cacheRoot, currentImageGeneration, manifests: [] }).entries.length, 0);
    makeImage(cacheRoot, STALE, { "asset.bin": Buffer.alloc(1024) });
    const override = inspectHostImageCache({
      env: { PI_GONDOLIN_CACHE_DIR: cacheRoot },
      currentImageGeneration,
      manifests: [],
    });
    assert.equal(override.cacheRoot, cacheRoot);
    assert.deepEqual(override.staleEntries.map((entry) => entry.name), [STALE]);
  });
});

test("gondolinier storage list reports stale host cache without an active VM", async () => {
  await withCache(async (cacheOptions) => {
    makeImage(cacheOptions.cacheRoot, STALE, { "asset.bin": Buffer.alloc(10 * 1024 * 1024) });
    const stdout = output();
    await runGondolinier(["storage", "list"], { stdout, ...cacheOptions, manifests: [] });
    assert.match(stdout.value(), /No active Pi VMs with Docker storage/);
    assert.match(stdout.value(), /Stale\s+1 reclaimable generation/);
    assert.match(stdout.value(), /Overall reclaimable (?!0\.00 GB)/);
  });
});

test("gondolinier storage list combines Docker and host image-cache totals", async () => {
  await withCache(async (cacheOptions) => {
    makeImage(cacheOptions.cacheRoot, CURRENT, { "asset.bin": Buffer.alloc(1024) });
    makeImage(cacheOptions.cacheRoot, STALE, { "asset.bin": Buffer.alloc(1024) });
    const harness = storageHarness({ one: STORAGE_ROWS, two: STORAGE_ROWS });
    const stdout = output();
    assert.equal(await runGondolinier(["storage", "list"], { stdout, ...cacheOptions, ...harness }), 0);
    assert.match(stdout.value(), /Images       3.00 GB/);
    assert.match(stdout.value(), /Containers   1.00 GB/);
    assert.match(stdout.value(), /Volumes      4.00 GB/);
    assert.match(stdout.value(), /Build cache  0.50 GB/);
    assert.match(stdout.value(), /Total        8.50 GB/);
    assert.match(stdout.value(), /Host VM image cache \(allocated\):/);
    assert.match(stdout.value(), /Current\s+1 protected generation/);
    assert.match(stdout.value(), /Stale\s+1 reclaimable generation/);
    assert.match(stdout.value(), /Overall reclaimable/);
    assert.match(stdout.value(), /WARNING: 4 active volumes \(2.00 GB\) will be preserved by purge/);
    assert.deepEqual(harness.releases.sort(), ["one", "two"]);
  });
});

test("gondolinier storage purge defaults to no and removes only previewed stale generations", async () => {
  await withCache(async (cacheOptions) => {
    makeImage(cacheOptions.cacheRoot, CURRENT, { "asset.bin": Buffer.alloc(1024) });
    makeImage(cacheOptions.cacheRoot, ACTIVE, { "asset.bin": Buffer.alloc(1024) });
    makeImage(cacheOptions.cacheRoot, STALE, { "asset.bin": Buffer.alloc(1024) });
    const malformed = imagePath(cacheOptions.cacheRoot, MALFORMED);
    fs.mkdirSync(malformed, { recursive: true });
    fs.writeFileSync(path.join(malformed, "pi-image.json"), "invalid");

    const declined = storageHarness({ one: STORAGE_ROWS });
    declined.manifests[0].imageGeneration = ACTIVE;
    const declinedOutput = output();
    await runGondolinier(["storage", "purge"], {
      stdout: declinedOutput,
      confirm: async () => false,
      ...cacheOptions,
      ...declined,
    });
    assert.match(declinedOutput.value(), /Host VM image cache/);
    assert.match(declinedOutput.value(), /Purge cancelled/);
    assert.equal(fs.existsSync(imagePath(cacheOptions.cacheRoot, STALE)), true);
    assert.equal(declined.calls.filter(([, argv]) => argv[2] === "prune").length, 0);

    const confirmed = storageHarness({ one: STORAGE_ROWS, two: STORAGE_ROWS });
    confirmed.manifests[0].imageGeneration = ACTIVE;
    const confirmedOutput = output();
    await runGondolinier(["storage", "purge"], {
      stdout: confirmedOutput,
      confirm: async () => true,
      ...cacheOptions,
      ...confirmed,
    });
    assert.equal(confirmed.calls.filter(([, argv]) => argv[2] === "prune").length, 2);
    assert.equal(fs.existsSync(imagePath(cacheOptions.cacheRoot, STALE)), false);
    assert.equal(fs.existsSync(imagePath(cacheOptions.cacheRoot, CURRENT)), true);
    assert.equal(fs.existsSync(imagePath(cacheOptions.cacheRoot, ACTIVE)), true);
    assert.equal(fs.existsSync(malformed), true);
    assert.match(confirmedOutput.value(), /Reclaimable Docker storage purged/);
    assert.match(confirmedOutput.value(), /Removed 1 stale host VM image generation/);
  });
});

test("stale-image deletion revalidates targets and never deletes after inspection failure", async () => {
  await withCache(async (cacheOptions) => {
    makeImage(cacheOptions.cacheRoot, CURRENT, { "asset.bin": Buffer.alloc(1024) });
    makeImage(cacheOptions.cacheRoot, STALE, { "asset.bin": Buffer.alloc(1024) });
    const preview = inspectHostImageCache({ ...cacheOptions, manifests: [] });
    const changed = removeStaleImageGenerations(preview, {
      ...cacheOptions,
      manifests: [{ imageGeneration: STALE }],
    });
    assert.deepEqual(changed.removed, []);
    assert.deepEqual(changed.skipped, [STALE]);
    assert.equal(fs.existsSync(imagePath(cacheOptions.cacheRoot, STALE)), true);

    await assert.rejects(
      () => runGondolinier(["storage", "purge"], {
        stdout: output(),
        manifests: [],
        cacheRoot: cacheOptions.cacheRoot,
        getImageInputs: () => { throw new Error("cache inspection failed"); },
        confirm: async () => true,
      }),
      /cache inspection failed/,
    );
    assert.equal(fs.existsSync(imagePath(cacheOptions.cacheRoot, STALE)), true);
  });
});

test("gondolinier storage purge skips an empty preview and aborts all deletion after controller inspection failure", async () => {
  await withCache(async (cacheOptions) => {
    const empty = storageHarness({ one: "" });
    const emptyOutput = output();
    await runGondolinier(["storage", "purge"], {
      stdout: emptyOutput,
      confirm: async () => { throw new Error("must not prompt"); },
      ...cacheOptions,
      ...empty,
    });
    assert.match(emptyOutput.value(), /No reclaimable Docker storage or stale host VM images found/);

    makeImage(cacheOptions.cacheRoot, STALE, { "asset.bin": Buffer.alloc(1024) });
    const failed = storageHarness({ one: STORAGE_ROWS, two: STORAGE_ROWS }, "two");
    await assert.rejects(
      () => runGondolinier(["storage", "purge"], { stdout: output(), confirm: async () => true, ...cacheOptions, ...failed }),
      /inspection failed/,
    );
    assert.equal(failed.calls.filter(([, argv]) => argv[2] === "prune").length, 0);
    assert.equal(fs.existsSync(imagePath(cacheOptions.cacheRoot, STALE)), true);
    assert.deepEqual(failed.releases.sort(), ["one", "two"]);
  });
});
