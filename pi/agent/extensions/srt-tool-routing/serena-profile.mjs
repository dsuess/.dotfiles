import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const SERENA_INSPECTION_TOOLS = Object.freeze([
  "search_for_pattern", "get_symbols_overview", "find_symbol", "find_referencing_symbols",
]);
export const SERENA_EDIT_TOOLS = Object.freeze([
  "replace_symbol_body", "insert_after_symbol", "insert_before_symbol", "rename_symbol", "safe_delete_symbol",
]);
export const SERENA_TOOLS = Object.freeze([...SERENA_INSPECTION_TOOLS, ...SERENA_EDIT_TOOLS]);
export const SERENA_PROFILE = Object.freeze({
  workspace: "/Users/dsuess/src/visonic/dev",
  server: "serena",
  command: ".dev/run-serena-mcp.sh",
  args: Object.freeze(["pi"]),
  env: Object.freeze({ SERENA_USAGE_REPORTING: "false" }),
  fingerprints: Object.freeze({
    ".pi/mcp.json": "7c4fba4e3f40df741843514528fbe5f48d5d166b8aa3c948521643ca4811b591",
    ".dev/run-serena-mcp.sh": "2fcb66ea089bec479f5301dfc7204668e10fad74445446328565c6ad95dd118f",
    ".dev/install-serena.sh": "ab626a1bd7a197a4d25c269083fd75f29cbf63d74c230900849a4ca87f55779f",
    ".pi/serena-context.yml": "25b7b4df2a0ca60a35009cc3d895c9bcc66291d99dac0ac3c43c2754f25c089d",
  }),
});
const denied = (message) => new Error(`Routed Serena admission denied: ${message}`);

/** Never loads user configuration, executes env expansions, or accepts registrations. */
export function readReviewedSerena({ cwd, projectTrusted }, profile = SERENA_PROFILE) {
  if (!projectTrusted) throw denied("current project is not trusted");
  if (fs.realpathSync(cwd) !== profile.workspace || fs.realpathSync(profile.workspace) !== profile.workspace) throw denied("workspace is not the reviewed canonical worktree");
  let configBytes;
  for (const [relative, expected] of Object.entries(profile.fingerprints)) {
    const pathname = path.join(profile.workspace, relative);
    if (fs.realpathSync(pathname) !== pathname) throw denied(`reviewed file identity changed: ${relative}`);
    const descriptor = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let bytes;
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > 64 * 1024) throw denied(`invalid reviewed file: ${relative}`);
      bytes = fs.readFileSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    if (createHash("sha256").update(bytes).digest("hex") !== expected) throw denied(`reviewed content changed: ${relative}; review and update the profile`);
    if (relative === ".pi/mcp.json") configBytes = bytes;
  }
  const document = JSON.parse(configBytes.toString("utf8"));
  if (!isDeepStrictEqual(Object.keys(document).sort(), ["mcpServers"]) || !isDeepStrictEqual(Object.keys(document.mcpServers), [profile.server])) throw denied("unexpected configuration or servers");
  const config = document.mcpServers[profile.server];
  validateReviewedEntry({ name: profile.server, scope: "project", source: path.join(profile.workspace, ".pi/mcp.json"), config }, profile.workspace, profile);
  // Only exact, explicitly direct offerings may be registered. Discovery and
  // resources get no admission even though the project default is deferred.
  const toolExposure = Object.fromEntries(SERENA_TOOLS.filter((name) => config.toolExposure?.[name] === "direct").map((name) => [name, "direct"]));
  return { name: profile.server, scope: "project", source: path.join(profile.workspace, ".pi/mcp.json"), config: { ...config, exposure: "hidden", toolExposure } };
}

export function validateReviewedEntry(entry, cwd, profile = SERENA_PROFILE) {
  if (entry.name !== profile.server || entry.scope !== "project" || entry.source !== path.join(profile.workspace, ".pi/mcp.json") || fs.realpathSync(cwd) !== profile.workspace) throw denied("server configuration provenance does not match");
  const config = entry.config;
  const allowedKeys = new Set(["command", "args", "env", "cwd", "type", "exposure", "toolExposure", "enabled"]);
  if (!config || Object.keys(config).some((key) => !allowedKeys.has(key)) || (config.type !== undefined && config.type !== "stdio") || config.command !== profile.command || !isDeepStrictEqual(config.args, profile.args) || !isDeepStrictEqual(config.env, profile.env) || (config.cwd !== undefined && config.cwd !== profile.workspace)) throw denied("stdio launch identity does not match");
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") throw denied("invalid enabled state");
  if (config.exposure !== "deferred" && config.exposure !== "hidden") throw denied("unexpected server exposure");
  if (!config.toolExposure || Object.entries(config.toolExposure).some(([name, exposure]) => !SERENA_TOOLS.includes(name) || !["direct", "hidden"].includes(exposure))) throw denied("unexpected tool exposure");
  return { argv: [path.join(profile.workspace, profile.command), ...profile.args], cwd: profile.workspace, env: { ...profile.env } };
}
