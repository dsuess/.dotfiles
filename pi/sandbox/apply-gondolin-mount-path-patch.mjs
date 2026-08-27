#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@earendil-works/gondolin";
const PACKAGE_VERSION = "0.12.0";

function replacement(file, before, after) {
  return { file, before, after };
}

export const patchReplacements = [
  replacement(
    "dist/src/sandbox/server-boot-config.js",
    "export function buildSandboxfsAppend(baseAppend, config) {\n    const pieces = [baseAppend.trim(), `sandboxfs.mount=${config.fuseMount}`];\n    if (config.fuseBinds.length > 0) {\n        pieces.push(`sandboxfs.bind=${config.fuseBinds.join(\",\")}`);\n    }",
    "export function encodeSandboxfsPath(path) {\n    return Buffer.from(path, \"utf8\").toString(\"base64url\");\n}\nexport function buildSandboxfsAppend(baseAppend, config) {\n    // Kernel command lines are whitespace-delimited. Transport each path as an\n    // independent base64url value so no valid path byte becomes a delimiter.\n    const pieces = [baseAppend.trim(), `sandboxfs.mount.v1=${encodeSandboxfsPath(config.fuseMount)}`];\n    for (const bind of config.fuseBinds) {\n        pieces.push(`sandboxfs.bind.v1=${encodeSandboxfsPath(bind)}`);\n    }",
  ),
  replacement(
    "dist/src/alpine/init-scripts.js",
    "sandboxfs_mount=\"/data\"\nsandboxfs_binds=\"\"\n\nif [ -r /proc/cmdline ]; then\n  for arg in \\$(cat /proc/cmdline); do\n    case \"\\${arg}\" in\n      sandboxfs.mount=*)\n        sandboxfs_mount=\"\\${arg#sandboxfs.mount=}\"\n        ;;\n      sandboxfs.bind=*)\n        sandboxfs_binds=\"\\${arg#sandboxfs.bind=}\"\n        ;;\n    esac\n  done\nfi",
    "sandboxfs_mount=\"/data\"\nsandboxfs_binds=\"\"\nsandboxfs_mount_v1=\"\"\nsandboxfs_binds_v1=\"\"\n\ndecode_sandboxfs_path_v1() {\n  encoded=\"$1\"\n  case \"\\${encoded}\" in\n    \"\"|*[!A-Za-z0-9_-]*) return 1 ;;\n  esac\n  case $(( \\${#encoded} % 4 )) in\n    0) padding=\"\" ;;\n    2) padding=\"==\" ;;\n    3) padding=\"=\" ;;\n    *) return 1 ;;\n  esac\n  # The sentinel preserves a path whose final byte is a newline.\n  sandboxfs_decoded=\"$(printf '%s' \"\\${encoded}\\${padding}\" | tr '_-' '/+' | base64 -d 2>/dev/null && printf x)\" || return 1\n  case \"\\${sandboxfs_decoded}\" in\n    *x) sandboxfs_decoded=\"\\${sandboxfs_decoded%x}\" ;;\n    *) return 1 ;;\n  esac\n  [ -n \"\\${sandboxfs_decoded}\" ] || return 1\n}\n\nif [ -r /proc/cmdline ]; then\n  for arg in \\$(cat /proc/cmdline); do\n    case \"\\${arg}\" in\n      sandboxfs.mount.v1=*)\n        sandboxfs_mount_v1=\"\\${arg#sandboxfs.mount.v1=}\"\n        ;;\n      sandboxfs.bind.v1=*)\n        sandboxfs_binds_v1=\"\\${sandboxfs_binds_v1}\\${sandboxfs_binds_v1:+\n}\\${arg#sandboxfs.bind.v1=}\"\n        ;;\n      # Keep accepting Gondolin's pre-v1 command-line fields.\n      sandboxfs.mount=*)\n        sandboxfs_mount=\"\\${arg#sandboxfs.mount=}\"\n        ;;\n      sandboxfs.bind=*)\n        sandboxfs_binds=\"\\${arg#sandboxfs.bind=}\"\n        ;;\n    esac\n  done\nfi\n\nif [ -n \"\\${sandboxfs_mount_v1}\" ]; then\n  if decode_sandboxfs_path_v1 \"\\${sandboxfs_mount_v1}\"; then\n    sandboxfs_mount=\"\\${sandboxfs_decoded}\"\n  else\n    log \"[init] invalid sandboxfs.mount.v1\"\n    sandboxfs_mount=\"/data\"\n  fi\nfi",
  ),
  replacement(
    "dist/src/alpine/init-scripts.js",
    "    if [ -n \"\\${sandboxfs_binds}\" ]; then\n      OLD_IFS=\"\\${IFS}\"\n      IFS=\",\"\n      for bind in \\${sandboxfs_binds}; do\n        if [ -z \"\\${bind}\" ]; then\n          continue\n        fi\n        mkdir -p \"\\${bind}\"\n        if [ \"\\${sandboxfs_mount}\" = \"/\" ]; then\n          bind_source=\"\\${bind}\"\n        else\n          bind_source=\"\\${sandboxfs_mount}\\${bind}\"\n        fi\n        log \"[init] binding sandboxfs \\${bind_source} -> \\${bind}\"\n        log_cmd mount --bind \"\\${bind_source}\" \"\\${bind}\"\n      done\n      IFS=\"\\${OLD_IFS}\"\n    fi",
    "    if [ -n \"\\${sandboxfs_binds_v1}\" ]; then\n      while IFS= read -r encoded_bind; do\n        decode_sandboxfs_path_v1 \"\\${encoded_bind}\" || {\n          log \"[init] invalid sandboxfs.bind.v1\"\n          continue\n        }\n        bind=\"\\${sandboxfs_decoded}\"\n        mkdir -p \"\\${bind}\"\n        if [ \"\\${sandboxfs_mount}\" = \"/\" ]; then\n          bind_source=\"\\${bind}\"\n        else\n          bind_source=\"\\${sandboxfs_mount}\\${bind}\"\n        fi\n        log \"[init] binding sandboxfs \\${bind_source} -> \\${bind}\"\n        log_cmd mount --bind \"\\${bind_source}\" \"\\${bind}\"\n      done <<EOF\n\\${sandboxfs_binds_v1}\nEOF\n    elif [ -n \"\\${sandboxfs_binds}\" ]; then\n      OLD_IFS=\"\\${IFS}\"\n      IFS=\",\"\n      for bind in \\${sandboxfs_binds}; do\n        if [ -z \"\\${bind}\" ]; then\n          continue\n        fi\n        mkdir -p \"\\${bind}\"\n        if [ \"\\${sandboxfs_mount}\" = \"/\" ]; then\n          bind_source=\"\\${bind}\"\n        else\n          bind_source=\"\\${sandboxfs_mount}\\${bind}\"\n        fi\n        log \"[init] binding sandboxfs \\${bind_source} -> \\${bind}\"\n        log_cmd mount --bind \"\\${bind_source}\" \"\\${bind}\"\n      done\n      IFS=\"\\${OLD_IFS}\"\n    fi",
  ),
  replacement(
    "dist/src/vm/core.js",
    "        const script = `for i in $(seq 1 ${VFS_READY_ATTEMPTS}); do if grep -q \" $1 \" /proc/mounts; then exit 0; fi; mkdir -p \"$1\"; mount --bind \"$2\" \"$1\" > /dev/null 2>&1 || true; sleep ${VFS_READY_SLEEP_SECONDS}; done; exit 1`;",
    "        // /proc/mounts escapes spaces as \\040, so a literal-path grep can\n        // never observe a successful bind for a spaced workspace. mountpoint\n        // delegates that encoding detail to the guest mount table parser.\n        const script = `for i in $(seq 1 ${VFS_READY_ATTEMPTS}); do if mountpoint -q \"$1\"; then exit 0; fi; mkdir -p \"$1\"; mount --bind \"$2\" \"$1\" > /dev/null 2>&1 || true; sleep ${VFS_READY_SLEEP_SECONDS}; done; exit 1`;",
  ),
];

function packageRoot(root) {
  return path.join(root, "node_modules", ...PACKAGE_NAME.split("/"));
}

function fail(message) {
  throw new Error(`Gondolin mount-path patch: ${message}`);
}

export function applyGondolinMountPathPatch(root = path.dirname(fileURLToPath(import.meta.url))) {
  const target = packageRoot(root);
  const manifestPath = path.join(target, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`cannot read ${manifestPath}: ${error.message}`);
  }
  if (manifest.name !== PACKAGE_NAME || manifest.version !== PACKAGE_VERSION) {
    fail(`expected ${PACKAGE_NAME}@${PACKAGE_VERSION}, found ${manifest.name ?? "unknown"}@${manifest.version ?? "unknown"}`);
  }

  const state = patchReplacements.map((item) => {
    const source = fs.readFileSync(path.join(target, item.file), "utf8");
    if (source.includes(item.after)) return "patched";
    if (source.includes(item.before)) return "clean";
    fail(`unexpected source anchor in ${item.file}`);
  });
  const upgradingExistingPatch = state.slice(0, -1).every((value) => value === "patched") && state.at(-1) === "clean";
  if (state.some((value) => value === "patched") && state.some((value) => value === "clean") && !upgradingExistingPatch) {
    fail("package is partially patched");
  }
  if (state.every((value) => value === "patched")) return { changed: 0 };

  const files = new Map();
  for (const [index, item] of patchReplacements.entries()) {
    if (state[index] !== "clean") continue;
    const filePath = path.join(target, item.file);
    const source = files.get(filePath) ?? fs.readFileSync(filePath, "utf8");
    files.set(filePath, source.replace(item.before, item.after));
  }
  for (const [filePath, source] of files) fs.writeFileSync(filePath, source);
  return { changed: files.size };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.dirname(fileURLToPath(import.meta.url));
  const result = applyGondolinMountPathPatch(root);
  process.stdout.write(`Gondolin mount-path patch verified (${result.changed === 0 ? "already patched" : "applied"}).\n`);
}
