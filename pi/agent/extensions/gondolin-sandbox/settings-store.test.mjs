import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalizeSandboxSettings,
  SandboxSettingsStore,
  validateSandboxSettings,
} from "./settings-store.ts";

function baseSettings(overrides = {}) {
  return {
    version: 1,
    filesystem: {
      workspace: { access: "rw", writeProtectedPaths: [".git/config"] },
      workspaceOverrides: [],
      bareCommon: { access: "rw", writeProtectedPaths: ["hooks", "config"] },
      externalMounts: [],
    },
    network: { mode: "public-http", allowedHosts: [], allowWebSockets: false, tcpMappings: [] },
    ...overrides,
  };
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-settings-store-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"); const workspace = path.join(root, "workspace"); const external = path.join(root, "external");
  const dotfiles = path.join(home, ".dotfiles");
  const source = path.join(root, "stow-source", "settings.json"); const target = path.join(home, ".pi", "sandbox", "settings.json");
  fs.mkdirSync(home); fs.mkdirSync(workspace); fs.mkdirSync(external); fs.mkdirSync(dotfiles, { recursive: true });
  fs.mkdirSync(path.dirname(source), { recursive: true }); fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(source, `${JSON.stringify(baseSettings(), null, 2)}\n`, { mode: 0o640 }); fs.symlinkSync(source, target);
  return { root, home, workspace: fs.realpathSync(workspace), external: fs.realpathSync(external), dotfiles: fs.realpathSync(dotfiles), source, target, status: { workspaceRoot: fs.realpathSync(workspace), bareCommonDirectory: null } };
}

test("validates the complete versioned filesystem settings schema", (t) => {
  const item = fixture(t);
  assert.deepEqual(validateSandboxSettings(baseSettings(), item.home), baseSettings());
  assert.equal(validateSandboxSettings(baseSettings({ network: { ...baseSettings().network, mode: "public-tcp" } }), item.home).network.mode, "public-tcp");
  assert.throws(() => validateSandboxSettings(baseSettings({ network: { ...baseSettings().network, mode: "public-tcp", allowedHosts: ["example.com"] } }), item.home), /does not use allowedHosts/);
  assert.throws(() => validateSandboxSettings({ ...baseSettings(), extra: true }, item.home), /unknown key/);
  assert.throws(() => validateSandboxSettings(baseSettings({ filesystem: { ...baseSettings().filesystem, workspace: { access: "bad", writeProtectedPaths: [] } } }), item.home), /access/);
  assert.throws(() => validateSandboxSettings(baseSettings({ filesystem: { ...baseSettings().filesystem, workspace: { access: "rw", writeProtectedPaths: ["/absolute"] } } }), item.home), /relative/);
  assert.throws(() => validateSandboxSettings(baseSettings({ filesystem: { ...baseSettings().filesystem, workspaceOverrides: [{ root: "~/missing", access: "rw", writeProtectedPaths: [] }] } }), item.home), /existing directory/);
  fs.symlinkSync(item.dotfiles, path.join(item.home, "dotfiles-alias"));
  assert.throws(() => validateSandboxSettings(baseSettings({ filesystem: { ...baseSettings().filesystem, workspaceOverrides: [
    { root: "~/.dotfiles", access: "rw", writeProtectedPaths: [] }, { root: "~/dotfiles-alias", access: "rw", writeProtectedPaths: [] },
  ] } }), item.home), /duplicate canonical roots/);
});

test("canonicalizes external mounts while preserving portable workspace overrides", (t) => {
  const item = fixture(t); const alias = path.join(item.home, "external-link"); fs.symlinkSync(item.external, alias);
  const normalized = canonicalizeSandboxSettings(baseSettings({ filesystem: {
    ...baseSettings().filesystem,
    workspaceOverrides: [{ root: "~/.dotfiles", access: "rw", writeProtectedPaths: [] }],
    externalMounts: [{ path: alias, access: "ro" }],
  } }), item.status, item.home);
  assert.deepEqual(normalized.filesystem.externalMounts, [{ path: item.external, access: "ro" }]);
  assert.equal(normalized.filesystem.workspaceOverrides[0].root, "~/.dotfiles");
  for (const candidate of ["/", item.home, item.workspace, path.join(item.home, ".ssh")]) {
    assert.throws(() => canonicalizeSandboxSettings(baseSettings({ filesystem: { ...baseSettings().filesystem, externalMounts: [{ path: candidate, access: "rw" }] } }), item.status, item.home), /whole home|boundary|does not exist/);
  }
});

test("atomic saves preserve Stow metadata, nested fields, portable overrides, and serialization", async (t) => {
  const item = fixture(t); const firstStore = new SandboxSettingsStore(item.target); const secondStore = new SandboxSettingsStore(item.target);
  const first = baseSettings({ filesystem: { ...baseSettings().filesystem, workspaceOverrides: [{ root: "~/.dotfiles", access: "rw", writeProtectedPaths: [] }] }, network: { ...baseSettings().network, allowWebSockets: true } });
  const second = baseSettings({ filesystem: { ...baseSettings().filesystem, workspaceOverrides: [{ root: "~/.dotfiles", access: "rw", writeProtectedPaths: [] }], externalMounts: [{ path: item.external, access: "ro" }] } });
  await Promise.all([firstStore.save(first, item.status), secondStore.save(second, item.status)]);
  assert.equal(fs.lstatSync(item.target).isSymbolicLink(), true); assert.equal(fs.statSync(item.source).mode & 0o777, 0o640);
  const saved = JSON.parse(fs.readFileSync(item.source, "utf8"));
  assert.deepEqual(saved.filesystem.externalMounts, [{ path: item.external, access: "ro" }]);
  assert.equal(saved.filesystem.workspaceOverrides[0].root, "~/.dotfiles");
  assert.deepEqual(firstStore.load().filesystem.externalMounts, [{ path: item.external, access: "ro" }]);
  const siblings = fs.readdirSync(path.dirname(item.source)); assert.equal(siblings.some((entry) => entry.endsWith(".tmp") || entry.endsWith(".lock")), false);
});

test("invalid settings leave durable source bytes unchanged", async (t) => {
  const item = fixture(t); const store = new SandboxSettingsStore(item.target); const before = fs.readFileSync(item.source);
  await assert.rejects(() => store.save(baseSettings({ filesystem: { ...baseSettings().filesystem, workspace: { access: "rw", writeProtectedPaths: ["../escape"] } } }), item.status), /relative/);
  assert.deepEqual(fs.readFileSync(item.source), before);
});
