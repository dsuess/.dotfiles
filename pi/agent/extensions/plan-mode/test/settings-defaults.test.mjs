import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPiJiti } from "../../../../test-helpers.mjs";

const jiti = await createPiJiti(import.meta.url);
const { SettingsModelDefaults } = await jiti.import(new URL("../settings-defaults.ts", import.meta.url).pathname);

const high = "high";
const profiles = {
	planning: { provider: "openai-codex", modelId: "gpt-5.6-sol", thinkingLevel: high },
	inference: { provider: "openai-codex", modelId: "gpt-5.6-terra", thinkingLevel: high },
};

test("settings defaults preserve unrelated fields and the Stow symlink through Pi-side writes", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-settings-defaults-"));
	const target = path.join(directory, "settings-source.json");
	const settingsPath = path.join(directory, "settings.json");
	try {
		await writeFile(target, JSON.stringify({
			defaultProvider: "openai-codex", defaultModel: "gpt-5.6-terra",
			defaultThinkingProvider: "openai-codex", defaultThinkingModel: "gpt-5.6-sol",
			unrelated: { retained: true },
		}, null, 2));
		await symlink(target, settingsPath);
		const defaults = new SettingsModelDefaults(settingsPath);
		assert.deepEqual(defaults.load(high).profiles, profiles);

		// This is the native setDefaultModelAndProvider() side effect that an
		// automatic Sol/Terra transition leaves queued before reconciliation.
		const piWrite = JSON.parse(await readFile(target, "utf8"));
		piWrite.defaultProvider = "anthropic";
		piWrite.defaultModel = "claude-sonnet-5";
		await writeFile(target, JSON.stringify(piWrite, null, 2));
		await defaults.persist(profiles);

		const persisted = JSON.parse(await readFile(target, "utf8"));
		assert.equal((await lstat(settingsPath)).isSymbolicLink(), true);
		assert.deepEqual(persisted.unrelated, { retained: true });
		assert.deepEqual({ provider: persisted.defaultThinkingProvider, modelId: persisted.defaultThinkingModel }, {
			provider: "openai-codex", modelId: "gpt-5.6-sol",
		});
		assert.deepEqual({ provider: persisted.defaultProvider, modelId: persisted.defaultModel }, {
			provider: "openai-codex", modelId: "gpt-5.6-terra",
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("malformed and partial settings warn without producing a profile", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-settings-defaults-"));
	const settingsPath = path.join(directory, "settings.json");
	try {
		await writeFile(settingsPath, '{"defaultProvider":"openai-codex"}');
		const defaults = new SettingsModelDefaults(settingsPath);
		const partial = defaults.load(high);
		assert.equal(partial.profiles, null);
		assert.match(partial.warning, /incomplete/);
		await writeFile(settingsPath, "not json");
		const malformed = defaults.load(high);
		assert.equal(malformed.profiles, null);
		assert.match(malformed.warning, /could not be read/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
