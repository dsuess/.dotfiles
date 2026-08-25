#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAssets as gondolinBuildAssets,
  loadAssetManifest,
  parseBuildConfig as gondolinParseBuildConfig,
  verifyAssets as gondolinVerifyAssets,
} from "@earendil-works/gondolin";

export const GONDOLIN_VERSION = "0.12.0";
export const IMAGE_SPEC_VERSION = 3;
export const RTK_VERSION = "0.44.0";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(SCRIPT_DIR, "image", "docker.json");
const INIT_PATH = path.join(SCRIPT_DIR, "image", "docker-init-extra.sh");
const ROOTFS_DOCKERFILE_PATH = path.join(SCRIPT_DIR, "image", "rootfs.Dockerfile");
const PACKAGE_PATH = path.join(
  SCRIPT_DIR,
  "node_modules",
  "@earendil-works",
  "gondolin",
  "package.json",
);
const DOCKER_RECOVERY = "start Docker, then run: gondolinier image build";
const GONDOLIN_BUILD_ID_NAMESPACE = "7b6ed0c0-7e7f-4c2a-8b2d-0bf3d5be9d52";
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;
const KERNEL_RELEASE_PATTERN = /^[A-Za-z0-9.+_-]+$/;

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function readRequired(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    throw new Error(`cannot read image input ${filePath}: ${error.message}`);
  }
}

export function getHostImageArch(hostArch = os.arch()) {
  if (hostArch === "arm64") return "aarch64";
  if (hostArch === "x64") return "x86_64";
  throw new Error(`unsupported Gondolin image architecture: ${hostArch}`);
}

export function getDebianKernelPackage(arch) {
  if (arch === "aarch64") return { architecture: "arm64", package: "linux-image-arm64" };
  if (arch === "x86_64") return { architecture: "amd64", package: "linux-image-amd64" };
  throw new Error(`unsupported Debian kernel architecture: ${arch}`);
}

function getOciPlatform(arch) {
  if (arch === "aarch64") return "linux/arm64";
  if (arch === "x86_64") return "linux/amd64";
  throw new Error(`unsupported OCI image architecture: ${arch}`);
}

export function getCacheRoot(env = process.env) {
  if (env.PI_GONDOLIN_CACHE_DIR) return path.resolve(env.PI_GONDOLIN_CACHE_DIR);
  return path.join(os.homedir(), ".cache", "pi-gondolin");
}

export function getImageInputs(arch = getHostImageArch()) {
  getDebianKernelPackage(arch);
  const config = readRequired(CONFIG_PATH);
  const init = readRequired(INIT_PATH);
  const rootfsDockerfile = readRequired(ROOTFS_DOCKERFILE_PATH);
  const packageJson = JSON.parse(readRequired(PACKAGE_PATH).toString("utf8"));
  if (packageJson.version !== GONDOLIN_VERSION) {
    throw new Error(
      `Gondolin package mismatch: expected ${GONDOLIN_VERSION}, found ${packageJson.version ?? "unknown"}`,
    );
  }

  const inputChecksums = Object.freeze({
    config: sha256(config),
    init: sha256(init),
    rootfsDockerfile: sha256(rootfsDockerfile),
  });
  const input = Buffer.from(
    JSON.stringify({
      schemaVersion: IMAGE_SPEC_VERSION,
      gondolinVersion: GONDOLIN_VERSION,
      arch,
      rtkVersion: RTK_VERSION,
      inputChecksums,
    }),
  );

  return {
    arch,
    config,
    init,
    rootfsDockerfile,
    digest: sha256(input),
    inputChecksums,
  };
}

export function getImageDirectory(options = {}) {
  const inputs = getImageInputs(options.arch);
  return path.join(options.cacheRoot ?? getCacheRoot(), "images", inputs.digest);
}

function assertSafeManifestAsset(name, value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== path.basename(value) ||
    value.includes("\0")
  ) {
    throw new Error(`invalid ${name} path in Gondolin manifest`);
  }
}

function assertChecksum(name, value) {
  if (!CHECKSUM_PATTERN.test(value ?? "")) throw new Error(`invalid ${name} checksum in Gondolin manifest`);
}

function validateDebianKernelProvenance(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Pi image metadata is missing Debian kernel provenance");
  }
  const selected = getDebianKernelPackage(expected.arch);
  if (value.architecture !== selected.architecture || value.package !== selected.package) {
    throw new Error("Pi image Debian kernel package does not match the requested architecture");
  }
  if (typeof value.release !== "string" || !KERNEL_RELEASE_PATTERN.test(value.release)) {
    throw new Error("Pi image Debian kernel release is invalid");
  }
  if (!CHECKSUM_PATTERN.test(value.sha256 ?? "")) {
    throw new Error("Pi image Debian kernel checksum is invalid");
  }
  return value;
}

export function verifyImageDirectory(imageDir, expected = getImageInputs(), options = {}) {
  const verifyAssets = options.verifyAssets ?? gondolinVerifyAssets;
  const loadManifest = options.loadAssetManifest ?? loadAssetManifest;
  if (!verifyAssets(imageDir)) {
    throw new Error(`Gondolin image checksum verification failed: ${imageDir}`);
  }

  const manifest = loadManifest(imageDir);
  if (!manifest || manifest.version !== 1) {
    throw new Error(`invalid Gondolin image manifest: ${imageDir}`);
  }
  if (manifest.config?.arch !== expected.arch) {
    throw new Error(
      `Gondolin image architecture mismatch: expected ${expected.arch}, found ${manifest.config?.arch ?? "unknown"}`,
    );
  }
  for (const [name, value] of Object.entries(manifest.assets ?? {})) {
    if (value !== undefined) assertSafeManifestAsset(name, value);
  }
  for (const [name, value] of Object.entries(manifest.checksums ?? {})) {
    if (value !== undefined) assertChecksum(name, value);
  }

  const specPath = path.join(imageDir, "pi-image.json");
  const spec = JSON.parse(readRequired(specPath).toString("utf8"));
  const debianKernel = validateDebianKernelProvenance(spec.debianKernel, expected);
  if (manifest.checksums?.kernel !== debianKernel.sha256) {
    throw new Error("Pi image Debian kernel checksum does not match the Gondolin manifest");
  }
  if (manifest.buildId !== computeGondolinAssetBuildId(manifest)) {
    throw new Error("Gondolin manifest build ID does not match its assets");
  }
  const expectedSpec = {
    version: IMAGE_SPEC_VERSION,
    digest: expected.digest,
    gondolinVersion: GONDOLIN_VERSION,
    arch: expected.arch,
    rtkVersion: RTK_VERSION,
    inputChecksums: expected.inputChecksums,
    gondolinBuildId: manifest.buildId,
    debianKernel,
  };
  if (JSON.stringify(spec) !== JSON.stringify(expectedSpec)) {
    throw new Error(`Pi image metadata mismatch: ${specPath}`);
  }
  return { imageDir, manifest, spec };
}

function ensurePrivateDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  fs.chmodSync(dirPath, 0o700);
}

function describeCommandError(error) {
  const detail = error?.stderr?.toString().trim() || error?.message || String(error);
  return detail.replace(/\s+/g, " ");
}

function runDocker(args, options) {
  const dockerExec = options.dockerExec ?? execFileSync;
  try {
    return dockerExec("docker", args, {
      encoding: "utf8",
      stdio: options.verbose ? "inherit" : "pipe",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`Docker rootfs build failed (${describeCommandError(error)}). Recovery: ${DOCKER_RECOVERY}`);
  }
}

function removeDocker(args, options) {
  try {
    const dockerExec = options.dockerExec ?? execFileSync;
    dockerExec("docker", args, {
      encoding: "utf8",
      stdio: options.verbose ? "inherit" : "pipe",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    // A build error is more useful than a best-effort cleanup error.
  }
}

export function buildDockerRootfs(inputs, options = {}) {
  const nonce = options.nonce ?? `${process.pid}-${randomBytes(4).toString("hex")}`;
  const tag = options.rootfsTag ?? `pi-gondolin-rootfs:${inputs.digest.slice(0, 24)}-${nonce}`;
  runDocker(["version", "--format", "{{.Server.Version}}"], options);
  runDocker(
    [
      "build",
      ...(options.verbose ? [] : ["--quiet"]),
      "--platform", getOciPlatform(inputs.arch),
      "--tag", tag,
      "--file", ROOTFS_DOCKERFILE_PATH,
      SCRIPT_DIR,
    ],
    options,
  );
  return tag;
}

function removeDockerRootfs(tag, options) {
  if (tag) removeDocker(["image", "rm", "--force", tag], options);
}

const KERNEL_DISCOVERY_SCRIPT = String.raw`set -eu
set -- /boot/vmlinuz-*
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  printf '%s\n' "expected exactly one /boot/vmlinuz-* artifact" >&2
  exit 64
fi
release="${"$"}{1#/boot/vmlinuz-}"
if [ -z "$release" ] || [ ! -d "/lib/modules/$release" ]; then
  printf '%s\n' "missing matching /lib/modules/$release" >&2
  exit 65
fi
if [ "$(dpkg --print-architecture)" != "$EXPECTED_DEBIAN_ARCH" ]; then
  printf '%s\n' "OCI architecture does not match requested Debian architecture" >&2
  exit 66
fi
printf '%s\n' "$release"`;

export function extractDebianKernel(rootfsTag, inputs, outputPath, options = {}) {
  const selected = getDebianKernelPackage(inputs.arch);
  const modulesRoot = options.modulesRoot ?? path.join(path.dirname(outputPath), "debian-module-tree");
  let containerId = null;
  try {
    containerId = String(runDocker([
      "create",
      "--env", `EXPECTED_DEBIAN_ARCH=${selected.architecture}`,
      rootfsTag,
      "/bin/sh",
      "-ec",
      KERNEL_DISCOVERY_SCRIPT,
    ], options)).trim();
    if (!/^[0-9a-f]{12,64}$/i.test(containerId)) {
      throw new Error("Docker kernel extraction returned an invalid container ID");
    }
    const release = String(runDocker(["start", "--attach", containerId], options)).trim();
    if (!KERNEL_RELEASE_PATTERN.test(release)) {
      throw new Error(`Docker rootfs reported an invalid Debian kernel release: ${release || "empty"}`);
    }
    fs.rmSync(outputPath, { force: true });
    fs.rmSync(modulesRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(modulesRoot, "lib", "modules"), { recursive: true, mode: 0o700 });
    runDocker(["cp", `${containerId}:/boot/vmlinuz-${release}`, outputPath], options);
    runDocker(["cp", `${containerId}:/lib/modules/${release}`, path.join(modulesRoot, "lib", "modules")], options);
    const stat = fs.statSync(outputPath);
    const modulesPath = path.join(modulesRoot, "lib", "modules", release);
    if (!stat.isFile() || stat.size === 0) throw new Error("extracted Debian kernel is missing or empty");
    if (!fs.statSync(modulesPath).isDirectory()) throw new Error("extracted Debian kernel modules are missing");
    return {
      architecture: selected.architecture,
      package: selected.package,
      release,
      sha256: sha256(fs.readFileSync(outputPath)),
      path: outputPath,
      modulesRoot,
    };
  } finally {
    if (containerId) removeDocker(["rm", "--force", containerId], options);
  }
}

function uuidToBytes(uuid) {
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

function bytesToUuid(bytes) {
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Gondolin does not export this identity helper. Keep the compatible algorithm
// here and lock it to known vectors in test-build-gondolin-image.mjs.
export function computeGondolinAssetBuildId(manifest) {
  const checksums = manifest?.checksums;
  assertChecksum("kernel", checksums?.kernel);
  assertChecksum("initramfs", checksums?.initramfs);
  assertChecksum("rootfs", checksums?.rootfs);
  const parts = [
    "gondolin-asset-build",
    `kernel=${checksums.kernel}`,
    `initramfs=${checksums.initramfs}`,
    `rootfs=${checksums.rootfs}`,
  ];
  if (checksums.krunKernel !== undefined) {
    assertChecksum("krunKernel", checksums.krunKernel);
    parts.push(`krunKernel=${checksums.krunKernel}`);
  }
  if (checksums.krunInitrd !== undefined) {
    assertChecksum("krunInitrd", checksums.krunInitrd);
    parts.push(`krunInitrd=${checksums.krunInitrd}`);
  }
  parts.push(`arch=${manifest?.config?.arch ?? "unknown"}`);
  const digest = createHash("sha1")
    .update(uuidToBytes(GONDOLIN_BUILD_ID_NAMESPACE))
    .update(Buffer.from(parts.join("\n"), "utf8"))
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  return bytesToUuid(digest.subarray(0, 16));
}

function appendDebianModulesToInitramfs(rootfsTag, outputDir, initramfsName, kernel, options) {
  assertSafeManifestAsset("initramfs", initramfsName);
  if (!kernel.modulesRoot || !fs.statSync(kernel.modulesRoot).isDirectory()) {
    throw new Error("extracted Debian kernel module tree is missing");
  }
  const initramfsPath = path.join(outputDir, initramfsName);
  if (!fs.statSync(initramfsPath).isFile()) throw new Error("Gondolin initramfs is missing");
  const script = String.raw`set -eu
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
lz4 -d -c /assets/${initramfsName} > "$work/initramfs.cpio"
(cd /modules && find . -print | cpio -o -H newc >> "$work/initramfs.cpio")
lz4 -z -l -f -c "$work/initramfs.cpio" > /assets/${initramfsName}.tmp
mv /assets/${initramfsName}.tmp /assets/${initramfsName}`;
  runDocker([
    "run",
    "--rm",
    "--mount", `type=bind,src=${path.resolve(outputDir)},dst=/assets`,
    "--mount", `type=bind,src=${path.resolve(kernel.modulesRoot)},dst=/modules,readonly`,
    rootfsTag,
    "/bin/sh",
    "-ec",
    script,
  ], options);
}

export function rewriteDebianKernelAsset(outputDir, kernel, options = {}) {
  const loadManifest = options.loadAssetManifest ?? loadAssetManifest;
  const manifestPath = path.join(outputDir, "manifest.json");
  const manifest = loadManifest(outputDir);
  if (!manifest || manifest.version !== 1 || !manifest.assets?.kernel || !manifest.assets?.initramfs) {
    throw new Error("Gondolin build did not produce a usable manifest for Debian kernel replacement");
  }
  assertSafeManifestAsset("kernel", manifest.assets.kernel);
  const destination = path.join(outputDir, manifest.assets.kernel);
  fs.copyFileSync(kernel.path, destination);
  appendDebianModulesToInitramfs(options.rootfsTag, outputDir, manifest.assets.initramfs, kernel, options);
  manifest.checksums.kernel = sha256(fs.readFileSync(destination));
  manifest.checksums.initramfs = sha256(fs.readFileSync(path.join(outputDir, manifest.assets.initramfs)));
  if (manifest.checksums.kernel !== kernel.sha256) {
    throw new Error("copied Debian kernel checksum does not match extracted kernel");
  }
  manifest.buildId = computeGondolinAssetBuildId(manifest);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

function stageInputs(stageDir) {
  ensurePrivateDirectory(stageDir);
  fs.copyFileSync(INIT_PATH, path.join(stageDir, "docker-init-extra.sh"));
  fs.chmodSync(path.join(stageDir, "docker-init-extra.sh"), 0o755);
}

function materializeConfig(inputs, rootfsTag, parseBuildConfig = gondolinParseBuildConfig) {
  const config = parseBuildConfig(inputs.config.toString("utf8"));
  config.arch = inputs.arch;
  config.oci = { image: rootfsTag, runtime: "docker", pullPolicy: "never" };
  return config;
}

export async function ensureGondolinImage(options = {}) {
  const inputs = options.inputs ?? getImageInputs(options.arch);
  const cacheRoot = options.cacheRoot ?? getCacheRoot();
  const imagesDir = path.join(cacheRoot, "images");
  const imageDir = path.join(imagesDir, inputs.digest);
  const verify = (dir) => verifyImageDirectory(dir, inputs, options);
  ensurePrivateDirectory(cacheRoot);
  ensurePrivateDirectory(imagesDir);

  if (fs.existsSync(imageDir) && !options.force) return verify(imageDir);
  if (options.verifyOnly) throw new Error(`Gondolin image is missing: ${imageDir}`);

  const nonce = options.nonce ?? `${process.pid}-${randomBytes(4).toString("hex")}`;
  const buildRoot = path.join(cacheRoot, "build", `${inputs.digest}-${nonce}`);
  const stageDir = path.join(buildRoot, "inputs");
  const kernelPath = path.join(buildRoot, "debian-vmlinuz");
  const outputDir = path.join(imagesDir, `.${inputs.digest}.tmp-${nonce}`);
  const buildAssets = options.buildAssets ?? gondolinBuildAssets;
  const verifyAssets = options.verifyAssets ?? gondolinVerifyAssets;
  const extractKernel = options.extractDebianKernel ?? extractDebianKernel;
  let rootfsTag = null;
  ensurePrivateDirectory(path.dirname(buildRoot));
  ensurePrivateDirectory(buildRoot);

  try {
    rootfsTag = buildDockerRootfs(inputs, { ...options, nonce });
    const debianKernel = extractKernel(rootfsTag, inputs, kernelPath, {
      ...options,
      nonce,
      modulesRoot: path.join(buildRoot, "debian-module-tree"),
    });
    stageInputs(stageDir);
    const result = await buildAssets(
      materializeConfig(inputs, rootfsTag, options.parseBuildConfig ?? gondolinParseBuildConfig),
      {
        outputDir,
        configDir: stageDir,
        verbose: options.verbose ?? true,
      },
    );
    const manifest = rewriteDebianKernelAsset(result.outputDir, debianKernel, { ...options, rootfsTag });
    if (!verifyAssets(result.outputDir)) {
      throw new Error("new Gondolin image failed checksum verification after Debian kernel replacement");
    }

    const spec = {
      version: IMAGE_SPEC_VERSION,
      digest: inputs.digest,
      gondolinVersion: GONDOLIN_VERSION,
      arch: inputs.arch,
      rtkVersion: RTK_VERSION,
      inputChecksums: inputs.inputChecksums,
      gondolinBuildId: manifest.buildId,
      debianKernel: {
        architecture: debianKernel.architecture,
        package: debianKernel.package,
        release: debianKernel.release,
        sha256: debianKernel.sha256,
      },
    };
    fs.writeFileSync(path.join(outputDir, "pi-image.json"), `${JSON.stringify(spec, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    verify(outputDir);

    // Do not discard a forced-build cache until the replacement is complete and verified.
    if (options.force) fs.rmSync(imageDir, { recursive: true, force: true });
    try {
      fs.renameSync(outputDir, imageDir);
    } catch (error) {
      if (!fs.existsSync(imageDir)) throw error;
      verify(imageDir);
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
    return verify(imageDir);
  } finally {
    removeDockerRootfs(rootfsTag, options);
    fs.rmSync(buildRoot, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const known = new Set(["--force", "--verify", "--print-path", "--quiet"]);
  for (const arg of args) if (!known.has(arg)) throw new Error(`unknown option: ${arg}`);
  if (args.has("--force") && args.has("--verify")) throw new Error("--force and --verify cannot be combined");
  const result = await ensureGondolinImage({
    force: args.has("--force"),
    verifyOnly: args.has("--verify"),
    verbose: !args.has("--quiet"),
  });
  if (args.has("--print-path") || !args.has("--quiet")) process.stdout.write(`${result.imageDir}\n`);
}

if (process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`pi-gondolin-image: ${error.message}\n`);
    process.exitCode = 1;
  });
}
