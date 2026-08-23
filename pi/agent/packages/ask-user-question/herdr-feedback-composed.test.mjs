import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import feedbackExtension from "../../extensions/herdr-feedback-state/index.ts";
import { registerAskUserQuestionTool } from "./ask-user-question.js";

const PARAMS = {
	questions: [{
		question: "Which library?",
		header: "Library",
		options: [
			{ label: "React", description: "Use React" },
			{ label: "Vue", description: "Use Vue" },
		],
	}],
};

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createUI(custom) {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		editor: async () => undefined,
		custom,
	};
}

function createHarness() {
	const lifecycle = new Map();
	const bus = new Map();
	let tool;
	const pi = {
		registerCommand() {},
		events: {
			on(name, handler) {
				const handlers = bus.get(name) ?? [];
				handlers.push(handler);
				bus.set(name, handlers);
				return () => {
					const index = handlers.indexOf(handler);
					if (index >= 0) handlers.splice(index, 1);
				};
			},
			emit(name, payload) {
				for (const handler of [...(bus.get(name) ?? [])]) handler(payload);
			},
		},
		on(name, handler) {
			const handlers = lifecycle.get(name) ?? [];
			handlers.push(handler);
			lifecycle.set(name, handlers);
		},
		registerTool(candidate) { tool = candidate; },
		sendUserMessage() {},
		getActiveTools: () => [],
	};
	feedbackExtension(pi);
	registerAskUserQuestionTool(pi);

	async function emitLifecycle(name, event, ctx) {
		for (const handler of lifecycle.get(name) ?? []) await handler(event, ctx);
	}

	return {
		pi,
		emitLifecycle,
		async start(ui, isIdle = () => false) {
			const ctx = {
				mode: "tui",
				hasUI: true,
				isIdle,
				ui,
				sessionManager: {
					getSessionFile: () => "/tmp/questionnaire-session.jsonl",
					getSessionId: () => "questionnaire-session",
				},
			};
			await emitLifecycle("session_start", { reason: "startup" }, ctx);
			return ctx;
		},
		execute(ui) {
			const ctx = {
				mode: "tui",
				hasUI: true,
				ui,
				cwd: process.cwd(),
				isProjectTrusted: () => true,
				sessionManager: { getSessionFile: () => "/tmp/questionnaire-session.jsonl" },
			};
			return tool.execute("tool-call", PARAMS, undefined, undefined, ctx);
		},
	};
}

async function listen(server, socketPath) {
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
}

async function close(server) {
	await new Promise((resolve) => server.close(resolve));
}

async function waitFor(predicate, description) {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${description}`);
}

function states(requests) {
	return requests
		.filter((request) => request.method === "pane.report_agent")
		.map((request) => request.params.state);
}

describe("real questionnaire producer through the stock Herdr reporter", () => {
	it("reports working, blocked, working, and idle without duplicate edges", async () => {
		const previous = Object.fromEntries(["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"].map((key) => [key, process.env[key]]));
		const directory = await mkdtemp(join("/tmp", "herdr-questionnaire-"));
		const socketPath = join(directory, "herdr.sock");
		const requests = [];
		const server = createServer((socket) => {
			let input = "";
			socket.on("data", (chunk) => {
				input += chunk.toString("utf8");
				for (;;) {
					const newline = input.indexOf("\n");
					if (newline < 0) break;
					requests.push(JSON.parse(input.slice(0, newline)));
					input = input.slice(newline + 1);
					socket.end('{"ok":true}\n');
				}
			});
		});

		try {
			await listen(server, socketPath);
			process.env.HERDR_ENV = "1";
			process.env.HERDR_PANE_ID = "questionnaire-pane";
			process.env.HERDR_SOCKET_PATH = socketPath;
			const reporter = (await import("../../extensions/herdr-agent-state.ts?questionnaire-composed")).default;
			const harness = createHarness();
			reporter(harness.pi);
			let idle = false;
			const dialog = deferred();
			const ui = createUI(() => dialog.promise);
			const ctx = await harness.start(ui, () => idle);
			await waitFor(() => states(requests).join() === "working", "initial working state");

			const execution = harness.execute(ui);
			await waitFor(() => states(requests).join() === "working,blocked", "questionnaire blocked state");
			dialog.resolve({
				cancelled: false,
				answers: [{ questionIndex: 0, question: "Which library?", kind: "option", answer: "React" }],
			});
			await execution;
			await waitFor(() => states(requests).join() === "working,blocked,working", "post-answer working state");

			idle = true;
			await harness.emitLifecycle("agent_settled", {}, ctx);
			await waitFor(() => states(requests).join() === "working,blocked,working,idle", "settled idle state");
			const sessionIndex = requests.findIndex((request) => request.method === "pane.report_agent_session");
			const stateIndex = requests.findIndex((request) => request.method === "pane.report_agent");
			expect(sessionIndex).toBeGreaterThanOrEqual(0);
			expect(sessionIndex).toBeLessThan(stateIndex);
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			await close(server);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it.each([
		["answer", { cancelled: false, answers: [{ questionIndex: 0, question: "Which library?", kind: "option", answer: "React" }] }],
		["cancellation", { cancelled: true, answers: [] }],
	])("clears after %s", async (_name, result) => {
		const harness = createHarness();
		const reports = [];
		harness.pi.events.on("herdr:blocked", (payload) => reports.push(payload));
		const dialog = deferred();
		const ui = createUI(() => dialog.promise);
		await harness.start(ui);
		const execution = harness.execute(ui);
		await expect.poll(() => reports).toEqual([{ active: true, label: "waiting for feedback" }]);
		dialog.resolve(result);
		await execution;
		await expect.poll(() => reports).toEqual([{ active: true, label: "waiting for feedback" }, { active: false }]);
	});

	it("clears after UI rejection", async () => {
		const harness = createHarness();
		const reports = [];
		harness.pi.events.on("herdr:blocked", (payload) => reports.push(payload));
		const dialog = deferred();
		const ui = createUI(() => dialog.promise);
		await harness.start(ui);
		const execution = harness.execute(ui);
		await expect.poll(() => reports).toHaveLength(1);
		dialog.reject(new Error("questionnaire failed"));
		await expect(execution).rejects.toThrow("questionnaire failed");
		await expect.poll(() => reports).toEqual([{ active: true, label: "waiting for feedback" }, { active: false }]);
	});

	it("stays blocked while an unresolved questionnaire is suspended for discussion", async () => {
		const harness = createHarness();
		const reports = [];
		harness.pi.events.on("herdr:blocked", (payload) => reports.push(payload));
		const suspendedQuestionnaire = deferred();
		const ui = createUI(() => suspendedQuestionnaire.promise);
		await harness.start(ui);
		const execution = harness.execute(ui);
		await expect.poll(() => reports).toEqual([{ active: true, label: "waiting for feedback" }]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(reports).toEqual([{ active: true, label: "waiting for feedback" }]);
		suspendedQuestionnaire.resolve({ cancelled: true, answers: [] });
		await execution;
		await expect.poll(() => reports.at(-1)).toEqual({ active: false });
	});
});
