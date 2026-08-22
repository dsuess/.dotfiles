// installed by herdr
// managed by herdr; reinstalling or updating the integration overwrites this file.
// add custom hooks/plugins beside this file instead of editing it.
// HERDR_INTEGRATION_ID=pi
// HERDR_INTEGRATION_VERSION=8
// @ts-nocheck
// Local hardening: sandboxed Pi uses the status-only HTTP broker transport below.
// Reinstalling this generated integration must preserve that transport.

import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { PLAN_MODE_WORKFLOW_STATE_EVENT } from "./plan-mode/events.ts";

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

async function sendRequest(request: unknown, shouldContinue = () => true): Promise<boolean> {
  if (!shouldContinue()) return false;
  if (await sendRequestAttempt(request, 500)) return true;
  if (!shouldContinue()) return false;
  return sendRequestAttempt(request, 1500);
}

type AgentState = "working" | "blocked" | "idle";
type SessionRef = Record<string, unknown> | undefined;

type DesiredState = {
  generation: number;
  state: AgentState;
  message?: string;
  seq: number;
  sessionRef: SessionRef;
};

const RECONCILE_DELAYS_MS = [100, 250, 500, 1000, 2000] as const;

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
  let file: string | undefined;
  let id: string | undefined;
  try {
    const candidate = ctx?.sessionManager?.getSessionFile?.();
    if (typeof candidate === "string" && candidate.startsWith("/") && existsSync(candidate)) file = candidate;
  } catch {
    // The session ID below remains a stable fallback while Pi creates its file.
  }

  try {
    const candidate = ctx?.sessionManager?.getSessionId?.();
    if (typeof candidate === "string" && candidate.length > 0) id = candidate;
  } catch {
    // Herdr can still receive a canonical state without a session reference.
  }
  return file || id ? {
    ...(file ? { agent_session_path: file } : {}),
    ...(id ? { agent_session_id: id } : {}),
  } : undefined;
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

function enqueueRequest(
  generation: number,
  request: Record<string, unknown>,
  isCurrent = () => true,
): Promise<boolean> {
  const runtime = reporterRuntime();
  const shouldContinue = () => reporterRuntime().activeGeneration === generation && isCurrent();
  const pending = runtime.operationQueue.then(async () => {
    if (!shouldContinue()) return false;
    return sendRequest(request, shouldContinue);
  });
  runtime.operationQueue = pending.then(() => {}, () => {});
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
  let completedWorkflow = false;
  let blockedCount = 0;
  let blockedMessage: string | undefined;
  let rootSession = false;
  let generation = 0;
  let sessionRef: SessionRef;
  let pendingSessionStartSource: string | undefined;
  let sessionAcknowledged = false;
  let metadataAcknowledged = false;
  let desired: DesiredState | undefined;
  let acknowledged: DesiredState | undefined;
  let deliveryFailureNotified = false;
  let latestContext: any;
  let reconcilePromise: Promise<void> | undefined;
  let reconcileGeneration = 0;
  let reconciliationRequested = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryIndex = 0;
  const deliveries = new Set<Promise<unknown>>();

  function ownsAuthority(owner = generation): boolean {
    return rootSession && owner !== 0 && reporterRuntime().activeGeneration === owner;
  }

  function track<T>(delivery: Promise<T>): Promise<T> {
    deliveries.add(delivery);
    void delivery.then(
      () => deliveries.delete(delivery),
      () => deliveries.delete(delivery),
    );
    return delivery;
  }

  function notifyDeliveryFailure(owner: number): void {
    if (deliveryFailureNotified || !ownsAuthority(owner)) return;
    deliveryFailureNotified = true;
    latestContext?.ui?.notify?.("Herdr status unavailable; retrying automatically.", "warning");
  }

  function clearRetryTimer(): void {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
  }

  function clearDeliveryFailure(): void {
    clearRetryTimer();
    retryIndex = 0;
    deliveryFailureNotified = false;
  }

  function refreshSessionRef(ctx: any): boolean {
    const next = readSessionRef(ctx);
    const changed = sessionRefKey(next) !== sessionRefKey(sessionRef);
    sessionRef = next;
    if (changed) sessionAcknowledged = false;
    return changed;
  }

  function effectiveState() {
    if (blockedCount > 0) {
      return { state: "blocked" as const, message: blockedMessage };
    }
    if (completedWorkflow) {
      return { state: "idle" as const, message: undefined };
    }
    if (agentActive) {
      return { state: "working" as const, message: undefined };
    }
    return { state: "idle" as const, message: undefined };
  }

  function updateDesired(force = false, owner = generation): void {
    if (!ownsAuthority(owner)) return;
    const next = effectiveState();
    const currentSessionKey = sessionRefKey(sessionRef);
    if (
      !force
      && desired?.generation === owner
      && desired.state === next.state
      && desired.message === next.message
      && sessionRefKey(desired.sessionRef) === currentSessionKey
    ) return;
    desired = {
      generation: owner,
      state: next.state,
      message: next.message,
      seq: nextReportSeq(),
      sessionRef: sessionRef ? { ...sessionRef } : undefined,
    };
  }

  function reportSession(owner: number): Promise<boolean> {
    if (!ownsAuthority(owner)) return Promise.resolve(false);
    const expectedSessionKey = sessionRefKey(sessionRef);
    const request = sessionRequest(sessionRef ? { ...sessionRef } : undefined, pendingSessionStartSource);
    return request
      ? track(enqueueRequest(owner, request, () => sessionRefKey(sessionRef) === expectedSessionKey))
      : Promise.resolve(false);
  }

  function reportDisplayAgent(owner: number): Promise<boolean> {
    if (!ownsAuthority(owner)) return Promise.resolve(false);
    return track(enqueueRequest(owner, metadataRequest()));
  }

  function scheduleRetry(owner: number): void {
    if (retryTimer || !ownsAuthority(owner)) return;
    const delay = RECONCILE_DELAYS_MS[Math.min(retryIndex, RECONCILE_DELAYS_MS.length - 1)];
    retryIndex += 1;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (ownsAuthority(owner)) void startReconciliation(owner, false);
    }, delay);
    retryTimer.unref?.();
  }

  async function reconcile(owner: number): Promise<void> {
    while (ownsAuthority(owner)) {
      const expectedSessionKey = sessionRefKey(sessionRef);
      if (!sessionAcknowledged) {
        const delivered = await reportSession(owner);
        if (!ownsAuthority(owner)) return;
        if (sessionRefKey(sessionRef) !== expectedSessionKey) continue;
        if (!delivered) {
          notifyDeliveryFailure(owner);
          scheduleRetry(owner);
          return;
        }
        sessionAcknowledged = true;
        pendingSessionStartSource = undefined;
      }

      if (!metadataAcknowledged) {
        const delivered = await reportDisplayAgent(owner);
        if (!ownsAuthority(owner)) return;
        if (!delivered) {
          notifyDeliveryFailure(owner);
          scheduleRetry(owner);
          return;
        }
        metadataAcknowledged = true;
      }

      // A lifecycle event can invalidate session authority while another
      // authority request is in flight. Re-check ordering before state.
      if (!sessionAcknowledged || !metadataAcknowledged) continue;

      const next = desired;
      if (!next || next.generation !== owner) return;
      if (acknowledged?.generation === owner && acknowledged.seq === next.seq) {
        clearDeliveryFailure();
        return;
      }

      const delivered = await track(enqueueRequest(
        owner,
        stateRequest(next.state, next.message, next.seq, next.sessionRef),
        () => desired === next && sessionRefKey(sessionRef) === sessionRefKey(next.sessionRef),
      ));
      if (!ownsAuthority(owner)) return;
      if (desired !== next || sessionRefKey(sessionRef) !== sessionRefKey(next.sessionRef)) continue;
      if (!sessionAcknowledged || !metadataAcknowledged) continue;
      if (!delivered) {
        notifyDeliveryFailure(owner);
        scheduleRetry(owner);
        return;
      }

      acknowledged = next;
      if (desired !== next) continue;
      clearDeliveryFailure();
      return;
    }
  }

  function startReconciliation(owner = generation, immediate = true): Promise<void> {
    if (!ownsAuthority(owner)) return Promise.resolve();
    if (immediate) clearRetryTimer();
    if (reconcilePromise && reconcileGeneration === owner) {
      reconciliationRequested = true;
      return reconcilePromise;
    }
    reconciliationRequested = false;
    const pending = reconcile(owner);
    reconcilePromise = pending;
    reconcileGeneration = owner;
    void pending.finally(() => {
      if (reconcilePromise !== pending) return;
      reconcilePromise = undefined;
      reconcileGeneration = 0;
      if (reconciliationRequested && ownsAuthority(owner)) {
        reconciliationRequested = false;
        void startReconciliation(owner);
      }
    });
    return pending;
  }

  function publishState(force = false, owner = generation): void {
    updateDesired(force, owner);
    void startReconciliation(owner);
  }

  function activateRootSession(ctx: any, sessionStartSource?: string): number {
    clearRetryTimer();
    const runtime = reporterRuntime();
    generation = ++runtime.nextGeneration;
    runtime.activeGeneration = generation;
    rootSession = true;
    sessionAcknowledged = false;
    metadataAcknowledged = false;
    pendingSessionStartSource = sessionStartSource;
    desired = undefined;
    acknowledged = undefined;
    reconciliationRequested = false;
    deliveryFailureNotified = false;
    retryIndex = 0;
    agentActive = false;
    completedWorkflow = false;
    blockedCount = 0;
    blockedMessage = undefined;
    latestContext = ctx;
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

  pi.events.on(PLAN_MODE_WORKFLOW_STATE_EVENT, (data) => {
    if (!ownsAuthority()) return;
    completedWorkflow = data?.mode === "completed";
    publishState();
  });

  pi.on("session_start", async (event, ctx) => {
    // TUI only: RPC/JSON/print modes are headless (no PTY Herdr can display),
    // and RPC still reports hasUI=true, so mode is the reliable gate.
    if (ctx?.mode !== "tui") return;

    const owner = activateRootSession(ctx, event?.reason);
    // A reload can replace this extension mid-run without another agent_start.
    agentActive = ctx?.isIdle?.() === false;
    updateDesired(true, owner);
    // Session and metadata authority must be acknowledged before lifecycle state.
    void startReconciliation(owner);
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!ownsAuthority()) return;

    const owner = generation;
    latestContext = ctx;
    refreshSessionRef(ctx);
    // Preserve the existing session-before-turn ordering even when the
    // canonical reference has not changed.
    sessionAcknowledged = false;
    completedWorkflow = false;
    agentActive = true;
    updateDesired(false, owner);
    void startReconciliation(owner);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!ownsAuthority() || ctx?.isIdle?.() !== true) return;
    const owner = generation;
    latestContext = ctx;
    refreshSessionRef(ctx);
    agentActive = false;
    updateDesired(false, owner);
    void startReconciliation(owner);
  });

  pi.on("session_shutdown", async () => {
    const owner = generation;
    rootSession = false;
    clearRetryTimer();
    sessionAcknowledged = false;
    metadataAcknowledged = false;
    desired = undefined;
    acknowledged = undefined;
    reconciliationRequested = false;
    latestContext = undefined;
    if (reporterRuntime().activeGeneration === owner) reporterRuntime().activeGeneration = undefined;
    await reconcilePromise;
    await Promise.allSettled([...deliveries]);
  });
}
