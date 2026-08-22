import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const GENERATED = path.join(ROOT, "pi/agent/extensions/herdr-agent-state.ts");
const LOCAL_REPORTER = path.join(ROOT, "pi/agent/extensions/herdr-status-reporter.ts");

function run(command, args, env) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr}`));
		});
	});
}

test("Herdr v8 integration reinstall replaces only the generated extension", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-herdr-upgrade-"));
	const home = path.join(root, "home");
	const extensions = path.join(home, ".pi/agent/extensions");
	try {
		await mkdir(extensions, { recursive: true });
		const expectedGenerated = await readFile(GENERATED, "utf8");
		const expectedReporter = await readFile(LOCAL_REPORTER, "utf8");
		await cp(LOCAL_REPORTER, path.join(extensions, "herdr-status-reporter.ts"));

		await run("herdr", ["integration", "install", "pi"], {
			PATH: process.env.PATH ?? "",
			HOME: home,
			HERDR_CONFIG_DIR: path.join(root, "config"),
		});

		assert.equal(
			await readFile(path.join(extensions, "herdr-agent-state.ts"), "utf8"),
			expectedGenerated,
			"the tracked generated file exactly matches Herdr's installed v8 artifact",
		);
		assert.equal(
			await readFile(path.join(extensions, "herdr-status-reporter.ts"), "utf8"),
			expectedReporter,
			"integration reinstall leaves the locally owned broker reporter untouched",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
