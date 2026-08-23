import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CACHE_TTL_MS,
  parseCatalog,
  resolveModelScope,
  validateCacheRecord,
} from "./model-scope-cache.mjs";

const NOW = Date.UTC(2026, 7, 23, 12);
const HEADER = "provider model context max-out thinking images\n";
const BASE_ROWS = [
  "other unrelated 1K 1K no no",
  "zai glm-5.3 1M 128K yes no",
  "openai-codex gpt-5.6-sol 272K 128K yes yes",
  "zai glm-5.2 1M 128K yes no",
  "openai-codex gpt-5.6-luna 272K 128K yes yes",
  "openai-codex gpt-5.6-terra 272K 128K yes yes",
];
const PREFERRED = [
  "openai-codex/gpt-5.6-luna",
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.6-sol",
  "zai/glm-5.2",
  "zai/glm-5.3",
  "anthropic/claude-fable-5",
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-haiku-4-5",
];
const CURRENT_SCOPE = PREFERRED.slice(0, 5);
const CLAUDE_ROWS = [
  "anthropic claude-fable-5 200K 64K yes yes",
  "anthropic claude-opus-5 200K 64K yes yes",
  "anthropic claude-sonnet-5 200K 64K yes yes",
  "anthropic claude-haiku-4-5 200K 64K yes yes",
];

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-model-scope-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    root,
    piPath: path.join(root, "pi"),
    settingsPath: path.join(root, "settings.json"),
    authPath: path.join(root, "auth.json"),
    modelsPath: path.join(root, "models.json"),
    cachePath: path.join(root, "cache", "model-scope.json"),
  };
  await fs.writeFile(files.piPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await fs.writeFile(files.settingsPath, JSON.stringify({ enabledModels: PREFERRED }));
  await fs.writeFile(files.authPath, JSON.stringify({
    zai: { type: "api_key", key: "zai-secret" },
    "openai-codex": { type: "oauth", access: "oauth-secret", refresh: "refresh-secret" },
  }));
  await fs.writeFile(files.modelsPath, JSON.stringify({ providers: { zai: { models: [] } } }));
  return files;
}

const catalog = (rows = BASE_ROWS) => parseCatalog(HEADER + rows.join("\n") + "\n");
const resolve = (files, options = {}) => resolveModelScope({
  ...files,
  now: options.now ?? NOW,
  refreshCatalog: options.refreshCatalog ?? (async () => catalog()),
});

test("refresh caches a bounded catalog and retains preferred settings order", async (t) => {
  const files = await fixture(t);
  const result = await resolve(files);
  assert.deepEqual(result.models, CURRENT_SCOPE);
  assert.equal(result.source, "refresh");

  const text = await fs.readFile(files.cachePath, "utf8");
  assert.doesNotMatch(text, /zai-secret|oauth-secret|refresh-secret/);
  const record = validateCacheRecord(JSON.parse(text), NOW);
  assert.ok(record);
  assert.deepEqual(record.source.credentials, [
    { provider: "openai-codex", type: "oauth" },
    { provider: "zai", type: "api_key" },
  ]);
  assert.ok(record.catalog.includes("other/unrelated"));
  assert.equal((await fs.stat(path.dirname(files.cachePath))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(files.cachePath)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(path.dirname(files.cachePath))).sort(), ["model-scope.json"]);
});

test("a warm cache skips refresh and expiry refreshes once", async (t) => {
  const files = await fixture(t);
  let refreshes = 0;
  const refreshCatalog = async () => { refreshes += 1; return catalog(); };
  await resolve(files, { refreshCatalog });
  const warm = await resolve(files, { now: NOW + CACHE_TTL_MS - 1, refreshCatalog });
  assert.equal(warm.source, "cache");
  assert.equal(refreshes, 1);
  const expired = await resolve(files, { now: NOW + CACHE_TTL_MS, refreshCatalog });
  assert.equal(expired.source, "refresh");
  assert.equal(refreshes, 2);
});

test("provider identity changes invalidate a fresh cache without storing values", async (t) => {
  const files = await fixture(t);
  await resolve(files);
  await fs.writeFile(files.authPath, JSON.stringify({
    zai: { type: "api_key", key: "changed-but-ignored" },
    "openai-codex": { type: "oauth", access: "changed-but-ignored" },
    anthropic: { type: "api_key", key: "anthropic-secret" },
  }));
  let refreshes = 0;
  const result = await resolve(files, {
    now: NOW + 1,
    refreshCatalog: async () => { refreshes += 1; return catalog([...BASE_ROWS, ...CLAUDE_ROWS]); },
  });
  assert.equal(refreshes, 1);
  assert.deepEqual(result.models, PREFERRED);
  assert.doesNotMatch(await fs.readFile(files.cachePath, "utf8"), /anthropic-secret|changed-but-ignored/);
});

test("credential value refresh does not invalidate provider/type identity", async (t) => {
  const files = await fixture(t);
  await resolve(files);
  await fs.writeFile(files.authPath, JSON.stringify({
    zai: { type: "api_key", key: "new-value" },
    "openai-codex": { type: "oauth", access: "new-access", refresh: "new-refresh" },
  }));
  const result = await resolve(files, {
    now: NOW + 1,
    refreshCatalog: async () => { throw new Error("must not refresh"); },
  });
  assert.equal(result.source, "cache");
});

test("Pi and models configuration revisions each invalidate the cache", async (t) => {
  const files = await fixture(t);
  await resolve(files);
  let refreshes = 0;
  const refreshCatalog = async () => { refreshes += 1; return catalog(); };
  await fs.appendFile(files.piPath, "# revision\n");
  assert.equal((await resolve(files, { now: NOW + 1, refreshCatalog })).source, "refresh");
  await fs.writeFile(files.modelsPath, JSON.stringify({ providers: { zai: { models: [{ id: "new" }] } } }));
  assert.equal((await resolve(files, { now: NOW + 2, refreshCatalog })).source, "refresh");
  assert.equal(refreshes, 2);
});

test("malformed and future-dated records are rejected", async (t) => {
  const files = await fixture(t);
  await fs.mkdir(path.dirname(files.cachePath), { recursive: true });
  await fs.writeFile(files.cachePath, "not json\n");
  let refreshes = 0;
  assert.equal((await resolve(files, { refreshCatalog: async () => { refreshes += 1; return catalog(); } })).source, "refresh");
  const record = JSON.parse(await fs.readFile(files.cachePath, "utf8"));
  record.refreshedAt = NOW + 1;
  await fs.writeFile(files.cachePath, JSON.stringify(record));
  assert.equal((await resolve(files, { refreshCatalog: async () => { refreshes += 1; return catalog(); } })).source, "refresh");
  assert.equal(refreshes, 2);
});

test("malformed catalog output is rejected", () => {
  assert.throws(() => parseCatalog("Provider Model\na b\n"), /header/);
  assert.throws(() => parseCatalog(HEADER + "openai only-two\n"), /malformed row/);
  assert.throws(() => parseCatalog(HEADER + BASE_ROWS[0] + "\n" + BASE_ROWS[0] + "\n"), /duplicate/);
});

test("same-source stale cache survives transient refresh failure", async (t) => {
  const files = await fixture(t);
  await resolve(files);
  const result = await resolve(files, {
    now: NOW + CACHE_TTL_MS,
    refreshCatalog: async () => { throw new Error("temporary failure"); },
  });
  assert.equal(result.source, "stale");
  assert.deepEqual(result.models, CURRENT_SCOPE);
  assert.match(result.warning, /same-source stale catalog/);
});

test("no trustworthy cache falls back after refresh failure", async (t) => {
  const files = await fixture(t);
  await resolve(files);
  await fs.writeFile(files.authPath, JSON.stringify({ anthropic: { type: "api_key", key: "new" } }));
  const result = await resolve(files, {
    now: NOW + 1,
    refreshCatalog: async () => { throw new Error("offline"); },
  });
  assert.equal(result.source, "fallback");
  assert.deepEqual(result.models, []);
  assert.match(result.warning, /native model resolution/);
});

test("concurrent misses publish one complete atomic record", async (t) => {
  const files = await fixture(t);
  let refreshes = 0;
  const refreshCatalog = async () => {
    refreshes += 1;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    return catalog();
  };
  const [first, second] = await Promise.all([
    resolve(files, { refreshCatalog }),
    resolve(files, { refreshCatalog }),
  ]);
  assert.equal(refreshes, 1);
  assert.deepEqual(first.models, CURRENT_SCOPE);
  assert.deepEqual(second.models, CURRENT_SCOPE);
  assert.ok(validateCacheRecord(JSON.parse(await fs.readFile(files.cachePath, "utf8")), NOW));
  assert.deepEqual((await fs.readdir(path.dirname(files.cachePath))).sort(), ["model-scope.json"]);
});
