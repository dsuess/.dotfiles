import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSandboxPolicy,
  createNetworkOptions,
  createPolicyProviders,
  parseSandboxSettings,
  parseSandboxSettingsText,
  ProtectedWriteProvider,
  resolveExternalMounts,
  WORKSPACE_PROTECTED_PATHS,
} from "./policy.mjs";

function makeRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-policy-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function validSettings(overrides = {}) {
  return {
    version: 1,
    externalMounts: [],
    network: {
      mode: "public-http",
      allowedHosts: [],
      allowWebSockets: false,
      tcpMappings: [],
    },
    ...overrides,
  };
}

function makeScope(workspace, bareCommonDirectory = null) {
  return Object.freeze({
    physicalLaunchDirectory: workspace,
    canonicalWorkspaceRoot: workspace,
    bareCommonDirectory,
    workspaceKey: "a".repeat(64),
  });
}

test("settings parser accepts only the versioned Gondolin schema", () => {
  const parsed = parseSandboxSettings(
    validSettings({
      externalMounts: [{ path: "~/source", access: "ro" }],
      network: {
        mode: "allowlist",
        allowedHosts: ["example.com", "*.npmjs.org"],
        allowWebSockets: true,
        tcpMappings: [
          {
            guestHost: "database.local",
            guestPort: 5432,
            connectHost: "127.0.0.1",
            connectPort: 15432,
          },
        ],
      },
    }),
  );
  assert.equal(parsed.version, 1);
  assert.equal(parsed.externalMounts[0].access, "ro");
  assert.equal(parsed.network.tcpMappings[0].connectPort, 15432);
  assert.equal(Object.isFrozen(parsed.network), true);

  assert.throws(
    () => parseSandboxSettings({ network: {}, filesystem: {} }),
    /unknown key|version/,
  );
  assert.throws(() => parseSandboxSettingsText("{"), /malformed/);
  assert.throws(
    () => parseSandboxSettings({ ...validSettings(), extra: true }),
    /unknown key/,
  );
  assert.throws(
    () =>
      parseSandboxSettings(
        validSettings({
          network: {
            mode: "allowlist",
            allowedHosts: [],
            allowWebSockets: false,
            tcpMappings: [],
          },
        }),
      ),
    /requires at least one/,
  );
  assert.throws(
    () =>
      parseSandboxSettings(
        validSettings({
          network: {
            mode: "offline",
            allowedHosts: [],
            allowWebSockets: true,
            tcpMappings: [],
          },
        }),
      ),
    /offline mode/,
  );
  assert.throws(
    () =>
      parseSandboxSettings(
        validSettings({
          network: {
            mode: "allowlist",
            allowedHosts: ["*"],
            allowWebSockets: false,
            tcpMappings: [],
          },
        }),
      ),
    /global wildcard/,
  );
});

test("external mounts canonicalize same-path directories and reject unsafe grants", (t) => {
  const root = makeRoot(t);
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const external = path.join(root, "external");
  const credential = path.join(home, ".ssh");
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  fs.mkdirSync(external);
  fs.mkdirSync(credential);
  fs.mkdirSync(path.join(credential, "git"));
  const signingPublicKey = path.join(credential, "git", "id_ed25519_signing.pub");
  const signingPrivateKey = path.join(credential, "git", "id_ed25519_signing");
  fs.writeFileSync(signingPublicKey, "ssh-ed25519 public-key");
  fs.writeFileSync(signingPrivateKey, "private-key");
  fs.symlinkSync(external, path.join(home, "external-link"));

  const parsed = parseSandboxSettings(
    validSettings({ externalMounts: [{ path: "~/external-link", access: "ro" }] }),
  );
  const resolved = resolveExternalMounts(parsed, {
    homeDirectory: home,
    workspaceRoot: workspace,
    invariantRoots: [credential],
  });
  assert.equal(resolved[0].hostPath, fs.realpathSync(external));
  assert.equal(resolved[0].guestPath, fs.realpathSync(external));
  assert.equal(resolved[0].configuredPath, "~/external-link");

  const signingKey = resolveExternalMounts(
    parseSandboxSettings(validSettings({ externalMounts: [{ path: signingPublicKey, access: "ro" }] })),
    { homeDirectory: home, workspaceRoot: workspace, invariantRoots: [credential] },
  );
  const signingGuestDirectory = path.dirname(signingPublicKey);
  assert.equal(signingKey[0].kind, "signing-public-key");
  assert.equal(signingKey[0].hostPath, signingPublicKey);
  assert.equal(signingKey[0].guestPath, signingGuestDirectory);
  const signingProvider = createPolicyProviders({ mounts: signingKey })[signingGuestDirectory];
  assert.deepEqual(signingProvider.readdirSync("/"), ["id_ed25519_signing.pub"]);
  const signingHandle = signingProvider.openSync("/id_ed25519_signing.pub", "r");
  assert.equal(signingHandle.readFileSync({ encoding: "utf8" }), "ssh-ed25519 public-key");
  signingHandle.closeSync();
  assert.throws(() => signingProvider.openSync("/id_ed25519_signing", "r"), /ENOENT|no such file/i);
  assert.throws(() => signingProvider.openSync("/unrelated", "r"), /ENOENT|no such file/i);
  assert.throws(() => signingProvider.openSync("/id_ed25519_signing.pub", "w"), /read-only|EROFS|ERRNO_30/i);
  assert.throws(() => signingProvider.openSync("/id_ed25519_signing.pub", "r+"), /read-only|EROFS|ERRNO_30/i);
  assert.throws(() => signingProvider.renameSync("/id_ed25519_signing.pub", "/renamed"), /read-only|EROFS|ERRNO_30/i);
  assert.throws(() => signingProvider.unlinkSync("/id_ed25519_signing.pub"), /read-only|EROFS|ERRNO_30/i);
  for (const invalidSigningMount of [
    { path: signingPublicKey, access: "rw" },
    { path: signingPrivateKey, access: "ro" },
  ]) {
    assert.throws(
      () =>
        resolveExternalMounts(
          parseSandboxSettings(validSettings({ externalMounts: [invalidSigningMount] })),
          { homeDirectory: home, workspaceRoot: workspace, invariantRoots: [credential] },
        ),
      /directory or the read-only signing public key/,
    );
  }

  const failures = [
    [{ path: "/", access: "ro" }],
    [{ path: "~", access: "ro" }],
    [{ path: "relative", access: "ro" }],
    [{ path: "~/missing", access: "ro" }],
    [{ path: credential, access: "ro" }],
    [{ path: workspace, access: "ro" }],
    [
      { path: external, access: "ro" },
      { path: path.join(external, "nested"), access: "rw" },
    ],
  ];
  fs.mkdirSync(path.join(external, "nested"));
  for (const externalMounts of failures) {
    const settings = parseSandboxSettings(validSettings({ externalMounts }));
    assert.throws(
      () =>
        resolveExternalMounts(settings, {
          homeDirectory: home,
          workspaceRoot: workspace,
          invariantRoots: [credential],
        }),
      /absolute|does not exist|whole home|boundary|overlaps/,
    );
  }
});

test("effective policy creates private workspace state and stable mount generations", (t) => {
  const root = makeRoot(t);
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const external = path.join(root, "external");
  const cacheRoot = path.join(root, "cache-root");
  const runtimeRoot = path.join(root, "runtime");
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  fs.mkdirSync(external);

  const settings = parseSandboxSettings(
    validSettings({ externalMounts: [{ path: external, access: "ro" }] }),
  );
  const policy = buildSandboxPolicy({
    scope: makeScope(fs.realpathSync(workspace)),
    settings,
    homeDirectory: home,
    cacheRoot,
    runtimeRoot,
    imageGeneration: "image-a",
  });
  const same = buildSandboxPolicy({
    scope: makeScope(fs.realpathSync(workspace)),
    settings,
    homeDirectory: home,
    cacheRoot,
    runtimeRoot,
    imageGeneration: "image-a",
  });
  assert.equal(policy.policyGeneration, same.policyGeneration);
  assert.equal(policy.imageGeneration, "image-a");
  assert.deepEqual(
    policy.mounts.map((mount) => [mount.kind, mount.access]),
    [
      ["workspace", "rw"],
      ["external", "ro"],
      ["cache", "rw"],
      ["npm-cache", "rw"],
      ["cargo-cache", "rw"],
    ],
  );
  assert.equal(fs.statSync(policy.workspaceState).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(path.join(policy.workspaceState, "docker")), false);

  const changed = buildSandboxPolicy({
    scope: makeScope(fs.realpathSync(workspace)),
    settings: parseSandboxSettings(
      validSettings({
        network: {
          mode: "allowlist",
          allowedHosts: ["example.com"],
          allowWebSockets: false,
          tcpMappings: [],
        },
      }),
    ),
    homeDirectory: home,
    cacheRoot,
    runtimeRoot,
  });
  assert.notEqual(changed.policyGeneration, policy.policyGeneration);
});

test("protected provider guards lexical, resolved, hard-link, link, and rename writes", async (t) => {
  const root = makeRoot(t);
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(workspace, ".git", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(workspace, ".vscode"));
  fs.writeFileSync(path.join(workspace, ".git", "config"), "protected");
  fs.writeFileSync(path.join(workspace, ".bashrc"), "protected");
  fs.writeFileSync(path.join(workspace, "allowed.txt"), "allowed");
  fs.writeFileSync(path.join(workspace, "hard-source"), "hard");
  fs.linkSync(path.join(workspace, "hard-source"), path.join(workspace, "hard-alias"));
  fs.symlinkSync(".git/config", path.join(workspace, "config-alias"));

  const protectedPaths = WORKSPACE_PROTECTED_PATHS.map((entry) => path.join(workspace, entry));
  const provider = new ProtectedWriteProvider(workspace, protectedPaths);

  await provider.mkdir("/", { recursive: true });
  await assert.rejects(() => provider.rmdir("/"), /write denied/);
  const allowed = await provider.open("/allowed.txt", "r+");
  await allowed.writeFile("changed");
  await allowed.close();
  assert.equal(fs.readFileSync(path.join(workspace, "allowed.txt"), "utf8"), "changed");

  for (const entry of ["/.git/config", "/.bashrc", "/config-alias", "/hard-alias"]) {
    await assert.rejects(() => provider.open(entry, "r+"), /write denied/);
  }
  await assert.rejects(() => provider.mkdir("/.git/hooks/new"), /write denied/);
  await assert.rejects(() => provider.rename("/allowed.txt", "/.bashrc"), /write denied/);
  await assert.rejects(() => provider.rename("/.bashrc", "/moved"), /write denied/);
  await assert.rejects(() => provider.link("/.git/config", "/linked"), /write denied/);
  await assert.rejects(() => provider.link("/allowed.txt", "/.git/hooks/linked"), /write denied/);
  await assert.rejects(() => provider.symlink(".git/config", "/new-alias"), /write denied/);
  assert.throws(() => provider.openSync("/.vscode/settings.json", "w"), /write denied/);
});

test("policy providers enforce external read-only access", async (t) => {
  const root = makeRoot(t);
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const external = path.join(root, "external");
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "value"), "readable");
  const policy = buildSandboxPolicy({
    scope: makeScope(fs.realpathSync(workspace)),
    settings: parseSandboxSettings(
      validSettings({ externalMounts: [{ path: external, access: "ro" }] }),
    ),
    homeDirectory: home,
    cacheRoot: path.join(root, "cache"),
    runtimeRoot: path.join(root, "runtime"),
  });
  const providers = createPolicyProviders(policy);
  const externalProvider = providers[fs.realpathSync(external)];
  const handle = await externalProvider.open("/value", "r");
  assert.equal(await handle.readFile({ encoding: "utf8" }), "readable");
  await handle.close();
  await assert.rejects(() => externalProvider.open("/value", "w"), /read-only|EROFS|ERRNO_30/i);
});

test("network modes compile to blocked-internal HTTP, optional TCP, or offline", () => {
  const publicOptions = createNetworkOptions(
    parseSandboxSettings(validSettings()).network,
  );
  assert.equal(publicOptions.netEnabled, true);
  assert.equal(typeof publicOptions.httpHooks.isIpAllowed, "function");
  assert.equal(publicOptions.allowWebSockets, false);

  const allowlist = parseSandboxSettings(
    validSettings({
      network: {
        mode: "allowlist",
        allowedHosts: ["example.com"],
        allowWebSockets: true,
        tcpMappings: [
          {
            guestHost: "database.local",
            guestPort: 5432,
            connectHost: "127.0.0.1",
            connectPort: 15432,
          },
        ],
      },
    }),
  ).network;
  const mapped = createNetworkOptions(allowlist);
  assert.deepEqual(mapped.tcp.hosts, { "database.local:5432": "127.0.0.1:15432" });
  assert.deepEqual(mapped.dns, { mode: "synthetic", syntheticHostMapping: "per-host" });

  const offline = createNetworkOptions(
    parseSandboxSettings(
      validSettings({
        network: {
          mode: "offline",
          allowedHosts: [],
          allowWebSockets: false,
          tcpMappings: [],
        },
      }),
    ).network,
  );
  assert.deepEqual(offline, { netEnabled: false, allowWebSockets: false });
});
