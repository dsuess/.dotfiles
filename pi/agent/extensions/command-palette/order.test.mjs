import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { piPackageRoot } from "../../../test-helpers.mjs";

const { DefaultPackageManager } = await import(pathToFileURL(path.join(piPackageRoot, "dist/core/package-manager.js")).href);
const settings = JSON.parse(await fs.readFile(new URL("../../settings.json", import.meta.url), "utf8"));

test("installed resolver loads palette after the configured vim and fzf editor extensions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-palette-order-"));
  try {
    const agentDir = path.join(root, "agent");
    const cfg = { packages: settings.packages.filter((source) => typeof source === "string" &&
      (source.includes("pi-vim@") || source === "extensions/fzf-file-picker" || source === "extensions/command-palette.ts")) };
    const manager = new DefaultPackageManager({ cwd: root, agentDir, settingsManager: {
      getGlobalSettings: () => cfg, getProjectSettings: () => ({}), isProjectTrusted: () => false,
    } });
    const vimSource = cfg.packages.find((source) => source.includes("pi-vim@"));
    assert.ok(vimSource);
    const vim = manager.getInstalledPath(vimSource, "user") ?? path.join(agentDir, "git/github.com/peloyeje/pi-vim");
    for (const directory of [vim, path.join(agentDir, "extensions/fzf-file-picker")]) await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(vim, "package.json"), JSON.stringify({ pi: { extensions: ["./index.ts"] } }));
    await fs.writeFile(path.join(vim, "index.ts"), "");
    await fs.writeFile(path.join(agentDir, "extensions/fzf-file-picker/index.ts"), "");
    await fs.writeFile(path.join(agentDir, "extensions/fzf-file-picker/package.json"), JSON.stringify({ pi: { extensions: ["./index.ts"] } }));
    await fs.writeFile(path.join(agentDir, "extensions/command-palette.ts"), "");
    const extensions = (await manager.resolve()).extensions.filter((entry) => entry.enabled).map((entry) => entry.path);
    const vimIndex = extensions.indexOf(path.join(vim, "index.ts"));
    const fzfIndex = extensions.indexOf(path.join(agentDir, "extensions/fzf-file-picker/index.ts"));
    const paletteIndex = extensions.indexOf(path.join(agentDir, "extensions/command-palette.ts"));
    assert.ok(vimIndex >= 0 && fzfIndex > vimIndex && paletteIndex > fzfIndex, JSON.stringify(extensions));
    assert.equal(extensions.filter((name) => name.endsWith("command-palette.ts")).length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
