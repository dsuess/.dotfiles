import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("../index.ts", import.meta.url));
const piBin = process.env.PI_BIN || "pi";
const result = spawnSync(
	piBin,
	["--no-extensions", "--no-skills", "--no-prompt-templates", "--offline", "-e", entrypoint, "--list-models"],
	{ encoding: "utf8", timeout: 30_000 },
);

if (result.error) throw result.error;
assert.equal(
	result.status,
	0,
	`Pi failed to load ${entrypoint}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
);
assert.doesNotMatch(result.stderr, /Failed to load extension|Extension error|SyntaxError/i);
