import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildDockerRootfs,
  computeGondolinAssetBuildId,
  ensureGondolinImage,
  extractDebianKernel,
  getDebianKernelPackage,
} from "./build-gondolin-image.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function inputs(arch = "aarch64") {
  return {
    arch,
    config: Buffer.from("{}"),
    init: Buffer.from("init"),
    rootfsDockerfile: Buffer.from("Dockerfile"),
    digest: "a".repeat(64),
    inputChecksums: { config: "b".repeat(64), init: "c".repeat(64), rootfsDockerfile: "d".repeat(64) },
  };
}

function makeHarness(t, options = {}) {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-image-builder-"));
  t.after(() => fs.rmSync(cacheRoot, { recursive: true, force: true }));
  const calls = [];
  const manifest = {
    version: 1,
    buildId: "00000000-0000-5000-8000-000000000000",
    config: { arch: "aarch64" },
    assets: { kernel: "vmlinuz-virt", initramfs: "initramfs.cpio.lz4", rootfs: "rootfs.ext4" },
    checksums: { kernel: "1".repeat(64), initramfs: "2".repeat(64), rootfs: "3".repeat(64) },
  };
  return {
    cacheRoot,
    calls,
    dockerExec(command, args) {
      calls.push([command, args]);
      if (options.failDocker?.(args)) throw new Error("daemon unavailable");
      if (args[0] === "create") return "a".repeat(64);
      if (args[0] === "start") return "6.12.57+deb13-arm64\n";
      if (args[0] === "cp") {
        if (args[1].includes(":/lib/modules/")) {
          fs.mkdirSync(path.join(args[2], "6.12.57+deb13-arm64"), { recursive: true });
        } else {
          fs.writeFileSync(args[2], "debian-kernel");
        }
        return "";
      }
      return "";
    },
    parseBuildConfig: () => ({ arch: "x86_64", oci: {} }),
    async buildAssets(config, buildOptions) {
      if (options.failBuild) throw new Error("Gondolin assembly failed");
      fs.mkdirSync(buildOptions.outputDir, { recursive: true });
      fs.writeFileSync(path.join(buildOptions.outputDir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
      fs.writeFileSync(path.join(buildOptions.outputDir, "vmlinuz-virt"), "alpine-kernel");
      fs.writeFileSync(path.join(buildOptions.outputDir, "initramfs.cpio.lz4"), "alpine-initramfs");
      fs.writeFileSync(path.join(buildOptions.outputDir, "rootfs.ext4"), "rootfs");
      return { outputDir: buildOptions.outputDir, manifest, config };
    },
    verifyAssets: () => !options.failVerification,
    loadAssetManifest: () => manifest,
  };
}

test("Debian kernel packages and Docker rootfs platforms match both supported architectures", () => {
  assert.deepEqual(getDebianKernelPackage("aarch64"), { architecture: "arm64", package: "linux-image-arm64" });
  assert.deepEqual(getDebianKernelPackage("x86_64"), { architecture: "amd64", package: "linux-image-amd64" });
  assert.throws(() => getDebianKernelPackage("riscv64"), /unsupported Debian kernel architecture/);

  const calls = [];
  const tag = buildDockerRootfs(inputs(), {
    nonce: "nonce",
    verbose: false,
    dockerExec(command, args) {
      calls.push([command, args]);
      return "";
    },
  });
  assert.equal(tag, `pi-gondolin-rootfs:${"a".repeat(24)}-nonce`);
  assert.deepEqual(calls.map(([, args]) => args.slice(0, 2)), [["version", "--format"], ["build", "--quiet"]]);
  assert.deepEqual(calls[1][1].slice(0, 7), ["build", "--quiet", "--platform", "linux/arm64", "--tag", tag, "--file"]);

  const x64Calls = [];
  buildDockerRootfs(inputs("x86_64"), {
    nonce: "x64",
    verbose: false,
    dockerExec(command, args) {
      x64Calls.push([command, args]);
      return "";
    },
  });
  assert.equal(x64Calls[1][1][3], "linux/amd64");
});

test("kernel extraction validates the OCI release and always removes its disposable container", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kernel-extract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "vmlinuz");
  const calls = [];
  const kernel = extractDebianKernel("rootfs:test", inputs(), output, {
    verbose: false,
    dockerExec(command, args) {
      calls.push([command, args]);
      if (args[0] === "create") return "b".repeat(64);
      if (args[0] === "start") return "6.12.57+deb13-arm64\n";
      if (args[0] === "cp") {
        if (args[1].includes(":/lib/modules/")) {
          fs.mkdirSync(path.join(args[2], "6.12.57+deb13-arm64"), { recursive: true });
        } else {
          fs.writeFileSync(args[2], "kernel-bytes");
        }
      }
      return "";
    },
  });
  assert.equal(kernel.architecture, "arm64");
  assert.equal(kernel.package, "linux-image-arm64");
  assert.equal(kernel.release, "6.12.57+deb13-arm64");
  assert.equal(kernel.sha256, sha256("kernel-bytes"));
  assert.equal(kernel.path, output);
  assert.equal(fs.statSync(path.join(kernel.modulesRoot, "lib", "modules", kernel.release)).isDirectory(), true);
  assert.equal(calls[0][1][0], "create");
  assert.ok(calls[0][1].includes("EXPECTED_DEBIAN_ARCH=arm64"));
  assert.deepEqual(calls.at(-1)[1].slice(0, 3), ["rm", "--force", "b".repeat(64)]);

  const failedCalls = [];
  assert.throws(
    () => extractDebianKernel("rootfs:test", inputs(), output, {
      verbose: false,
      dockerExec(command, args) {
        failedCalls.push([command, args]);
        if (args[0] === "create") return "c".repeat(64);
        if (args[0] === "start") return "ambiguous\nkernels";
        return "";
      },
    }),
    /invalid Debian kernel release/,
  );
  assert.deepEqual(failedCalls.at(-1)[1].slice(0, 3), ["rm", "--force", "c".repeat(64)]);
});

test("compatible build IDs match a Gondolin manifest vector and change with the kernel", () => {
  // This vector was emitted by Gondolin 0.12.0 before kernel replacement.
  const manifest = {
    config: { arch: "aarch64" },
    checksums: {
      kernel: "648faf1fbbfeb4e9e3143d2c830972b3373355e6290b2255f4deeb58d83bb6ff",
      initramfs: "7a3f11a0ea8ba44d25d0affb0ee2d5a8d53c4a4ff2df8b3bfdefdcc67a7ad528",
      rootfs: "5ea9174e835c38e42cb2847dce033c4e0dfdb248b677ebdee54015d2dcc78121",
      krunKernel: "2bfc6989476acc7f772ef05053e56613668daa507a5fe64244b9cc4adcb66ee0",
      krunInitrd: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
  };
  assert.equal(computeGondolinAssetBuildId(manifest), "4473e283-5453-5882-9269-67fe36c4abd1");
  const changed = structuredClone(manifest);
  changed.checksums.kernel = "d".repeat(64);
  assert.notEqual(computeGondolinAssetBuildId(changed), computeGondolinAssetBuildId(manifest));
});

test("image assembly rewrites the kernel identity, records provenance, and removes temporary resources", async (t) => {
  const harness = makeHarness(t);
  const result = await ensureGondolinImage({ ...harness, inputs: inputs(), nonce: "success", verbose: false });
  assert.equal(result.spec.digest, "a".repeat(64));
  assert.equal(result.spec.inputChecksums.rootfsDockerfile, "d".repeat(64));
  assert.deepEqual(result.spec.debianKernel, {
    architecture: "arm64",
    package: "linux-image-arm64",
    release: "6.12.57+deb13-arm64",
    sha256: sha256("debian-kernel"),
  });
  assert.equal(result.manifest.checksums.kernel, sha256("debian-kernel"));
  assert.equal(result.manifest.buildId, computeGondolinAssetBuildId(result.manifest));
  assert.equal(harness.calls[1][1][0], "build");
  assert.equal(harness.calls.some(([, args]) => args[0] === "rm" && args[1] === "--force"), true);
  assert.equal(harness.calls.at(-1)[1][0], "image");
  assert.equal(harness.calls.at(-1)[1][1], "rm");
  assert.equal(fs.existsSync(result.imageDir), true);
});

test("cache hits do not require Docker and failed extraction or verification leaves no image", async (t) => {
  const harness = makeHarness(t);
  const first = await ensureGondolinImage({ ...harness, inputs: inputs(), nonce: "cached", verbose: false });
  harness.calls.length = 0;
  const cached = await ensureGondolinImage({ ...harness, inputs: inputs(), verbose: false });
  assert.equal(cached.imageDir, first.imageDir);
  assert.deepEqual(harness.calls, []);

  const failedExtraction = makeHarness(t, { failDocker: (args) => args[0] === "start" });
  await assert.rejects(
    () => ensureGondolinImage({ ...failedExtraction, inputs: inputs(), nonce: "extract-failed", verbose: false }),
    /Docker rootfs build failed/,
  );
  assert.equal(fs.existsSync(path.join(failedExtraction.cacheRoot, "images", "a".repeat(64))), false);
  assert.equal(failedExtraction.calls.some(([, args]) => args[0] === "rm" && args[1] === "--force"), true);

  const verificationFailure = makeHarness(t, { failVerification: true });
  await assert.rejects(
    () => ensureGondolinImage({ ...verificationFailure, inputs: inputs(), nonce: "verification-failure", verbose: false }),
    /checksum verification after Debian kernel replacement/,
  );
  assert.equal(fs.existsSync(path.join(verificationFailure.cacheRoot, "images", "a".repeat(64))), false);
  assert.equal(verificationFailure.calls.at(-1)[1][0], "image");
});
