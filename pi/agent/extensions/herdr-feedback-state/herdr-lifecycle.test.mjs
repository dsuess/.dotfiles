import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import feedbackExtension from "./index.ts";
import { ASK_USER_BLOCKED_EVENT } from "../../packages/ask-user-question/events.ts";
import { PLAN_MODE_WORKFLOW_STATE_EVENT } from "../plan-mode/events.ts";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const BROKER = path.join(ROOT, "pi/sandbox/herdr-status-broker.mjs");

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
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

async function waitFor(predicate, description) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${description}`);
}

async function brokerReady(readyFile, child, stderr) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (child.exitCode !== null) throw new Error(`broker exited: ${stderr.value}`);
		try {
			const [port, token] = (await readFile(readyFile, "utf8")).trim().split(" ");
			if (port && token) return { port: Number(port), token };
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for broker readiness: ${stderr.value}`);
}

function createHarness() {
	const lifecycle = new Map();
	const events = new Map();
	const commands = new Map();
	const pi = {
		registerCommand(name, definition) { commands.set(name, definition); },
		events: {
			on(name, handler) {
				if (!events.has(name)) events.set(name, []);
				events.get(name).push(handler);
				return () => {
					const handlers = events.get(name) ?? [];
					const index = handlers.indexOf(handler);
					if (index >= 0) handlers.splice(index, 1);
				};
			},
			emit(name, data) {
				for (const handler of [...(events.get(name) ?? [])]) handler(data);
			},
		},
		on(name, handler) {
			if (!lifecycle.has(name)) lifecycle.set(name, []);
			lifecycle.get(name).push(handler);
		},
	};
	return {
		pi,
		commands,
		emitEvent(name, data) { pi.events.emit(name, data); },
		async emitLifecycle(name, event, ctx) {
			for (const handler of lifecycle.get(name) ?? []) await handler(event, ctx);
		},
	};
}

function restoreEnvironment(previous) {
	for (const [name, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

test("regression: a replayed feedback snapshot clears before complete_plan settles", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-herdr-completed-plan-"));
	const sessionRoot = path.join(root, "sessions");
	const sessionPath = path.join(sessionRoot, "current.jsonl");
	const socketPath = path.join(root, "herdr.sock");
	const readyFile = path.join(root, "ready");
	const forwarded = [];
	const herdr = createServer((socket) => {
		let input = "";
		socket.on("data", (chunk) => {
			input += chunk.toString("utf8");
			for (;;) {
				const newline = input.indexOf("\n");
				if (newline < 0) return;
				const request = JSON.parse(input.slice(0, newline));
				input = input.slice(newline + 1);
				forwarded.push(request);
				socket.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
			}
		});
	});
	const stderr = { value: "" };
	let broker;
	const previous = Object.fromEntries([
		"HERDR_ENV",
		"HERDR_PANE_ID",
		"HERDR_SOCKET_PATH",
		"HERDR_PI_STATUS_PORT",
		"HERDR_PI_STATUS_TOKEN",
		"HTTP_PROXY",
		"http_proxy",
	].map((name) => [name, process.env[name]]));

	try {
		await mkdir(sessionRoot);
		await writeFile(sessionPath, "{}\n");
		await listen(herdr, socketPath);
		broker = spawn(process.execPath, [BROKER], {
			env: {
				HERDR_SOCKET_PATH: socketPath,
				HERDR_PANE_ID: "pane-completed-plan",
				HERDR_PI_BROKER_READY_FILE: readyFile,
				HERDR_PI_SESSION_ROOT: sessionRoot,
			},
			stdio: ["ignore", "ignore", "pipe"],
		});
		broker.stderr.on("data", (chunk) => { stderr.value += chunk.toString("utf8"); });
		const { port, token } = await brokerReady(readyFile, broker, stderr);

		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "pane-completed-plan";
		delete process.env.HERDR_SOCKET_PATH;
		process.env.HERDR_PI_STATUS_PORT = String(port);
		process.env.HERDR_PI_STATUS_TOKEN = token;
		delete process.env.HTTP_PROXY;
		delete process.env.http_proxy;

		const { default: reporter } = await import(`../herdr-status-reporter.ts?lifecycle=${Date.now()}`);
		const planState = await import("../plan-mode/state.js");
		const harness = createHarness();
		reporter(harness.pi);
		feedbackExtension(harness.pi);

		const dialog = deferred();
		let idle = false;
		const ctx = {
			mode: "tui",
			hasUI: true,
			isIdle: () => idle,
			ui: {
				select: () => Promise.resolve(undefined),
				confirm: () => Promise.resolve(false),
				input: () => Promise.resolve(undefined),
				editor: () => Promise.resolve(undefined),
				custom: () => dialog.promise,
				notify: () => {},
			},
			sessionManager: {
				getSessionFile: () => sessionPath,
				getSessionId: () => "w16-pF-completed-session",
				getBranch: () => [],
			},
		};
		await harness.emitLifecycle("session_start", { reason: "resume" }, ctx);
		await waitFor(
			() => forwarded.some((request) => request.method === "pane.report_agent" && request.params.state === "working"),
			"initial working state",
		);

		let workflow = planState.enterPlanning(planState.createInitialState(), ["read", "bash"]).state;
		workflow = planState.submitPlan(workflow, {
			path: "/plans/live-pane-regression.md",
			slug: "live-pane-regression",
			hash: "live-pane-regression",
			title: "Live completed-plan regression",
			intent: "Reproduce stale blocked status without using the live session as data.",
			approvalNonce: "approval-nonce",
			stages: [{ id: "A", description: "Complete", taskIds: ["A"] }],
			tasks: [{ id: "A", title: "Complete", status: "pending" }],
		}).state;
		harness.emitEvent(PLAN_MODE_WORKFLOW_STATE_EVENT, {
			mode: workflow.mode,
			feedbackPending: planState.hasDurableFeedbackPending(workflow),
		});
		await waitFor(
			() => forwarded.some((request) => request.method === "pane.report_agent" && request.params.state === "blocked"),
			"approval blocked state",
		);
		const notifications = [];
		await harness.commands.get("herdr-status").handler("", {
			ui: { notify: (message, level) => notifications.push({ message, level }) },
		});
		const diagnostic = JSON.parse(notifications.at(-1).message);
		assert.deepEqual(diagnostic.active_sources, [{ id: "plan-workflow", label: "waiting for feedback" }]);
		assert.equal(diagnostic.effective_desired_state.state, "blocked");
		assert.equal(diagnostic.transport, "authenticated-loopback-broker");
		assert.equal(JSON.stringify(diagnostic).includes(token), false, "diagnostics never expose the broker token");

		// A source snapshot can be replayed after reload. It must replace the
		// previous level, not acquire another irreversible blocked reference.
		harness.emitEvent("herdr:blocked", { active: true, label: "waiting for feedback" });
		const uiWait = ctx.ui.custom(() => undefined);
		harness.emitEvent(ASK_USER_BLOCKED_EVENT, { active: true });
		workflow = planState.approveExecution(workflow, "approval-nonce", "all").state;
		harness.emitEvent(PLAN_MODE_WORKFLOW_STATE_EVENT, {
			mode: workflow.mode,
			feedbackPending: planState.hasDurableFeedbackPending(workflow),
		});
		dialog.resolve(undefined);
		await uiWait;
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.emitEvent(ASK_USER_BLOCKED_EVENT, { active: false });
		await waitFor(
			() => forwarded.filter((request) => request.method === "pane.report_agent").at(-1)?.params.state === "working",
			"all explicit feedback sources to clear back to working",
		);
		workflow = planState.recordTaskProgress(workflow, { itemId: "A", status: "in_progress" }).state;
		workflow = planState.recordTaskProgress(workflow, { itemId: "A", status: "completed", evidence: "complete" }).state;
		workflow = planState.completeWorkflow(workflow).state;
		harness.emitEvent(PLAN_MODE_WORKFLOW_STATE_EVENT, {
			mode: workflow.mode,
			feedbackPending: planState.hasDurableFeedbackPending(workflow),
		});
		idle = true;
		await harness.emitLifecycle("agent_settled", {}, ctx);

		await waitFor(
			() => forwarded.filter((request) => request.method === "pane.report_agent").at(-1)?.params.state === "idle",
			"completed plan to settle idle after all sources clear",
		);
		const states = forwarded
			.filter((request) => request.method === "pane.report_agent")
			.map((request) => request.params.state);
		assert.deepEqual(states, ["working", "blocked", "working", "idle"]);
		assert.equal(
			new Set(forwarded.filter((request) => request.method === "pane.report_agent")
				.map((request) => request.params.agent_session_path)).size,
			1,
			"all lifecycle reports retain one canonical current Pi session reference",
		);
		await harness.emitLifecycle("session_shutdown", {}, ctx);
	} finally {
		restoreEnvironment(previous);
		if (broker?.exitCode === null) {
			const exited = new Promise((resolve) => broker.once("exit", resolve));
			broker.kill("SIGTERM");
			await exited;
		}
		await close(herdr);
		await rm(root, { recursive: true, force: true });
	}
});
