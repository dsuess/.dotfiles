#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createHttpHooks,
  ReadonlyProvider,
  RealFSProvider,
  VM,
} from "@earendil-works/gondolin";

import {
  ensureGondolinImage,
  verifyImageDirectory,
} from "./build-gondolin-image.mjs";
import {
  buildSandboxPolicy,
  createPolicyProviders,
  parseSandboxSettings,
} from "./policy.mjs";

const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const PUBLIC_URL = process.env.PI_GONDOLIN_CANARY_PUBLIC_URL ?? "https://example.com/";
const ALPINE_IMAGE = "alpine:3.23";
const NETWORK_PROBE_IMAGE = "alpine:3.20";
const UV_IMAGE = "ghcr.io/astral-sh/uv:0.9.18";
const BUILT_IMAGE = "pi-gondolin-canary:local";
const UV_COPY_IMAGE = "pi-gondolin-uv-copy:local";
const PERSISTENT_CONTAINER = "pi-gondolin-canary-container";
const PERSISTENT_VOLUME = "pi-gondolin-canary-volume";

function shQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

async function run(vm, command, options = {}) {
  const signal = AbortSignal.timeout(options.timeoutMs ?? COMMAND_TIMEOUT_MS);
  return vm.exec(["/bin/bash", "-lc", command], {
    cwd: options.cwd,
    env: options.env,
    signal,
  });
}

async function runOk(vm, command, options = {}) {
  const result = await run(vm, command, options);
  assert.equal(
    result.exitCode,
    0,
    `guest command failed (${result.exitCode}): ${command}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

async function runFails(vm, command, message) {
  const result = await run(vm, command, { timeoutMs: 30_000 });
  assert.notEqual(result.exitCode, 0, message ?? `guest command unexpectedly succeeded: ${command}`);
  return result;
}

async function dockerDiagnostics(vm) {
  if (!vm) return "VM was not created";
  try {
    const result = await run(
      vm,
      "printf '%s\\n' '--- docker info ---'; docker info 2>&1 || true; printf '%s\\n' '--- dockerd log ---'; tail -n 200 /var/log/dockerd.log 2>&1 || true; printf '%s\\n' '--- mounts ---'; cat /proc/mounts 2>&1 || true",
      { timeoutMs: 30_000 },
    );
    return result.stdout + result.stderr;
  } catch (error) {
    return `failed to collect diagnostics: ${error.message}`;
  }
}

function createSigningKeyVm(imageDir, mounts) {
  return VM.create({
    sandbox: {
      imagePath: imageDir,
      netEnabled: false,
    },
    rootfs: { mode: "memory", size: "1G" },
    memory: "1G",
    cpus: 2,
    vfs: { mounts },
  });
}

function createVm(imageDir, fixture) {
  const { httpHooks } = createHttpHooks({
    allowedHosts: ["*"],
    blockInternalRanges: true,
  });

  return VM.create({
    sandbox: {
      imagePath: imageDir,
      netEnabled: true,
    },
    rootfs: { mode: "memory", size: process.env.PI_GONDOLIN_CANARY_ROOTFS_SIZE ?? "4G" },
    memory: process.env.PI_GONDOLIN_CANARY_MEMORY ?? "3G",
    cpus: Number(process.env.PI_GONDOLIN_CANARY_CPUS ?? 4),
    httpHooks,
    allowWebSockets: false,
    vfs: {
      mounts: {
        [fixture.workspace]: new RealFSProvider(fixture.workspace),
        [fixture.readonly]: new ReadonlyProvider(new RealFSProvider(fixture.readonly)),
      },
    },
  });
}

async function proveFilesystemAndNetwork(vm, fixture) {
  await runOk(
    vm,
    [
      "set -eu",
      `test \"$(cat ${shQuote(path.join(fixture.workspace, "host.txt"))})\" = host-visible`,
      `printf guest-visible > ${shQuote(path.join(fixture.workspace, "guest.txt"))}`,
    ].join("\n"),
  );
  assert.equal(fs.readFileSync(path.join(fixture.workspace, "guest.txt"), "utf8"), "guest-visible");

  const readonlyFile = path.join(fixture.readonly, "readonly.txt");
  await runOk(vm, `test \"$(cat ${shQuote(readonlyFile)})\" = immutable`);
  await runFails(vm, `printf changed > ${shQuote(readonlyFile)}`, "read-only VFS mount accepted a write");
  assert.equal(fs.readFileSync(readonlyFile, "utf8"), "immutable");

  await runFails(
    vm,
    `cat ${shQuote(path.join(fixture.workspace, "escape-link"))}`,
    "RealFSProvider followed an escaping symlink",
  );
  await runFails(
    vm,
    `printf escaped > ${shQuote(path.join(fixture.workspace, "dangling-link"))}`,
    "RealFSProvider followed a dangling escaping symlink",
  );
  assert.equal(fs.existsSync(fixture.danglingTarget), false);
  await runFails(vm, `cat ${shQuote(fixture.outsideSecret)}`, "unmounted host path was readable");

  const publicResult = await runOk(vm, `curl -fsS --max-time 30 ${shQuote(PUBLIC_URL)}`);
  assert.match(publicResult.stdout, /Example Domain|example/i, "public HTTPS response was unexpected");

  for (const blocked of [
    "http://127.0.0.1/",
    "http://10.255.255.1/",
    "http://192.168.0.1/",
    "http://169.254.169.254/latest/meta-data/",
  ]) {
    await runFails(
      vm,
      `curl -fsS --max-time 5 ${shQuote(blocked)}`,
      `internal destination was reachable: ${blocked}`,
    );
  }
}

async function proveDevelopmentImage(vm, fixture) {
  const versions = await runOk(
    vm,
    [
      "set -eu",
      "test \"$(. /etc/os-release; printf %s \"$ID\")\" = debian",
      "ldd --version | head -n1",
      "bash --version | head -n1; git --version; rg --version | head -n1; fd --version",
      "node --version; npm --version; python3 --version; uv --version; rtk --version",
      "gcloud version | head -n1; direnv version; chromium --version",
      "printf '#include <Python.h>\\n#include <linux/limits.h>\\nint main(void) { return PY_MAJOR_VERSION < 3; }\\n' | gcc -x c - $(python3-config --includes) -o /tmp/serena-header-canary",
      "/tmp/serena-header-canary",
    ].join("; "),
  );
  assert.match(versions.stdout, /GLIBC 2\.4[1-9]/, "Debian glibc is too old for RTK");
  assert.match(versions.stdout, /rtk 0\.44\.0/, "RTK did not execute directly on glibc");
  assert.match(versions.stdout, /Google Cloud SDK/, "gcloud is unavailable");
  assert.match(versions.stdout, /Chromium/, "system Chromium is unavailable");

  const page = path.join(fixture.workspace, "browser-canary.html");
  fs.writeFileSync(page, "<!doctype html><title>browser-canary</title><p style='font-family: DejaVu Sans'>rendered</p>");
  const localBrowser = await runOk(
    vm,
    `chromium --headless --no-sandbox --disable-gpu --dump-dom file://${shQuote(page)}`,
  );
  assert.match(localBrowser.stdout, /browser-canary.*rendered/s, "Chromium did not render the local page");
  await runOk(vm, "fc-match 'DejaVu Sans' | grep -qi dejavu");
  const publicBrowser = await runOk(
    vm,
    `chromium --headless --no-sandbox --disable-gpu --dump-dom ${shQuote(PUBLIC_URL)}`,
  );
  assert.match(publicBrowser.stdout, /Example Domain|example/i, "Chromium HTTPS failed");

  const playwrightDir = path.join(fixture.workspace, "playwright-canary");
  fs.mkdirSync(playwrightDir);
  await runOk(
    vm,
    [
      `cd ${shQuote(playwrightDir)}`,
      "npm init -y >/dev/null",
      "npm install --no-save playwright@1.55.0 >/dev/null",
      "npx playwright install chromium",
      "node -e \"const { chromium } = require('playwright'); (async () => { const b = await chromium.launch({ headless: true }); const p = await b.newPage(); await p.setContent('<main>playwright-ok</main>'); if ((await p.textContent('main')) !== 'playwright-ok') process.exit(1); await b.close(); })().catch(e => { console.error(e); process.exit(1); })\"",
    ].join("; "),
    { timeoutMs: 10 * 60 * 1000 },
  );

  await runOk(
    vm,
    [
      "set -eu",
      "before=$(date +%s)",
      "hwclock --hctosys --utc",
      "after=$(date +%s)",
      "test $after -ge $before",
      `curl -fsS --max-time 30 ${shQuote(PUBLIC_URL)} >/dev/null`,
      "curl -fsS --max-time 30 https://deb.debian.org/debian/dists/trixie/InRelease >/dev/null",
    ].join("; "),
  );
}

async function proveRuntimeKernel(vm) {
  const kernel = await runOk(
    vm,
    [
      "set -eu",
      "release=$(uname -r); printf '%s\\n' \"$release\"",
      "test -d /lib/modules/$release",
      "for module in bridge veth br_netfilter; do modprobe $module || test -d /sys/module/$module; done",
      "test -e /proc/sys/net/bridge/bridge-nf-call-iptables || test -d /sys/module/br_netfilter",
    ].join("; "),
  );
  assert.match(kernel.stdout, /^[A-Za-z0-9.+_-]+$/m, "uname did not report a Debian kernel release");
}

async function proveToolchainAndDocker(vm, fixture) {
  await proveRuntimeKernel(vm);
  await proveDevelopmentImage(vm, fixture);

  const dockerInfo = await runOk(
    vm,
    "docker info --format '{{.Driver}}|{{.OperatingSystem}}|{{.DockerRootDir}}|{{.Name}}'",
  );
  assert.match(dockerInfo.stdout, /^vfs\|Debian GNU\/Linux .*\|\/var\/lib\/docker\|/m);
  await runOk(vm, "! grep -E '[[:space:]]/var/lib/docker[[:space:]]+fuse\\.sandboxfs' /proc/mounts");

  await runOk(vm, "docker network inspect bridge");
  await runOk(vm, "docker network create --driver bridge pi-gondolin-network-probe");
  await runOk(vm, "docker network rm pi-gondolin-network-probe");
  await runOk(
    vm,
    `docker run --rm ${NETWORK_PROBE_IMAGE} sh -c 'getent hosts registry.npmjs.org && wget -qO- https://registry.npmjs.org/ >/dev/null'`,
  );

  await runOk(vm, `docker pull ${ALPINE_IMAGE}`);
  const runResult = await runOk(vm, `docker run --rm ${ALPINE_IMAGE} printf docker-run-ok`);
  assert.equal(runResult.stdout, "docker-run-ok");

  const nestedHttps = await runOk(
    vm,
    `docker run --rm ${ALPINE_IMAGE} wget -qO- ${shQuote(PUBLIC_URL)}`,
  );
  assert.match(nestedHttps.stdout, /Example Domain|example/i);
  for (const blocked of ["http://127.0.0.1/", "http://10.255.255.1/", "http://192.168.0.1/", "http://169.254.169.254/latest/meta-data/"]) {
    await runOk(
      vm,
      `docker run --rm ${ALPINE_IMAGE} sh -c ${shQuote(`if wget -q --timeout=5 -O- ${blocked}; then exit 97; fi; exit 0`)}`,
    );
  }

  const contextDir = path.join(fixture.workspace, "docker-build");
  fs.mkdirSync(contextDir);
  await runOk(vm, `cp /run/gondolin/ca-certificates.crt ${shQuote(path.join(contextDir, "gondolin-ca.crt"))}`);
  fs.writeFileSync(
    path.join(contextDir, "Dockerfile"),
    `FROM ${ALPINE_IMAGE}\nCOPY gondolin-ca.crt /usr/local/share/ca-certificates/gondolin-ca.crt\nRUN cat /usr/local/share/ca-certificates/gondolin-ca.crt >> /etc/ssl/cert.pem && apk add --no-cache ca-certificates wget && update-ca-certificates && wget -qO- https://registry.npmjs.org/ >/dev/null && printf buildkit-ok > /buildkit-proof\nCMD [\"cat\", \"/buildkit-proof\"]\n`,
  );
  await runOk(
    vm,
    `docker buildx build --load --progress=plain -t ${BUILT_IMAGE} ${shQuote(contextDir)}`,
  );
  const builtResult = await runOk(vm, `docker run --rm ${BUILT_IMAGE}`);
  assert.equal(builtResult.stdout, "buildkit-ok");

  const uvCopyContext = path.join(fixture.workspace, "uv-copy-build");
  fs.mkdirSync(uvCopyContext);
  fs.writeFileSync(
    path.join(uvCopyContext, "Dockerfile"),
    `FROM ${ALPINE_IMAGE}\nCOPY --from=${UV_IMAGE} /uv /uvx /bin/\nRUN uvx --version\n`,
  );
  await runOk(
    vm,
    `docker buildx build --load --progress=plain -t ${UV_COPY_IMAGE} ${shQuote(uvCopyContext)}`,
  );
  const uvx = await runOk(vm, `docker run --rm ${UV_COPY_IMAGE} uvx --version`);
  assert.match(uvx.stdout, /uvx /);

  const composePath = path.join(fixture.workspace, "compose.yaml");
  fs.writeFileSync(
    composePath,
    [
      "services:",
      "  canary:",
      `    image: ${ALPINE_IMAGE}`,
      '    command: ["/bin/sh", "-c", "printf compose-ok > /state/result"]',
      "    volumes:",
      "      - canary-data:/state",
      "volumes:",
      "  canary-data:",
      `    name: ${PERSISTENT_VOLUME}`,
      "",
    ].join("\n"),
  );
  await runOk(
    vm,
    `docker compose -p pi-gondolin-canary -f ${shQuote(composePath)} up --abort-on-container-exit --exit-code-from canary`,
  );
  await runOk(vm, "docker network inspect --format '{{.Driver}}|{{.Name}}' pi-gondolin-canary_default | grep -Fx 'bridge|pi-gondolin-canary_default'");
  const volumeResult = await runOk(
    vm,
    `docker run --rm -v ${PERSISTENT_VOLUME}:/state ${ALPINE_IMAGE} cat /state/result`,
  );
  assert.equal(volumeResult.stdout, "compose-ok");

  await runOk(
    vm,
    `docker create --name ${PERSISTENT_CONTAINER} ${BUILT_IMAGE} >/dev/null`,
  );
}

async function proveDockerCannotSeeHost(vm, fixture) {
  const hostDockerConfig = path.join(os.homedir(), ".docker", "config.json");
  const hostDockerSocket = path.join(os.homedir(), ".docker", "run", "docker.sock");

  await runFails(vm, `cat ${shQuote(fixture.outsideSecret)}`, "guest read the outside-host canary");
  await runOk(
    vm,
    `test ! -e ${shQuote(hostDockerConfig)} && test ! -S ${shQuote(hostDockerSocket)} && test -S /var/run/docker.sock`,
  );

  const outsideMount = await run(
    vm,
    `docker run --rm --privileged -v ${shQuote(fixture.outside)}:/outside-host:ro ${ALPINE_IMAGE} sh -c 'if [ -e /outside-host/host-secret ]; then cat /outside-host/host-secret; exit 97; fi'`,
  );
  assert.notEqual(
    outsideMount.exitCode,
    97,
    `privileged container exposed an outside-host canary: ${outsideMount.stdout}`,
  );
  assert.doesNotMatch(outsideMount.stdout + outsideMount.stderr, /outside-host-secret/);

  const configMount = await run(
    vm,
    `docker run --rm --privileged -v ${shQuote(path.dirname(hostDockerConfig))}:/host-docker-config:ro ${ALPINE_IMAGE} sh -c 'test ! -e /host-docker-config/config.json'`,
  );
  if (configMount.exitCode !== 0) {
    assert.doesNotMatch(configMount.stdout + configMount.stderr, /auths|credsStore|credHelpers/);
  }

  const localSocket = await runOk(
    vm,
    `docker run --rm --privileged -v /var/run/docker.sock:/guest-docker.sock ${ALPINE_IMAGE} test -S /guest-docker.sock`,
  );
  assert.equal(localSocket.stdout, "");
  assert.equal(fs.readFileSync(fixture.outsideSecret, "utf8"), "outside-host-secret");
}

async function proveEphemerality(vm) {
  const dockerInfo = await runOk(vm, "docker info --format '{{.Driver}}|{{.DockerRootDir}}'");
  assert.match(dockerInfo.stdout, /^vfs\|\/var\/lib\/docker/m);
  await runOk(vm, "! grep -E '[[:space:]]/var/lib/docker[[:space:]]+fuse\\.sandboxfs' /proc/mounts");
  await runFails(vm, `docker image inspect ${BUILT_IMAGE} >/dev/null`, "image survived VM replacement");
  await runFails(vm, `docker container inspect ${PERSISTENT_CONTAINER} >/dev/null`, "container survived VM replacement");
  await runFails(vm, `docker volume inspect ${PERSISTENT_VOLUME} >/dev/null`, "volume survived VM replacement");
}

test("production signing-public-key provider boots as a one-file read-only directory", { timeout: 180_000 }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-gondolin-signing-key-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const signingDirectory = path.join(home, ".ssh", "git");
  const publicKey = path.join(signingDirectory, "id_ed25519_signing.pub");
  const privateKey = path.join(signingDirectory, "id_ed25519_signing");
  const unrelatedKey = path.join(signingDirectory, "unrelated");
  fs.mkdirSync(signingDirectory, { recursive: true });
  fs.mkdirSync(workspace);
  fs.writeFileSync(publicKey, "ssh-ed25519 public-key");
  fs.writeFileSync(privateKey, "private-key");
  fs.writeFileSync(unrelatedKey, "unrelated");

  const policy = buildSandboxPolicy({
    scope: {
      physicalLaunchDirectory: workspace,
      canonicalWorkspaceRoot: workspace,
      bareCommonDirectory: null,
      workspaceKey: "a".repeat(64),
    },
    settings: parseSandboxSettings({
      version: 1,
      externalMounts: [{ path: publicKey, access: "ro" }],
      network: { mode: "offline", allowedHosts: [], allowWebSockets: false, tcpMappings: [] },
    }),
    homeDirectory: home,
    cacheRoot: path.join(root, "cache"),
    runtimeRoot: path.join(root, "runtime"),
  });
  const signingMount = policy.mounts.find((mount) => mount.kind === "signing-public-key");
  assert.ok(signingMount);
  assert.equal(signingMount.guestPath, signingDirectory);

  const image = await ensureGondolinImage({ verbose: false });
  let vm;
  try {
    vm = await createSigningKeyVm(image.imageDir, createPolicyProviders(policy));
    t.diagnostic(`vm=${vm.id}`);
    await runOk(
      vm,
      [
        "set -eu",
        `test "$(cat ${shQuote(publicKey)})" = "ssh-ed25519 public-key"`,
        `test "$(ls -A ${shQuote(signingDirectory)})" = "id_ed25519_signing.pub"`,
      ].join("\n"),
    );
    await runFails(vm, `cat ${shQuote(privateKey)}`, "private signing-key sibling was visible");
    await runFails(vm, `cat ${shQuote(unrelatedKey)}`, "unrelated signing-key sibling was visible");
    await runFails(vm, `printf changed > ${shQuote(publicKey)}`, "signing public key accepted a write");
    await runFails(
      vm,
      `python3 -c ${shQuote(`import os; os.truncate(${JSON.stringify(publicKey)}, 0)`)}`,
      "signing public key accepted a truncate",
    );
    await runFails(vm, `mv ${shQuote(publicKey)} ${shQuote(path.join(signingDirectory, "renamed"))}`, "signing public key accepted a rename");
    await runFails(vm, `rm ${shQuote(publicKey)}`, "signing public key accepted deletion");
    assert.equal(fs.readFileSync(publicKey, "utf8"), "ssh-ed25519 public-key");
  } finally {
    await vm?.close().catch(() => {});
  }
});

test("pinned Debian/glibc Gondolin image contains files, browsers, network, xattr-compatible, ephemeral nested Docker", async (t) => {
  const image = await ensureGondolinImage({ verbose: false });
  verifyImageDirectory(image.imageDir);
  t.diagnostic(`image=${image.imageDir}`);
  t.diagnostic(`gondolinBuildId=${image.manifest.buildId}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gondolin-canary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = {
    workspace: fs.realpathSync(fs.mkdirSync(path.join(root, "workspace"), { recursive: true })),
    readonly: fs.realpathSync(fs.mkdirSync(path.join(root, "readonly"), { recursive: true })),
    outside: fs.realpathSync(fs.mkdirSync(path.join(root, "outside"), { recursive: true })),
  };
  fixture.outsideSecret = path.join(fixture.outside, "host-secret");
  fixture.danglingTarget = path.join(fixture.outside, "dangling-created");

  fs.writeFileSync(path.join(fixture.workspace, "host.txt"), "host-visible");
  fs.writeFileSync(path.join(fixture.readonly, "readonly.txt"), "immutable");
  fs.writeFileSync(fixture.outsideSecret, "outside-host-secret");
  fs.symlinkSync(fixture.outsideSecret, path.join(fixture.workspace, "escape-link"));
  fs.symlinkSync(fixture.danglingTarget, path.join(fixture.workspace, "dangling-link"));

  let vm = null;
  try {
    vm = await createVm(image.imageDir, fixture);
    t.diagnostic(`firstVm=${vm.id}`);
    await proveFilesystemAndNetwork(vm, fixture);
    await proveToolchainAndDocker(vm, fixture);
    await proveDockerCannotSeeHost(vm, fixture);
    await vm.close();
    vm = null;

    vm = await createVm(image.imageDir, fixture);
    t.diagnostic(`secondVm=${vm.id}`);
    await proveEphemerality(vm);
  } catch (error) {
    t.diagnostic(await dockerDiagnostics(vm));
    throw error;
  } finally {
    await vm?.close().catch(() => {});
  }
});
