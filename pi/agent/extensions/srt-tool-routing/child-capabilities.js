export const SRT_ROUTING_CHILD_BUILTINS = Object.freeze([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
]);

export const AUDITED_CHILD_HOST_ADAPTERS = Object.freeze([
  "ketch_search",
  "ketch_scrape",
  "ketch_code",
  "ketch_docs",
  "ketch_crawl",
  "ask_user_question",
  "subagent",
  "mcp_list",
  "session_history",
]);

const BUILTINS = new Set(SRT_ROUTING_CHILD_BUILTINS);
const HOST_ADAPTERS = new Set(AUDITED_CHILD_HOST_ADAPTERS);

export function splitChildCapabilities(activeTools = [], options = {}) {
  const excluded = new Set(options.excluded ?? []);
  const builtins = [];
  const hostAdapters = [];
  const rejected = [];
  for (const name of activeTools) {
    if (typeof name !== "string" || excluded.has(name)) continue;
    if (BUILTINS.has(name)) builtins.push(name);
    else if (HOST_ADAPTERS.has(name)) hostAdapters.push(name);
    else rejected.push(name);
  }
  return Object.freeze({
    builtins: Object.freeze([...new Set(builtins)]),
    hostAdapters: Object.freeze([...new Set(hostAdapters)]),
    rejected: Object.freeze([...new Set(rejected)]),
  });
}

export function isInheritedPlanningMode(guardActive = false, systemPrompt = "") {
  return guardActive === true && /\[PI PLANNING MODE ACTIVE\]/.test(systemPrompt);
}

export function childToolCliArgs(capabilities, env = {}) {
  if (env.PI_SRT_ROUTING === "1" || env.PI_SRT_ROUTING_SANDBOX === "1") {
    // --tools also filters replacements; routing applies private allowlists
    // after the readiness handshake, with native built-ins disabled throughout.
    return ["--no-builtin-tools"];
  }
  const admitted = [...capabilities.builtins, ...capabilities.hostAdapters];
  // MCP offerings can remain callable outside --tools, including resources.
  return [...(admitted.length ? ["--tools", admitted.join(",")] : ["--no-tools"]), "--no-mcp"];
}
