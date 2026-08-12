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

function tuiContext({ isIdle = () => true } = {}) {
	return {
		mode: "tui",
		hasUI: true,
		isIdle,
		sessionManager: {
			getSessionFile: () => "/tmp/pi-session.jsonl",
			getSessionId: () => "session-7",
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
		await waitForCount(requests, 2);
		assert.deepEqual(requestMethods(requests), ["pane.report_agent_session", "pane.report_agent"]);
		assert.equal(requests[0].body.request.params.session_start_source, "reload");
		assert.equal(requests[1].body.request.params.state, "working", "reload seeds active work from ctx.isIdle()");

		await harness.emitLifecycle("agent_settled", {}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(requestStates(requests), ["working"], "a non-idle settled event cannot publish idle");

		idle = true;
		await harness.emitLifecycle("agent_settled", {}, ctx);
		await waitForCount(requests, 3);
		assert.deepEqual(requestStates(requests), ["working", "idle"]);

		await harness.emitLifecycle("agent_start", {}, ctx);
		await waitForCount(requests, 5);
		assert.deepEqual(requestMethods(requests).slice(-2), ["pane.report_agent_session", "pane.report_agent"]);
		assert.equal(requests.at(-1).body.request.params.state, "working");
		assert.equal(requests.at(-2).body.request.params.session_start_source, undefined);

		assert.deepEqual(requests.map(({ url }) => url), Array(5).fill("http://localhost:43210/"));
		assert.deepEqual(requests.map(({ host }) => host), Array(5).fill("localhost:43210"));
		assert.deepEqual(
			requests.map(({ authorization }) => authorization),
			Array(5).fill(`Basic ${Buffer.from("proxy-user:proxy-pass").toString("base64")}`),
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
		await waitForCount(requests, 2);
		await harness.emitLifecycle("agent_start", {}, ctx);
		await waitForCount(requests, 4);

		harness.emitEvent("herdr:blocked", { active: true, label: "Waiting for feedback" });
		await waitForCount(requests, 5);
		await harness.emitLifecycle("agent_settled", {}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(requestStates(requests), ["idle", "working", "blocked"]);

		harness.emitEvent("herdr:blocked", { active: false });
		await waitForCount(requests, 6);
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
			response.writeHead(requests.length === 2 ? 503 : 200);
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
		await waitForCount(requests, 3);
		assert.deepEqual(requestMethods(requests), [
			"pane.report_agent_session",
			"pane.report_agent",
			"pane.report_agent",
		]);
		assert.equal(requests[1].body.request.params.state, "idle");
		assert.equal(requests[2].body.request.params.state, "idle");
		assert.equal(requests[1].body.request.params.seq, requests[2].body.request.params.seq, "retry preserves sequence");
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
		await waitForCount(requests, 3);
		assert.deepEqual(requests.map((request) => request.method), [
			"pane.report_agent_session",
			"pane.report_agent_session",
			"pane.report_agent",
		]);
		assert.equal(requests[0].params.seq, requests[1].params.seq, "retry preserves sequence");
	} finally {
		restore();
		await close(socket);
		await rm(root, { recursive: true, force: true });
	}
});
