import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("../index.ts", import.meta.url));
const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-plan-rpc-"));
const proc = spawn(process.env.PI_BIN || "pi", [
	"--no-extensions", "--no-skills", "--no-prompt-templates", "--offline",
	"-e", entrypoint, "--mode", "rpc", "--no-session",
], { cwd, stdio: ["pipe", "pipe", "pipe"] });
let stdoutBuffer = "";
let stderr = "";
const pending = new Map();
const events = [];
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (chunk) => { stderr += chunk; });
proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (chunk) => {
	stdoutBuffer += chunk;
	for (;;) {
		const newline = stdoutBuffer.indexOf("\n");
		if (newline < 0) break;
		const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
		stdoutBuffer = stdoutBuffer.slice(newline + 1);
		if (!line) continue;
		let message;
		try { message = JSON.parse(line); } catch { continue; }
		events.push(message);
		if (message.id && pending.has(message.id) && message.type === "response") {
			pending.get(message.id)(message);
			pending.delete(message.id);
		}
	}
});

let sequence = 0;
function request(command) {
	const id = `request-${++sequence}`;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout for ${command.type}\nstderr:\n${stderr}`)); }, 15_000);
		pending.set(id, (response) => { clearTimeout(timer); resolve(response); });
		proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
	});
}

try {
	const commands = await request({ type: "get_commands" });
	assert.equal(commands.success, true, stderr);
	const names = commands.data.commands.map((command) => command.name);
	for (const name of ["plan", "plan-actions", "plan-stage-actions", "plan-resume"]) assert.ok(names.includes(name), name);

	assert.equal((await request({ type: "prompt", message: "/plan" })).success, true);
	const plannedEntries = await request({ type: "get_entries" });
	const planningState = plannedEntries.data.entries.filter((entry) => entry.type === "custom" && entry.customType === "plan-mode-state").at(-1)?.data;
	assert.equal(planningState?.mode, "planning", JSON.stringify(events, null, 2));
	assert.deepEqual(planningState?.originalActiveTools, ["read", "bash", "edit", "write"]);
	assert.equal((await request({ type: "prompt", message: "/plan off" })).success, true);
	const offEntries = await request({ type: "get_entries" });
	const offState = offEntries.data.entries.filter((entry) => entry.type === "custom" && entry.customType === "plan-mode-state").at(-1)?.data;
	assert.equal(offState?.mode, "off");
} finally {
	proc.stdin.end();
	proc.kill("SIGTERM");
	await rm(cwd, { recursive: true, force: true });
}
