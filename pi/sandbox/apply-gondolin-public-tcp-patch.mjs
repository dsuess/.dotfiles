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
    "dist/src/qemu/net.js",
    "    tcp;\n    tlsContextCacheMaxEntries;",
    "    tcp;\n    // Pi compatibility patch: raw public TCP is explicitly opt-in.\n    publicTcp;\n    tlsContextCacheMaxEntries;",
  ),
  replacement(
    "dist/src/qemu/net.js",
    "        this.tcp = createQemuTcpInternals(options.tcp);\n        this.syntheticDnsHostMapping =\n            options.dns?.syntheticHostMapping ??\n                (this.ssh.enabled || this.tcp.enabled\n                    ? \"per-host\"",
    "        this.tcp = createQemuTcpInternals(options.tcp);\n        // Pi compatibility patch: public TCP requires DNS hostname attribution.\n        this.publicTcp = options.publicTcp ?? null;\n        this.syntheticDnsHostMapping =\n            options.dns?.syntheticHostMapping ??\n                (this.ssh.enabled || this.tcp.enabled || this.publicTcp\n                    ? \"per-host\"",
  ),
  replacement(
    "dist/src/qemu/net.js",
    "                    const allowed = Boolean(session?.mappedTcp);",
    "                    const allowed = Boolean(session?.mappedTcp || session?.publicTcp);",
  ),
  replacement(
    "dist/src/qemu/net.js",
    "            mappedTcp,\n            flowControlPaused: false,",
    "            mappedTcp,\n            // Pi compatibility patch: raw TCP never falls back to HTTP/TLS MITM.\n            publicTcp: !mappedTcp && this.publicTcp\n                ? { hostname: syntheticHostname ?? message.dstIP }\n                : null,\n            flowControlPaused: false,",
  ),
  replacement(
    "dist/src/qemu/net.js",
    "        return { allowRawTcp: Boolean(mappedTcp) };",
    "        return { allowRawTcp: Boolean(mappedTcp || session.publicTcp) };",
  ),
  replacement(
    "dist/src/qemu/net.js",
    "    ensureTcpSocket(key, session) {\n        if (session.socket)\n            return;\n        const socket = new net.Socket();",
    "    ensureTcpSocket(key, session) {\n        if (session.socket || session.connecting)\n            return;\n        if (session.publicTcp) {\n            session.connecting = this.resolvePublicTcp(session.publicTcp, session.connectPort)\n                .then((address) => {\n                if (this.tcpSessions.get(key) !== session || session.socket)\n                    return;\n                session.connectIP = address;\n                this.openTcpSocket(key, session);\n            })\n                .catch((error) => this.abortTcpSession(key, session, `public-tcp-blocked (${formatError(error)})`))\n                .finally(() => {\n                session.connecting = null;\n            });\n            return;\n        }\n        this.openTcpSocket(key, session);\n    }\n    // Pi compatibility patch: resolve at connect time and approve every answer\n    // before opening a socket. This rejects DNS rebinding and mixed answers.\n    async resolvePublicTcp(publicTcp, port) {\n        const addresses = await dns.promises.lookup(publicTcp.hostname, { all: true, verbatim: true });\n        if (addresses.length === 0)\n            throw new Error(\"public-tcp DNS returned no addresses\");\n        for (const address of addresses) {\n            const allowed = await this.publicTcp?.isIpAllowed?.({\n                hostname: publicTcp.hostname,\n                ip: address.address,\n                family: address.family,\n                port,\n            });\n            if (!allowed)\n                throw new Error(`public-tcp destination blocked: ${address.address}`);\n        }\n        return addresses[0].address;\n    }\n    openTcpSocket(key, session) {\n        const socket = new net.Socket();",
  ),
  replacement(
    "dist/src/qemu/net.d.ts",
    "    /** http fetch implementation */\n    fetch?: HttpFetch;",
    "    /** raw public TCP passthrough; callers must supply an address guard */\n    publicTcp?: {\n        isIpAllowed?: (info: { hostname: string; ip: string; family: 4 | 6; port: number }) => boolean | Promise<boolean>;\n    };\n    /** http fetch implementation */\n    fetch?: HttpFetch;",
  ),
  replacement(
    "dist/src/qemu/contracts.d.ts",
    "    connectIP: string;\n    syntheticHostname: string | null;",
    "    connectIP: string;\n    syntheticHostname: string | null;\n    /** Pi compatibility patch: raw public TCP hostname attribution. */\n    publicTcp?: { hostname: string } | null;\n    connecting?: Promise<void> | null;",
  ),
  replacement(
    "dist/src/sandbox/server-options.js",
    "        tcp: options.tcp,\n        mitmCertDir: options.mitmCertDir,",
    "        tcp: options.tcp,\n        publicTcp: options.publicTcp,\n        mitmCertDir: options.mitmCertDir,",
  ),
  replacement(
    "dist/src/sandbox/server.js",
    "                tcp: this.options.tcp,\n                mitmCertDir: this.options.mitmCertDir,",
    "                tcp: this.options.tcp,\n                publicTcp: this.options.publicTcp,\n                mitmCertDir: this.options.mitmCertDir,",
  ),
  replacement(
    "dist/src/sandbox/server-options.d.ts",
    "    /** explicit host-mapped tcp egress configuration */\n    tcp?: TcpOptions;",
    "    /** explicit host-mapped tcp egress configuration */\n    tcp?: TcpOptions;\n    /** raw public TCP passthrough; callers must supply an address guard */\n    publicTcp?: {\n        isIpAllowed?: (info: { hostname: string; ip: string; family: 4 | 6; port: number }) => boolean | Promise<boolean>;\n    };",
  ),
  replacement(
    "dist/src/vm/core.js",
    "        if (options.tcp && sandboxOptions.tcp === undefined) {\n            sandboxOptions.tcp = options.tcp;\n        }\n        if (options.memory",
    "        if (options.tcp && sandboxOptions.tcp === undefined) {\n            sandboxOptions.tcp = options.tcp;\n        }\n        if (options.publicTcp && sandboxOptions.publicTcp === undefined) {\n            sandboxOptions.publicTcp = options.publicTcp;\n        }\n        if (options.memory",
  ),
  replacement(
    "dist/src/vm/core.js",
    "        if (options.tcp && sandboxOptions.tcp === undefined) {\n            sandboxOptions.tcp = options.tcp;\n        }\n        if (this.vfs && sandboxOptions.vfsProvider === undefined) {",
    "        if (options.tcp && sandboxOptions.tcp === undefined) {\n            sandboxOptions.tcp = options.tcp;\n        }\n        if (options.publicTcp && sandboxOptions.publicTcp === undefined) {\n            sandboxOptions.publicTcp = options.publicTcp;\n        }\n        if (this.vfs && sandboxOptions.vfsProvider === undefined) {",
  ),
  replacement(
    "dist/src/vm/types.d.ts",
    "    /** explicit host-mapped tcp egress configuration */\n    tcp?: TcpOptions;",
    "    /** explicit host-mapped tcp egress configuration */\n    tcp?: TcpOptions;\n    /** raw public TCP passthrough; callers must supply an address guard */\n    publicTcp?: {\n        isIpAllowed?: (info: { hostname: string; ip: string; family: 4 | 6; port: number }) => boolean | Promise<boolean>;\n    };",
  ),
];

function packageRoot(root) {
  return path.join(root, "node_modules", ...PACKAGE_NAME.split("/"));
}

function fail(message) {
  throw new Error(`Gondolin public-TCP patch: ${message}`);
}

export function applyGondolinPublicTcpPatch(root = path.dirname(fileURLToPath(import.meta.url))) {
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
  if (state.some((value) => value === "patched") && state.some((value) => value === "clean")) {
    fail("package is partially patched");
  }
  if (state.every((value) => value === "patched")) return { changed: 0 };

  const files = new Map();
  for (const item of patchReplacements) {
    const filePath = path.join(target, item.file);
    const source = files.get(filePath) ?? fs.readFileSync(filePath, "utf8");
    files.set(filePath, source.replace(item.before, item.after));
  }
  for (const [filePath, source] of files) fs.writeFileSync(filePath, source);
  return { changed: files.size };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.dirname(fileURLToPath(import.meta.url));
  const result = applyGondolinPublicTcpPatch(root);
  process.stdout.write(`Gondolin public-TCP patch verified (${result.changed === 0 ? "already patched" : "applied"}).\n`);
}
