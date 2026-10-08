import { randomBytes } from "node:crypto";

export const STDIO_CHUNK_BYTES = 64 * 1024;
export const STDIO_BUFFER_BYTES = 1024 * 1024;
export const MAX_STDIO_SESSIONS = 2;
const START_MS = 5_000;
const CLOSE_MS = 2_000;
const failure = (code, message) => Object.assign(new Error(message), { code });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Private, connection-owned channels. Idle channels do not occupy exec slots. */
export class StdioSessions {
  constructor({ spawn, emit, kill = (pid, signal) => process.kill(-pid, signal) }) {
    this.spawn = spawn;
    this.emit = emit;
    this.kill = kill;
    this.sessions = new Map();
    this.blocked = new WeakSet();
    this.closed = false;
  }
  async open(owner, requestId, params, policy) {
    if (this.closed || owner.destroyed || this.blocked.has(owner)) throw failure("stdio_unavailable", "stdio authority is retired");
    if (this.sessions.size >= MAX_STDIO_SESSIONS) throw failure("busy", "stdio process limit reached");
    const handle = randomBytes(32).toString("hex");
    const session = { owner, requestId, handle, policyGeneration: params.policyGeneration, child: null, closing: null };
    this.sessions.set(handle, session); // Reserve before asynchronous sandbox wrapping.
    let expired = false;
    let timer;
    const spawning = Promise.resolve().then(() => this.spawn(params, policy)).then(async (child) => {
      session.child = child;
      if (expired || this.closed || owner.destroyed || this.blocked.has(owner)) {
        session.closing = null;
        await this.closeSession(session);
        throw failure("stdio_unavailable", "stdio startup was retired");
      }
      child.stdin.on("error", () => void this.closeSession(session).catch(() => {}));
      child.on("error", () => void this.closeSession(session).catch(() => {}));
      for (const name of ["stdout", "stderr"]) child[name].on("data", (chunk) => {
        for (let offset = 0; offset < chunk.length; offset += STDIO_CHUNK_BYTES) {
          if (session.closing) return;
          if (owner.destroyed || owner.writableLength > STDIO_BUFFER_BYTES) {
            void this.closeSession(session).catch(() => {});
            return;
          }
          this.emit(session, name, chunk.subarray(offset, offset + STDIO_CHUNK_BYTES));
        }
      });
      // Kill surviving descendants even when their parent exits normally.
      child.once("exit", () => void this.closeSession(session).catch(() => {}));
      return { handle, policyGeneration: session.policyGeneration };
    });
    try {
      return await Promise.race([spawning, new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; this.blocked.add(owner); reject(failure("stdio_start_timeout", "stdio startup timed out")); }, START_MS);
      })]);
    } catch (error) {
      if (session.child) await this.closeSession(session);
      else if (!expired) this.sessions.delete(handle);
      throw error;
    } finally { clearTimeout(timer); }
  }
  owned(owner, handle, generation) {
    const session = this.sessions.get(handle);
    if (!session || session.owner !== owner) throw failure("stdio_owner", "stdio handle does not belong to this connection");
    if (session.policyGeneration !== generation || this.blocked.has(owner) || session.closing) throw failure("stale_generation", "stdio policy is retired");
    return session;
  }
  async input(owner, params) {
    const session = this.owned(owner, params.handle, params.policyGeneration);
    const data = Buffer.from(params.data, "base64");
    if (session.child.stdin.writableLength + data.length > STDIO_BUFFER_BYTES) {
      await this.closeSession(session);
      throw failure("stdio_backpressure", "stdio input buffer exceeded");
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void this.closeSession(session).catch(() => {}); reject(failure("stdio_backpressure", "stdio input stalled")); }, CLOSE_MS);
      session.child.stdin.write(data, (error) => { clearTimeout(timer); error ? reject(error) : resolve(); });
    });
    return { written: data.length };
  }
  async close(owner, params) {
    // Duplicate closes are harmless, but cannot affect another owner's handle.
    if (!this.sessions.has(params.handle)) return { closed: true };
    await this.closeSession(this.owned(owner, params.handle, params.policyGeneration));
    return { closed: true };
  }
  async closeSession(session) {
    if (session.closing) return session.closing;
    session.closing = (async () => {
      const child = session.child;
      if (!child) return; // Startup completion observes retired authority.
      const signal = (name) => { try { this.kill(child.pid, name); return true; } catch (error) { if (error.code === "ESRCH") return false; error.message = `stdio process group ${child.pid} signal ${name}: ${error.message}`; throw error; } };
      try {
        const signalled = signal("SIGTERM");
        child.stdin.destroy();
        if (signalled) {
          await delay(100);
          signal("SIGKILL");
          const deadline = Date.now() + CLOSE_MS;
          while (signal(0)) {
            if (Date.now() >= deadline) throw failure("stdio_cleanup", "stdio process group did not retire");
            await delay(20);
          }
        }
        this.sessions.delete(session.handle);
        if (!session.owner.destroyed) this.emit(session, "exit", Buffer.alloc(0));
      } catch (error) { this.blocked.add(session.owner); throw error; }
    })();
    return session.closing;
  }
  async retire(owner) {
    this.blocked.add(owner);
    await Promise.all([...this.sessions.values()].filter((s) => s.owner === owner).map((s) => this.closeSession(s)));
  }
  allow(owner) { if ([...this.sessions.values()].some((s) => s.owner === owner)) throw failure("stdio_cleanup", "old stdio authority remains"); this.blocked.delete(owner); }
  async shutdown() { this.closed = true; await Promise.all([...new Set([...this.sessions.values()].map((s) => s.owner))].map((owner) => this.retire(owner))); }
}
