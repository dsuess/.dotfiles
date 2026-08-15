import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const WRAPPER = path.join(ROOT, "bin/pi");

function waitForExit(child, stderr) {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`wrapper exited with ${code ?? signal}: ${stderr}`));
		});
	});
}

function listen(server, socketPath) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
}

function close(server) {
	return new Promise((resolve) => server.close(resolve));
}

test("sandbox wrapper establishes Herdr authority before an unresolved plan wait", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-herdr-composed-"));
	const home = path.join(root, "home");
	const realBin = path.join(root, "real-bin");
	const workspace = path.join(root, "workspace");
	const socketPath = path.join(root, "herdr.sock");
	const forwarded = [];
	const herdr = createServer((connection) => {
		let input = "";
		connection.on("data", (chunk) => {
			input += chunk.toString("utf8");
			for (;;) {
				const newline = input.indexOf("\n");
				if (newline < 0) return;
				const request = JSON.parse(input.slice(0, newline));
				input = input.slice(newline + 1);
				forwarded.push(request);
				connection.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
			}
		});
	});

	try {
		await mkdir(path.join(home, ".pi/agent/sessions"), { recursive: true });
		await mkdir(path.join(home, ".pi/sandbox/node_modules/.bin"), { recursive: true });
		await mkdir(path.join(home, ".pi/agent/extensions/herdr-feedback-state"), { recursive: true });
		await mkdir(path.join(home, ".pi/agent/extensions/plan-mode"), { recursive: true });
		await mkdir(realBin, { recursive: true });
		await mkdir(workspace, { recursive: true });
		await writeFile(path.join(home, ".pi/agent/settings.json"), "{}\n");
		await writeFile(path.join(home, ".pi/sandbox/settings.json"), JSON.stringify({
			network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
			filesystem: { denyRead: ["~"], allowRead: ["."], allowWrite: [".", "/tmp"], denyWrite: [], allowGitConfig: false },
		}));
		await cp(path.join(HERE, "herdr-status-broker.mjs"), path.join(home, ".pi/sandbox/herdr-status-broker.mjs"));
		await cp(path.join(ROOT, "pi/agent/extensions/herdr-agent-state.ts"), path.join(home, ".pi/agent/extensions/herdr-agent-state.ts"));
		await cp(path.join(ROOT, "pi/agent/extensions/herdr-feedback-state/index.ts"), path.join(home, ".pi/agent/extensions/herdr-feedback-state/index.ts"));
		await cp(path.join(ROOT, "pi/agent/extensions/plan-mode/events.ts"), path.join(home, ".pi/agent/extensions/plan-mode/events.ts"));
		await writeFile(path.join(home, ".pi/sandbox/unrestricted-network.mjs"), `
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] !== "--settings" || args[2] !== "--") process.exit(2);
const result = spawnSync(args[3], args.slice(4), { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
`);
		await writeFile(path.join(home, ".pi/sandbox/node_modules/.bin/srt"), "#!/usr/bin/env bash\nexit 0\n");
		await chmod(path.join(home, ".pi/sandbox/node_modules/.bin/srt"), 0o755);
		await writeFile(path.join(realBin, "pi"), `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const extensionPath = (relative) => pathToFileURL(path.join(process.env.HOME, ".pi/agent/extensions", relative)).href;
const { default: reporter } = await import(extensionPath("herdr-agent-state.ts"));
const { default: feedback } = await import(extensionPath("herdr-feedback-state/index.ts"));
const lifecycle = new Map();
const listeners = new Map();
const pi = {
  events: {
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
      return () => listeners.get(name)?.splice(listeners.get(name).indexOf(listener), 1);
    },
    emit(name, payload) { for (const listener of [...(listeners.get(name) ?? [])]) listener(payload); },
  },
  on(name, listener) {
    if (!lifecycle.has(name)) lifecycle.set(name, []);
    lifecycle.get(name).push(listener);
  },
};
const emit = async (name, event, context) => {
  for (const listener of lifecycle.get(name) ?? []) await listener(event, context);
};
const sessionFile = path.join(process.env.HOME, ".pi/agent/sessions/current.jsonl");
const context = {
  mode: "tui",
  hasUI: true,
  isIdle: () => true,
  ui: {
    select: () => Promise.resolve(), confirm: () => Promise.resolve(), input: () => Promise.resolve(),
    editor: () => Promise.resolve(), custom: () => Promise.resolve(), notify: () => {},
  },
  sessionManager: {
    getSessionFile: () => sessionFile,
    getSessionId: () => "sandbox-session-7",
    getBranch: () => [],
  },
};
reporter(pi);
feedback(pi);
await emit("session_start", { reason: "startup" }, context);
await writeFile(sessionFile, "{}\\n");
pi.events.emit("plan-mode:workflow-state", { mode: "approval", feedbackPending: true });
await new Promise((resolve) => setTimeout(resolve, 30));
`);
		await chmod(path.join(realBin, "pi"), 0o755);
		await listen(herdr, socketPath);

		const child = spawn(WRAPPER, [], {
			cwd: workspace,
			env: {
				HOME: home,
				PATH: `${path.dirname(WRAPPER)}:${realBin}:${process.env.PATH}`,
				HERDR_ENV: "1",
				HERDR_SOCKET_PATH: socketPath,
				HERDR_PANE_ID: "pane-composed",
			},
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
		await waitForExit(child, stderr);

		const session = forwarded.find((request) => request.method === "pane.report_agent_session");
		const metadata = forwarded.find((request) => request.method === "pane.report_metadata");
		const blocked = forwarded.find((request) => request.method === "pane.report_agent" && request.params.state === "blocked");
		assert.ok(session, "the broker must forward a current Pi session reference");
		assert.equal(session.params.agent_session_id, "sandbox-session-7", "the stable ID survives the session-file creation race");
		assert.ok(metadata, "metadata follows the acknowledged session");
		assert.ok(blocked, "the unresolved plan action wait reports blocked");
		assert.equal(blocked.params.message, "waiting for feedback");
		assert.ok(forwarded.indexOf(session) < forwarded.indexOf(metadata));
		assert.ok(forwarded.indexOf(metadata) < forwarded.indexOf(blocked));
		assert.equal(blocked.params.pane_id, "pane-composed");
		assert.equal(blocked.params.source, "herdr:pi");
		assert.equal(blocked.params.agent, "pi");
	} finally {
		await close(herdr);
		await rm(root, { recursive: true, force: true });
	}
});
