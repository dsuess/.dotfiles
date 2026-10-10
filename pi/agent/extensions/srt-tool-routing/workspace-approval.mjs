import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const fail = (message) => new Error(`Routed MCP approval denied: ${message}`);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
const digest = (value) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const snapshotDigest = (snapshot) => digest({ workspace: snapshot.workspace, servers: Object.fromEntries(snapshot.servers.map((server) => [server.entry.name, server])) });
function boundedRead(file, maximum) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw fail("invalid or oversized file");
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > maximum) throw fail("file exceeded size limit while reading");
    try { return JSON.parse(bytes.subarray(0, length).toString("utf8")); }
    catch { throw fail("malformed JSON; repair the configuration or approval state before retrying"); }
  } finally { fs.closeSync(fd); }
}
function literal(value, label) {
  if (typeof value !== "string" || value.includes("\0") || value.startsWith("!") || value.startsWith("~") || /\$\{|\$\(/.test(value)) throw fail(`${label}: use literal values, not expansion or command substitution`);
  return value;
}
const exposures = new Set(["direct", "hidden", "codemode", "codemode-deferred", "deferred"]);

/** Host-only reader: trust is checked before opening any project file. */
export function readWorkspaceServers(ctx) {
  if (ctx.isProjectTrusted?.() !== true) return { workspace: fs.realpathSync(ctx.cwd), servers: [] };
  const workspace = fs.realpathSync(ctx.cwd);
  const source = path.join(workspace, ".pi/mcp.json");
  if (!fs.existsSync(source)) return { workspace, servers: [] };
  if (fs.realpathSync(source) !== source) throw fail(".pi/mcp.json and its parent must not be symlinks");
  const document = boundedRead(source, 64 * 1024);
  if (!object(document) || Object.keys(document).some((key) => !["mcpServers", "autoEnableCodemode"].includes(key)) || !object(document.mcpServers)) throw fail("expected an mcpServers object");
  const servers = [];
  const names = new Set();
  for (const [name, config] of Object.entries(document.mcpServers)) {
    const normalized = name.replaceAll("-", "_");
    if (!/^[A-Za-z0-9_-]+$/.test(name) || names.has(normalized)) throw fail("invalid or colliding server name");
    names.add(normalized);
    if (!object(config) || (config.enabled !== undefined && typeof config.enabled !== "boolean")) throw fail(`${name}: invalid enabled state`);
    if (config.enabled === false) continue;
    const allowed = new Set(["command", "args", "cwd", "env", "type", "enabled", "exposure", "toolExposure", "description", "timeout"]);
    const unsupported = Object.keys(config).filter((key) => !allowed.has(key));
    if (unsupported.length || (config.type !== undefined && config.type !== "stdio")) throw fail(`${name}: only project stdio is supported; remove unsupported fields ${unsupported.join(", ")}`);
    const command = literal(config.command, `${name}.command`);
    if (!command) throw fail(`${name}: command is empty`);
    if (config.args !== undefined && !Array.isArray(config.args)) throw fail(`${name}: args must be an array`);
    const args = (config.args ?? []).map((value) => literal(value, `${name}.args`));
    const cwd = fs.realpathSync(path.resolve(workspace, literal(config.cwd ?? workspace, `${name}.cwd`)));
    if (!fs.statSync(cwd).isDirectory()) throw fail(`${name}: cwd is not a directory`);
    if (config.env !== undefined && !object(config.env)) throw fail(`${name}: env must be an object`);
    const env = Object.fromEntries(Object.entries(config.env ?? {}).map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw fail(`${name}: invalid environment name`);
      return [key, literal(value, `${name}.env`)];
    }));
    if (config.exposure !== undefined && !exposures.has(config.exposure)) throw fail(`${name}: invalid exposure`);
    if (config.toolExposure !== undefined && (!object(config.toolExposure) || Object.values(config.toolExposure).some((value) => !exposures.has(value)))) throw fail(`${name}: invalid toolExposure`);
    if (config.description !== undefined && typeof config.description !== "string") throw fail(`${name}: invalid description`);
    if (config.timeout !== undefined && (!Number.isFinite(config.timeout) || config.timeout <= 0)) throw fail(`${name}: invalid timeout`);
    const executable = command.includes("/") ? path.resolve(cwd, command) : command;
    const launch = { argv: [executable, ...args], cwd, env };
    const fingerprint = digest({ name, source, command: executable, args, cwd, env });
    // Normalize non-hidden exposure without changing launch authority. No discovery.
    const direct = (value) => value === "hidden" ? "hidden" : "direct";
    const entry = { name, scope: "project", source, config: { ...config, command: executable, args, cwd, env,
      exposure: direct(config.exposure), toolExposure: Object.fromEntries(Object.entries(config.toolExposure ?? {}).map(([key, value]) => [key, direct(value)])) } };
    servers.push({ entry, launch, fingerprint, identity: digest(entry) });
  }
  return { workspace, servers };
}

/** Private state is deliberately outside agent/ (the Stow tree). */
export class WorkspaceApprovalStore {
  constructor(home = os.homedir()) {
    this.home = fs.realpathSync(home);
    this.directory = path.join(this.home, ".pi/routed-mcp");
    this.file = path.join(this.directory, "approvals.json");
  }
  checkDirectory(create = false) {
    for (const [directory, privateMode] of [[path.join(this.home, ".pi"), false], [this.directory, true]]) {
      try {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & (privateMode ? 0o077 : 0o022))) throw fail("unsafe approval directory");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (!create) return false;
        try { fs.mkdirSync(directory, { mode: 0o700 }); }
        catch (creation) { if (creation.code !== "EEXIST") throw creation; }
        return this.checkDirectory(create);
      }
    }
    return true;
  }
  read() {
    if (!this.checkDirectory()) return { version: 1, workspaces: {} };
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o077)) throw fail("unsafe approval file");
      const state = boundedRead(this.file, 1024 * 1024);
      if (!object(state) || state.version !== 1 || Object.keys(state).sort().join(",") !== "version,workspaces" || !object(state.workspaces)) throw fail("malformed approval state");
      for (const [workspace, record] of Object.entries(state.workspaces)) {
        if (!path.isAbsolute(workspace) || !object(record) || Object.keys(record).sort().join(",") !== "revision,servers" || typeof record.revision !== "string" || !/^[0-9a-f-]{36}$/.test(record.revision) || !object(record.servers) || Object.entries(record.servers).some(([name, fingerprint]) => !/^[A-Za-z0-9_-]+$/.test(name) || typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint))) throw fail("malformed workspace approval");
      }
      return state;
    } catch (error) { if (error.code === "ENOENT") return { version: 1, workspaces: {} }; throw error; }
  }
  async update(mutate) {
    this.checkDirectory(true);
    const lock = path.join(this.directory, "lock");
    let acquired = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { fs.mkdirSync(lock, { mode: 0o700 }); acquired = true; break; }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const stat = fs.lstatSync(lock);
          if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw fail("unsafe approval lock");
        } catch (inspection) { if (inspection.code !== "ENOENT") throw inspection; }
        await delay(20);
      }
    }
    if (!acquired) throw fail("approval store is busy; retry after the other writer exits");
    const temporary = path.join(this.directory, `${randomUUID()}.tmp`);
    try {
      const state = this.read();
      mutate(state.workspaces);
      const bytes = Buffer.from(JSON.stringify(state));
      if (bytes.length > 1024 * 1024) throw fail("approval state exceeds its size limit");
      const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      this.checkDirectory();
      // Recheck the target before replacement; never follow an unsafe target.
      this.read();
      fs.renameSync(temporary, this.file);
      const directory = fs.openSync(this.directory, fs.constants.O_RDONLY);
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } finally {
      fs.rmSync(temporary, { force: true });
      fs.rmdirSync(lock);
    }
  }
  approve(snapshot, verify = () => snapshot) {
    return this.update((workspaces) => {
      if (snapshotDigest(snapshot) !== snapshotDigest(verify())) throw fail("configuration changed before saving approval; retry /mcp approve");
      workspaces[snapshot.workspace] = { revision: randomUUID(), servers: Object.fromEntries(snapshot.servers.map((server) => [server.entry.name, server.fingerprint])) };
    });
  }
  revoke(workspace) { return this.update((workspaces) => { delete workspaces[workspace]; }); }
  matching(snapshot) {
    const record = this.read().workspaces[snapshot.workspace];
    return snapshot.servers.filter((server) => record?.servers[server.entry.name] === server.fingerprint).map((server) => ({ ...server, revision: record.revision }));
  }
}

export function createWorkspaceApproval({ store = new WorkspaceApprovalStore(), read = readWorkspaceServers } = {}) {
  let context;
  let attempted = false;
  let error;
  let session;
  const snapshot = () => read(context);
  const load = (ctx) => {
    if (ctx) context = ctx;
    try {
      const current = snapshot();
      const servers = store.matching(current);
      error = undefined;
      return { ...current, servers, errors: servers.length < current.servers.length ? ["Project MCP needs routed approval; use /mcp approve in an interactive terminal session"] : [] };
    }
    catch (cause) { error = cause.message; return { workspace: context?.cwd, servers: [], errors: [error] }; }
  };
  return {
    async initialize(ctx, retry = false) {
      context = ctx;
      if (retry || (ctx.sessionManager && session !== ctx.sessionManager)) attempted = false;
      session = ctx.sessionManager;
      try {
        const current = snapshot();
        const approved = store.matching(current);
        if (!current.servers.length || approved.length === current.servers.length || attempted || !ctx.hasUI || ctx.mode !== "tui") return;
        attempted = true;
        // Arguments and literal env can contain credentials. Only show executable,
        // argument count, working directory, and environment variable names.
        const summary = current.servers.map(({ entry, launch }) => `${entry.name}: ${launch.argv[0]} (${launch.argv.length - 1} arguments)\ncwd: ${launch.cwd}\nenv names: ${Object.keys(launch.env).join(", ") || "none"}`).join("\n\n");
        if (!await ctx.ui.confirm("Approve routed project MCP?", `${current.workspace}\n\n${summary}\n\nLaunchers can change without reapproval. Servers remain sandboxed. Non-hidden tools are exposed directly.`)) return;
        const after = snapshot();
        if (snapshotDigest(current) !== snapshotDigest(after)) throw fail("configuration changed during confirmation; use /mcp approve to retry");
        await store.approve(after, snapshot);
        error = undefined;
      } catch (cause) { error = cause.message; ctx.ui?.notify?.(error, "warning"); }
    },
    load,
    validate(server) {
      const current = load().servers.find((candidate) => candidate.entry.name === server.entry.name);
      if (!current || current.revision !== server.revision || current.fingerprint !== server.fingerprint || current.identity !== server.identity) throw fail(error ?? "approval or configuration changed; use /mcp approve then /mcp reconnect");
      return current.launch;
    },
    status() {
      try {
        const current = snapshot();
        const matching = store.matching(current);
        return `${current.workspace}: ${matching.length}/${current.servers.length} project stdio servers approved. Non-hidden tools: direct exposure.\n${current.servers.map((server) => `${server.entry.name}: ${matching.some((approved) => approved.entry.name === server.entry.name) ? "approved" : "approval required"}`).join("\n")}\n${error ?? ""}`;
      } catch (cause) { return cause.message; }
    },
    async revoke() { await store.revoke(fs.realpathSync(context.cwd)); },
  };
}
