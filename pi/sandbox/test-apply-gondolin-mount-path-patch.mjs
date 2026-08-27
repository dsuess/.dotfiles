import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyGondolinMountPathPatch,
  patchReplacements,
} from "./apply-gondolin-mount-path-patch.mjs";
import {
  buildSandboxfsAppend,
  encodeSandboxfsPath,
} from "./node_modules/@earendil-works/gondolin/dist/src/sandbox/server-boot-config.js";
import { ROOTFS_INIT_SCRIPT } from "./node_modules/@earendil-works/gondolin/dist/src/alpine/init-scripts.js";

const sourcePackage = path.join(import.meta.dirname, "node_modules", "@earendil-works", "gondolin");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gondolin-mount-patch-"));
  const target = path.join(root, "node_modules", "@earendil-works", "gondolin");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(sourcePackage, target, { recursive: true });
  for (const item of patchReplacements) {
    const filePath = path.join(target, item.file);
    const source = fs.readFileSync(filePath, "utf8");
    if (source.includes(item.after)) fs.writeFileSync(filePath, source.replace(item.after, item.before));
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, target };
}

function parseGuestMountConfig(cmdline) {
  const start = ROOTFS_INIT_SCRIPT.indexOf('sandboxfs_mount="/data"');
  const end = ROOTFS_INIT_SCRIPT.indexOf("wait_for_sandboxfs()", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const parser = ROOTFS_INIT_SCRIPT
    .slice(start, end)
    .replace("if [ -r /proc/cmdline ]; then\n  for arg in $(cat /proc/cmdline); do", "if true; then\n  for arg in $CMDLINE; do");
  const output = execFileSync("sh", ["-ec", `${parser}printf '%s' "$sandboxfs_mount" | base64 | tr -d '\\n'; printf '\\n'; printf '%s' "$sandboxfs_binds" | base64 | tr -d '\\n'; printf '\\n'`], {
    encoding: "utf8",
    env: { ...process.env, CMDLINE: cmdline },
  });
  return output.split("\n").slice(0, 2).map((value) => Buffer.from(value, "base64").toString());
}

test("pinned Gondolin mount-path patch applies cleanly and is idempotent", (t) => {
  const { root, target } = fixture(t);
  assert.deepEqual(applyGondolinMountPathPatch(root), { changed: 3 });
  assert.match(
    fs.readFileSync(path.join(target, "dist/src/sandbox/server-boot-config.js"), "utf8"),
    /sandboxfs\.mount\.v1/,
  );
  assert.match(
    fs.readFileSync(path.join(target, "dist/src/vm/core.js"), "utf8"),
    /mountpoint -q/,
  );
  assert.deepEqual(applyGondolinMountPathPatch(root), { changed: 0 });
});

test("pinned Gondolin mount-path patch rejects partial, version, and source drift", (t) => {
  const { root, target } = fixture(t);
  const item = patchReplacements[0];
  const filePath = path.join(target, item.file);
  fs.writeFileSync(filePath, fs.readFileSync(filePath, "utf8").replace(item.before, item.after));
  assert.throws(() => applyGondolinMountPathPatch(root), /partially patched/);

  const versionFixture = fixture(t);
  const manifestPath = path.join(versionFixture.target, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.version = "0.12.1";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => applyGondolinMountPathPatch(versionFixture.root), /expected @earendil-works\/gondolin@0\.12\.0/);

  const sourceFixture = fixture(t);
  const sourcePath = path.join(sourceFixture.target, item.file);
  fs.writeFileSync(sourcePath, fs.readFileSync(sourcePath, "utf8").replace("export function buildSandboxfsAppend", "export function changedBuildSandboxfsAppend"));
  assert.throws(() => applyGondolinMountPathPatch(sourceFixture.root), /unexpected source anchor/);
});

test("v1 boot fields independently round-trip whitespace and delimiter-bearing paths", () => {
  const mount = "/Users/dsuess/src/Video Upscale,100%\n";
  const binds = ["/tmp/a b", "/tmp/comma,%", "/tmp/line\nbreak", "/tmp/final-newline\n"];
  const append = buildSandboxfsAppend("root=/dev/vda", { fuseMount: mount, fuseBinds: binds });
  const tokens = append.split(" ");
  assert.equal(tokens.includes(mount), false);
  assert.equal(tokens.includes(binds[0]), false);
  assert.equal(tokens.filter((token) => token.startsWith("sandboxfs.bind.v1=")).length, binds.length);
  assert.ok(tokens.every((token) => !token.includes(",") && !token.includes("%")));
  assert.deepEqual(parseGuestMountConfig(append), [mount, ""]);
  assert.equal(encodeSandboxfsPath(mount), Buffer.from(mount).toString("base64url"));
});

test("guest parser retains legacy mount and bind fields", () => {
  assert.deepEqual(
    parseGuestMountConfig("root=/dev/vda sandboxfs.mount=/legacy sandboxfs.bind=/one,/two"),
    ["/legacy", "/one,/two"],
  );
});
