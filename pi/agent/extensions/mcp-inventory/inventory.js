import fs from "node:fs";
import path from "node:path";

export const MAX_FILE_BYTES = 128 * 1024;
export const MAX_SERVERS = 32;
export const MAX_PATH_LENGTH = 512;
export const MAX_OUTPUT_BYTES = 32 * 1024;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (name) => name.replace(/-/g, "_");

// Read at most the limit plus one byte, even if the file grows after stat.
export function readConfig(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { code: "unreadable" };
    if (stat.size > MAX_FILE_BYTES) return { code: "oversized" };
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const size = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!size) break;
      length += size;
    }
    if (length > MAX_FILE_BYTES) return { code: "oversized" };
    try {
      return { value: JSON.parse(buffer.subarray(0, length).toString("utf8")) };
    } catch {
      return { code: "malformed" };
    }
  } catch (error) {
    return { code: error?.code === "ENOENT" ? "missing" : "unreadable" };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function metadata(name, config, source) {
  if (typeof name !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(name) || !record(config)) return null;
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") return null;
  const command = config.command !== undefined;
  const url = config.url !== undefined;
  if (command === url) return null;
  if (command && (typeof config.command !== "string" || !config.command.trim())) return null;
  if (url && (typeof config.url !== "string" || !config.url.trim())) return null;
  const transport = command ? "stdio" : "http";
  if (config.type !== undefined && config.type !== transport && !(transport === "http" && config.type === "streamable-http")) return null;
  return { name, source, enabled: config.enabled !== false, transport };
}

export function collectInventory({ agentDir, ctx, getMcpServers, read = readConfig }) {
  const servers = new Map();
  const diagnostics = [];
  const diagnose = (scope, code) => {
    if (!diagnostics.some((entry) => entry.scope === scope && entry.code === code)) diagnostics.push({ scope, code });
  };
  const ingest = (entries, source) => {
    if (entries.length > MAX_SERVERS) {
      diagnose(source.scope, "server-limit");
      return;
    }
    const seen = new Set();
    for (const [name, config] of entries) {
      const entry = metadata(name, config, source);
      if (!entry) { diagnose(source.scope, "unsupported-metadata"); continue; }
      const key = identity(name);
      const previous = servers.get(key);
      if (seen.has(key) || (previous && previous.source.scope !== "extension" && previous.name !== name)) {
        diagnose(source.scope, "ambiguous-name"); continue;
      }
      seen.add(key);
      if (!servers.has(key) && servers.size >= MAX_SERVERS) { diagnose(source.scope, "server-limit"); continue; }
      servers.set(key, entry);
    }
  };
  try {
    const registered = getMcpServers();
    if (!Array.isArray(registered)) diagnose("extension", "unsupported-metadata");
    else if (registered.length > MAX_SERVERS) diagnose("extension", "server-limit");
    else {
      // Only the registration's path and the selected metadata fields reach output.
      for (const server of registered) {
        if (!record(server) || typeof server.extensionPath !== "string" || server.extensionPath.length > MAX_PATH_LENGTH) {
          diagnose("extension", "unsupported-metadata"); continue;
        }
        ingest([[server.name, server.config]], { scope: "extension", path: server.extensionPath });
      }
    }
  } catch { diagnose("extension", "unavailable"); }
  const load = (scope, file) => {
    if (file.length > MAX_PATH_LENGTH) { diagnose(scope, "path-limit"); return; }
    const result = read(file);
    if (result.code) { if (result.code !== "missing") diagnose(scope, result.code); return; }
    if (!record(result.value) || (result.value.mcpServers !== undefined && !record(result.value.mcpServers))) {
      diagnose(scope, "unsupported-shape"); return;
    }
    ingest(Object.entries(result.value.mcpServers ?? {}), { scope, path: file });
  };
  load("user", path.join(agentDir, "mcp.json"));
  let trusted = false;
  try { trusted = ctx.isProjectTrusted?.() === true; } catch { /* Fail closed. */ }
  if (trusted) load("project", path.join(ctx.cwd, ".pi", "mcp.json"));
  const result = {
    inventoryOnly: true,
    establishes: "configuration metadata only; not upstream validity, connectivity, or callable capabilities",
    projectConfiguration: trusted ? "included" : "skipped-untrusted",
    servers: [...servers.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    diagnostics,
  };
  while (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES && result.servers.length) {
    result.servers.pop();
    diagnose("inventory", "output-limit");
  }
  return result;
}
