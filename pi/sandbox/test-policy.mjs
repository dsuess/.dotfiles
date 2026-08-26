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
} from "./policy.mjs";

const defaultProtectedPaths = [
  ".gitconfig", ".gitmodules", ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile",
  ".ripgreprc", ".mcp.json", ".vscode", ".idea", ".claude/commands", ".claude/agents",
  ".agents", ".pi", ".git/hooks", ".git/config", "bin/pi", "pi/sandbox", "pi/agent",
];

function makeRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-policy-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function filesystem(overrides = {}) {
  return {
    workspace: { access: "rw", writeProtectedPaths: defaultProtectedPaths },
    workspaceOverrides: [],
    bareCommon: { access: "rw", writeProtectedPaths: ["hooks", "config"] },
    externalMounts: [],
    ...overrides,
  };
}

function validSettings(overrides = {}) {
  return {
    version: 1,
    filesystem: filesystem(),
    network: { mode: "public-http", allowedHosts: [], allowWebSockets: false, tcpMappings: [] },
    ingress: { workspaceProfiles: [] },
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

function build(scope, settings, home, root) {
  return buildSandboxPolicy({
    scope,
    settings,
    homeDirectory: home,
    cacheRoot: path.join(root, "cache"),
    runtimeRoot: path.join(root, "runtime"),
  });
}

test("settings parser enforces the versioned filesystem schema", (t) => {
  const root = makeRoot(t);
  const home = path.join(root, "home");
  const dotfiles = path.join(home, ".dotfiles");
  fs.mkdirSync(dotfiles, { recursive: true });
  const parsed = parseSandboxSettings(validSettings({
    filesystem: filesystem({
      workspaceOverrides: [{ root: "~/.dotfiles", access: "rw", writeProtectedPaths: [] }],
      externalMounts: [{ path: "~/source", access: "ro" }],
    }),
    network: {
      mode: "allowlist", allowedHosts: ["example.com", "*.npmjs.org"], allowWebSockets: true,
      tcpMappings: [{ guestHost: "database.local", guestPort: 5432, connectHost: "127.0.0.1", connectPort: 15432 }],
    },
  }), { homeDirectory: home });
  assert.equal(parsed.filesystem.workspaceOverrides[0].root, "~/.dotfiles");
  assert.equal(parsed.filesystem.externalMounts[0].access, "ro");
  assert.equal(Object.isFrozen(parsed.filesystem), true);

  assert.throws(() => parseSandboxSettings({ network: {}, filesystem: {} }), /unknown key|version/);
  assert.throws(() => parseSandboxSettingsText("{"), /malformed/);
  assert.throws(() => parseSandboxSettings(validSettings({ filesystem: filesystem({ workspace: { access: "bad", writeProtectedPaths: [] } }) })), /access/);
  for (const protectedPath of ["/absolute", "../escape", "folder/../escape", "", "."]) {
    assert.throws(() => parseSandboxSettings(validSettings({ filesystem: filesystem({ workspace: { access: "rw", writeProtectedPaths: [protectedPath] } }) })), /relative|bounded/);
  }
  assert.throws(() => parseSandboxSettings(validSettings({ filesystem: filesystem({ workspace: { access: "rw", writeProtectedPaths: [".git", ".git"] } }) })), /duplicates/);
  assert.throws(() => parseSandboxSettings(validSettings({ filesystem: filesystem({ workspaceOverrides: [{ root: "~/missing", access: "rw", writeProtectedPaths: [] }] }) }), { homeDirectory: home }), /existing directory/);
  fs.symlinkSync(dotfiles, path.join(home, "dotfiles-alias"));
  assert.throws(() => parseSandboxSettings(validSettings({ filesystem: filesystem({ workspaceOverrides: [
    { root: "~/.dotfiles", access: "rw", writeProtectedPaths: [] },
    { root: "~/dotfiles-alias", access: "rw", writeProtectedPaths: [] },
  ] }) }), { homeDirectory: home }), /duplicate canonical roots/);
});

test("ingress profiles are canonical, bounded, exact, and independent from egress", (t) => {
  const root = makeRoot(t);
  const home = path.join(root, "home");
  const visonic = path.join(home, "src", "visonic", "dev");
  const unrelated = path.join(root, "unrelated");
  fs.mkdirSync(visonic, { recursive: true }); fs.mkdirSync(unrelated);
  fs.symlinkSync(visonic, path.join(home, "visonic-alias"));
  const profile = {
    root: "~/src/visonic/dev",
    allowWebSockets: true,
    listeners: [
      { name: "manager", hostPort: 28080, guestPort: 28080 },
      { name: "ephemeral", hostPort: 0, guestPort: 8080 },
    ],
  };
  const omitted = validSettings(); delete omitted.ingress;
  assert.deepEqual(parseSandboxSettings(omitted, { homeDirectory: home }).ingress, { workspaceProfiles: [] });
  const settings = parseSandboxSettings(validSettings({
    network: { mode: "offline", allowedHosts: [], allowWebSockets: false, tcpMappings: [] },
    ingress: { workspaceProfiles: [profile] },
  }), { homeDirectory: home });
  const selected = build(makeScope(fs.realpathSync(visonic)), settings, home, root);
  assert.equal(selected.ingress.root, "~/src/visonic/dev");
  assert.equal(selected.ingress.canonicalRoot, fs.realpathSync(visonic));
  assert.equal(selected.ingress.listeners[1].hostPort, 0);
  assert.equal(build(makeScope(unrelated), settings, home, root).ingress, null);
  const changed = parseSandboxSettings(validSettings({ ingress: { workspaceProfiles: [{ ...profile, listeners: [{ name: "manager", hostPort: 28081, guestPort: 28080 }] }] } }), { homeDirectory: home });
  assert.notEqual(build(makeScope(fs.realpathSync(visonic)), changed, home, root).policyGeneration, selected.policyGeneration);
  for (const badProfile of [
    { ...profile, listeners: Array.from({ length: 17 }, (_, index) => ({ name: `service-${index}`, hostPort: index + 1, guestPort: 8080 })) },
    { ...profile, listeners: [{ name: "same", hostPort: 1, guestPort: 8080 }, { name: "SAME", hostPort: 2, guestPort: 8081 }] },
    { ...profile, listeners: [{ name: "one", hostPort: 28080, guestPort: 8080 }, { name: "two", hostPort: 28080, guestPort: 8081 }] },
  ]) {
    assert.throws(() => parseSandboxSettings(validSettings({ ingress: { workspaceProfiles: [badProfile] } }), { homeDirectory: home }), /at most|duplicate/);
  }
  assert.throws(() => parseSandboxSettings(validSettings({ ingress: { workspaceProfiles: [profile, { ...profile, root: "~/visonic-alias" }] } }), { homeDirectory: home }), /duplicate canonical roots/);
});

test("external mounts retain their boundaries and signing-key exception", (t) => {
  const root = makeRoot(t);
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const external = path.join(root, "external");
  const credential = path.join(home, ".ssh", "git");
  fs.mkdirSync(credential, { recursive: true });
  fs.mkdirSync(workspace); fs.mkdirSync(external);
  const signingPublicKey = path.join(credential, "id_ed25519_signing.pub");
  fs.writeFileSync(signingPublicKey, "ssh-ed25519 public-key");
  fs.symlinkSync(external, path.join(home, "external-link"));
  const resolved = resolveExternalMounts(parseSandboxSettings(validSettings({ filesystem: filesystem({ externalMounts: [{ path: "~/external-link", access: "ro" }] }) })), {
    homeDirectory: home, workspaceRoot: workspace, invariantRoots: [path.dirname(credential)],
  });
  assert.equal(resolved[0].hostPath, fs.realpathSync(external));
  const signingKey = resolveExternalMounts(parseSandboxSettings(validSettings({ filesystem: filesystem({ externalMounts: [{ path: signingPublicKey, access: "ro" }] }) })), {
    homeDirectory: home, workspaceRoot: workspace, invariantRoots: [path.dirname(credential)],
  });
  const signingProvider = createPolicyProviders({ mounts: signingKey })[path.dirname(signingPublicKey)];
  assert.equal(signingProvider.openSync("/id_ed25519_signing.pub", "r").readFileSync({ encoding: "utf8" }), "ssh-ed25519 public-key");
  assert.throws(() => signingProvider.openSync("/id_ed25519_signing.pub", "w"), /read-only|EROFS|ERRNO_30/i);
  assert.throws(() => resolveExternalMounts(parseSandboxSettings(validSettings({ filesystem: filesystem({ externalMounts: [{ path: workspace, access: "ro" }] }) })), {
    homeDirectory: home, workspaceRoot: workspace, invariantRoots: [path.dirname(credential)],
  }), /boundary/);
});

test("exact canonical overrides grant only the configured workspace", (t) => {
  const root = makeRoot(t);
  const home = path.join(root, "home");
  const dotfiles = path.join(home, ".dotfiles");
  const other = path.join(root, "other");
  fs.mkdirSync(dotfiles, { recursive: true }); fs.mkdirSync(other);
  fs.symlinkSync(dotfiles, path.join(home, "dotfiles-alias"));
  const settings = parseSandboxSettings(validSettings({ filesystem: filesystem({
    workspaceOverrides: [{ root: "~/.dotfiles", access: "rw", writeProtectedPaths: [] }],
  }) }), { homeDirectory: home });
  const exact = build(makeScope(fs.realpathSync(dotfiles)), settings, home, root);
  const nested = build(makeScope(fs.realpathSync(dotfiles)), settings, home, root);
  const alias = build(makeScope(fs.realpathSync(path.join(home, "dotfiles-alias"))), settings, home, root);
  const unrelated = build(makeScope(fs.realpathSync(other)), settings, home, root);
  for (const policy of [exact, nested, alias]) {
    const mount = policy.mounts.find((entry) => entry.kind === "workspace");
    assert.equal(mount.access, "rw");
    assert.equal(mount.protectedHostPaths, undefined);
  }
  const otherMount = unrelated.mounts.find((entry) => entry.kind === "workspace");
  assert.equal(otherMount.access, "rw");
  assert.deepEqual(otherMount.protectedHostPaths, defaultProtectedPaths.map((entry) => path.join(other, entry)));
  assert.equal(exact.policyGeneration, alias.policyGeneration);
  const equivalent = parseSandboxSettings(validSettings({ filesystem: filesystem({
    workspaceOverrides: [{ root: "~/dotfiles-alias", access: "rw", writeProtectedPaths: [] }],
  }) }), { homeDirectory: home });
  assert.equal(build(makeScope(fs.realpathSync(dotfiles)), equivalent, home, root).policyGeneration, exact.policyGeneration);
  const changed = parseSandboxSettings(validSettings({ filesystem: filesystem({ workspaceOverrides: [{ root: "~/.dotfiles", access: "ro", writeProtectedPaths: [] }] }) }), { homeDirectory: home });
  assert.notEqual(build(makeScope(fs.realpathSync(dotfiles)), changed, home, root).policyGeneration, exact.policyGeneration);
  const defaultChanged = parseSandboxSettings(validSettings({ filesystem: filesystem({ workspace: { access: "rw", writeProtectedPaths: [".git"] }, workspaceOverrides: [] }) }), { homeDirectory: home });
  assert.notEqual(build(makeScope(fs.realpathSync(other)), defaultChanged, home, root).policyGeneration, unrelated.policyGeneration);
});

test("permissive overrides use an unguarded real provider for every workspace path", async (t) => {
  const root = makeRoot(t);
  const home = path.join(root, "home");
  const workspace = path.join(home, ".dotfiles");
  fs.mkdirSync(path.join(workspace, ".git", "hooks"), { recursive: true });
  for (const entry of [".git/config", ".git/hooks/hook", ".pi/value", "bin/pi", "pi/sandbox/value", "pi/agent/value"]) {
    const target = path.join(workspace, entry);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, "old");
  }
  fs.writeFileSync(path.join(workspace, "hard-source"), "hard");
  fs.linkSync(path.join(workspace, "hard-source"), path.join(workspace, "hard-alias"));
  const settings = parseSandboxSettings(validSettings({ filesystem: filesystem({ workspaceOverrides: [{ root: "~/.dotfiles", access: "rw", writeProtectedPaths: [] }] }) }), { homeDirectory: home });
  const policy = build(makeScope(fs.realpathSync(workspace)), settings, home, root);
  const provider = createPolicyProviders(policy)[workspace];
  for (const entry of ["/.git/config", "/.git/hooks/hook", "/.pi/value", "/bin/pi", "/pi/sandbox/value", "/pi/agent/value"]) {
    const handle = await provider.open(entry, "r+"); await handle.truncate(0); await handle.writeFile("new"); await handle.close();
  }
  await provider.rename("/.git/config", "/.git/config.renamed");
  await provider.link("/hard-source", "/hard-linked");
  await provider.unlink("/.git/hooks/hook");
  const hard = await provider.open("/hard-alias", "r+"); await hard.writeFile("changed"); await hard.close();
  assert.equal(fs.readFileSync(path.join(workspace, "hard-source"), "utf8"), "changed");
});

test("protected providers still reject lexical, resolved, hard-link, rename, and structural writes", async (t) => {
  const root = makeRoot(t);
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".git", "config"), "protected");
  fs.writeFileSync(path.join(workspace, ".bashrc"), "protected");
  fs.writeFileSync(path.join(workspace, "allowed.txt"), "allowed");
  fs.writeFileSync(path.join(workspace, "hard-source"), "hard");
  fs.linkSync(path.join(workspace, "hard-source"), path.join(workspace, "hard-alias"));
  fs.symlinkSync(".git/config", path.join(workspace, "config-alias"));
  const provider = new ProtectedWriteProvider(workspace, defaultProtectedPaths.map((entry) => path.join(workspace, entry)));
  for (const entry of ["/.git/config", "/.bashrc", "/config-alias", "/hard-alias"]) {
    await assert.rejects(() => provider.open(entry, "r+"), /write denied/);
  }
  await assert.rejects(() => provider.mkdir("/.git/hooks/new"), /write denied/);
  await assert.rejects(() => provider.rename("/allowed.txt", "/.bashrc"), /write denied/);
  await assert.rejects(() => provider.rename("/.bashrc", "/moved"), /write denied/);
  await assert.rejects(() => provider.link("/.git/config", "/linked"), /write denied/);
  await assert.rejects(() => provider.symlink(".git/config", "/new-alias"), /write denied/);
});

test("workspace, bare-common, and external mount access follows settings", async (t) => {
  const root = makeRoot(t);
  const home = path.join(root, "home"); const workspace = path.join(root, "workspace"); const bare = path.join(root, "bare"); const external = path.join(root, "external");
  fs.mkdirSync(home); fs.mkdirSync(workspace); fs.mkdirSync(bare); fs.mkdirSync(external); fs.writeFileSync(path.join(external, "value"), "readable");
  const settings = parseSandboxSettings(validSettings({ filesystem: filesystem({
    workspace: { access: "ro", writeProtectedPaths: [] }, bareCommon: { access: "ro", writeProtectedPaths: [] }, externalMounts: [{ path: external, access: "ro" }],
  }) }), { homeDirectory: home });
  const policy = build(makeScope(workspace, bare), settings, home, root);
  const providers = createPolicyProviders(policy);
  await assert.rejects(() => providers[workspace].open("/blocked", "w"), /read-only|EROFS|ERRNO_30/i);
  await assert.rejects(() => providers[bare].open("/blocked", "w"), /read-only|EROFS|ERRNO_30/i);
  await assert.rejects(() => providers[external].open("/value", "w"), /read-only|EROFS|ERRNO_30/i);
});

test("network modes compile to mediated HTTP, guarded raw TCP, or offline", async () => {
  const publicOptions = createNetworkOptions(parseSandboxSettings(validSettings()).network);
  assert.equal(publicOptions.netEnabled, true);
  assert.ok(publicOptions.httpHooks);
  const passthrough = createNetworkOptions(parseSandboxSettings(validSettings({ network: { mode: "public-tcp", allowedHosts: [], allowWebSockets: false, tcpMappings: [] } })).network);
  assert.equal(passthrough.netEnabled, true);
  assert.equal(passthrough.httpHooks, undefined);
  assert.equal(passthrough.dns.syntheticHostMapping, "per-host");
  assert.equal(await passthrough.publicTcp.isIpAllowed({ hostname: "example.com", ip: "93.184.216.34", family: 4, port: 443 }), true);
  assert.equal(await passthrough.publicTcp.isIpAllowed({ hostname: "metadata.google.internal", ip: "169.254.169.254", family: 4, port: 80 }), false);
  assert.throws(() => parseSandboxSettings(validSettings({ network: { mode: "public-tcp", allowedHosts: ["example.com"], allowWebSockets: false, tcpMappings: [] } })), /does not use allowedHosts/);
  const offline = createNetworkOptions(parseSandboxSettings(validSettings({ network: { mode: "offline", allowedHosts: [], allowWebSockets: false, tcpMappings: [] } })).network);
  assert.deepEqual(offline, { netEnabled: false, allowWebSockets: false });
});
