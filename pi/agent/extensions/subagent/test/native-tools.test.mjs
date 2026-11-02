import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { piPackageRoot } from "../../../../test-helpers.mjs";
import { childToolCliArgs, splitChildCapabilities } from "../../srt-tool-routing/child-capabilities.js";

// Exercise the installed CLI and its actual startup filtering, without a model call.
test("native child selection loads only admitted tools and reads a fixture", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-inventory-"));
	try {
		const agentDir = path.join(root, "agent");
		await mkdir(agentDir);
		await writeFile(path.join(root, "fixture.txt"), "native fixture contents\n");
		await writeFile(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
			fixture: { command: process.execPath, args: [path.join(root, "server.js")], exposure: "direct" },
		} }));
		await writeFile(path.join(root, "server.js"), `require('fs').writeFileSync(${JSON.stringify(path.join(root, "server-started"))}, 'started'); setInterval(() => {}, 1000);`);
		const probe = path.join(root, "probe.mjs");
		await writeFile(probe, `import { writeFileSync } from 'node:fs';
import { createReadTool } from ${JSON.stringify(path.join(piPackageRoot, "dist/index.js"))};
export default function(pi) {
  pi.registerTool({ name: 'ketch_search', label: 'fixture', description: 'fixture', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [] }) });
  pi.registerTool({ name: 'subagent', label: 'fixture', description: 'fixture', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [] }) });
  pi.registerTool({ name: 'show_plan', label: 'fixture', description: 'fixture', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [] }) });
  pi.on('session_start', async () => {
    const active = pi.getActiveTools();
    const read = active.includes('read') ? await createReadTool(process.cwd()).execute('fixture-read', { path: 'fixture.txt' }) : null;
    writeFileSync(${JSON.stringify(path.join(root, "inventory.json"))}, JSON.stringify({ active, read }));
  });
}`);
		const cases = [
			{ tools: ["read", "grep", "find", "ls", "ketch_search", "subagent", "show_plan", "mcp__fixture__tool"], expected: ["read", "grep", "find", "ls", "ketch_search"] },
			{ tools: ["ketch_search"], expected: ["ketch_search"] },
			{ tools: [], expected: [] },
		];
		for (const { tools, expected } of cases) {
			const capabilities = splitChildCapabilities(tools, { excluded: ["subagent", "show_plan"] });
			const args = childToolCliArgs(capabilities, {});
			const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
			delete env.PI_SRT_ROUTING;
			delete env.PI_SRT_ROUTING_SANDBOX;
			const result = spawnSync(process.execPath, [path.join(piPackageRoot, "dist/bundle/cli.js"), "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--offline", "-e", probe, ...args], {
				cwd: root, env, input: '{"id":"state","type":"get_state"}\n', encoding: "utf8", timeout: 30000,
			});
			assert.equal(result.status, 0, `${result.error || ""}\n${result.stderr}\n${result.stdout}`);
			const inventory = JSON.parse(await readFile(path.join(root, "inventory.json"), "utf8"));
			assert.deepEqual([...inventory.active].sort(), [...expected].sort());
			if (expected.includes("read")) assert.match(JSON.stringify(inventory.read.content), /native fixture contents/);
			else assert.equal(inventory.read, null);
			await rm(path.join(root, "inventory.json"));
		}
		await assert.rejects(readFile(path.join(root, "server-started")), { code: "ENOENT" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
