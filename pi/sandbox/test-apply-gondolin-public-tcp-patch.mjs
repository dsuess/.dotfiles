import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyGondolinPublicTcpPatch, patchReplacements } from "./apply-gondolin-public-tcp-patch.mjs";

const sourcePackage = path.join(import.meta.dirname, "node_modules", "@earendil-works", "gondolin");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gondolin-patch-"));
  const target = path.join(root, "node_modules", "@earendil-works", "gondolin");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(sourcePackage, target, { recursive: true });
  // The checked-out runtime can already be patched; normalize fixtures to the
  // exact published source so this test covers the clean install path too.
  for (const item of patchReplacements) {
    const filePath = path.join(target, item.file);
    const source = fs.readFileSync(filePath, "utf8");
    if (source.includes(item.after)) fs.writeFileSync(filePath, source.replace(item.after, item.before));
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, target };
}

test("pinned Gondolin public-TCP patch applies cleanly and is idempotent", (t) => {
  const { root, target } = fixture(t);
  assert.deepEqual(applyGondolinPublicTcpPatch(root), { changed: 8 });
  assert.match(fs.readFileSync(path.join(target, "dist/src/qemu/net.js"), "utf8"), /resolvePublicTcp/);
  assert.deepEqual(applyGondolinPublicTcpPatch(root), { changed: 0 });
});

test("pinned Gondolin public-TCP patch rejects a partially patched package", (t) => {
  const { root, target } = fixture(t);
  const item = patchReplacements[0];
  const filePath = path.join(target, item.file);
  fs.writeFileSync(filePath, fs.readFileSync(filePath, "utf8").replace(item.before, item.after));
  assert.throws(() => applyGondolinPublicTcpPatch(root), /partially patched/);
});

test("pinned Gondolin public-TCP patch rejects a version mismatch", (t) => {
  const { root, target } = fixture(t);
  const manifestPath = path.join(target, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.version = "0.12.1";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => applyGondolinPublicTcpPatch(root), /expected @earendil-works\/gondolin@0\.12\.0/);
});

test("pinned Gondolin public-TCP patch rejects an unknown source anchor", (t) => {
  const { root, target } = fixture(t);
  const netPath = path.join(target, "dist/src/qemu/net.js");
  fs.writeFileSync(netPath, fs.readFileSync(netPath, "utf8").replace("    tcp;", "    tcpChanged;"));
  assert.throws(() => applyGondolinPublicTcpPatch(root), /unexpected source anchor in dist\/src\/qemu\/net\.js/);
});
