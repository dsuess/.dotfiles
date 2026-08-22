// Locally owned broker reporter. It is enabled only when the sandbox wrapper
// grants the authenticated loopback status capability. Herdr owns the adjacent
// generated `herdr-agent-state.ts` direct-socket integration.
// @ts-nocheck

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { PLAN_MODE_WORKFLOW_STATE_EVENT } from "./plan-mode/events.ts";
import { HERDR_FEEDBACK_SNAPSHOT_EVENT, type HerdrFeedbackSource } from "./herdr-feedback-state/events.ts";

const HERDR_ENV = process.env.HERDR_ENV;
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
  // --yolo keeps HERDR_SOCKET_PATH for Herdr's generated integration. The
  // local reporter must never become a second direct-socket authority.
  return HERDR_ENV === "1" && !!paneId && usesStatusBroker();
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

function sendRequestAttempt(request: unknown, timeoutMs: number): Promise<boolean> {
  if (!enabled()) return Promise.resolve(true);
  return sendBrokerRequestAttempt(request, timeoutMs);
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

type Transition = {
  at: string;
  stage: string;
  desired?: AgentState;
  sources: HerdrFeedbackSource[];
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

function logicalRequestId(kind: string, key: string): string {
  return `${source}:${kind}:${createHash("sha256").update(key).digest("hex")}`;
}

function sessionRequest(sessionRef: SessionRef, sessionStartSource?: string, id?: string): Record<string, unknown> | undefined {
  if (!sessionRef) return undefined;
  return {
    id: id ?? logicalRequestId("session", JSON.stringify(sessionRef)),
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

function metadataRequest(id?: string): Record<string, unknown> {
  return {
    id: id ?? logicalRequestId("metadata", "default"),
    method: "pane.report_metadata",
    params: {
      pane_id: paneId,
      source,
      display_agent: "π",
      seq: nextReportSeq(),
    },
  };
}

function stateRequest(
  state: AgentState,
  message: string | undefined,
  seq: number,
  sessionRef: SessionRef,
  id = logicalRequestId("state", String(seq)),
): Record<string, unknown> {
  return {
    id,
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
  let feedbackSnapshotSeen = false;
  let feedbackSources = new Map<string, HerdrFeedbackSource>();
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
  let history: Transition[] = [];
  const deliveries = new Set<Promise<unknown>>();

  function diagnosticSources(): HerdrFeedbackSource[] {
    return [...feedbackSources.values()]
      .map((source) => ({ ...source }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  function recordTransition(stage: string): void {
    history.push({ at: new Date().toISOString(), stage, desired: desired?.state, sources: diagnosticSources() });
    if (history.length > 24) history.shift();
  }

  function describeState(value: DesiredState | undefined): Record<string, unknown> | undefined {
    return value ? {
      state: value.state,
      ...(value.message ? { message: value.message } : {}),
      seq: value.seq,
      session_reference: value.sessionRef,
    } : undefined;
  }

  function diagnosticSnapshot(): Record<string, unknown> {
    const effective = effectiveState();
    return {
      active_sources: diagnosticSources(),
      pi_lifecycle: { agent_active: agentActive, settled: !agentActive },
      completed_workflow_idle_override: completedWorkflow,
      effective_desired_state: { state: effective.state, ...(effective.message ? { message: effective.message } : {}) },
      desired: describeState(desired),
      acknowledged: describeState(acknowledged),
      delivery: {
        retry_pending: retryTimer !== undefined,
        retry_attempt: retryIndex,
        outage: deliveryFailureNotified,
        session_acknowledged: sessionAcknowledged,
        metadata_acknowledged: metadataAcknowledged,
      },
      session_reference: sessionRef,
      transport: usesStatusBroker() ? "authenticated-loopback-broker" : "native-unix-socket",
      history: [...history],
    };
  }

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
    recordTransition("delivery-failure");
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
    const activeSources = [...feedbackSources.values()].sort((left, right) => left.id.localeCompare(right.id));
    if (activeSources.length > 0) {
      return { state: "blocked" as const, message: activeSources[0]?.label };
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
    recordTransition("desired-state");
  }

  function reportSession(owner: number): Promise<boolean> {
    if (!ownsAuthority(owner)) return Promise.resolve(false);
    const expectedSessionKey = sessionRefKey(sessionRef);
    const request = sessionRequest(
      sessionRef ? { ...sessionRef } : undefined,
      pendingSessionStartSource,
      logicalRequestId("session", `${owner}:${expectedSessionKey}`),
    );
    return request
      ? track(enqueueRequest(owner, request, () => sessionRefKey(sessionRef) === expectedSessionKey))
      : Promise.resolve(false);
  }

  function reportDisplayAgent(owner: number): Promise<boolean> {
    if (!ownsAuthority(owner)) return Promise.resolve(false);
    return track(enqueueRequest(owner, metadataRequest(logicalRequestId("metadata", String(owner)))));
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
        recordTransition("session-acknowledged");
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
        recordTransition("metadata-acknowledged");
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
        stateRequest(
          next.state,
          next.message,
          next.seq,
          next.sessionRef,
          logicalRequestId("state", `${owner}:${next.seq}`),
        ),
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
      recordTransition("state-acknowledged");
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
    history = [];
    agentActive = false;
    completedWorkflow = false;
    feedbackSnapshotSeen = false;
    feedbackSources = new Map();
    latestContext = ctx;
    refreshSessionRef(ctx);
    return generation;
  }

  pi.registerCommand("herdr-status", {
    description: "Show local Herdr status sources and delivery diagnostics",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /herdr-status", "warning");
        return;
      }
      ctx.ui.notify(JSON.stringify(diagnosticSnapshot(), null, 2), "info");
    },
  });

  pi.events.on(HERDR_FEEDBACK_SNAPSHOT_EVENT, (data) => {
    if (!ownsAuthority() || !Array.isArray(data?.sources)) return;
    const next = new Map<string, HerdrFeedbackSource>();
    for (const source of data.sources) {
      if (
        !source || typeof source.id !== "string" || !source.id
        || typeof source.label !== "string" || !source.label
      ) continue;
      next.set(source.id, { id: source.id, label: source.label });
    }
    feedbackSnapshotSeen = true;
    feedbackSources = next;
    recordTransition("feedback-snapshot");
    publishState();
  });

  // Compatibility only for direct tests and --yolo's generated integration.
  // The brokered reporter gives a full snapshot precedence over this lossy edge.
  pi.events.on("herdr:blocked", (data) => {
    if (!ownsAuthority() || feedbackSnapshotSeen) return;
    if (data?.active === true) feedbackSources.set("legacy", {
      id: "legacy",
      label: typeof data.label === "string" && data.label ? data.label : "waiting for feedback",
    });
    else feedbackSources.delete("legacy");
    recordTransition("legacy-feedback-edge");
    publishState();
  });

  pi.events.on(PLAN_MODE_WORKFLOW_STATE_EVENT, (data) => {
    if (!ownsAuthority()) return;
    completedWorkflow = data?.mode === "completed";
    recordTransition("workflow-state");
    publishState();
  });

  pi.on("session_start", async (event, ctx) => {
    // TUI only: RPC/JSON/print modes are headless (no PTY Herdr can display),
    // and RPC still reports hasUI=true, so mode is the reliable gate.
    if (ctx?.mode !== "tui") return;

    const owner = activateRootSession(ctx, event?.reason);
    // A reload can replace this extension mid-run without another agent_start.
    agentActive = ctx?.isIdle?.() === false;
    recordTransition("session-start");
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
    recordTransition("agent-start");
    updateDesired(false, owner);
    void startReconciliation(owner);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!ownsAuthority() || ctx?.isIdle?.() !== true) return;
    const owner = generation;
    latestContext = ctx;
    refreshSessionRef(ctx);
    agentActive = false;
    recordTransition("agent-settled");
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
