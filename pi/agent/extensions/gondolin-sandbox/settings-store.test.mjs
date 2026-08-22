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

function baseSettings() {
  return {
    version: 1,
    externalMounts: [],
    network: {
      mode: "public-http",
      allowedHosts: [],
      allowWebSockets: false,
      tcpMappings: [],
    },
  };
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-settings-store-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const external = path.join(root, "external");
  const source = path.join(root, "stow-source", "settings.json");
  const target = path.join(home, ".pi", "sandbox", "settings.json");
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  fs.mkdirSync(external);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(source, `${JSON.stringify(baseSettings(), null, 2)}\n`, { mode: 0o640 });
  fs.symlinkSync(source, target);
  return {
    root,
    home,
    workspace: fs.realpathSync(workspace),
    external: fs.realpathSync(external),
    source,
    target,
    status: { workspaceRoot: fs.realpathSync(workspace), bareCommonDirectory: null },
  };
}

test("validates the complete versioned settings schema", () => {
  assert.deepEqual(validateSandboxSettings(baseSettings()), baseSettings());
  assert.throws(() => validateSandboxSettings({ ...baseSettings(), extra: true }), /unknown key/);
  assert.throws(
    () =>
      validateSandboxSettings({
        ...baseSettings(),
        network: { ...baseSettings().network, mode: "allowlist" },
      }),
    /requires at least one/,
  );
  assert.throws(
    () =>
      validateSandboxSettings({
        ...baseSettings(),
        network: { ...baseSettings().network, mode: "offline", allowWebSockets: true },
      }),
    /offline mode/,
  );
});

test("canonicalizes external mounts and rejects control, credential, and workspace overlaps", (t) => {
  const item = fixture(t);
  const alias = path.join(item.home, "external-link");
  fs.symlinkSync(item.external, alias);
  const normalized = canonicalizeSandboxSettings(
    { ...baseSettings(), externalMounts: [{ path: alias, access: "ro" }] },
    item.status,
    item.home,
  );
  assert.deepEqual(normalized.externalMounts, [{ path: item.external, access: "ro" }]);

  fs.mkdirSync(path.join(item.home, ".ssh"));
  for (const candidate of ["/", item.home, item.workspace, path.join(item.home, ".ssh")]) {
    assert.throws(
      () =>
        canonicalizeSandboxSettings(
          { ...baseSettings(), externalMounts: [{ path: candidate, access: "rw" }] },
          item.status,
          item.home,
        ),
      /whole home|boundary/,
    );
  }
});

test("atomic saves replace the Stow source, preserve its mode and symlink, and serialize writers", async (t) => {
  const item = fixture(t);
  const firstStore = new SandboxSettingsStore(item.target);
  const secondStore = new SandboxSettingsStore(item.target);
  const first = {
    ...baseSettings(),
    network: { ...baseSettings().network, allowWebSockets: true },
  };
  const second = {
    ...baseSettings(),
    externalMounts: [{ path: item.external, access: "ro" }],
  };
  const firstSave = firstStore.save(first, item.status);
  const secondSave = secondStore.save(second, item.status);
  await Promise.all([firstSave, secondSave]);

  assert.equal(fs.lstatSync(item.target).isSymbolicLink(), true);
  assert.equal(fs.statSync(item.source).mode & 0o777, 0o640);
  assert.deepEqual(JSON.parse(fs.readFileSync(item.source, "utf8")), {
    ...second,
    externalMounts: [{ path: item.external, access: "ro" }],
  });
  assert.deepEqual(firstStore.load().externalMounts, [{ path: item.external, access: "ro" }]);
  const siblings = fs.readdirSync(path.dirname(item.source));
  assert.equal(siblings.some((entry) => entry.endsWith(".tmp")), false);
  assert.equal(siblings.some((entry) => entry.endsWith(".lock")), false);
});

test("validation failure leaves the durable settings bytes unchanged", async (t) => {
  const item = fixture(t);
  const store = new SandboxSettingsStore(item.target);
  const before = fs.readFileSync(item.source);
  await assert.rejects(
    () =>
      store.save(
        { ...baseSettings(), externalMounts: [{ path: item.workspace, access: "rw" }] },
        item.status,
      ),
    /boundary/,
  );
  assert.deepEqual(fs.readFileSync(item.source), before);
});
