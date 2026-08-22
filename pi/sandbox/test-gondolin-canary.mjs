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

const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const PUBLIC_URL = process.env.PI_GONDOLIN_CANARY_PUBLIC_URL ?? "https://example.com/";
const ALPINE_IMAGE = "alpine:3.23";
const BUILT_IMAGE = "pi-gondolin-canary:local";
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
    rootfs: { mode: "memory" },
    memory: process.env.PI_GONDOLIN_CANARY_MEMORY ?? "3G",
    cpus: Number(process.env.PI_GONDOLIN_CANARY_CPUS ?? 4),
    httpHooks,
    allowWebSockets: false,
    vfs: {
      mounts: {
        [fixture.workspace]: new RealFSProvider(fixture.workspace),
        [fixture.readonly]: new ReadonlyProvider(new RealFSProvider(fixture.readonly)),
        "/var/lib/docker": new RealFSProvider(fixture.dockerStore),
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

async function proveToolchainAndDocker(vm, fixture) {
  const versions = await runOk(
    vm,
    "set -eu; bash --version | head -n1; git --version; rg --version | head -n1; fd --version; node --version; npm --version; python3 --version; uv --version; rtk --version; docker --version; docker buildx version; docker compose version",
  );
  assert.match(versions.stdout, /rtk/i, "RTK did not execute inside Alpine");

  const dockerInfo = await runOk(
    vm,
    "docker info --format '{{.Driver}}|{{.OperatingSystem}}|{{.DockerRootDir}}|{{.Name}}'",
  );
  assert.match(dockerInfo.stdout, /^vfs\|Alpine Linux .*\|\/var\/lib\/docker\|/m);

  await runOk(vm, `docker pull ${ALPINE_IMAGE}`);
  const runResult = await runOk(vm, `docker run --rm ${ALPINE_IMAGE} printf docker-run-ok`);
  assert.equal(runResult.stdout, "docker-run-ok");

  const nestedHttps = await runOk(
    vm,
    `docker run --rm ${ALPINE_IMAGE} wget -qO- ${shQuote(PUBLIC_URL)}`,
  );
  assert.match(nestedHttps.stdout, /Example Domain|example/i);

  const contextDir = path.join(fixture.workspace, "docker-build");
  fs.mkdirSync(contextDir);
  fs.writeFileSync(
    path.join(contextDir, "Dockerfile"),
    `FROM ${ALPINE_IMAGE}\nRUN printf buildkit-ok > /buildkit-proof\nCMD [\"cat\", \"/buildkit-proof\"]\n`,
  );
  await runOk(
    vm,
    `docker buildx build --load --progress=plain -t ${BUILT_IMAGE} ${shQuote(contextDir)}`,
  );
  const builtResult = await runOk(vm, `docker run --rm ${BUILT_IMAGE}`);
  assert.equal(builtResult.stdout, "buildkit-ok");

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

async function provePersistence(vm, fixture) {
  const dockerInfo = await runOk(vm, "docker info --format '{{.Driver}}|{{.DockerRootDir}}'");
  assert.match(dockerInfo.stdout, /^vfs\|\/var\/lib\/docker/m);
  await runOk(vm, `docker image inspect ${BUILT_IMAGE} >/dev/null`);
  await runOk(vm, `docker container inspect ${PERSISTENT_CONTAINER} >/dev/null`);
  await runOk(vm, `docker volume inspect ${PERSISTENT_VOLUME} >/dev/null`);

  const imageResult = await runOk(vm, `docker run --rm ${BUILT_IMAGE}`);
  assert.equal(imageResult.stdout, "buildkit-ok");
  const volumeResult = await runOk(
    vm,
    `docker run --rm -v ${PERSISTENT_VOLUME}:/state ${ALPINE_IMAGE} cat /state/result`,
  );
  assert.equal(volumeResult.stdout, "compose-ok");
  assert.ok(fs.readdirSync(fixture.dockerStore).length > 0, "host-backed Docker store is empty");
}

test("pinned Gondolin image contains files, network, and persistent nested Docker", async (t) => {
  const image = await ensureGondolinImage({ verbose: false });
  verifyImageDirectory(image.imageDir);
  t.diagnostic(`image=${image.imageDir}`);
  t.diagnostic(`gondolinBuildId=${image.manifest.buildId}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gondolin-canary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = {
    workspace: fs.realpathSync(fs.mkdirSync(path.join(root, "workspace"), { recursive: true })),
    readonly: fs.realpathSync(fs.mkdirSync(path.join(root, "readonly"), { recursive: true })),
    dockerStore: fs.realpathSync(fs.mkdirSync(path.join(root, "docker"), { recursive: true })),
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
    await provePersistence(vm, fixture);
  } catch (error) {
    t.diagnostic(await dockerDiagnostics(vm));
    throw error;
  } finally {
    await vm?.close().catch(() => {});
  }
});
