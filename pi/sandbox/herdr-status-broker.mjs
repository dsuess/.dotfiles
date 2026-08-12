#!/usr/bin/env node

import { randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const MAX_LINE_BYTES = 16 * 1024;
const MAX_MESSAGE_LENGTH = 4096;
const MAX_SESSION_REF_LENGTH = 4096;
const MAX_SESSION_START_SOURCE_LENGTH = 64;
const SESSION_START_SOURCES = new Set(["startup", "reload", "new", "resume", "fork"]);
const FORWARD_TIMEOUT_MS = 400;
const SOURCE = "herdr:pi";
const AGENT = "pi";
const ALLOWED_STATES = new Set(["idle", "working", "blocked"]);

const herdrSocketPath = process.env.HERDR_SOCKET_PATH;
const paneId = process.env.HERDR_PANE_ID;
const readyFile = process.env.HERDR_PI_BROKER_READY_FILE;
const configuredSessionRoot = process.env.HERDR_PI_SESSION_ROOT;
const brokerDir = process.env.HERDR_PI_BROKER_DIR;
const parentPid = Number(process.env.HERDR_PI_BROKER_PARENT_PID);

if (!herdrSocketPath || !paneId || !readyFile || !configuredSessionRoot) {
	console.error("herdr status broker: missing required environment");
	process.exit(1);
}
if (brokerDir && resolve(dirname(readyFile)) !== resolve(brokerDir)) {
	console.error("herdr status broker: readiness file is outside its private directory");
	process.exit(1);
}

let sessionRoot;
try {
	sessionRoot = realpathSync(configuredSessionRoot);
} catch {
	console.error("herdr status broker: Pi session root does not exist");
	process.exit(1);
}

const token = randomBytes(32).toString("hex");
let reportSeq = Date.now() * 1000;
let operationQueue = Promise.resolve();
let hasReportedAgent = false;
let shuttingDown = false;

function nextSeq() {
	reportSeq += 1;
	return reportSeq;
}

function sameToken(candidate) {
	if (typeof candidate !== "string") return false;
	const actual = Buffer.from(token);
	const supplied = Buffer.from(candidate);
	return actual.length === supplied.length && timingSafeEqual(actual, supplied);
}

function allowedSessionPath(candidate) {
	if (!isAbsolute(candidate) || candidate.length > MAX_SESSION_REF_LENGTH) return undefined;
	try {
		const canonical = realpathSync(candidate);
		const fromRoot = relative(sessionRoot, canonical);
		if (fromRoot !== "" && !fromRoot.startsWith("..") && !isAbsolute(fromRoot)) return canonical;
	} catch {
		// Only existing, canonical Pi session files may be reported.
	}
	return undefined;
}

function sessionRef(params) {
	if (typeof params.agent_session_path === "string") {
		const sessionPath = allowedSessionPath(params.agent_session_path);
		if (sessionPath) return { agent_session_path: sessionPath };
	}
	if (
		typeof params.agent_session_id === "string"
		&& params.agent_session_id.length > 0
		&& params.agent_session_id.length <= MAX_SESSION_REF_LENGTH
	) {
		return { agent_session_id: params.agent_session_id };
	}
	return {};
}

function sessionStartSource(params) {
	return typeof params.session_start_source === "string"
		&& params.session_start_source.length <= MAX_SESSION_START_SOURCE_LENGTH
		&& SESSION_START_SOURCES.has(params.session_start_source)
		? params.session_start_source
		: undefined;
}

function canonicalRequest(input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new Error("request must be an object");
	}

	const params = input.params;
	if (!params || typeof params !== "object" || Array.isArray(params)) {
		throw new Error("request params must be an object");
	}

	const common = {
		pane_id: paneId,
		source: SOURCE,
		agent: AGENT,
		seq: nextSeq(),
	};
	const id = `${SOURCE}:broker:${Date.now()}:${Math.random().toString(36).slice(2)}`;

	switch (input.method) {
		case "pane.report_agent": {
			if (!ALLOWED_STATES.has(params.state)) {
				throw new Error("invalid agent state");
			}
			const message = typeof params.message === "string"
				? params.message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, MAX_MESSAGE_LENGTH)
				: undefined;
			hasReportedAgent = true;
			return {
				id,
				method: "pane.report_agent",
				params: {
					...common,
					state: params.state,
					...(message ? { message } : {}),
					...sessionRef(params),
				},
			};
		}
		case "pane.report_agent_session": {
			const ref = sessionRef(params);
			if (Object.keys(ref).length === 0) {
				throw new Error("agent session reference is required");
			}
			const startSource = sessionStartSource(params);
			hasReportedAgent = true;
			return {
				id,
				method: "pane.report_agent_session",
				params: { ...common, ...ref, ...(startSource ? { session_start_source: startSource } : {}) },
			};
		}
		case "pane.release_agent":
			return {
				id,
				method: "pane.release_agent",
				params: common,
			};
		default:
			throw new Error("method is not permitted");
	}
}

function forwardToHerdr(request) {
	return new Promise((resolve, reject) => {
		let response = "";
		let settled = false;
		const socket = createConnection(herdrSocketPath);
		const timer = setTimeout(() => finish(new Error("Herdr request timed out")), FORWARD_TIMEOUT_MS);
		timer.unref?.();

		function finish(error) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve();
		}

		function consumeResponse() {
			const newline = response.indexOf("\n");
			if (newline < 0) return;
			try {
				const decoded = JSON.parse(response.slice(0, newline));
				if (decoded?.error) {
					finish(new Error(String(decoded.error.message ?? "Herdr rejected the request")));
				} else {
					finish();
				}
			} catch {
				finish(new Error("Herdr returned an invalid response"));
			}
		}

		socket.on("error", finish);
		socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", (chunk) => {
			response += chunk.toString("utf8");
			if (Buffer.byteLength(response) > MAX_LINE_BYTES) {
				finish(new Error("Herdr response is too large"));
				return;
			}
			consumeResponse();
		});
		socket.on("end", () => {
			if (!settled) finish(new Error("Herdr closed without a response"));
		});
	});
}

function enqueue(request) {
	const pending = operationQueue.then(() => forwardToHerdr(request));
	operationQueue = pending.catch(() => {});
	return pending;
}

function reply(response, status, payload) {
	if (response.destroyed) return;
	const body = JSON.stringify(payload);
	response.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(body),
		Connection: "close",
	});
	response.end(body);
}

const server = createServer((request, response) => {
	if (request.method !== "POST") {
		request.resume();
		reply(response, 405, { ok: false, error: "method must be POST" });
		return;
	}

	const declaredLength = Number(request.headers["content-length"] ?? 0);
	if (!Number.isFinite(declaredLength) || declaredLength > MAX_LINE_BYTES) {
		request.resume();
		reply(response, 413, { ok: false, error: "request is too large" });
		return;
	}

	let input = "";
	let handled = false;
	request.setTimeout(1000, () => request.destroy());
	request.on("data", (chunk) => {
		if (handled) return;
		input += chunk.toString("utf8");
		if (Buffer.byteLength(input) > MAX_LINE_BYTES) {
			handled = true;
			reply(response, 413, { ok: false, error: "request is too large" });
			request.destroy();
		}
	});
	request.on("end", () => {
		if (handled) return;
		handled = true;
		try {
			const envelope = JSON.parse(input);
			if (!sameToken(envelope?.token)) throw new Error("unauthorized");
			const canonical = canonicalRequest(envelope.request);
			void enqueue(canonical).then(
				() => reply(response, 200, { ok: true }),
				(error) => reply(response, 502, { ok: false, error: error.message }),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : "invalid request";
			reply(response, message === "unauthorized" ? 401 : 400, { ok: false, error: message });
		}
	});
});

server.maxConnections = 32;
server.headersTimeout = 1000;
server.requestTimeout = 1000;
server.keepAliveTimeout = 1000;
server.on("error", (error) => {
	console.error(`herdr status broker: ${error.message}`);
	process.exit(1);
});
server.listen(0, "127.0.0.1", () => {
	const address = server.address();
	if (!address || typeof address === "string") {
		console.error("herdr status broker: failed to bind loopback listener");
		process.exit(1);
	}
	writeFileSync(readyFile, `${address.port} ${token}\n`, { mode: 0o600 });
});

async function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	server.close();
	await operationQueue;
	if (hasReportedAgent) {
		try {
			await forwardToHerdr(canonicalRequest({ method: "pane.release_agent", params: {} }));
		} catch {
			// Best-effort cleanup when Herdr has already stopped.
		}
	}
	try {
		unlinkSync(readyFile);
	} catch {
		// The wrapper may already have removed its readiness file.
	}
	if (brokerDir) {
		try {
			rmSync(brokerDir, { recursive: true, force: true });
		} catch {
			// Process exit still closes the status capability.
		}
	}
	process.exit(0);
}

if (Number.isSafeInteger(parentPid) && parentPid > 1) {
	const parentMonitor = setInterval(() => {
		if (process.ppid !== parentPid) void shutdown();
	}, 250);
	parentMonitor.unref?.();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGHUP", () => void shutdown());
