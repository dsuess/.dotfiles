import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSandboxPolicy,
  parseSandboxSettings,
} from "./policy.mjs";
import { validateRepositoryScope } from "./client.mjs";
import {
  discoverRepositoryScope,
  findTrustedExecutable,
} from "./repository-scope.mjs";

const HOST_GIT = execFileSync("/usr/bin/env", ["which", "git"], { encoding: "utf8" }).trim();

function git(args, options = {}) {
  return execFileSync(HOST_GIT, args, {
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-repository-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync(root);
}

function makeTrustedBin(root) {
  const trusted = path.join(root, "trusted-bin");
  fs.mkdirSync(trusted);
  fs.symlinkSync(HOST_GIT, path.join(trusted, "git"));
  return trusted;
}

function gondolinSettings() {
  return parseSandboxSettings({
    version: 1,
    externalMounts: [],
    network: { mode: "public-http", allowedHosts: [], allowWebSockets: false, tcpMappings: [] },
  });
}

function initRepository(repo) {
  fs.mkdirSync(repo, { recursive: true });
  git(["-C", repo, "init", "-q"]);
}

function commitEmpty(repo) {
  git([
    "-C",
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  ]);
}

test("non-repository scope fails narrow to the physical launch directory", (t) => {
  const root = makeRoot(t);
  const launch = path.join(root, "not-a-repository", "nested");
  fs.mkdirSync(launch, { recursive: true });
  const trusted = makeTrustedBin(root);

  const scope = discoverRepositoryScope({ launchDirectory: launch, pathValue: trusted });
  assert.equal(scope.physicalLaunchDirectory, fs.realpathSync(launch));
  assert.equal(scope.canonicalWorkspaceRoot, fs.realpathSync(launch));
  assert.equal(scope.bareCommonDirectory, null);
  assert.match(scope.workspaceKey, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(scope), true);
});

test("passed repository scope records must match canonical paths and their workspace key", (t) => {
  const root = makeRoot(t);
  const scope = discoverRepositoryScope({ launchDirectory: root, pathValue: "" });
  assert.deepEqual(validateRepositoryScope(scope, root), scope);
  assert.throws(
    () => validateRepositoryScope({ ...scope, workspaceKey: "a".repeat(64) }, root),
    /key does not match/,
  );
  assert.throws(
    () => validateRepositoryScope({ ...scope, physicalLaunchDirectory: "/" }, root),
    /launch directory does not match|not contained/,
  );
});

test("normal nested launches share the canonical worktree and ignore repository shims", (t) => {
  const root = makeRoot(t);
  const repo = path.join(root, "normal repository");
  const launch = path.join(repo, "nested", "deep");
  initRepository(repo);
  fs.mkdirSync(launch, { recursive: true });
  const trusted = makeTrustedBin(root);
  const shimDir = path.join(repo, "bootstrap-shims");
  const marker = path.join(root, "shim-ran");
  fs.mkdirSync(shimDir);
  fs.writeFileSync(path.join(shimDir, "git"), `#!/bin/sh\nprintf ran >${JSON.stringify(marker)}\nexit 97\n`);
  fs.chmodSync(path.join(shimDir, "git"), 0o755);

  const pathValue = `${shimDir}${path.delimiter}${trusted}`;
  const nested = discoverRepositoryScope({ launchDirectory: launch, pathValue });
  const atRoot = discoverRepositoryScope({ launchDirectory: repo, pathValue });
  assert.equal(nested.canonicalWorkspaceRoot, fs.realpathSync(repo));
  assert.equal(atRoot.canonicalWorkspaceRoot, fs.realpathSync(repo));
  assert.equal(nested.workspaceKey, atRoot.workspaceKey);
  assert.equal(nested.bareCommonDirectory, null);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(findTrustedExecutable("git", pathValue, [fs.realpathSync(repo)]), fs.realpathSync(HOST_GIT));

  const policy = buildSandboxPolicy({
    scope: nested,
    settings: gondolinSettings(),
    homeDirectory: root,
    cacheRoot: path.join(root, "normal-cache"),
    runtimeRoot: path.join(root, "normal-runtime"),
  });
  const workspaceMount = policy.mounts.find((mount) => mount.kind === "workspace");
  assert.equal(workspaceMount.hostPath, fs.realpathSync(repo));
  assert.equal(workspaceMount.guestPath, fs.realpathSync(repo));
  assert.ok(workspaceMount.protectedHostPaths.includes(path.join(fs.realpathSync(repo), ".git", "config")));
  assert.ok(workspaceMount.protectedHostPaths.includes(path.join(fs.realpathSync(repo), ".pi")));
});

test("malformed metadata and unavailable or failing Git fail narrow", (t) => {
  const root = makeRoot(t);
  const stale = path.join(root, "stale", "nested");
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(root, "stale", ".git"), "gitdir: ../missing\n");
  const trusted = makeTrustedBin(root);

  const staleScope = discoverRepositoryScope({ launchDirectory: stale, pathValue: trusted });
  assert.equal(staleScope.canonicalWorkspaceRoot, fs.realpathSync(stale));

  const repo = path.join(root, "no git repository");
  const launch = path.join(repo, "nested");
  initRepository(repo);
  fs.mkdirSync(launch, { recursive: true });
  const emptyBin = path.join(root, "empty-bin");
  fs.mkdirSync(emptyBin);
  const noGit = discoverRepositoryScope({ launchDirectory: launch, pathValue: emptyBin });
  assert.equal(noGit.canonicalWorkspaceRoot, fs.realpathSync(launch));

  const failingBin = path.join(root, "failing-bin");
  fs.mkdirSync(failingBin);
  fs.writeFileSync(path.join(failingBin, "git"), "#!/bin/sh\nexit 42\n");
  fs.chmodSync(path.join(failingBin, "git"), 0o755);
  const failed = discoverRepositoryScope({ launchDirectory: launch, pathValue: failingBin });
  assert.equal(failed.canonicalWorkspaceRoot, fs.realpathSync(launch));
});

test("bare-backed linked worktrees share only the verified bare common directory", (t) => {
  const root = makeRoot(t);
  const trusted = makeTrustedBin(root);
  const seed = path.join(root, "seed");
  const bare = path.join(root, "shared bare.git");
  const primary = path.join(root, "primary worktree");
  const sibling = path.join(root, "sibling worktree");
  initRepository(seed);
  commitEmpty(seed);
  git(["init", "--bare", "-q", bare]);
  git(["-C", seed, "remote", "add", "origin", bare]);
  git(["-C", seed, "push", "-q", "origin", "HEAD:main"]);
  git([`--git-dir=${bare}`, "symbolic-ref", "HEAD", "refs/heads/main"]);
  git([`--git-dir=${bare}`, "worktree", "add", "-q", primary, "main"]);
  git([`--git-dir=${bare}`, "worktree", "add", "-q", "-b", "sibling", sibling, "main"]);
  const launch = path.join(primary, "nested");
  fs.mkdirSync(launch);

  const scope = discoverRepositoryScope({ launchDirectory: launch, pathValue: trusted });
  assert.equal(scope.canonicalWorkspaceRoot, fs.realpathSync(primary));
  assert.equal(scope.bareCommonDirectory, fs.realpathSync(bare));
  assert.notEqual(scope.canonicalWorkspaceRoot, fs.realpathSync(sibling));

  const policy = buildSandboxPolicy({
    scope,
    settings: gondolinSettings(),
    homeDirectory: root,
    cacheRoot: path.join(root, "bare-cache"),
    runtimeRoot: path.join(root, "bare-runtime"),
  });
  const bareMount = policy.mounts.find((mount) => mount.kind === "bare-common");
  assert.equal(bareMount.hostPath, fs.realpathSync(bare));
  assert.equal(bareMount.guestPath, fs.realpathSync(bare));
  assert.deepEqual(
    [...bareMount.protectedHostPaths].sort(),
    [path.join(fs.realpathSync(bare), "config"), path.join(fs.realpathSync(bare), "hooks")].sort(),
  );
});

test("non-bare linked worktrees do not expose their external common metadata", (t) => {
  const root = makeRoot(t);
  const trusted = makeTrustedBin(root);
  const main = path.join(root, "nonbare main");
  const linked = path.join(root, "nonbare linked");
  initRepository(main);
  commitEmpty(main);
  git(["-C", main, "worktree", "add", "-q", "-b", "linked", linked]);
  const launch = path.join(linked, "nested");
  fs.mkdirSync(launch);

  const scope = discoverRepositoryScope({ launchDirectory: launch, pathValue: trusted });
  assert.equal(scope.canonicalWorkspaceRoot, fs.realpathSync(linked));
  assert.equal(scope.bareCommonDirectory, null);
});
