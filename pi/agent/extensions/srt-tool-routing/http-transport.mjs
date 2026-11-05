import { canonicalLocalUrl } from "./workspace-approval.mjs";
import { routedTransportLimits } from "./mcp-transport.mjs";

/** Host HTTP authority, not a process or filesystem grant. Upstream owns MCP/SSE. */
export class ApprovedHttpTransport {
  constructor({ connect, validate, createHttpTransport, onRetire = () => {}, timeoutMs = 60_000, fetch = globalThis.fetch }) {
    Object.assign(this, { connect, validate, createHttpTransport, onRetire, timeoutMs, fetch });
    this.messages = new Set(); this.errors = new Set(); this.closes = new Set();
    this.closed = false;
    this.abort = new AbortController();
    this.cancellations = new Map();
    this.connecting = null;
    this.closing = null;
  }
  onMessage(fn) { this.messages.add(fn); return () => this.messages.delete(fn); }
  onError(fn) { this.errors.add(fn); return () => this.errors.delete(fn); }
  onClose(fn) { this.closes.add(fn); return () => this.closes.delete(fn); }
  emit(listeners, value) { for (const fn of listeners) { try { fn(value); } catch {} } }
  fail(cause) {
    if (this.closed) return;
    this.emit(this.errors, cause instanceof Error ? cause : new Error(String(cause)));
    void this.close();
  }
  assertAuthority() {
    if (this.closed || this.abort.signal.aborted) throw new Error("Routed HTTP authority is retired");
    const launch = this.validate();
    if (canonicalLocalUrl(launch.url) !== this.url) throw new Error("Routed HTTP endpoint changed");
    if (!this.channel || this.channel.policyGeneration !== this.client.policyGeneration) throw new Error("Routed HTTP policy generation retired");
  }
  async start() {
    if (this.connecting || this.closed) throw new Error("Routed HTTP transport already started or retired");
    this.connecting = (async () => {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = AbortSignal.any([this.abort.signal, timeout]);
      // A late readiness result cannot create a transport after close.
      this.client = await new Promise((resolve, reject) => {
        const stop = () => reject(new Error("Routed HTTP readiness cancelled or timed out"));
        signal.addEventListener("abort", stop, { once: true });
        Promise.resolve().then(() => this.connect()).then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
        if (signal.aborted) stop();
      });
      if (this.closed) throw new Error("Routed HTTP retired during readiness");
      this.url = canonicalLocalUrl(this.validate().url);
      this.channel = { policyGeneration: this.client.policyGeneration };
      this.assertAuthority();
      this.unsubscribe = this.client.onTerminal?.(() => this.fail(new Error("Routed HTTP controller lost")));
      this.inner = await this.createHttpTransport({ url: this.url, fetch: (input, init) => this.authorizedFetch(input, init),
        maxMessageBytes: routedTransportLimits.maxMessageBytes, reconnect: { maxRetries: 0 } });
      if (this.closed) { await this.inner.close(); throw new Error("Routed HTTP retired during transport creation"); }
      this.inner.onMessage((message) => {
        try {
          this.assertAuthority();
          if (!message || message.jsonrpc !== "2.0" || Buffer.byteLength(JSON.stringify(message)) > routedTransportLimits.maxMessageBytes) throw new Error("Invalid routed HTTP message");
          if (Object.hasOwn(message, "id") && ("result" in message || "error" in message)) {
            this.cancellations.get(message.id)?.();
            this.cancellations.delete(message.id);
          }
          this.emit(this.messages, message);
        } catch (error) { this.fail(error); }
      });
      this.inner.onError((error) => this.fail(error));
      this.inner.onClose(() => { if (!this.closed) void this.close(); });
      await this.inner.start();
      if (this.closed) { await this.inner.close(); throw new Error("Routed HTTP retired during start"); }
      // Approval changes and policy replacement must also stop idle streams.
      this.monitor = setInterval(() => { try { this.assertAuthority(); } catch (error) { this.fail(error); } }, 50);
      this.monitor.unref?.();
    })();
    try { await this.connecting; } catch (error) { this.fail(error); throw error; }
  }
  setProtocolVersion(version) { this.inner?.setProtocolVersion(version); }
  async authorizedFetch(input, init = {}) {
    const cleanup = init.method === "DELETE";
    if (canonicalLocalUrl(String(input)) !== this.url) throw new Error("Routed HTTP dispatch endpoint mismatch");
    if (!cleanup) this.assertAuthority();
    else {
      // Cleanup may reach only the original, still-approved endpoint; no recovery.
      try { if (canonicalLocalUrl(this.validate().url) !== this.url) throw new Error("changed"); }
      catch { return new Response(null, { status: 204 }); }
    }
    const headers = new Headers(init.headers);
    if (headers.has("authorization")) throw new Error("Routed HTTP credentials prohibited");
    if (init.body && Buffer.byteLength(String(init.body)) > routedTransportLimits.maxMessageBytes) throw new Error("Routed HTTP request exceeds message limit");
    const signal = AbortSignal.any([...(cleanup ? [] : [this.abort.signal]), ...(init.signal ? [init.signal] : []), AbortSignal.timeout(cleanup ? 1_000 : this.timeoutMs)]);
    const response = await this.fetch(input, { ...init, headers, redirect: "error", signal });
    if (!cleanup) this.assertAuthority();
    if (!response.body) return response;
    const reader = response.body.getReader();
    let bytes = 0, cancelled = false;
    const sse = response.headers.get("content-type")?.startsWith("text/event-stream");
    const body = new ReadableStream({
      pull: async (controller) => {
        try {
          if (!cleanup) this.assertAuthority();
          const { done, value } = await reader.read();
          if (cancelled) return;
          if (!cleanup) this.assertAuthority();
          if (done) { controller.close(); return; }
          bytes += value.byteLength;
          // SSE's per-event bound is enforced by upstream, JSON/error bodies here.
          if (!sse && bytes > routedTransportLimits.maxMessageBytes) throw new Error("Routed HTTP response exceeds message limit");
          controller.enqueue(value);
        } catch (error) { if (cancelled) return; controller.error(error); void reader.cancel().catch(() => {}); if (!cleanup) this.fail(error); }
      },
      cancel: () => { cancelled = true; return reader.cancel().catch(() => {}); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  async send(message, { signal } = {}) {
    try {
      this.assertAuthority();
      if (signal?.aborted) throw new Error("Routed HTTP request cancelled");
      // Caller cancellation retires the connection while a response is pending.
      const stop = () => this.fail(new Error("Routed HTTP request cancelled"));
      const remove = () => signal?.removeEventListener("abort", stop);
      signal?.addEventListener("abort", stop, { once: true });
      if (Object.hasOwn(message, "id") && "method" in message) this.cancellations.set(message.id, remove);
      const work = this.inner.send(message, { signal });
      try { await work; }
      finally {
        if (!Object.hasOwn(message, "id") || !("method" in message)) remove();
      }
    } catch (error) {
      this.fail(error);
      // Do not leak upstream HTTP error classes: the manager retries session 404s.
      throw new Error(`Routed HTTP request failed (never replayed): ${error.message}`);
    }
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.abort.abort(); clearInterval(this.monitor); this.unsubscribe?.();
    for (const remove of this.cancellations.values()) remove();
    this.cancellations.clear();
    this.onRetire(); this.emit(this.closes);
    this.closing = (async () => {
      if (this.inner) {
        let timer;
        await Promise.race([this.inner.close().catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, 1_100); })]);
        clearTimeout(timer);
      }
      this.channel = null;
    })();
    return this.closing;
  }
}
