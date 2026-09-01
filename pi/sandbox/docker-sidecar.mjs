import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import {
  PI_SBX_APP,
  REVIEWED_SHELL_TEMPLATE,
  assertCanarySandbox,
  fixedSpawnEnvironment,
  piSbxArgs,
  preflightPiApp,
  runPiSbx,
} from "./srt-compatibility-canary.mjs";

const MAX_STDERR_BYTES = 16 * 1024;
const NAME_PREFIX = "pi-srt-";

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const stat = fs.statSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error("sidecar runtime directory is not private");
  return directory;
}

function safeWorkspaceName(workspaceKey) {
  if (!/^[0-9a-f]{64}$/.test(workspaceKey)) throw new Error("workspace key is invalid");
  return `${NAME_PREFIX}${workspaceKey.slice(0, 24)}`;
}

function ownershipDigest(record) {
  return createHash("sha256").update(JSON.stringify({
    workspaceKey: record.workspaceKey, workspaceRoot: record.workspaceRoot, bareCommonDirectory: record.bareCommonDirectory,
    name: record.name, template: record.template, cpus: record.cpus, memory: record.memory,
  })).digest("hex");
}

function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, filePath);
}

export function validateSidecarInspect(inspect, expected) {
  assertCanarySandbox(inspect, expected.workspaceRoot);
  if (inspect.name !== expected.name) throw new Error("sidecar name drift");
  if (!inspect.id || typeof inspect.id !== "string") throw new Error("sidecar has no stable ID");
  if (inspect.cpus !== undefined && Number(inspect.cpus) !== expected.cpus) throw new Error("sidecar CPU limit drift");
  if (inspect.memory !== undefined && String(inspect.memory).toLowerCase() !== expected.memory) throw new Error("sidecar memory limit drift");
  if (Array.isArray(inspect.ports) && inspect.ports.length !== 0) throw new Error("sidecar has unexpected published ports");
  if (inspect.skills && inspect.skills.shared) throw new Error("sidecar has shared skills");
  return inspect;
}

export class WorkspaceDockerSidecar {
  constructor(options) {
    this.workspaceKey = options.workspaceKey;
    this.workspaceRoot = fs.realpathSync(options.workspaceRoot);
    this.bareCommonDirectory = options.bareCommonDirectory ? fs.realpathSync(options.bareCommonDirectory) : null;
    this.runtimeRoot = privateDirectory(options.runtimeRoot);
    this.brokerRoot = privateDirectory(options.brokerRoot ?? path.join(path.dirname(this.runtimeRoot), `${path.basename(this.runtimeRoot)}-broker`));
    if (this.brokerRoot === this.runtimeRoot || this.brokerRoot.startsWith(`${this.runtimeRoot}${path.sep}`)) throw new Error("broker root must not be inside controller state");
    this.name = safeWorkspaceName(this.workspaceKey);
    this.cpus = options.cpus ?? 2;
    this.memory = String(options.memory ?? "4g").toLowerCase();
    this.template = options.template ?? REVIEWED_SHELL_TEMPLATE;
    this.sbx = options.sbx ?? ((args) => runPiSbx(args, options.sbxOptions));
    this.preflight = options.preflight ?? (() => preflightPiApp(options.sbxOptions));
    this.spawn = options.spawn ?? spawn;
    this.metadataPath = path.join(this.runtimeRoot, "sidecar.json");
    this.socketPath = path.join(this.brokerRoot, "docker.sock");
    this.server = null;
    this.socketInode = null;
    this.ready = null;
    this.bridges = new Set();
  }

  expected() {
    return {
      workspaceKey: this.workspaceKey, workspaceRoot: this.workspaceRoot, bareCommonDirectory: this.bareCommonDirectory,
      name: this.name, template: this.template, cpus: this.cpus, memory: this.memory,
    };
  }

  async inspect() {
    const result = await this.sbx(["inspect", this.name, "--json"]);
    if (result.code !== 0) return null;
    let inspect;
    try { inspect = JSON.parse(result.stdout); } catch { throw new Error("sidecar inspect returned invalid JSON"); }
    if (!inspect.id) {
      const listed = await this.sbx(["ls", "--json"]);
      if (listed.code !== 0) throw new Error("sidecar inventory lookup failed");
      let inventory;
      try { inventory = JSON.parse(listed.stdout); } catch { throw new Error("sidecar inventory returned invalid JSON"); }
      const matches = (inventory.sandboxes ?? []).filter((item) => item?.name === this.name && item?.workspaces?.includes(this.workspaceRoot));
      if (matches.length !== 1 || typeof matches[0].id !== "string" || !matches[0].id) throw new Error("sidecar has no unique stable ID");
      inspect.id = matches[0].id;
    }
    return validateSidecarInspect(inspect, this.expected());
  }

  metadata() {
    if (!fs.existsSync(this.metadataPath)) return null;
    let metadata;
    try { metadata = JSON.parse(fs.readFileSync(this.metadataPath, "utf8")); } catch { throw new Error("sidecar ownership metadata is invalid"); }
    const expected = this.expected();
    if (!metadata || metadata.appName !== PI_SBX_APP || metadata.ownershipDigest !== ownershipDigest(metadata) ||
        Object.entries(expected).some(([key, value]) => metadata[key] !== value) || typeof metadata.id !== "string" || !metadata.id) {
      throw new Error("sidecar ownership metadata drift");
    }
    return metadata;
  }

  async ensure() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      await this.preflight();
      const recorded = this.metadata();
      let inspect = await this.inspect();
      if (recorded && inspect && recorded.id !== inspect.id) throw new Error("sidecar identity drift");
      if (!inspect) {
        const created = await this.sbx([
          "create", "--name", this.name, "--cpus", String(this.cpus), "--memory", this.memory,
          "--template", this.template, "shell", this.workspaceRoot,
        ]);
        if (created.code !== 0) throw new Error(`sidecar creation failed: ${created.stderr || created.stdout}`);
        inspect = await this.inspect();
        if (!inspect) throw new Error("created sidecar cannot be inspected");
      }
      const metadata = { ...this.expected(), id: inspect.id, appName: PI_SBX_APP, ownershipDigest: "" };
      metadata.ownershipDigest = ownershipDigest(metadata);
      atomicJson(this.metadataPath, metadata);
      return metadata;
    })().catch((error) => { this.ready = null; throw error; });
    return this.ready;
  }

  async startBroker() {
    if (this.server) return this.socketPath;
    fs.rmSync(this.socketPath, { force: true });
    const server = net.createServer((client) => void this.bridge(client));
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(this.socketPath, resolve); });
    fs.chmodSync(this.socketPath, 0o600);
    this.socketInode = fs.lstatSync(this.socketPath).ino;
    this.server = server;
    return this.socketPath;
  }

  async bridge(client) {
    try {
      await this.ensure();
      const child = this.spawn("/opt/homebrew/bin/sbx", piSbxArgs(["exec", "-i", this.name, "docker", "system", "dial-stdio"]), {
        cwd: this.workspaceRoot, env: fixedSpawnEnvironment(), stdio: ["pipe", "pipe", "pipe"],
      });
      const bridge = { client, child }; this.bridges.add(bridge);
      let stderr = ""; let settled = false;
      const cleanup = () => { if (!settled) { settled = true; this.bridges.delete(bridge); } };
      child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_BYTES); });
      // pipe() preserves client FIN as stdin EOF, which Docker needs for request bodies.
      client.pipe(child.stdin); child.stdout.pipe(client);
      const terminate = () => { if (!child.killed) child.kill("SIGTERM"); };
      client.once("error", terminate);
      client.once("close", () => { child.stdin.end(); terminate(); });
      child.once("error", (error) => { if (!client.destroyed) client.destroy(error); cleanup(); });
      child.once("close", (code) => {
        if (code !== 0 && !client.destroyed) client.destroy(new Error(`private Docker bridge exited (${code}): ${stderr.replace(/((?:token|password|authorization))=[^\\s]+/gi, "$1=[redacted]")}`));
        cleanup();
      });
    } catch (error) {
      client.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }

  activeBridgeCount() { return this.bridges.size; }

  async reset() {
    if (this.bridges.size > 0) throw new Error("refusing to reset while Docker bridge traffic is active");
    const inspected = await this.inspect();
    if (!inspected) throw new Error("refusing to reset an unvalidated sidecar");
    const removed = await this.sbx(["rm", "--force", this.name]);
    if (removed.code !== 0) throw new Error(`sidecar reset failed: ${removed.stderr || removed.stdout}`);
    fs.rmSync(this.metadataPath, { force: true }); this.ready = null;
  }

  async close() {
    for (const { client, child } of this.bridges) { client.destroy(); child.kill("SIGTERM"); }
    this.bridges.clear();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
    try { if (fs.lstatSync(this.socketPath).ino === this.socketInode) fs.rmSync(this.socketPath); } catch {}
    this.socketInode = null;
  }
}

export const dockerSidecarInternals = Object.freeze({ ownershipDigest, safeWorkspaceName });
