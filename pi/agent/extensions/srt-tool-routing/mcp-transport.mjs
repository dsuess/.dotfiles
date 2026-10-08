const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const closedError = () => new Error("Sandboxed MCP transport is closed; requests are never replayed");

/** MCP's exported transport contract, backed exclusively by ControllerClient. */
export class RoutedMcpTransport {
  constructor({ connect, validate, onRetire = () => {} }) {
    this.connect = connect;
    this.validate = validate;
    this.onRetire = onRetire;
    this.listeners = { message: new Set(), error: new Set(), close: new Set() };
    this.buffer = Buffer.alloc(0);
    this.stderrBuffer = Buffer.alloc(0);
    this.started = false;
    this.closed = false;
    this.channel = null;
    this.removeTerminal = null;
    this.queue = Promise.resolve();
    this.queuedBytes = 0;
  }
  get stderr() { return this.stderrBuffer.toString("utf8"); }
  subscribe(name, listener) { this.listeners[name].add(listener); return () => this.listeners[name].delete(listener); }
  onMessage(listener) { return this.subscribe("message", listener); }
  onError(listener) { return this.subscribe("error", listener); }
  onClose(listener) { return this.subscribe("close", listener); }
  emit(name, value) { for (const listener of this.listeners[name]) listener(value); }
  async start() {
    if (this.started || this.closed) throw closedError();
    this.started = true;
    try {
      const client = await this.connect(); // Includes restored client policy readiness.
      if (this.closed) throw closedError();
      const launch = this.validate(); // Revalidate at every fresh connection.
      this.client = client;
      this.removeTerminal = client.onTerminal((error) => this.fail(error));
      this.channel = await client.openProcess(launch.argv, { cwd: launch.cwd, env: launch.env, onEvent: (name, data) => this.receive(name, data) });
      if (this.closed) { await this.channel.close(); throw closedError(); }
    } catch (error) { this.fail(error); throw error; }
  }
  receive(name, data) {
    if (this.closed) return;
    if (name === "exit") {
      if (this.buffer.length) this.emit("error", new Error("Sandboxed MCP closed with an incomplete message"));
      this.finish();
      return;
    }
    if (name === "stderr") {
      this.stderrBuffer = Buffer.concat([this.stderrBuffer, data]).subarray(-MAX_STDERR_BYTES);
      return;
    }
    try {
      this.buffer = Buffer.concat([this.buffer, data]);
      let newline;
      while ((newline = this.buffer.indexOf(10)) >= 0) {
        if (newline > MAX_MESSAGE_BYTES) throw new Error("Sandboxed MCP message exceeds its byte limit");
        const line = this.buffer.subarray(0, newline).toString("utf8").trim();
        this.buffer = this.buffer.subarray(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" || (typeof message.method !== "string" && !("result" in message) && !("error" in message))) throw new Error("Invalid sandboxed MCP JSON-RPC message");
        this.emit("message", message);
      }
      if (this.buffer.length > MAX_MESSAGE_BYTES) throw new Error("Sandboxed MCP message exceeds its byte limit");
    } catch (error) { this.fail(error); }
  }
  async send(message) {
    if (!this.channel || this.closed) throw closedError();
    const payload = Buffer.from(`${JSON.stringify(message)}\n`);
    if (payload.length > MAX_MESSAGE_BYTES || this.queuedBytes + payload.length > MAX_MESSAGE_BYTES) {
      const error = new Error("Sandboxed MCP input exceeds its buffer limit");
      this.fail(error);
      throw error;
    }
    this.queuedBytes += payload.length;
    const sending = this.queue.then(async () => {
      if (this.closed) throw closedError();
      await this.channel.send(payload);
    });
    this.queue = sending.catch(() => {});
    try { await sending; }
    catch (error) { this.fail(error); throw error; }
    finally { this.queuedBytes -= payload.length; }
  }
  fail(error) {
    if (this.closed) return;
    this.emit("error", error instanceof Error ? error : new Error(String(error)));
    void this.close().catch(() => {});
  }
  finish() {
    if (this.closed) return;
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    this.removeTerminal?.();
    this.removeTerminal = null;
    this.onRetire();
    this.emit("close");
  }
  async close() {
    if (this.closed) return;
    this.finish(); // Revoke tool authority before waiting for process cleanup.
    await this.channel?.close();
  }
}

export const routedTransportLimits = Object.freeze({ maxMessageBytes: MAX_MESSAGE_BYTES, maxStderrBytes: MAX_STDERR_BYTES });
