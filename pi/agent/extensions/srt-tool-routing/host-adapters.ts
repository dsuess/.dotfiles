import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SRT_ROUTING_BUILTIN_NAMES } from "./tools.ts";

export interface ToolSourceInfo {
  path: string;
  source: string;
  scope: "user" | "project" | "temporary";
  origin: "package" | "top-level";
  baseDir?: string;
}

export interface ConfiguredToolInfo {
  name: string;
  parameters: unknown;
  sourceInfo: ToolSourceInfo;
}

export interface AdapterSpec {
  name: string;
  hostEffects: readonly string[];
}

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SRT_ROUTING_EXTENSION_PATH = path.join(EXTENSION_DIR, "index.ts");

export const HOST_ADAPTER_NAMES = Object.freeze([
  "plan_progress",
  "complete_plan",
  "complete_stage",
  "show_plan",
  "subagent",
  "ketch_search",
  "ketch_scrape",
  "ketch_code",
  "ketch_docs",
  "ketch_crawl",
  "ask_user_question",
  "mcp_list",
] as const);

interface ProvenanceCache {
  canonicalPaths: Map<string, string | null>;
}

function createProvenanceCache(): ProvenanceCache {
  return { canonicalPaths: new Map() };
}

function canonical(candidate: string, cache?: ProvenanceCache): string | null {
  if (cache?.canonicalPaths.has(candidate)) return cache.canonicalPaths.get(candidate) ?? null;
  let resolved: string | null;
  try {
    resolved = fs.realpathSync(candidate);
  } catch {
    resolved = null;
  }
  cache?.canonicalPaths.set(candidate, resolved);
  return resolved;
}

function canonicalMatches(actual: string, expected: string, cache?: ProvenanceCache): boolean {
  const expectedPath = canonical(expected, cache);
  return expectedPath !== null && canonical(actual, cache) === expectedPath;
}

function agentDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"));
}

export function createHostAdapterManifest(): ReadonlyMap<string, AdapterSpec> {
  const specs: AdapterSpec[] = [];
  specs.push({
    name: "mcp_list",
    hostEffects: Object.freeze([
      "bounded read-only user MCP configuration metadata",
      "bounded read-only project MCP configuration metadata only with current session trust",
      "extension-registered metadata inventory; no server execution or connections",
    ]),
  });

  for (const name of ["show_plan", "plan_progress", "complete_plan", "complete_stage"]) {
    specs.push({
      name,
      hostEffects: Object.freeze(["validated plan/ledger persistence under the current workspace"]),
    });
  }
  specs.push({
    name: "subagent",
    hostEffects: Object.freeze(["spawn one local child Pi process", "bounded temporary prompt/output files"]),
  });
  for (const name of ["ketch_search", "ketch_scrape", "ketch_code", "ketch_docs", "ketch_crawl"]) {
    specs.push({
      name,
      hostEffects: Object.freeze(["bounded public network research through the trusted Ketch executable"]),
    });
  }
  specs.push({
    name: "ask_user_question",
    hostEffects: Object.freeze(["structured user interaction", "optional persisted discussion child Pi process"]),
  });

  return new Map(specs.map((spec) => [spec.name, Object.freeze(spec)]));
}

// Host extensions already run with host permissions. Admit known adapter names
// without duplicating Pi's package loading rules in a provenance manifest.
export function isHostAdapter(
  tool: ConfiguredToolInfo,
  manifest: ReadonlyMap<string, AdapterSpec> = createHostAdapterManifest(),
): boolean {
  return manifest.has(tool.name);
}

export function isSrtToolRoutingReplacement(
  tool: ConfiguredToolInfo,
  options: { extensionPath?: string; agentDir?: string } = {},
  cache?: ProvenanceCache,
): boolean {
  if (!SRT_ROUTING_BUILTIN_NAMES.includes(tool.name as (typeof SRT_ROUTING_BUILTIN_NAMES)[number])) {
    return false;
  }
  return isRoutingExtensionSource(tool.sourceInfo, options, cache);
}

/** Provenance only: routed MCP still requires separate live-session authority. */
export function isRoutingExtensionSource(
  sourceInfo: ToolSourceInfo,
  options: { extensionPath?: string; agentDir?: string } = {},
  cache?: ProvenanceCache,
): boolean {
  const expectedPath = options.extensionPath ?? SRT_ROUTING_EXTENSION_PATH;
  const expectedAgentDir = path.resolve(options.agentDir ?? agentDirectory());
  return (
    sourceInfo.source === "auto" &&
    sourceInfo.scope === "user" &&
    sourceInfo.origin === "top-level" &&
    canonicalMatches(sourceInfo.path, expectedPath, cache) &&
    canonicalMatches(sourceInfo.baseDir ?? "", expectedAgentDir, cache)
  );
}

export interface InventoryVerification {
  allowedNames: Set<string>;
  untrusted: ConfiguredToolInfo[];
  replacementErrors: string[];
}

export function verifyToolInventory(
  tools: ConfiguredToolInfo[],
  options: {
    manifest?: ReadonlyMap<string, AdapterSpec>;
    isRoutedMcp?: (tool: ConfiguredToolInfo) => boolean;
    extensionPath?: string;
    agentDir?: string;
  } = {},
): InventoryVerification {
  const manifest = options.manifest ?? createHostAdapterManifest();
  const cache = createProvenanceCache();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const allowedNames = new Set<string>();
  const replacementErrors: string[] = [];

  for (const name of SRT_ROUTING_BUILTIN_NAMES) {
    const tool = byName.get(name);
    if (!tool) {
      replacementErrors.push(`required SRT replacement for built-in slot '${name}' is missing`);
    } else if (!isSrtToolRoutingReplacement(tool, options, cache)) {
      replacementErrors.push(
        `built-in slot '${name}' is not registered from the trusted SRT tool-routing extension provenance`,
      );
    } else {
      allowedNames.add(name);
    }
  }
  for (const tool of tools) {
    if (isHostAdapter(tool, manifest) || options.isRoutedMcp?.(tool)) allowedNames.add(tool.name);
  }
  return {
    allowedNames,
    untrusted: tools.filter((tool) => !allowedNames.has(tool.name)),
    replacementErrors,
  };
}

export function adapterEffects(
  manifest: ReadonlyMap<string, AdapterSpec> = createHostAdapterManifest(),
): Readonly<Record<string, readonly string[]>> {
  return Object.freeze(
    Object.fromEntries([...manifest].map(([name, spec]) => [name, spec.hostEffects])),
  );
}

export const hostAdapterInternals = Object.freeze({
  canonical,
  canonicalMatches,
});
