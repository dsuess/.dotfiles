import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const BROKER = new URL("./herdr-status-broker.mjs", import.meta.url);

function waitForExit(child) {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
}

async function waitForReady(readyFile, child, stderr) {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (child.exitCode !== null) {
			throw new Error(`broker exited before readiness: ${stderr.value}`);
		}
		try {
			const [port, token] = (await readFile(readyFile, "utf8")).trim().split(" ");
			if (port && token) return { port: Number(port), token };
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`broker readiness timed out: ${stderr.value}`);
}

function send(port, token, request) {
	return new Promise((resolve, reject) => {
		const body = JSON.stringify({ token, request });
		const client = httpRequest({
			host: "127.0.0.1",
			port,
			method: "POST",
			path: "/",
			headers: {
				"Content-Type": "application/json",
				"Content-Length": Buffer.byteLength(body),
			},
		}, (response) => {
			let responseBody = "";
			response.on("data", (chunk) => {
				responseBody += chunk.toString("utf8");
			});
			response.on("end", () => resolve(JSON.parse(responseBody)));
		});
		client.on("error", reject);
		client.end(body);
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

test("broker exposes only canonical Herdr agent-status requests", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-herdr-broker-test-"));
	const herdrSocket = path.join(root, "herdr.sock");
	const readyFile = path.join(root, "ready");
	const sessionRoot = path.join(root, "sessions");
	const sessionFile = path.join(sessionRoot, "session.jsonl");
	await mkdir(sessionRoot);
	await writeFile(sessionFile, "{}\n");
	const canonicalSessionFile = await realpath(sessionFile);
	const forwarded = [];
	const herdr = createServer((socket) => {
		let input = "";
		socket.on("data", (chunk) => {
			input += chunk.toString("utf8");
			const newline = input.indexOf("\n");
			if (newline < 0) return;
			const request = JSON.parse(input.slice(0, newline));
			forwarded.push(request);
			socket.end(`${JSON.stringify({ id: request.id, result: {} })}\n`);
		});
	});
	await listen(herdr, herdrSocket);

	const stderr = { value: "" };
	const broker = spawn(process.execPath, [BROKER.pathname], {
		env: {
			HERDR_SOCKET_PATH: herdrSocket,
			HERDR_PANE_ID: "trusted-pane",
			HERDR_PI_BROKER_READY_FILE: readyFile,
			HERDR_PI_SESSION_ROOT: sessionRoot,
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	broker.stderr.on("data", (chunk) => {
		stderr.value += chunk.toString("utf8");
	});

	try {
		const { port, token } = await waitForReady(readyFile, broker, stderr);
		const stateResponse = await send(port, token, {
			id: "caller-id",
			method: "pane.report_agent",
			params: {
				pane_id: "other-pane",
				source: "attacker",
				agent: "other-agent",
				state: "working",
				message: "running tests",
				custom_status: "must not pass",
				seq: 1,
				agent_session_path: sessionFile,
			},
		});
		assert.deepEqual(stateResponse, { ok: true });
		assert.equal(forwarded.length, 1);
		assert.match(forwarded[0].id, /^herdr:pi:broker:/u);
		assert.deepEqual(
			{ ...forwarded[0], id: undefined, params: { ...forwarded[0].params, seq: undefined } },
			{
				id: undefined,
				method: "pane.report_agent",
				params: {
					pane_id: "trusted-pane",
					source: "herdr:pi",
					agent: "pi",
					state: "working",
					message: "running tests",
					agent_session_path: canonicalSessionFile,
					seq: undefined,
				},
			},
		);

		const denied = await send(port, token, {
			method: "pane.run",
			params: { pane_id: "trusted-pane", command: "touch /tmp/escaped" },
		});
		assert.deepEqual(denied, { ok: false, error: "method is not permitted" });
		assert.equal(forwarded.length, 1);

		const outsideSession = await send(port, token, {
			method: "pane.report_agent_session",
			params: { agent_session_path: "/etc/passwd" },
		});
		assert.deepEqual(outsideSession, { ok: false, error: "agent session reference is required" });
		assert.equal(forwarded.length, 1);

		const unauthorized = await send(port, "0".repeat(64), {
			method: "pane.release_agent",
			params: {},
		});
		assert.deepEqual(unauthorized, { ok: false, error: "unauthorized" });
		assert.equal(forwarded.length, 1);

		assert.deepEqual(await send(port, token, {
			method: "pane.report_agent_session",
			params: { agent_session_id: "session-7" },
		}), { ok: true });
		assert.deepEqual(await send(port, token, {
			method: "pane.release_agent",
			params: {},
		}), { ok: true });

		broker.kill("SIGTERM");
		const exit = await waitForExit(broker);
		assert.equal(exit.code, 0, stderr.value);
		assert.deepEqual(forwarded.map((request) => request.method), [
			"pane.report_agent",
			"pane.report_agent_session",
			"pane.release_agent",
			"pane.release_agent",
		]);
		for (let index = 1; index < forwarded.length; index += 1) {
			assert.ok(forwarded[index].params.seq > forwarded[index - 1].params.seq);
		}
	} finally {
		if (broker.exitCode === null) broker.kill("SIGKILL");
		await close(herdr);
		await rm(root, { recursive: true, force: true });
	}
});
