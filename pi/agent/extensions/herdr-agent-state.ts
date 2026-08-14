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

async function sendRequest(request: unknown, shouldContinue = () => true): Promise<void> {
  if (!shouldContinue() || await sendRequestAttempt(request, 500)) return;
  if (!shouldContinue()) return;
  await sendRequestAttempt(request, 1500);
}

type AgentState = "working" | "blocked" | "idle";
type SessionRef = Record<string, unknown> | undefined;

type QueuedState = {
  generation: number;
  state: AgentState;
  message?: string;
  seq: number;
  sessionRef: SessionRef;
};

type ReporterRuntime = {
  activeGeneration: number | undefined;
  nextGeneration: number;
  operationQueue: Promise<void>;
  reportSeq: number;
};

// Pi reloads extension modules, but the shared event bus intentionally survives.
// Keep transport ordering and lifecycle authority outside an individual module so
// a retired reporter cannot race its replacement.
const runtimeKey = "__herdrPiReporterRuntime";

function reporterRuntime(): ReporterRuntime {
  const scope = globalThis as typeof globalThis & { [runtimeKey]?: ReporterRuntime };
  const existing = scope[runtimeKey];
  if (existing) return existing;
  const created: ReporterRuntime = {
    activeGeneration: undefined,
    nextGeneration: 0,
    operationQueue: Promise.resolve(),
    reportSeq: Date.now() * 1000,
  };
  scope[runtimeKey] = created;
  return created;
}

function nextReportSeq(): number {
  const runtime = reporterRuntime();
  runtime.reportSeq += 1;
  return runtime.reportSeq;
}

function readSessionRef(ctx: any): SessionRef {
  try {
    const file = ctx?.sessionManager?.getSessionFile?.();
    if (typeof file === "string" && file.startsWith("/")) return { agent_session_path: file };
  } catch {
    // Fall through to the session ID when the current session file is unavailable.
  }

  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (typeof id === "string" && id.length > 0) return { agent_session_id: id };
  } catch {
    // Herdr can still receive a canonical state without a session reference.
  }
  return undefined;
}

function sessionRefKey(sessionRef: SessionRef): string {
  if (!sessionRef) return "";
  if (typeof sessionRef.agent_session_path === "string") return `path:${sessionRef.agent_session_path}`;
  if (typeof sessionRef.agent_session_id === "string") return `id:${sessionRef.agent_session_id}`;
  return "";
}

function withSessionRef(params: Record<string, unknown>, sessionRef: SessionRef): Record<string, unknown> {
  return sessionRef ? { ...params, ...sessionRef } : params;
}

function enqueueRequest(generation: number, request: Record<string, unknown>): Promise<void> {
  const runtime = reporterRuntime();
  const pending = runtime.operationQueue.then(async () => {
    if (runtime.activeGeneration !== generation) return;
    await sendRequest(request, () => reporterRuntime().activeGeneration === generation);
  });
  runtime.operationQueue = pending.catch(() => {});
  return pending;
}

function sessionRequest(sessionRef: SessionRef, sessionStartSource?: string): Record<string, unknown> | undefined {
  if (!sessionRef) return undefined;
  return {
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
  };
}

function metadataRequest(): Record<string, unknown> {
  return {
    id: `${source}:metadata:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "pane.report_metadata",
    params: {
      pane_id: paneId,
      source,
      display_agent: "π",
      seq: nextReportSeq(),
    },
  };
}

function stateRequest(state: AgentState, message: string | undefined, seq: number, sessionRef: SessionRef): Record<string, unknown> {
  return {
    id: `${source}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "pane.report_agent",
    params: withSessionRef({
      pane_id: paneId,
      source,
      agent: "pi",
      state,
      message,
      seq,
    }, sessionRef),
  };
}

export default function (pi) {
  if (!enabled()) return;

  let agentActive = false;
  let blockedCount = 0;
  let blockedMessage: string | undefined;
  let lastState: AgentState | undefined;
  let lastMessage: string | undefined;
  let rootSession = false;
  let generation = 0;
  let sessionRef: SessionRef;
  let queuedState: QueuedState | undefined;
  let drainPromise: Promise<void> | undefined;
  let drainGeneration = 0;
  const deliveries = new Set<Promise<void>>();

  function ownsAuthority(owner = generation): boolean {
    return rootSession && owner !== 0 && reporterRuntime().activeGeneration === owner;
  }

  function track(delivery: Promise<void>): Promise<void> {
    deliveries.add(delivery);
    void delivery.then(
      () => deliveries.delete(delivery),
      () => deliveries.delete(delivery),
    );
    return delivery;
  }

  function reportSession(sessionStartSource?: string, owner = generation): Promise<void> {
    if (!ownsAuthority(owner)) return Promise.resolve();
    const request = sessionRequest(sessionRef, sessionStartSource);
    return request ? track(enqueueRequest(owner, request)) : Promise.resolve();
  }

  function reportDisplayAgent(owner = generation): Promise<void> {
    if (!ownsAuthority(owner)) return Promise.resolve();
    return track(enqueueRequest(owner, metadataRequest()));
  }

  function refreshSessionRef(ctx: any): boolean {
    const next = readSessionRef(ctx);
    const changed = sessionRefKey(next) !== sessionRefKey(sessionRef);
    sessionRef = next;
    return changed;
  }

  function desiredState() {
    if (blockedCount > 0) {
      return { state: "blocked" as const, message: blockedMessage };
    }
    if (agentActive) {
      return { state: "working" as const, message: undefined };
    }
    return { state: "idle" as const, message: undefined };
  }

  function queueState(state: AgentState, message: string | undefined, owner = generation): void {
    if (!ownsAuthority(owner)) return;
    queuedState = {
      generation: owner,
      state,
      message,
      seq: nextReportSeq(),
      sessionRef: sessionRef ? { ...sessionRef } : undefined,
    };
    if (!drainPromise || drainGeneration !== owner) {
      const drain = drainStateQueue(owner);
      drainPromise = drain;
      drainGeneration = owner;
      void drain.then(
        () => {
          if (drainPromise === drain) {
            drainPromise = undefined;
            drainGeneration = 0;
          }
        },
        () => {
          if (drainPromise === drain) {
            drainPromise = undefined;
            drainGeneration = 0;
          }
        },
      );
    }
  }

  async function drainStateQueue(owner: number): Promise<void> {
    while (queuedState?.generation === owner && ownsAuthority(owner)) {
      const next = queuedState;
      queuedState = undefined;
      await track(enqueueRequest(owner, stateRequest(next.state, next.message, next.seq, next.sessionRef)));
    }
    if (!ownsAuthority(owner) && queuedState?.generation === owner) queuedState = undefined;
  }

  function publishState(force = false, owner = generation): void {
    if (!ownsAuthority(owner)) return;
    const next = desiredState();
    if (!force && next.state === lastState && next.message === lastMessage) return;
    lastState = next.state;
    lastMessage = next.message;
    queueState(next.state, next.message, owner);
  }

  function activateRootSession(ctx: any): number {
    const runtime = reporterRuntime();
    generation = ++runtime.nextGeneration;
    runtime.activeGeneration = generation;
    rootSession = true;
    agentActive = false;
    blockedCount = 0;
    blockedMessage = undefined;
    lastState = undefined;
    lastMessage = undefined;
    queuedState = undefined;
    refreshSessionRef(ctx);
    return generation;
  }

  pi.events.on("herdr:blocked", (data) => {
    if (!ownsAuthority()) return;
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

    const owner = activateRootSession(ctx);
    // A current session reference must reach Herdr before any lifecycle state.
    await reportSession(event?.reason, owner);
    if (!ownsAuthority(owner)) return;
    // Keep the canonical `pi` identifier for integration state, but show π in Herdr's sidebar.
    await reportDisplayAgent(owner);
    if (!ownsAuthority(owner)) return;
    // A reload can replace this extension mid-run without another agent_start.
    agentActive = ctx?.isIdle?.() === false;
    publishState(true, owner);
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!ownsAuthority()) return;

    refreshSessionRef(ctx);
    await reportSession();
    if (!ownsAuthority()) return;
    agentActive = true;
    publishState();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!ownsAuthority() || ctx?.isIdle?.() !== true) return;
    const changedSessionRef = refreshSessionRef(ctx);
    if (changedSessionRef) await reportSession();
    if (!ownsAuthority()) return;
    agentActive = false;
    publishState();
  });

  pi.on("session_shutdown", async () => {
    const owner = generation;
    rootSession = false;
    queuedState = undefined;
    if (reporterRuntime().activeGeneration === owner) reporterRuntime().activeGeneration = undefined;
    await drainPromise;
    await Promise.allSettled([...deliveries]);
  });
}
