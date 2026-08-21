import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import feedbackExtension from "../../extensions/herdr-feedback-state/index.ts";
import { registerAskUserQuestionTool } from "./ask-user-question.js";

const PARAMS = {
	questions: [
		{
			question: "Which library?",
			header: "Library",
			options: [
				{ label: "React", description: "Use React" },
				{ label: "Vue", description: "Use Vue" },
			],
		},
	],
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
	const reports = [];
	let tool;
	const pi = {
		events: {
			on(name, handler) {
				if (!bus.has(name)) bus.set(name, []);
				bus.get(name).push(handler);
				return () => {
					const handlers = bus.get(name) ?? [];
					const index = handlers.indexOf(handler);
					if (index >= 0) handlers.splice(index, 1);
				};
			},
			emit(name, payload) {
				if (name === "herdr:blocked") reports.push(payload);
				for (const handler of [...(bus.get(name) ?? [])]) handler(payload);
			},
		},
		on(name, handler) {
			if (!lifecycle.has(name)) lifecycle.set(name, []);
			lifecycle.get(name).push(handler);
		},
		registerTool(candidate) {
			tool = candidate;
		},
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
		reports,
		emitLifecycle,
		async start(ui, isIdle = () => false) {
			const ctx = {
				mode: "tui",
				hasUI: true,
				isIdle,
				ui,
				sessionManager: {
					getBranch: () => [],
					getSessionFile: () => undefined,
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
				sessionManager: { buildContextEntries: () => [] },
			};
			return tool.execute("tool-call", PARAMS, undefined, undefined, ctx);
		},
	};
}

function listen(server) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve(server.address().port));
	});
}

function close(server) {
	return new Promise((resolve) => server.close(resolve));
}

function reportStates(requests) {
	return requests
		.filter((body) => body.request.method === "pane.report_agent")
		.map((body) => body.request.params.state);
}

describe("real questionnaire producer to Herdr feedback bridge", () => {
	it.each([
		{
			name: "answer",
			settle(dialog) {
				dialog.resolve({
					cancelled: false,
					answers: [{ questionIndex: 0, question: "Which library?", kind: "option", answer: "React" }],
				});
			},
		},
		{
			name: "cancellation",
			settle(dialog) {
				dialog.resolve({ answers: [], cancelled: true });
			},
		},
	])("reports blocked while a production-shaped $name is unresolved and clears afterward", async ({ settle }) => {
		const harness = createHarness();
		await harness.start(createUI(async () => undefined));
		const dialog = deferred();
		const execution = harness.execute(createUI(() => dialog.promise));

		await expect.poll(() => harness.reports).toEqual([
			{ active: true, label: "waiting for feedback" },
		]);
		settle(dialog);
		await execution;
		expect(harness.reports).toEqual([
			{ active: true, label: "waiting for feedback" },
			{ active: false },
		]);
	});

	it("clears blocked state when the real questionnaire UI rejects", async () => {
		const harness = createHarness();
		await harness.start(createUI(async () => undefined));
		const dialog = deferred();
		const execution = harness.execute(createUI(() => dialog.promise));

		await expect.poll(() => harness.reports).toEqual([
			{ active: true, label: "waiting for feedback" },
		]);
		dialog.reject(new Error("questionnaire failed"));
		await expect(execution).rejects.toThrow("questionnaire failed");
		expect(harness.reports).toEqual([
			{ active: true, label: "waiting for feedback" },
			{ active: false },
		]);
	});

	it("reports working, blocked, working, then settled idle through the real reporter", async () => {
		const previous = Object.fromEntries([
			"HERDR_ENV",
			"HERDR_PANE_ID",
			"HERDR_SOCKET_PATH",
			"HERDR_PI_STATUS_PORT",
			"HERDR_PI_STATUS_TOKEN",
			"HTTP_PROXY",
			"http_proxy",
		].map((name) => [name, process.env[name]]));
		const requests = [];
		const broker = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => { body += chunk.toString("utf8"); });
			request.on("end", () => {
				requests.push(JSON.parse(body));
				response.writeHead(200);
				response.end('{"ok":true}');
			});
		});
		const port = await listen(broker);

		try {
			process.env.HERDR_ENV = "1";
			process.env.HERDR_PANE_ID = "questionnaire-pane";
			delete process.env.HERDR_SOCKET_PATH;
			process.env.HERDR_PI_STATUS_PORT = String(port);
			process.env.HERDR_PI_STATUS_TOKEN = "status-token";
			delete process.env.HTTP_PROXY;
			delete process.env.http_proxy;

			const reporter = (await import("../../extensions/herdr-agent-state.ts?questionnaire-composed")).default;
			const harness = createHarness();
			reporter(harness.pi);
			let idle = false;
			const ctx = await harness.start(createUI(async () => undefined), () => idle);
			await expect.poll(() => reportStates(requests)).toEqual(["working"]);

			const dialog = deferred();
			const execution = harness.execute(createUI(() => dialog.promise));
			await expect.poll(() => reportStates(requests)).toEqual(["working", "blocked"]);
			dialog.resolve({
				cancelled: false,
				answers: [{ questionIndex: 0, question: "Which library?", kind: "option", answer: "React" }],
			});
			await execution;
			await expect.poll(() => reportStates(requests)).toEqual(["working", "blocked", "working"]);

			idle = true;
			await harness.emitLifecycle("agent_settled", {}, ctx);
			await expect.poll(() => reportStates(requests)).toEqual(["working", "blocked", "working", "idle"]);
			await harness.emitLifecycle("session_shutdown", {}, ctx);
		} finally {
			for (const [name, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			await close(broker);
		}
	});
});
