import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

function listen(server) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve(server.address().port));
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

test("official integration sends status through the configured HTTP proxy", async () => {
	const previous = {
		HERDR_ENV: process.env.HERDR_ENV,
		HERDR_PANE_ID: process.env.HERDR_PANE_ID,
		HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
		HERDR_PI_STATUS_PORT: process.env.HERDR_PI_STATUS_PORT,
		HERDR_PI_STATUS_TOKEN: process.env.HERDR_PI_STATUS_TOKEN,
		HTTP_PROXY: process.env.HTTP_PROXY,
		http_proxy: process.env.http_proxy,
	};
	const requests = [];
	const proxy = createServer((request, response) => {
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

		const lifecycle = new Map();
		const pi = {
			events: { on() {} },
			on(name, handler) {
				if (!lifecycle.has(name)) lifecycle.set(name, []);
				lifecycle.get(name).push(handler);
			},
		};
		const { default: extension } = await import(`../agent/extensions/herdr-agent-state.ts?test=${Date.now()}`);
		extension(pi);
		const ctx = {
			hasUI: true,
			sessionManager: {
				getSessionFile: () => "/tmp/pi-session.jsonl",
				getSessionId: () => "session-7",
			},
		};
		const emit = async (name, event = {}) => {
			for (const handler of lifecycle.get(name) ?? []) await handler(event, ctx);
		};

		await emit("session_start");
		await waitForCount(requests, 2);
		await emit("agent_start");
		await waitForCount(requests, 3);
		await emit("session_shutdown");
		await waitForCount(requests, 4);

		assert.deepEqual(requests.map(({ url }) => url), Array(4).fill("http://localhost:43210/"));
		assert.deepEqual(requests.map(({ host }) => host), Array(4).fill("localhost:43210"));
		assert.deepEqual(
			requests.map(({ authorization }) => authorization),
			Array(4).fill(`Basic ${Buffer.from("proxy-user:proxy-pass").toString("base64")}`),
		);
		assert.ok(requests.every(({ body }) => body.token === "status-token"));
		assert.deepEqual(requests.map(({ body }) => body.request.method), [
			"pane.report_agent_session",
			"pane.report_agent",
			"pane.report_agent",
			"pane.release_agent",
		]);
		assert.equal(requests[1].body.request.params.state, "idle");
		assert.equal(requests[2].body.request.params.state, "working");
	} finally {
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		await close(proxy);
	}
});
