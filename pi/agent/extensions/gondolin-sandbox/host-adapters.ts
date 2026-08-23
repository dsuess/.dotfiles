import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GONDOLIN_BUILTIN_NAMES } from "./tools.ts";

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

interface AdapterSpec {
  name: string;
  source: string;
  scope: "user";
  origin: "package" | "top-level";
  sourcePath: string;
  baseDir: string;
  schemaSha256: string;
  packageJson?: string;
  packageVersion?: string;
  hostEffects: readonly string[];
}

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
export const GONDOLIN_EXTENSION_PATH = path.join(EXTENSION_DIR, "index.ts");

const BUILTIN_SCHEMA_HASHES: Readonly<Record<string, string>> = Object.freeze({
  read: "134f19bcabe3e29d63c5cebb38f1d2556759fd08adad6bc90a4b4d3cd1fb8441",
  bash: "456434a5b776beeebb2940d78b1c7b6663add6c6f2d47450c7ad4616ecf7ff3a",
  edit: "55866598f02c5e00ddfcbcae3df78081e3712de09a622bac7a6bc02ef2acc1bc",
  write: "e98a2484f667cf7c22d76ca103bf2022bf9113dc63fe38b899e71c328cb1e833",
  grep: "d281ef46cdcb72d6ec342b248a8b622f99638d193fe93fbc77a532002b7ee4f7",
  find: "fd95c0d507c9b0e6db36704bbe038363f24d43d72d5c5f217dd5c44f94459632",
  ls: "ad4ee18683e9c3d6bfa7969709a0683bc9f896099ed6a74db0b6c49444718a0c",
});

const ADAPTER_SCHEMAS: Readonly<Record<string, string>> = Object.freeze({
  plan_progress: "f8a173633682df6961211b10f7e49d8d88170cdda31f277066b4d3346087b25d",
  complete_plan: "3fdcf886c0c54154083a34b95c6fc8ad4ae6b026796ed5ce78a079f3105c0471",
  complete_stage: "0c07cc92d9c81f5a986561f8d636dce9a443c977e2556250c95508c05a703790",
  submit_plan: "6831cf97d50e813d677713dc06f0b930f4c60d75b9988e7d88af3f5822dacc6f",
  subagent: "0fa20121938abdcac98352bc39bdd4bba7c0cbcdcc7af4b0cca21cbfe487794e",
  ketch_search: "324c231308e94346cecc2fadbb5c67848f65ecff709be43106356df787a7a211",
  ketch_scrape: "96681b1aa6231982402dc61738fa88b67dbd642a08e2e75a3b92f244e49fd343",
  ketch_code: "476d2322712ef8280526dde7f3b728a1340edc5e69a7ad2a57f1ac8cd3016604",
  ketch_docs: "292538936e3918391b3c23a254d2b9ad6dac69621c95a555098697787e7a8bea",
  ketch_crawl: "de9e90f95fd269f03e9fdd125266847b96b7d4a8aecc34569a02ac860a18dbd1",
  ask_user_question: "73e4ecfc199f44fc6f3f30187188e270fdfb52677c9f8630584cd7028fb63813",
});

export const HOST_ADAPTER_NAMES = Object.freeze(Object.keys(ADAPTER_SCHEMAS));

interface AuditCache {
  canonicalPaths: Map<string, string | null>;
  packageVersions: Map<string, string | null>;
}

function createAuditCache(): AuditCache {
  return { canonicalPaths: new Map(), packageVersions: new Map() };
}

function canonical(candidate: string, cache?: AuditCache): string | null {
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

export function schemaSha256(parameters: unknown): string {
  return createHash("sha256").update(JSON.stringify(parameters)).digest("hex");
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
      schemaSha256: ADAPTER_SCHEMAS[name],
      packageJson: path.join(planDir, "package.json"),
      packageVersion: "0.1.0",
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
    schemaSha256: ADAPTER_SCHEMAS.subagent,
    hostEffects: Object.freeze(["spawn one local child Pi process", "bounded temporary prompt/output files"]),
  });
  for (const name of ["ketch_search", "ketch_scrape", "ketch_code", "ketch_docs", "ketch_crawl"]) {
    specs.push({
      name,
      source: "npm:pi-ketch@0.1.6",
      scope: "user",
      origin: "package",
      sourcePath: path.join(ketchDir, "src", "index.ts"),
      baseDir: ketchDir,
      schemaSha256: ADAPTER_SCHEMAS[name],
      packageJson: path.join(ketchDir, "package.json"),
      packageVersion: "0.1.6",
      hostEffects: Object.freeze(["bounded public network research through the pinned Ketch executable"]),
    });
  }
  specs.push({
    name: "ask_user_question",
    source: "packages/ask-user-question",
    scope: "user",
    origin: "package",
    sourcePath: path.join(askDir, "index.ts"),
    baseDir: askDir,
    schemaSha256: ADAPTER_SCHEMAS.ask_user_question,
    packageJson: path.join(askDir, "package.json"),
    packageVersion: "2.4.0-local.0",
    hostEffects: Object.freeze(["structured user interaction", "optional persisted discussion child Pi process"]),
  });

  return new Map(specs.map((spec) => [spec.name, Object.freeze(spec)]));
}

function packageVersionMatches(spec: AdapterSpec, cache?: AuditCache): boolean {
  if (!spec.packageJson) return true;
  let version = cache?.packageVersions.get(spec.packageJson);
  if (version === undefined) {
    try {
      version = JSON.parse(fs.readFileSync(spec.packageJson, "utf8")).version;
    } catch {
      version = null;
    }
    cache?.packageVersions.set(spec.packageJson, version);
  }
  return version === spec.packageVersion;
}

function sourceMatches(sourceInfo: ToolSourceInfo, expected: AdapterSpec, cache?: AuditCache): boolean {
  return (
    sourceInfo.source === expected.source &&
    sourceInfo.scope === expected.scope &&
    sourceInfo.origin === expected.origin &&
    canonical(sourceInfo.path, cache) === canonical(expected.sourcePath, cache) &&
    canonical(sourceInfo.baseDir ?? "", cache) === canonical(expected.baseDir, cache)
  );
}

export function isAuditedHostAdapter(
  tool: ConfiguredToolInfo,
  manifest: ReadonlyMap<string, AdapterSpec> = createHostAdapterManifest(),
  cache?: AuditCache,
): boolean {
  const spec = manifest.get(tool.name);
  return Boolean(
    spec &&
      sourceMatches(tool.sourceInfo, spec, cache) &&
      packageVersionMatches(spec, cache) &&
      schemaSha256(tool.parameters) === spec.schemaSha256,
  );
}

export function isGondolinReplacement(
  tool: ConfiguredToolInfo,
  options: { extensionPath?: string; agentDir?: string } = {},
  cache?: AuditCache,
): boolean {
  if (!GONDOLIN_BUILTIN_NAMES.includes(tool.name as (typeof GONDOLIN_BUILTIN_NAMES)[number])) {
    return false;
  }
  const expectedPath = options.extensionPath ?? GONDOLIN_EXTENSION_PATH;
  const expectedAgentDir = path.resolve(options.agentDir ?? agentDirectory());
  return (
    tool.sourceInfo.source === "auto" &&
    tool.sourceInfo.scope === "user" &&
    tool.sourceInfo.origin === "top-level" &&
    canonical(tool.sourceInfo.path, cache) === canonical(expectedPath, cache) &&
    canonical(tool.sourceInfo.baseDir ?? "", cache) === canonical(expectedAgentDir, cache) &&
    schemaSha256(tool.parameters) === BUILTIN_SCHEMA_HASHES[tool.name]
  );
}

export interface InventoryAudit {
  allowedNames: Set<string>;
  unaudited: ConfiguredToolInfo[];
  replacementErrors: string[];
}

export function auditToolInventory(
  tools: ConfiguredToolInfo[],
  options: {
    manifest?: ReadonlyMap<string, AdapterSpec>;
    extensionPath?: string;
    agentDir?: string;
  } = {},
): InventoryAudit {
  const manifest = options.manifest ?? createHostAdapterManifest({ agentDir: options.agentDir });
  const cache = createAuditCache();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const allowedNames = new Set<string>();
  const replacementErrors: string[] = [];

  for (const name of GONDOLIN_BUILTIN_NAMES) {
    const tool = byName.get(name);
    if (!tool || !isGondolinReplacement(tool, options, cache)) {
      replacementErrors.push(`built-in slot '${name}' is not owned by the Gondolin routing extension`);
    } else {
      allowedNames.add(name);
    }
  }
  for (const tool of tools) {
    if (isAuditedHostAdapter(tool, manifest, cache)) allowedNames.add(tool.name);
  }
  return {
    allowedNames,
    unaudited: tools.filter((tool) => !allowedNames.has(tool.name)),
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
  ADAPTER_SCHEMAS,
  BUILTIN_SCHEMA_HASHES,
  canonical,
  packageVersionMatches,
  sourceMatches,
});
