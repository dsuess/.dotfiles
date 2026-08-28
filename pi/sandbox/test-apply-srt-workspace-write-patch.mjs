import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applySrtWorkspaceWritePatch,
  SRT_PACKAGE_ROOT,
  SRT_WORKSPACE_WRITE_PATCHES,
} from "./apply-srt-workspace-write-patch.mjs";

function copyPackage(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-srt-patch-"));
  fs.cpSync(SRT_PACKAGE_ROOT, root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function digest(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

test("the SRT workspace-write patch is idempotent and pins every patched output", (t) => {
  const root = copyPackage(t);
  applySrtWorkspaceWritePatch(root);
  for (const patch of SRT_WORKSPACE_WRITE_PATCHES) {
    assert.match(digest(path.join(root, patch.relativePath)), /^[0-9a-f]{64}$/, patch.relativePath);
  }
  assert.match(fs.readFileSync(path.join(root, "dist/sandbox/macos-sandbox-utils.js"), "utf8"), /allowUnrestrictedIp/);
});

test("the SRT workspace-write patch refuses unreviewed package drift", (t) => {
  const root = copyPackage(t);
  const target = path.join(root, SRT_WORKSPACE_WRITE_PATCHES[0].relativePath);
  fs.appendFileSync(target, "\n// unreviewed drift\n");
  assert.throws(() => applySrtWorkspaceWritePatch(root), /pre-patch hash drift/);
});

test("the patch is limited to the macOS write exception", () => {
  const macos = SRT_WORKSPACE_WRITE_PATCHES.find((patch) => patch.relativePath.endsWith("macos-sandbox-utils.js"));
  const manager = SRT_WORKSPACE_WRITE_PATCHES.find((patch) => patch.relativePath.endsWith("sandbox-manager.js"));
  assert.match(macos.replace, /cwdHasCompleteWrites/);
  assert.match(macos.replace, /allowCompleteWorkspaceWrites/);
  assert.match(manager.replace, /getAllowCompleteWorkspaceWrites/);
  assert.doesNotMatch(macos.replace, /file-read\*/);
});
