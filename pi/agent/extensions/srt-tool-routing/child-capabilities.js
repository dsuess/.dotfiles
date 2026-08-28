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
  "submit_plan",
  "plan_progress",
  "complete_plan",
  "complete_stage",
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

export function childToolCliArgs(_capabilities) {
  // Pi's --tools filter applies to extension replacements as well as native
  // built-ins. A private post-handshake allowlist is therefore the only mode
  // that is both capability-preserving and fail-closed when the extension is
  // missing.
  return ["--no-builtin-tools"];
}
