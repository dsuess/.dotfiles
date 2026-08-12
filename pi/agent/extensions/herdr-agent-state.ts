// installed by herdr
// managed by herdr; reinstalling or updating the integration overwrites this file.
// add custom hooks/plugins beside this file instead of editing it.
// HERDR_INTEGRATION_ID=pi
// HERDR_INTEGRATION_VERSION=8
// @ts-nocheck
// Local hardening: sandboxed Pi uses the status-only HTTP broker transport below.
// Reinstalling this generated integration must preserve that transport.

import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";

const HERDR_ENV = process.env.HERDR_ENV;
const socketPath = process.env.HERDR_SOCKET_PATH;
const socketEndpoint = process.platform === "win32" && socketPath ? `\\\\.\\pipe\\${socketPath}` : socketPath;
const paneId = process.env.HERDR_PANE_ID;
const statusPort = parseStatusPort(process.env.HERDR_PI_STATUS_PORT);
const statusToken = process.env.HERDR_PI_STATUS_TOKEN;
const source = "herdr:pi";

function parseStatusPort(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : undefined;
}

function usesStatusBroker() {
  return statusPort !== undefined && !!statusToken;
}

function enabled() {
  return HERDR_ENV === "1" && !!paneId && (usesStatusBroker() || !!socketEndpoint);
}

function statusProxy(): URL | undefined {
  const raw = process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!raw) return undefined;
  try {
    const proxy = new URL(raw);
    return proxy.protocol === "http:" ? proxy : undefined;
  } catch {
    return undefined;
  }
}

function sendBrokerRequestAttempt(request: unknown, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ token: statusToken, request });
    const proxy = statusProxy();
    const headers: Record<string, string | number> = {
      Host: `localhost:${statusPort}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      Connection: "close",
    };
    if (proxy?.username || proxy?.password) {
      const username = decodeURIComponent(proxy.username);
      const password = decodeURIComponent(proxy.password);
      headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    }

    let done = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const client = httpRequest({
      hostname: proxy?.hostname ?? "127.0.0.1",
      port: proxy ? Number(proxy.port || 80) : statusPort,
      method: "POST",
      path: proxy ? `http://localhost:${statusPort}/` : "/",
      headers,
    });
    const finish = (delivered: boolean) => {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      client.destroy();
      resolve(delivered);
    };

    client.on("error", () => finish(false));
    client.on("response", (response) => {
      response.resume();
      finish(response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300);
    });
    timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref?.();
    client.end(body);
  });
}

function sendSocketRequestAttempt(request: unknown, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const socket = createConnection(socketEndpoint!);
    const finish = (delivered: boolean) => {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      socket.destroy();
      resolve(delivered);
    };

    socket.on("error", () => finish(false));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", () => finish(true));
    socket.on("end", () => finish(false));
    timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref?.();
  });
}

function sendRequestAttempt(request: unknown, timeoutMs: number): Promise<boolean> {
  if (!enabled()) return Promise.resolve(true);
  return usesStatusBroker()
    ? sendBrokerRequestAttempt(request, timeoutMs)
    : sendSocketRequestAttempt(request, timeoutMs);
}

async function sendRequest(request: unknown): Promise<void> {
  if (await sendRequestAttempt(request, 500)) return;
  await sendRequestAttempt(request, 1500);
}

type AgentState = "working" | "blocked" | "idle";

type QueuedState = {
  state: AgentState;
  message?: string;
  seq: number;
};

let reportSeq = Date.now() * 1000;
let currentAgentSessionId: string | undefined;
let currentAgentSessionPath: string | undefined;

function nextReportSeq(): number {
  reportSeq += 1;
  return reportSeq;
}

function updateSessionRef(ctx: any): void {
  try {
    const file = ctx?.sessionManager?.getSessionFile?.();
    currentAgentSessionPath =
      typeof file === "string" && file.startsWith("/") ? file : undefined;
  } catch {
    currentAgentSessionPath = undefined;
  }

  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    currentAgentSessionId = typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    currentAgentSessionId = undefined;
  }
}

function withSessionRef(params: Record<string, unknown>): Record<string, unknown> {
  if (currentAgentSessionPath) {
    return { ...params, agent_session_path: currentAgentSessionPath };
  }
  if (currentAgentSessionId) {
    return { ...params, agent_session_id: currentAgentSessionId };
  }
  return params;
}

function currentSessionRef(): Record<string, unknown> | undefined {
  if (currentAgentSessionPath) {
    return { agent_session_path: currentAgentSessionPath };
  }
  if (currentAgentSessionId) {
    return { agent_session_id: currentAgentSessionId };
  }
  return undefined;
}

function reportSession(sessionStartSource?: string): Promise<void> {
  const sessionRef = currentSessionRef();
  if (!sessionRef) return Promise.resolve();

  return sendRequest({
    id: `${source}:session:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "pane.report_agent_session",
    params: {
      pane_id: paneId,
      source,
      agent: "pi",
      seq: nextReportSeq(),
      session_start_source: sessionStartSource,
      ...sessionRef,
    },
  });
}

function sendState(state: AgentState, message?: string, seq = nextReportSeq()): Promise<void> {
  return sendRequest({
    id: `${source}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "pane.report_agent",
    params: withSessionRef({
      pane_id: paneId,
      source,
      agent: "pi",
      state,
      message,
      seq,
    }),
  });
}

let sendInFlight = false;
let queuedState: QueuedState | undefined;

function queueState(state: AgentState, message?: string): void {
  queuedState = { state, message, seq: nextReportSeq() };
  if (!sendInFlight) void drainStateQueue();
}

async function drainStateQueue(): Promise<void> {
  if (sendInFlight) return;

  sendInFlight = true;
  try {
    while (queuedState) {
      const next = queuedState;
      queuedState = undefined;
      await sendState(next.state, next.message, next.seq);
    }
  } finally {
    sendInFlight = false;
    if (queuedState) void drainStateQueue();
  }
}

export default function (pi) {
  if (!enabled()) return;

  let agentActive = false;
  let blockedCount = 0;
  let blockedMessage: string | undefined;
  let lastState: AgentState | undefined;
  let lastMessage: string | undefined;
  let rootSession = false;

  function desiredState() {
    if (blockedCount > 0) {
      return { state: "blocked" as const, message: blockedMessage };
    }
    if (agentActive) {
      return { state: "working" as const, message: undefined };
    }
    return { state: "idle" as const, message: undefined };
  }

  function publishState(force = false) {
    const next = desiredState();
    if (!force && next.state === lastState && next.message === lastMessage) return;
    lastState = next.state;
    lastMessage = next.message;
    queueState(next.state, next.message);
  }

  pi.events.on("herdr:blocked", (data) => {
    if (!rootSession) return;
    if (!data?.active) {
      blockedCount = Math.max(0, blockedCount - 1);
      if (blockedCount === 0) blockedMessage = undefined;
      publishState();
      return;
    }

    blockedCount += 1;
    blockedMessage = data.label;
    publishState();
  });

  pi.on("session_start", async (event, ctx) => {
    // TUI only: RPC/JSON/print modes are headless (no PTY Herdr can display),
    // and RPC still reports hasUI=true, so mode is the reliable gate.
    if (ctx?.mode !== "tui") return;

    rootSession = true;
    updateSessionRef(ctx);
    await reportSession(event?.reason);
    // A reload can replace this extension mid-run without another agent_start.
    agentActive = ctx?.isIdle?.() === false;
    publishState(true);
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!rootSession) return;

    updateSessionRef(ctx);
    await reportSession();
    agentActive = true;
    publishState();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!rootSession || ctx?.isIdle?.() !== true) return;
    agentActive = false;
    publishState();
  });
}
