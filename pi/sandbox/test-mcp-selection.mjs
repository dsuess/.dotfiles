import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { piPackageRoot } from "../test-helpers.mjs";

const installed = path.join(piPackageRoot, "dist");
const { DefaultPackageManager } = await import(path.join(installed, "core/package-manager.js"));

test("deployed selection excludes host MCP; explicit bypass selects upstream", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mcp-selection-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settings = JSON.parse(fs.readFileSync(new URL("../agent/settings.json", import.meta.url)));
  const manager = new DefaultPackageManager({ cwd: root, agentDir: root, builtinExtensions: ["mcp"],
    settingsManager: { isProjectTrusted: () => true, getGlobalSettings: () => ({ extensions: settings.extensions }), getProjectSettings: () => ({}) } });
  const resolved = await manager.resolve();
  assert.equal(resolved.extensions.find((entry) => entry.path === "builtin:mcp").enabled, false);
  const bypass = await manager.resolveExtensionSources(["builtin:mcp"], { temporary: true });
  assert.equal(bypass.extensions.find((entry) => entry.path === "builtin:mcp").enabled, true);
});
