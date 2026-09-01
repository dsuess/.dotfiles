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
  source: string;
  scope: "user";
  origin: "package" | "top-level";
  sourcePath: string;
  baseDir: string;
  hostEffects: readonly string[];
}

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SRT_ROUTING_EXTENSION_PATH = path.join(EXTENSION_DIR, "index.ts");

export const HOST_ADAPTER_NAMES = Object.freeze([
  "plan_progress",
  "complete_plan",
  "complete_stage",
  "submit_plan",
  "subagent",
  "ketch_search",
  "ketch_scrape",
  "ketch_code",
  "ketch_docs",
  "ketch_crawl",
  "ask_user_question",
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

export function createHostAdapterManifest(options: { agentDir?: string } = {}): ReadonlyMap<string, AdapterSpec> {
  const agentDir = path.resolve(options.agentDir ?? agentDirectory());
  const planDir = path.join(agentDir, "extensions", "plan-mode");
  const subagentDir = path.join(agentDir, "extensions", "subagent");
  const askDir = path.join(agentDir, "packages", "ask-user-question");
  const ketchDir = path.join(agentDir, "npm", "node_modules", "pi-ketch");
  const specs: AdapterSpec[] = [];

  for (const name of ["submit_plan", "plan_progress", "complete_plan", "complete_stage"]) {
    specs.push({
      name,
      source: "auto",
      scope: "user",
      origin: "top-level",
      sourcePath: path.join(planDir, "index.ts"),
      baseDir: agentDir,
      hostEffects: Object.freeze(["validated plan/ledger persistence under the current workspace"]),
    });
  }
  specs.push({
    name: "subagent",
    source: "auto",
    scope: "user",
    origin: "top-level",
    sourcePath: path.join(subagentDir, "index.ts"),
    baseDir: agentDir,
    hostEffects: Object.freeze(["spawn one local child Pi process", "bounded temporary prompt/output files"]),
  });
  for (const name of ["ketch_search", "ketch_scrape", "ketch_code", "ketch_docs", "ketch_crawl"]) {
    specs.push({
      name,
      source: "npm:pi-ketch",
      scope: "user",
      origin: "package",
      sourcePath: path.join(ketchDir, "src", "index.ts"),
      baseDir: ketchDir,
      hostEffects: Object.freeze(["bounded public network research through the trusted Ketch executable"]),
    });
  }
  specs.push({
    name: "ask_user_question",
    source: "packages/ask-user-question",
    scope: "user",
    origin: "package",
    sourcePath: path.join(askDir, "index.ts"),
    baseDir: askDir,
    hostEffects: Object.freeze(["structured user interaction", "optional persisted discussion child Pi process"]),
  });

  return new Map(specs.map((spec) => [spec.name, Object.freeze(spec)]));
}

function packageSourceIdentity(source: string): string {
  if (!source.startsWith("npm:")) return source;
  const label = source.slice("npm:".length);
  const separator = label.startsWith("@")
    ? label.indexOf("@", label.indexOf("/") + 1)
    : label.indexOf("@");
  return `npm:${separator === -1 ? label : label.slice(0, separator)}`;
}

function sourceLabelMatches(actual: ToolSourceInfo, expected: AdapterSpec): boolean {
  if (expected.origin === "package" && expected.source.startsWith("npm:")) {
    return packageSourceIdentity(actual.source) === packageSourceIdentity(expected.source);
  }
  return actual.source === expected.source;
}

function sourceMatches(sourceInfo: ToolSourceInfo, expected: AdapterSpec, cache?: ProvenanceCache): boolean {
  return (
    sourceLabelMatches(sourceInfo, expected) &&
    sourceInfo.scope === expected.scope &&
    sourceInfo.origin === expected.origin &&
    canonicalMatches(sourceInfo.path, expected.sourcePath, cache) &&
    canonicalMatches(sourceInfo.baseDir ?? "", expected.baseDir, cache)
  );
}

export function isTrustedHostAdapter(
  tool: ConfiguredToolInfo,
  manifest: ReadonlyMap<string, AdapterSpec> = createHostAdapterManifest(),
  cache?: ProvenanceCache,
): boolean {
  const spec = manifest.get(tool.name);
  return Boolean(spec && sourceMatches(tool.sourceInfo, spec, cache));
}

export function isSrtToolRoutingReplacement(
  tool: ConfiguredToolInfo,
  options: { extensionPath?: string; agentDir?: string } = {},
  cache?: ProvenanceCache,
): boolean {
  if (!SRT_ROUTING_BUILTIN_NAMES.includes(tool.name as (typeof SRT_ROUTING_BUILTIN_NAMES)[number])) {
    return false;
  }
  const expectedPath = options.extensionPath ?? SRT_ROUTING_EXTENSION_PATH;
  const expectedAgentDir = path.resolve(options.agentDir ?? agentDirectory());
  return (
    tool.sourceInfo.source === "auto" &&
    tool.sourceInfo.scope === "user" &&
    tool.sourceInfo.origin === "top-level" &&
    canonicalMatches(tool.sourceInfo.path, expectedPath, cache) &&
    canonicalMatches(tool.sourceInfo.baseDir ?? "", expectedAgentDir, cache)
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
    extensionPath?: string;
    agentDir?: string;
  } = {},
): InventoryVerification {
  const manifest = options.manifest ?? createHostAdapterManifest({ agentDir: options.agentDir });
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
    if (isTrustedHostAdapter(tool, manifest, cache)) allowedNames.add(tool.name);
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
  packageSourceIdentity,
  sourceMatches,
});
