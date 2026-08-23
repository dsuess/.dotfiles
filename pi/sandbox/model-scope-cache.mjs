#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 64 * 1024 * 1024;
const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_CATALOG_LINES = 10_000;
const REFRESH_TIMEOUT_MS = 15_000;
const LOCK_WAIT_MS = REFRESH_TIMEOUT_MS + 5_000;
const STALE_LOCK_MS = 60_000;
const THINKING_SUFFIX = /:(?:off|minimal|low|medium|high|xhigh|max)$/;
const SAFE_TOKEN = /^[^\s\0-\x1f\x7f,]+$/;
const CATALOG_HEADER = ["provider", "model", "context", "max-out", "thinking", "images"];
const METADATA_ARGS = [
  "--models", "*",
  "--list-models",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--no-session",
  "--no-tools",
  "--no-approve",
  "--offline",
];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function validToken(value, maximum = 512) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && SAFE_TOKEN.test(value);
}

function modelKey(pattern) {
  return pattern.replace(THINKING_SUFFIX, "");
}

function validQualifiedModel(value) {
  const slash = typeof value === "string" ? value.indexOf("/") : -1;
  return validToken(value, 512) && slash > 0 && slash < value.length - 1;
}

function validModelPattern(value) {
  return validQualifiedModel(typeof value === "string" ? modelKey(value) : value) && validToken(value, 512);
}

async function readBounded(file, maximum, { optional = false } = {}) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > maximum) throw new Error(`${path.basename(file)} is not a bounded regular file`);
    return await fs.readFile(file);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readJson(file, { optional = false } = {}) {
  const content = await readBounded(file, MAX_CONFIG_BYTES, { optional });
  if (content === null) return null;
  try {
    return JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error(`${path.basename(file)} is not valid JSON`);
  }
}

export async function readPreferredModels(settingsPath) {
  const settings = await readJson(settingsPath);
  if (!isPlainObject(settings) || !Array.isArray(settings.enabledModels) ||
      settings.enabledModels.length > 1_000 || !settings.enabledModels.every(validModelPattern)) {
    throw new Error("settings.json enabledModels must contain bounded provider/model patterns");
  }
  if (new Set(settings.enabledModels).size !== settings.enabledModels.length) {
    throw new Error("settings.json enabledModels must not contain duplicates");
  }
  return [...settings.enabledModels];
}

export async function readCredentialProviders(authPath) {
  const auth = await readJson(authPath, { optional: true });
  if (auth === null) return [];
  if (!isPlainObject(auth) || Object.keys(auth).length > 256) throw new Error("auth.json has an invalid provider map");
  const credentials = Object.entries(auth).map(([provider, credential]) => {
    if (!validToken(provider, 256) || !isPlainObject(credential) || !validToken(credential.type, 64)) {
      throw new Error("auth.json has an invalid credential provider/type entry");
    }
    return { provider, type: credential.type };
  });
  credentials.sort((left, right) => {
    const leftKey = `${left.provider}\0${left.type}`;
    const rightKey = `${right.provider}\0${right.type}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return credentials;
}

async function revisionForFile(file, maximum, { optional = false, includePath = false } = {}) {
  const content = await readBounded(file, maximum, { optional });
  if (content === null) return null;
  const hash = createHash("sha256");
  if (includePath) hash.update(path.resolve(file)).update("\0");
  hash.update(content);
  return hash.digest("hex");
}

function fingerprintSource(source) {
  return createHash("sha256").update(JSON.stringify({
    piRevision: source.piRevision,
    modelsRevision: source.modelsRevision,
    credentials: source.credentials,
  })).digest("hex");
}

export async function buildSourceFingerprint({ piPath, modelsPath, authPath }) {
  const source = {
    piRevision: await revisionForFile(piPath, MAX_EXECUTABLE_BYTES, { includePath: true }),
    modelsRevision: await revisionForFile(modelsPath, MAX_CONFIG_BYTES, { optional: true }),
    credentials: await readCredentialProviders(authPath),
  };
  return { ...source, fingerprint: fingerprintSource(source) };
}

export function parseCatalog(output) {
  if (typeof output !== "string" || Buffer.byteLength(output) > MAX_CATALOG_BYTES || output.includes("\0")) {
    throw new Error("Pi model catalog output exceeds its bound or contains NUL");
  }
  const lines = output.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length < 1 || lines.length > MAX_CATALOG_LINES) throw new Error("Pi model catalog has an invalid line count");
  const header = lines[0].trim().split(/\s+/);
  if (JSON.stringify(header) !== JSON.stringify(CATALOG_HEADER)) throw new Error("Pi model catalog header is invalid");

  const catalog = [];
  const seen = new Set();
  for (const line of lines.slice(1)) {
    if (!line.trim()) throw new Error("Pi model catalog contains an empty row");
    const columns = line.trim().split(/\s+/);
    if (columns.length !== CATALOG_HEADER.length || !columns.every((column) => validToken(column))) {
      throw new Error("Pi model catalog contains a malformed row");
    }
    const key = `${columns[0]}/${columns[1]}`;
    if (seen.has(key)) throw new Error("Pi model catalog contains a duplicate provider/model");
    seen.add(key);
    catalog.push(key);
  }
  return catalog;
}

export function intersectPreferred(preferred, catalog) {
  const available = new Set(catalog);
  return preferred.filter((pattern) => available.has(modelKey(pattern)));
}

function validateSource(value) {
  if (!hasExactKeys(value, ["piRevision", "modelsRevision", "credentials", "fingerprint"]) ||
      !/^[0-9a-f]{64}$/.test(value.piRevision) ||
      !(value.modelsRevision === null || /^[0-9a-f]{64}$/.test(value.modelsRevision)) ||
      !Array.isArray(value.credentials) || value.credentials.length > 256 ||
      !/^[0-9a-f]{64}$/.test(value.fingerprint)) return false;
  let previous = "";
  for (const entry of value.credentials) {
    if (!hasExactKeys(entry, ["provider", "type"]) || !validToken(entry.provider, 256) || !validToken(entry.type, 64)) return false;
    const current = `${entry.provider}\0${entry.type}`;
    if (current <= previous) return false;
    previous = current;
  }
  return value.fingerprint === fingerprintSource(value);
}

export function validateCacheRecord(value, now = Date.now()) {
  if (!hasExactKeys(value, ["schemaVersion", "refreshedAt", "source", "catalog"]) ||
      value.schemaVersion !== SCHEMA_VERSION || !Number.isSafeInteger(value.refreshedAt) ||
      value.refreshedAt < 0 || value.refreshedAt > now || !validateSource(value.source) ||
      !Array.isArray(value.catalog) || value.catalog.length > MAX_CATALOG_LINES) return null;
  const seen = new Set();
  for (const model of value.catalog) {
    if (!validQualifiedModel(model) || seen.has(model)) return null;
    seen.add(model);
  }
  return value;
}

async function readCache(cachePath, now) {
  try {
    const value = await readJson(cachePath, { optional: true });
    return value === null ? null : validateCacheRecord(value, now);
  } catch {
    return null;
  }
}

function cacheMatches(record, source) {
  return record?.source.fingerprint === source.fingerprint;
}

function cacheIsFresh(record, source, now, ttlMs) {
  return cacheMatches(record, source) && now - record.refreshedAt < ttlMs;
}

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

async function writeCacheAtomic(cachePath, record) {
  const directory = path.dirname(cachePath);
  await ensurePrivateDirectory(directory);
  const temporary = path.join(directory, `.${path.basename(cachePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, cachePath);
    await fs.chmod(cachePath, 0o600);
    const directoryHandle = await fs.open(directory, "r");
    await directoryHandle.sync();
    await directoryHandle.close();
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireRefreshLock(lockPath, cachePath, source, now, ttlMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < LOCK_WAIT_MS) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      return { acquired: true };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const cache = await readCache(cachePath, now);
    if (cacheIsFresh(cache, source, now, ttlMs)) return { acquired: false, cache };
    try {
      const stat = await fs.stat(lockPath);
      if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        await fs.rm(lockPath, { recursive: true, force: true });
        continue;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await sleep(50);
  }
  throw new Error("timed out waiting for another model catalog refresh");
}

async function traceMetadataLaunch(env) {
  const tracePath = env.PI_GONDOLIN_STARTUP_TRACE_FILE;
  if (typeof tracePath !== "string" || !tracePath.startsWith("/") || /[\t\r\n]/.test(tracePath)) return;
  await fs.appendFile(tracePath, "metadata_pi_launch\n").catch(() => {});
}

export async function runCatalogProcess(piPath, { timeoutMs = REFRESH_TIMEOUT_MS, env = process.env } = {}) {
  await traceMetadataLaunch(env);
  return new Promise((resolve, reject) => {
    const child = spawn(piPath, METADATA_ARGS, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const append = (current, chunk) => {
      const next = Buffer.concat([current, chunk]);
      if (next.length > MAX_CATALOG_BYTES) {
        child.kill("SIGKILL");
        throw new Error("Pi model catalog process exceeded its output bound");
      }
      return next;
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };
    child.stdout.on("data", (chunk) => {
      try { stdout = append(stdout, chunk); } catch (error) { fail(error); }
    });
    child.stderr.on("data", (chunk) => {
      try { stderr = append(stderr, chunk); } catch (error) { fail(error); }
    });
    child.once("error", fail);
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.toString("utf8").trim().slice(0, 300);
        reject(new Error(`Pi model catalog process exited ${code ?? signal}${detail ? `: ${detail}` : ""}`));
        return;
      }
      try { resolve(parseCatalog(stdout.toString("utf8"))); } catch (error) { reject(error); }
    });
  });
}

export async function resolveModelScope({
  piPath,
  settingsPath,
  authPath,
  modelsPath,
  cachePath,
  now = Date.now(),
  ttlMs = CACHE_TTL_MS,
  refreshCatalog = () => runCatalogProcess(piPath),
}) {
  let preferred;
  let source;
  try {
    [preferred, source] = await Promise.all([
      readPreferredModels(settingsPath),
      buildSourceFingerprint({ piPath, modelsPath, authPath }),
    ]);
  } catch (error) {
    return { models: [], source: "fallback", warning: `model scope configuration is unavailable: ${error.message}` };
  }

  let cache = await readCache(cachePath, now);
  if (cacheIsFresh(cache, source, now, ttlMs)) {
    return { models: intersectPreferred(preferred, cache.catalog), source: "cache" };
  }

  const stale = cacheMatches(cache, source) ? cache : null;
  const lockPath = `${cachePath}.lock`;
  let lock;
  try {
    await ensurePrivateDirectory(path.dirname(cachePath));
    lock = await acquireRefreshLock(lockPath, cachePath, source, now, ttlMs);
    if (!lock.acquired) return { models: intersectPreferred(preferred, lock.cache.catalog), source: "cache" };

    cache = await readCache(cachePath, now);
    if (cacheIsFresh(cache, source, now, ttlMs)) {
      return { models: intersectPreferred(preferred, cache.catalog), source: "cache" };
    }

    const catalog = await refreshCatalog();
    const sourceAfterRefresh = await buildSourceFingerprint({ piPath, modelsPath, authPath });
    if (sourceAfterRefresh.fingerprint !== source.fingerprint) {
      throw new Error("model scope inputs changed during catalog refresh");
    }
    const record = { schemaVersion: SCHEMA_VERSION, refreshedAt: now, source, catalog };
    let warning;
    try {
      await writeCacheAtomic(cachePath, record);
    } catch (error) {
      warning = `model scope cache could not be saved: ${error.message}`;
    }
    return { models: intersectPreferred(preferred, catalog), source: "refresh", warning };
  } catch (error) {
    if (stale) {
      return {
        models: intersectPreferred(preferred, stale.catalog),
        source: "stale",
        warning: `model scope refresh failed; using the same-source stale catalog: ${error.message}`,
      };
    }
    return {
      models: [],
      source: "fallback",
      warning: `model scope refresh failed; continuing with Pi's native model resolution: ${error.message}`,
    };
  } finally {
    if (lock?.acquired) await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--pi", "--settings", "--auth", "--models", "--cache"].includes(argument) || index + 1 >= argv.length) {
      throw new Error("usage: model-scope-cache.mjs --pi <path> --settings <path> --auth <path> --models <path> --cache <path>");
    }
    options[argument.slice(2)] = argv[++index];
  }
  if (!["pi", "settings", "auth", "models", "cache"].every((key) => typeof options[key] === "string")) {
    throw new Error("all model scope cache paths are required");
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await resolveModelScope({
    piPath: options.pi,
    settingsPath: options.settings,
    authPath: options.auth,
    modelsPath: options.models,
    cachePath: options.cache,
  });
  if (result.warning) process.stderr.write(`pi: warning: ${result.warning}\n`);
  if (result.models.length > 0) process.stdout.write(`${result.models.join(",")}\n`);
}

async function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return await fs.realpath(process.argv[1]) === await fs.realpath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (await isMainModule()) {
  main().catch((error) => {
    process.stderr.write(`pi: warning: model scope cache failed; continuing with Pi's native model resolution: ${error.message}\n`);
  });
}
