import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPiJiti } from "../../../test-helpers.mjs";

const jiti = await createPiJiti(import.meta.url);
const installedPackage = path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-rtk-optimizer");
const extensionModule = await jiti.import(path.join(installedPackage, "index.ts"));
const runtimeGuard = await jiti.import(path.join(installedPackage, "src", "runtime-guard.ts"));

function createHarness() {
	const handlers = new Map();
	const execCalls = [];
	let phase = "startup";
	const pi = {
		registerCommand() {},
		on(name, handler) {
			if (!handlers.has(name)) handlers.set(name, []);
			handlers.get(name).push(handler);
		},
		async exec(command, args, options) {
			execCalls.push({ command, args, options });
			if (phase !== "startup") {
				throw new Error(`Unexpected process probe during ${phase}: ${command} ${args.join(" ")}`);
			}
			if (command === "which" && args.length === 1 && args[0] === "rtk") {
				return { code: 0, stdout: "/test/bin/rtk\n", stderr: "" };
			}
			if (command === "/test/bin/rtk" && args.length === 1 && args[0] === "--version") {
				return { code: 0, stdout: "rtk 0.44.0\n", stderr: "" };
			}
			throw new Error(`Unexpected startup process probe: ${command} ${args.join(" ")}`);
		},
	};
	const ctx = {
		hasUI: false,
		ui: { notify() {} },
	};

	extensionModule.default(pi);
	return {
		execCalls,
		setPhase(next) { phase = next; },
		async emit(name, event = {}) {
			let result;
			for (const handler of handlers.get(name) ?? []) {
				const next = await handler(event, ctx);
				if (next !== undefined) result = next;
			}
			return result;
		},
	};
}

async function settlesBeforeNextTurn(promise) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setImmediate(() => reject(new Error("before_agent_start did not settle immediately")));
			}),
		]);
	} finally {
		if (timer) clearImmediate(timer);
	}
}

test("stale prompt status skips RTK probes when the managed guard is disabled", async () => {
	const config = JSON.parse(await readFile(new URL("./config.json", import.meta.url), "utf8"));
	assert.equal(config.guardWhenRtkMissing, false, "managed config must disable the stale prompt guard");
	assert.equal(runtimeGuard.shouldRequireRtkAvailabilityForCommandHandling(config), false);
	assert.equal(
		runtimeGuard.shouldRequireRtkAvailabilityForCommandHandling({ ...config, guardWhenRtkMissing: true }),
		true,
		"enabling the package guard would reactivate the stale probe path",
	);

	const originalNow = Date.now;
	let now = 1_000_000;
	Date.now = () => now;
	try {
		const harness = createHarness();
		await harness.emit("session_start");
		assert.deepEqual(
			harness.execCalls.map(({ command, args }) => [command, args]),
			[["which", ["rtk"]], ["/test/bin/rtk", ["--version"]]],
			"session_start must retain its RTK status probe",
		);

		harness.execCalls.length = 0;
		now += 30_001;
		harness.setPhase("stale before_agent_start");
		assert.deepEqual(
			await settlesBeforeNextTurn(harness.emit("before_agent_start", { systemPrompt: "Guidelines:\n- Be concise" })),
			{},
		);
		assert.deepEqual(harness.execCalls, [], "stale prompt submission must not resolve or version-check RTK");
	} finally {
		Date.now = originalNow;
	}
});
