import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

function listen(server, host = "127.0.0.1") {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, host, () => resolve(server.address().port));
	});
}

function listenSocket(server, socketPath) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
}

function close(server) {
	return new Promise((resolve) => server.close(resolve));
}

async function waitForCount(items, count) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (items.length >= count) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${count} requests; received ${items.length}`);
}

function preserveHerdrEnvironment() {
	const names = [
		"HERDR_ENV",
		"HERDR_PANE_ID",
		"HERDR_SOCKET_PATH",
		"HERDR_PI_STATUS_PORT",
		"HERDR_PI_STATUS_TOKEN",
		"HTTP_PROXY",
		"http_proxy",
	];
	const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
	return () => {
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

async function loadExtension() {
	const { default: extension } = await import(`../agent/extensions/herdr-agent-state.ts?test=${Date.now()}-${Math.random()}`);
	return extension;
}

async function loadFeedbackExtension() {
	const { default: extension } = await import(`../agent/extensions/herdr-feedback-state/index.ts?test=${Date.now()}-${Math.random()}`);
	return extension;
}

function createHarness() {
	const lifecycle = new Map();
	const events = new Map();
	const pi = {
		events: {
			on(name, handler) {
				if (!events.has(name)) events.set(name, []);
				events.get(name).push(handler);
			},
		},
		on(name, handler) {
			if (!lifecycle.has(name)) lifecycle.set(name, []);
			lifecycle.get(name).push(handler);
		},
	};
	return {
		pi,
		async emitLifecycle(name, event = {}, ctx = {}) {
			for (const handler of lifecycle.get(name) ?? []) await handler(event, ctx);
		},
		emitEvent(name, data) {
			for (const handler of events.get(name) ?? []) handler(data);
		},
	};
}

function requestMethods(requests) {
	return requests.map(({ body }) => body.request.method);
}

function requestStates(requests) {
	return requests
		.filter(({ body }) => body.request.method === "pane.report_agent")
		.map(({ body }) => body.request.params.state);
}

function tuiContext({ isIdle = () => true, ui } = {}) {
	return {
		mode: "tui",
		hasUI: true,
		isIdle,
		ui,
		sessionManager: {
			getSessionFile: () => "/tmp/pi-session.jsonl",
			getSessionId: () => "session-7",
		},
	};
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function nextTurn() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate, description) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${description}`);
}

function createComposedHarness() {
	const lifecycle = new Map();
	const eventHandlers = new Map();
	const events = {
		on(name, handler) {
			if (!eventHandlers.has(name)) eventHandlers.set(name, []);
			const handlers = eventHandlers.get(name);
			handlers.push(handler);
			return () => {
				const index = handlers.indexOf(handler);
				if (index >= 0) handlers.splice(index, 1);
			};
		},
		emit(name, data) {
			for (const handler of [...(eventHandlers.get(name) ?? [])]) handler(data);
		},
	};
	const pi = {
		events,
		on(name, handler) {
			if (!lifecycle.has(name)) lifecycle.set(name, []);
			lifecycle.get(name).push(handler);
		},
	};
	return {
		pi,
		async install() {
			const reporter = await loadExtension();
			const feedback = await loadFeedbackExtension();
			reporter(pi);
			feedback(pi);
		},
		replaceExtensions() {
			lifecycle.clear();
		},
		async emitLifecycle(name, event, ctx) {
			for (const handler of lifecycle.get(name) ?? []) await handler(event, ctx);
		},
		emitWorkflow(data) {
			events.emit("plan-mode:workflow-state", data);
		},
	};
}

function composedTuiContext(sessionId, isIdle, ui) {
	return {
		mode: "tui",
		hasUI: true,
		isIdle,
		ui,
		sessionManager: {
			getSessionFile: () => undefined,
			getSessionId: () => sessionId,
			getBranch: () => [],
		},
	};
}

function composedUI() {
	const dialogs = [];
	return {
		dialogs,
		select: () => Promise.resolve(undefined),
		confirm: () => Promise.resolve(false),
		input: () => Promise.resolve(undefined),
		editor: () => Promise.resolve(undefined),
		custom: () => {
			const dialog = deferred();
			dialogs.push(dialog);
			return dialog.promise;
		},
	};
}

test("version-8 reporter is TUI-only and reports sessions before lifecycle state", async () => {
	const restore = preserveHerdrEnvironment();
	const requests = [];
	const proxy = createHttpServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk.toString("utf8");
		});
		request.on("end", () => {
			requests.push({
				url: request.url,
				host: request.headers.host,
				authorization: request.headers["proxy-authorization"],
				body: JSON.parse(body),
			});
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end('{"ok":true}');
		});
	});
	const proxyPort = await listen(proxy);

	try {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "pane-7";
		delete process.env.HERDR_SOCKET_PATH;
		process.env.HERDR_PI_STATUS_PORT = "43210";
		process.env.HERDR_PI_STATUS_TOKEN = "status-token";
		process.env.HTTP_PROXY = `http://proxy-user:proxy-pass@127.0.0.1:${proxyPort}`;
		delete process.env.http_proxy;

		const extension = await loadExtension();
		const nonTui = createHarness();
		extension(nonTui.pi);
		await nonTui.emitLifecycle("session_start", { reason: "startup" }, { ...tuiContext(), mode: "rpc" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(requests.length, 0, "RPC must not claim the pane even when hasUI is true");

		const harness = createHarness();
		extension(harness.pi);
		let idle = false;
		const ctx = tuiContext({ isIdle: () => idle });
		await harness.emitLifecycle("session_start", { reason: "reload" }, ctx);
		await waitForCount(requests, 3);
		assert.deepEqual(requestMethods(requests), [
			"pane.report_agent_session",
			"pane.report_metadata",
			"pane.report_agent",
		]);
		assert.equal(requests[0].body.request.params.session_start_source, "reload");
		assert.equal(requests[1].body.request.params.display_agent, "π");
		assert.equal(requests[2].body.request.params.state, "working", "reload seeds active work from ctx.isIdle()");

		await harness.emitLifecycle("agent_settled", {}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(requestStates(requests), ["working"], "a non-idle settled event cannot publish idle");

		idle = true;
		await harness.emitLifecycle("agent_settled", {}, ctx);
		await waitForCount(requests, 4);
		assert.deepEqual(requestStates(requests), ["working", "idle"]);

		await harness.emitLifecycle("agent_start", {}, ctx);
		await waitForCount(requests, 6);
		assert.deepEqual(requestMethods(requests).slice(-2), ["pane.report_agent_session", "pane.report_agent"]);
		assert.equal(requests.at(-1).body.request.params.state, "working");
		assert.equal(requests.at(-2).body.request.params.session_start_source, undefined);

		assert.deepEqual(requests.map(({ url }) => url), Array(6).fill("http://localhost:43210/"));
		assert.deepEqual(requests.map(({ host }) => host), Array(6).fill("localhost:43210"));
		assert.deepEqual(
			requests.map(({ authorization }) => authorization),
			Array(6).fill(`Basic ${Buffer.from("proxy-user:proxy-pass").toString("base64")}`),
		);
		assert.ok(requests.every(({ body }) => body.token === "status-token"));
	} finally {
		restore();
		await close(proxy);
	}
});

test("blocked state takes precedence over a settled lifecycle transition", async () => {
	const restore = preserveHerdrEnvironment();
	const requests = [];
	const broker = createHttpServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk.toString("utf8");
		});
		request.on("end", () => {
			requests.push({ body: JSON.parse(body) });
			response.writeHead(200);
			response.end('{"ok":true}');
		});
	});
	const brokerPort = await listen(broker);

	try {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "pane-7";
		delete process.env.HERDR_SOCKET_PATH;
		process.env.HERDR_PI_STATUS_PORT = String(brokerPort);
		process.env.HERDR_PI_STATUS_TOKEN = "status-token";
		delete process.env.HTTP_PROXY;
		delete process.env.http_proxy;

		const harness = createHarness();
		const extension = await loadExtension();
		extension(harness.pi);
		const ctx = tuiContext();
		await harness.emitLifecycle("session_start", { reason: "startup" }, ctx);
		await waitForCount(requests, 3);
		await harness.emitLifecycle("agent_start", {}, ctx);
		await waitForCount(requests, 5);

		harness.emitEvent("herdr:blocked", { active: true, label: "Waiting for feedback" });
		await waitForCount(requests, 6);
		await harness.emitLifecycle("agent_settled", {}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(requestStates(requests), ["idle", "working", "blocked"]);

		harness.emitEvent("herdr:blocked", { active: false });
		await waitForCount(requests, 7);
		assert.deepEqual(requestStates(requests), ["idle", "working", "blocked", "idle"]);
	} finally {
		restore();
		await close(broker);
	}
});

test("broker delivery retries a failed acknowledgement before advancing the state queue", async () => {
	const restore = preserveHerdrEnvironment();
	const requests = [];
	const broker = createHttpServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk.toString("utf8");
		});
		request.on("end", () => {
			requests.push({ body: JSON.parse(body) });
			response.writeHead(requests.length === 3 ? 503 : 200);
			response.end('{"ok":true}');
		});
	});
	const brokerPort = await listen(broker);

	try {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "pane-7";
		delete process.env.HERDR_SOCKET_PATH;
		process.env.HERDR_PI_STATUS_PORT = String(brokerPort);
		process.env.HERDR_PI_STATUS_TOKEN = "status-token";
		delete process.env.HTTP_PROXY;
		delete process.env.http_proxy;

		const harness = createHarness();
		const extension = await loadExtension();
		extension(harness.pi);
		await harness.emitLifecycle("session_start", { reason: "startup" }, tuiContext());
		await waitForCount(requests, 4);
		assert.deepEqual(requestMethods(requests), [
			"pane.report_agent_session",
			"pane.report_metadata",
			"pane.report_agent",
			"pane.report_agent",
		]);
		assert.equal(requests[2].body.request.params.state, "idle");
		assert.equal(requests[3].body.request.params.state, "idle");
		assert.equal(requests[2].body.request.params.seq, requests[3].body.request.params.seq, "retry preserves sequence");
	} finally {
		restore();
		await close(broker);
	}
});

test("unacknowledged startup session blocks lifecycle state and reports a non-secret diagnostic", async () => {
	const restore = preserveHerdrEnvironment();
	const requests = [];
	let acceptSessions = false;
	const broker = createHttpServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk.toString("utf8");
		});
		request.on("end", () => {
			const parsed = JSON.parse(body);
			requests.push({ body: parsed });
			response.writeHead(acceptSessions || parsed.request.method !== "pane.report_agent_session" ? 200 : 502);
			response.end('{"ok":true}');
		});
	});
	const brokerPort = await listen(broker);

	try {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "pane-7";
		delete process.env.HERDR_SOCKET_PATH;
		process.env.HERDR_PI_STATUS_PORT = String(brokerPort);
		process.env.HERDR_PI_STATUS_TOKEN = "status-token";
		delete process.env.HTTP_PROXY;
		delete process.env.http_proxy;

		const notifications = [];
		const harness = createHarness();
		const extension = await loadExtension();
		extension(harness.pi);
		const ctx = tuiContext({ ui: { notify: (message, level) => notifications.push({ message, level }) } });
		await harness.emitLifecycle("session_start", { reason: "startup" }, ctx);
		await waitForCount(requests, 2);
		assert.deepEqual(requestMethods(requests), ["pane.report_agent_session", "pane.report_agent_session"]);
		assert.equal(requests[0].body.request.params.agent_session_id, "session-7", "a session ID accompanies a not-yet-canonical path");
		assert.deepEqual(notifications, [{
			message: "Herdr status unavailable; retrying on the next lifecycle event.",
			level: "warning",
		}]);

		acceptSessions = true;
		await harness.emitLifecycle("agent_start", {}, ctx);
		await waitForCount(requests, 5);
		assert.deepEqual(requestMethods(requests).slice(-3), [
			"pane.report_agent_session",
			"pane.report_metadata",
			"pane.report_agent",
		]);
		assert.equal(requests.at(-1).body.request.params.state, "working");
	} finally {
		restore();
		await close(broker);
	}
});

test("root session replacement retains only the current reporter through a durable approval wait", async () => {
	const restore = preserveHerdrEnvironment();
	const requests = [];
	const broker = createHttpServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk.toString("utf8");
		});
		request.on("end", () => {
			requests.push({ body: JSON.parse(body) });
			response.writeHead(200);
			response.end('{"ok":true}');
		});
	});
	const brokerPort = await listen(broker);

	try {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "pane-7";
		delete process.env.HERDR_SOCKET_PATH;
		process.env.HERDR_PI_STATUS_PORT = String(brokerPort);
		process.env.HERDR_PI_STATUS_TOKEN = "status-token";
		delete process.env.HTTP_PROXY;
		delete process.env.http_proxy;

		const state = await import("../agent/extensions/plan-mode/state.js");
		const harness = createComposedHarness();
		let idle = false;
		const firstUI = composedUI();
		const firstContext = composedTuiContext("session-1", () => idle, firstUI);
		await harness.install();
		await harness.emitLifecycle("session_start", { reason: "startup" }, firstContext);
		await waitForCount(requests, 3);

		// Pi reloads its extension runner after session_shutdown. The old reporter's
		// event-bus listener remains registered unless its shutdown lifecycle ends
		// its authority, which is the production failure this composes.
		await harness.emitLifecycle("session_shutdown", { reason: "reload" }, firstContext);
		harness.replaceExtensions();
		const secondUI = composedUI();
		const secondContext = composedTuiContext("session-2", () => idle, secondUI);
		const replacementStart = requests.length;
		await harness.install();
		await harness.emitLifecycle("session_start", { reason: "reload" }, secondContext);
		await waitForCount(requests, 6);

		const planning = state.enterPlanning(state.createInitialState(), ["read", "bash"]).state;
		let approval = state.submitPlan(planning, {
			path: "/tmp/approval.md",
			slug: "approval",
			hash: "approval-hash",
			title: "Approval",
			intent: "Exercise replacement authority",
			approvalNonce: "approval-nonce",
			stages: [{ id: "A", description: "Approval", taskIds: ["A"] }],
			tasks: [{ id: "A", title: "Wait for approval", status: "pending" }],
		}).state;
		harness.emitWorkflow({ mode: approval.mode, feedbackPending: state.hasDurableFeedbackPending(approval) });
		await waitFor(
			() => requests.some(({ body }) => body.request.method === "pane.report_agent"
				&& body.request.params.agent_session_id === "session-2"
				&& body.request.params.state === "blocked"),
			"the replacement session to report blocked",
		);

		const replacementRequests = requests.slice(replacementStart);
		const sessionIndex = replacementRequests.findIndex(({ body }) =>
			body.request.method === "pane.report_agent_session" && body.request.params.agent_session_id === "session-2");
		const stateIndex = replacementRequests.findIndex(({ body }) =>
			body.request.method === "pane.report_agent" && body.request.params.agent_session_id === "session-2");
		assert.ok(sessionIndex >= 0 && sessionIndex < stateIndex, "the replacement session reference precedes lifecycle state");
		assert.equal(
			replacementRequests.at(-1).body.request.params.state,
			"blocked",
			"the unresolved approval is the current effective state",
		);

		const dismissed = secondUI.custom(() => undefined);
		secondUI.dialogs.at(-1).resolve(undefined);
		await dismissed;
		await nextTurn();
		assert.equal(approval.approval.consumed, false, "dismissing retains the durable approval for reopening");
		assert.equal(requests.at(-1).body.request.params.state, "blocked", "closing UI alone cannot clear durable approval");

		const accepted = secondUI.custom(() => undefined);
		secondUI.dialogs.at(-1).resolve("run");
		approval = state.approveExecution(approval, "approval-nonce", "all").state;
		harness.emitWorkflow({ mode: approval.mode, feedbackPending: state.hasDurableFeedbackPending(approval) });
		await accepted;
		await nextTurn();
		await waitFor(
			() => requests.some(({ body }) => body.request.method === "pane.report_agent"
				&& body.request.params.agent_session_id === "session-2"
				&& body.request.params.state === "working"),
			"approval acceptance to restore working",
		);

		idle = true;
		await harness.emitLifecycle("agent_settled", {}, secondContext);
		await waitFor(
			() => requests.some(({ body }) => body.request.method === "pane.report_agent"
				&& body.request.params.agent_session_id === "session-2"
				&& body.request.params.state === "idle"),
			"settled active session to report idle",
		);

		const plainDialog = secondUI.custom(() => undefined);
		await waitFor(
			() => requests.at(-1)?.body.request.params.state === "blocked",
			"plain blocking UI to report blocked",
		);
		secondUI.dialogs.at(-1).resolve(undefined);
		await plainDialog;
		await nextTurn();
		await waitFor(
			() => requests.at(-1)?.body.request.params.state === "idle",
			"plain blocking UI dismissal to restore idle",
		);

		const postReplacementStates = requests.slice(replacementStart)
			.filter(({ body }) => body.request.method === "pane.report_agent");
		assert.ok(postReplacementStates.length > 0);
		assert.ok(
			postReplacementStates.every(({ body }) => body.request.params.agent_session_id === "session-2"),
			"a retired reporter must not reclaim or clear lifecycle authority",
		);
	} finally {
		restore();
		await close(broker);
	}
});

test("shutdown drops a stale retry before a replacement reporter starts", async () => {
	const restore = preserveHerdrEnvironment();
	const requests = [];
	let holdFirstState = true;
	const broker = createHttpServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk.toString("utf8");
		});
		request.on("end", () => {
			const parsed = JSON.parse(body);
			requests.push({ body: parsed });
			if (holdFirstState && parsed.request.method === "pane.report_agent") {
				holdFirstState = false;
				return;
			}
			response.writeHead(200);
			response.end('{"ok":true}');
		});
	});
	const brokerPort = await listen(broker);

	try {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "pane-7";
		delete process.env.HERDR_SOCKET_PATH;
		process.env.HERDR_PI_STATUS_PORT = String(brokerPort);
		process.env.HERDR_PI_STATUS_TOKEN = "status-token";
		delete process.env.HTTP_PROXY;
		delete process.env.http_proxy;

		const harness = createComposedHarness();
		await harness.install();
		const firstContext = composedTuiContext("session-1", () => true, composedUI());
		await harness.emitLifecycle("session_start", { reason: "startup" }, firstContext);
		await waitForCount(requests, 3);
		await harness.emitLifecycle("session_shutdown", { reason: "reload" }, firstContext);
		assert.equal(
			requests.filter(({ body }) => body.request.method === "pane.report_agent").length,
			1,
			"a failed retired state delivery must not retry after shutdown",
		);

		harness.replaceExtensions();
		await harness.install();
		const secondContext = composedTuiContext("session-2", () => true, composedUI());
		await harness.emitLifecycle("session_start", { reason: "reload" }, secondContext);
		await waitFor(
			() => requests.some(({ body }) => body.request.method === "pane.report_agent"
				&& body.request.params.agent_session_id === "session-2"),
			"replacement lifecycle state",
		);
		assert.deepEqual(
			requests.filter(({ body }) => body.request.method === "pane.report_agent").map(({ body }) => body.request.params.agent_session_id),
			["session-1", "session-2"],
			"only the current reporter may send after replacement",
		);
	} finally {
		restore();
		await close(broker);
	}
});

test("direct socket delivery retries a failed acknowledgement", async () => {
	const restore = preserveHerdrEnvironment();
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-herdr-agent-state-"));
	const socketPath = path.join(root, "herdr.sock");
	const requests = [];
	const socket = createSocketServer((connection) => {
		let input = "";
		connection.on("data", (chunk) => {
			input += chunk.toString("utf8");
			const newline = input.indexOf("\n");
			if (newline < 0) return;
			requests.push(JSON.parse(input.slice(0, newline)));
			if (requests.length === 1) connection.destroy();
			else connection.end('{"result":{}}\n');
		});
	});
	await listenSocket(socket, socketPath);

	try {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "pane-7";
		process.env.HERDR_SOCKET_PATH = socketPath;
		delete process.env.HERDR_PI_STATUS_PORT;
		delete process.env.HERDR_PI_STATUS_TOKEN;
		delete process.env.HTTP_PROXY;
		delete process.env.http_proxy;

		const harness = createHarness();
		const extension = await loadExtension();
		extension(harness.pi);
		await harness.emitLifecycle("session_start", { reason: "startup" }, tuiContext());
		await waitForCount(requests, 4);
		assert.deepEqual(requests.map((request) => request.method), [
			"pane.report_agent_session",
			"pane.report_agent_session",
			"pane.report_metadata",
			"pane.report_agent",
		]);
		assert.equal(requests[0].params.seq, requests[1].params.seq, "retry preserves sequence");
	} finally {
		restore();
		await close(socket);
		await rm(root, { recursive: true, force: true });
	}
});
