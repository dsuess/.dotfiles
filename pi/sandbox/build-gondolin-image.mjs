#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAssets,
  loadAssetManifest,
  parseBuildConfig,
  verifyAssets,
} from "@earendil-works/gondolin";

export const GONDOLIN_VERSION = "0.12.0";
export const IMAGE_SPEC_VERSION = 1;
export const RTK_VERSION = "0.44.0";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(SCRIPT_DIR, "image", "docker.json");
const INIT_PATH = path.join(SCRIPT_DIR, "image", "docker-init-extra.sh");
const RTK_COMPAT_SOURCE_PATH = path.join(SCRIPT_DIR, "image", "rtk-compat.c");
const RTK_WRAPPER_PATH = path.join(SCRIPT_DIR, "image", "rtk-wrapper.sh");
const PACKAGE_PATH = path.join(
  SCRIPT_DIR,
  "node_modules",
  "@earendil-works",
  "gondolin",
  "package.json",
);

const RTK_ASSETS = Object.freeze({
  aarch64: Object.freeze({
    url: `https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/rtk-aarch64-unknown-linux-gnu.tar.gz`,
    sha256: "48be2ebe6332ceb67301909125ea20a3f557b07a7c6614defed29f9bf8e1d074",
  }),
  x86_64: Object.freeze({
    url: `https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/rtk-x86_64-unknown-linux-musl.tar.gz`,
    sha256: "3c3316cfc068e372432b415faeab73d46f8047750d488dd94d01d8d9f016a2a1",
  }),
});

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

export function getCacheRoot(env = process.env) {
  if (env.PI_GONDOLIN_CACHE_DIR) {
    return path.resolve(env.PI_GONDOLIN_CACHE_DIR);
  }
  return path.join(os.homedir(), ".cache", "pi-gondolin");
}

export function getImageInputs(arch = getHostImageArch()) {
  const config = readRequired(CONFIG_PATH);
  const init = readRequired(INIT_PATH);
  const rtkCompatSource = readRequired(RTK_COMPAT_SOURCE_PATH);
  const rtkCompat = readRequired(
    path.join(SCRIPT_DIR, "image", `rtk-compat-${arch}.so`),
  );
  const rtkWrapper = readRequired(RTK_WRAPPER_PATH);
  const rtk = RTK_ASSETS[arch];
  if (!rtk) throw new Error(`no RTK asset is pinned for ${arch}`);

  const packageJson = JSON.parse(readRequired(PACKAGE_PATH).toString("utf8"));
  if (packageJson.version !== GONDOLIN_VERSION) {
    throw new Error(
      `Gondolin package mismatch: expected ${GONDOLIN_VERSION}, found ${packageJson.version ?? "unknown"}`,
    );
  }

  const input = Buffer.from(
    JSON.stringify({
      schemaVersion: IMAGE_SPEC_VERSION,
      gondolinVersion: GONDOLIN_VERSION,
      arch,
      configSha256: sha256(config),
      initSha256: sha256(init),
      rtkCompatSourceSha256: sha256(rtkCompatSource),
      rtkCompatSha256: sha256(rtkCompat),
      rtkWrapperSha256: sha256(rtkWrapper),
      rtkVersion: RTK_VERSION,
      rtkUrl: rtk.url,
      rtkSha256: rtk.sha256,
    }),
  );

  return {
    arch,
    config,
    init,
    rtk,
    rtkCompat,
    rtkCompatSource,
    rtkWrapper,
    digest: sha256(input),
    inputChecksums: Object.freeze({
      config: sha256(config),
      init: sha256(init),
      rtkCompatSource: sha256(rtkCompatSource),
      rtkCompat: sha256(rtkCompat),
      rtkWrapper: sha256(rtkWrapper),
      rtk: rtk.sha256,
    }),
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

export function verifyImageDirectory(imageDir, expected = getImageInputs()) {
  if (!verifyAssets(imageDir)) {
    throw new Error(`Gondolin image checksum verification failed: ${imageDir}`);
  }

  const manifest = loadAssetManifest(imageDir);
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
    if (value !== undefined && !/^[0-9a-f]{64}$/.test(value)) {
      throw new Error(`invalid ${name} checksum in Gondolin manifest`);
    }
  }

  const specPath = path.join(imageDir, "pi-image.json");
  const spec = JSON.parse(readRequired(specPath).toString("utf8"));
  const expectedSpec = {
    version: IMAGE_SPEC_VERSION,
    digest: expected.digest,
    gondolinVersion: GONDOLIN_VERSION,
    arch: expected.arch,
    rtkVersion: RTK_VERSION,
    inputChecksums: expected.inputChecksums,
    gondolinBuildId: manifest.buildId,
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

async function downloadFile(url, outputPath, expectedSha256) {
  if (fs.existsSync(outputPath)) {
    const existing = sha256(fs.readFileSync(outputPath));
    if (existing === expectedSha256) return;
    throw new Error(
      `cached download checksum mismatch: ${outputPath}; remove it before rebuilding`,
    );
  }

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== expectedSha256) {
    throw new Error(
      `download checksum mismatch for ${url}: expected ${expectedSha256}, got ${actual}`,
    );
  }

  const temporary = `${outputPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
  try {
    fs.renameSync(temporary, outputPath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (!fs.existsSync(outputPath)) throw error;
    const raced = sha256(fs.readFileSync(outputPath));
    if (raced !== expectedSha256) throw error;
  }
}

function validateTarEntries(archivePath) {
  const listing = execFileSync("tar", ["-tzf", archivePath], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const entries = listing.split("\n").filter(Boolean);
  if (entries.length === 0) throw new Error("RTK archive is empty");
  for (const entry of entries) {
    const normalized = path.posix.normalize(entry);
    if (
      path.posix.isAbsolute(entry) ||
      normalized === ".." ||
      normalized.startsWith("../")
    ) {
      throw new Error(`unsafe RTK archive entry: ${entry}`);
    }
  }
}

function findSingleFile(root, basename) {
  const matches = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name === basename) matches.push(fullPath);
    }
  };
  visit(root);
  if (matches.length !== 1) {
    throw new Error(`expected one ${basename} in RTK archive, found ${matches.length}`);
  }
  return matches[0];
}

async function stageInputs(stageDir, inputs, cacheRoot) {
  ensurePrivateDirectory(stageDir);
  fs.copyFileSync(INIT_PATH, path.join(stageDir, "docker-init-extra.sh"));
  fs.chmodSync(path.join(stageDir, "docker-init-extra.sh"), 0o755);
  fs.writeFileSync(path.join(stageDir, "rtk-compat.so"), inputs.rtkCompat, {
    mode: 0o755,
  });
  fs.writeFileSync(path.join(stageDir, "rtk-wrapper.sh"), inputs.rtkWrapper, {
    mode: 0o755,
  });

  const downloadsDir = path.join(cacheRoot, "downloads");
  ensurePrivateDirectory(downloadsDir);
  const archivePath = path.join(downloadsDir, `rtk-${RTK_VERSION}-${inputs.arch}.tar.gz`);
  await downloadFile(inputs.rtk.url, archivePath, inputs.rtk.sha256);
  validateTarEntries(archivePath);

  const extractedDir = path.join(stageDir, "rtk-extracted");
  fs.mkdirSync(extractedDir, { mode: 0o700 });
  execFileSync("tar", ["-xzf", archivePath, "-C", extractedDir], {
    stdio: "pipe",
  });
  const rtkPath = findSingleFile(extractedDir, "rtk");
  fs.copyFileSync(rtkPath, path.join(stageDir, "rtk"));
  fs.chmodSync(path.join(stageDir, "rtk"), 0o755);
}

function materializeConfig(inputs) {
  const config = parseBuildConfig(inputs.config.toString("utf8"));
  config.arch = inputs.arch;
  return config;
}

export async function ensureGondolinImage(options = {}) {
  const inputs = getImageInputs(options.arch);
  const cacheRoot = options.cacheRoot ?? getCacheRoot();
  const imagesDir = path.join(cacheRoot, "images");
  const imageDir = path.join(imagesDir, inputs.digest);
  ensurePrivateDirectory(cacheRoot);
  ensurePrivateDirectory(imagesDir);

  if (fs.existsSync(imageDir) && !options.force) {
    return verifyImageDirectory(imageDir, inputs);
  }
  if (options.verifyOnly) {
    throw new Error(`Gondolin image is missing: ${imageDir}`);
  }
  if (options.force) fs.rmSync(imageDir, { recursive: true, force: true });

  const nonce = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const buildRoot = path.join(cacheRoot, "build", `${inputs.digest}-${nonce}`);
  const stageDir = path.join(buildRoot, "inputs");
  const outputDir = path.join(imagesDir, `.${inputs.digest}.tmp-${nonce}`);
  ensurePrivateDirectory(path.dirname(buildRoot));
  ensurePrivateDirectory(buildRoot);

  try {
    await stageInputs(stageDir, inputs, cacheRoot);
    const config = materializeConfig(inputs);
    const result = await buildAssets(config, {
      outputDir,
      configDir: stageDir,
      verbose: options.verbose ?? true,
    });
    if (!verifyAssets(result.outputDir)) {
      throw new Error("new Gondolin image failed checksum verification");
    }

    const spec = {
      version: IMAGE_SPEC_VERSION,
      digest: inputs.digest,
      gondolinVersion: GONDOLIN_VERSION,
      arch: inputs.arch,
      rtkVersion: RTK_VERSION,
      inputChecksums: inputs.inputChecksums,
      gondolinBuildId: result.manifest.buildId,
    };
    fs.writeFileSync(
      path.join(outputDir, "pi-image.json"),
      `${JSON.stringify(spec, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    verifyImageDirectory(outputDir, inputs);

    try {
      fs.renameSync(outputDir, imageDir);
    } catch (error) {
      if (!fs.existsSync(imageDir)) throw error;
      verifyImageDirectory(imageDir, inputs);
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
    return verifyImageDirectory(imageDir, inputs);
  } finally {
    fs.rmSync(buildRoot, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const known = new Set(["--force", "--verify", "--print-path", "--quiet"]);
  for (const arg of args) {
    if (!known.has(arg)) throw new Error(`unknown option: ${arg}`);
  }
  if (args.has("--force") && args.has("--verify")) {
    throw new Error("--force and --verify cannot be combined");
  }

  const result = await ensureGondolinImage({
    force: args.has("--force"),
    verifyOnly: args.has("--verify"),
    verbose: !args.has("--quiet"),
  });
  if (args.has("--print-path") || !args.has("--quiet")) {
    process.stdout.write(`${result.imageDir}\n`);
  }
}

if (
  process.argv[1] &&
  fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1])
) {
  main().catch((error) => {
    process.stderr.write(`pi-gondolin-image: ${error.message}\n`);
    process.exitCode = 1;
  });
}
