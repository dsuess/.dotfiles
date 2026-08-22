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

function waitForExit(child, diagnostic) {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`wrapper exited with ${code ?? signal}: ${diagnostic()}`));
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
		await mkdir(path.join(home, ".pi/agent/packages/ask-user-question"), { recursive: true });
		await mkdir(realBin, { recursive: true });
		await mkdir(workspace, { recursive: true });
		await writeFile(path.join(home, ".pi/agent/settings.json"), "{}\n");
		await writeFile(path.join(home, ".pi/sandbox/settings.json"), JSON.stringify({
			version: 1,
			externalMounts: [],
			network: { mode: "public-http", allowedHosts: [], allowWebSockets: false, tcpMappings: [] },
		}));
		await cp(path.join(HERE, "herdr-status-broker.mjs"), path.join(home, ".pi/sandbox/herdr-status-broker.mjs"));
		await cp(path.join(HERE, "repository-scope.mjs"), path.join(home, ".pi/sandbox/repository-scope.mjs"));
		await cp(path.join(ROOT, "pi/agent/extensions/herdr-agent-state.ts"), path.join(home, ".pi/agent/extensions/herdr-agent-state.ts"));
		await cp(path.join(ROOT, "pi/agent/extensions/herdr-feedback-state/index.ts"), path.join(home, ".pi/agent/extensions/herdr-feedback-state/index.ts"));
		await cp(path.join(ROOT, "pi/agent/extensions/herdr-feedback-state/events.ts"), path.join(home, ".pi/agent/extensions/herdr-feedback-state/events.ts"));
		await cp(path.join(ROOT, "pi/agent/extensions/plan-mode/events.ts"), path.join(home, ".pi/agent/extensions/plan-mode/events.ts"));
		await cp(path.join(ROOT, "pi/agent/packages/ask-user-question/events.ts"), path.join(home, ".pi/agent/packages/ask-user-question/events.ts"));
		await mkdir(path.join(home, ".pi/agent/extensions/gondolin-sandbox"), { recursive: true });
		await writeFile(path.join(home, ".pi/agent/extensions/gondolin-sandbox/index.ts"), "export default function () {}\n");
		await writeFile(path.join(home, ".pi/sandbox/controller.mjs"), "export {};\n");
		await mkdir(path.join(root, "image"), { recursive: true });
		await writeFile(path.join(home, ".pi/sandbox/build-gondolin-image.mjs"), `process.stdout.write(${JSON.stringify(path.join(root, "image") + "\\n")});\n`);
		await writeFile(path.join(home, ".pi/sandbox/client-cli.mjs"), `
import { createHash } from "node:crypto";
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "release") process.exit(0);
const launch = fs.realpathSync(args[args.indexOf("--launch-dir") + 1]);
const runtimeRoot = ${JSON.stringify(path.join(root, "runtime"))};
fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
process.stdout.write(JSON.stringify({
  version: 1, socketPath: runtimeRoot + "/controller.sock",
  leaseToken: "a".repeat(64),
  workspaceKey: createHash("sha256").update(JSON.stringify([launch, null])).digest("hex"),
  workspaceRoot: launch,
  bareCommonDirectory: null, policyGeneration: "c".repeat(64), imageGeneration: "d".repeat(64),
  vmId: "composed-vm", dockerHealthy: true, controllerPid: process.pid, runtimeRoot,
}) + "\\n");
`);
		for (const qemu of ["qemu-system-aarch64", "qemu-system-x86_64"]) {
			await writeFile(path.join(realBin, qemu), "#!/bin/sh\nexit 0\n");
			await chmod(path.join(realBin, qemu), 0o755);
		}
		await writeFile(path.join(realBin, "pi"), `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (process.argv.includes("--list-models")) {
  process.stdout.write("Provider Model\\n");
  process.exit(0);
}
if (process.env.PI_GONDOLIN_HANDSHAKE_FILE) {
  await writeFile(process.env.PI_GONDOLIN_HANDSHAKE_FILE, JSON.stringify({
    ok: true,
    workspaceKey: process.env.PI_GONDOLIN_WORKSPACE_KEY,
    workspaceRoot: process.env.PI_GONDOLIN_WORKSPACE_ROOT,
    policyGeneration: process.env.PI_GONDOLIN_POLICY_GENERATION,
    imageGeneration: process.env.PI_GONDOLIN_IMAGE_GENERATION,
    vmId: process.env.PI_GONDOLIN_VM_ID,
    dockerHealthy: true,
    tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
  }));
}
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
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
		child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
		await waitForExit(child, () => `${stderr}\nstdout:\n${stdout}`);

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
