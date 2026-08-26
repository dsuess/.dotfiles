import { randomBytes } from "node:crypto";
import net from "node:net";

const LISTEN_HOST = "127.0.0.1";
const MAX_REQUEST_LINE_BYTES = 8 * 1024;

function waitForListening(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: LISTEN_HOST, port, exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function reject(socket) {
  if (!socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
}

function rewriteInitialRequest(chunk, prefix) {
  const end = chunk.indexOf("\r\n");
  if (end < 0) return null;
  if (end > MAX_REQUEST_LINE_BYTES) throw new Error("request line is too large");
  const line = chunk.subarray(0, end).toString("latin1");
  const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+) ([^\x00-\x20\x7f]+) HTTP\/1\.1$/.exec(line);
  if (!match || !match[2].startsWith("/") || match[2].startsWith("//")) {
    throw new Error("request must use an HTTP/1.1 origin-form target");
  }
  return Buffer.concat([
    Buffer.from(`${match[1]} ${prefix}${match[2]} HTTP/1.1\r\n`, "latin1"),
    chunk.subarray(end + 2),
  ]);
}

function createAdapter({ gatewayPort, prefix, hostPort }) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let initial = Buffer.alloc(0);
    const onData = (chunk) => {
      initial = Buffer.concat([initial, chunk]);
      const lineEnd = initial.indexOf("\r\n");
      if (
        (lineEnd < 0 && (initial.length > MAX_REQUEST_LINE_BYTES || initial.some((byte) => byte === 0 || byte === 10 || byte === 13 || byte < 0x20 || byte > 0x7e)))
      ) {
        socket.off("data", onData);
        reject(socket);
        return;
      }
      let rewritten;
      try {
        rewritten = rewriteInitialRequest(initial, prefix);
      } catch {
        socket.off("data", onData);
        reject(socket);
        return;
      }
      if (!rewritten) return;
      socket.off("data", onData);
      socket.pause();
      const upstream = net.connect({ host: LISTEN_HOST, port: gatewayPort });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => {
        if (!socket.destroyed) socket.destroy();
      });
      upstream.once("connect", () => {
        if (socket.destroyed) return upstream.destroy();
        upstream.write(rewritten);
        socket.pipe(upstream);
        upstream.pipe(socket);
        socket.resume();
      });
    };
    socket.on("data", onData);
  });
  return { server, sockets, hostPort, prefix };
}

async function startAdapter(options) {
  let adapter = createAdapter(options);
  try {
    await waitForListening(adapter.server, options.hostPort);
    return { ...adapter, actualPort: adapter.server.address().port, fallback: false };
  } catch (error) {
    await closeServer(adapter.server).catch(() => {});
    if (options.hostPort === 0 || error?.code !== "EADDRINUSE") throw error;
    adapter = createAdapter(options);
    try {
      await waitForListening(adapter.server, 0);
      return { ...adapter, actualPort: adapter.server.address().port, fallback: true };
    } catch (fallbackError) {
      await closeServer(adapter.server).catch(() => {});
      throw fallbackError;
    }
  }
}

/** Owns the supported Gondolin HTTP ingress gateway and localhost adapters for one VM. */
export class IngressManager {
  constructor(profile) {
    this.profile = profile;
    this.gateway = null;
    this.adapters = [];
    this.secret = randomBytes(18).toString("hex");
    this.health = profile ? "starting" : "disabled";
  }

  async start(vm) {
    if (!this.profile) return;
    const routes = this.profile.listeners.map((listener, index) => ({
      prefix: `/__pi_ingress_${this.secret}/${index}`,
      port: listener.guestPort,
      stripPrefix: true,
    }));
    try {
      vm.setIngressRoutes(routes);
      this.gateway = await vm.enableIngress({
        listenHost: LISTEN_HOST,
        listenPort: 0,
        allowWebSockets: this.profile.allowWebSockets,
        hooks: {
          isAllowed: ({ path, route }) => routes.some((candidate) => candidate.prefix === route.prefix && path.startsWith(candidate.prefix)),
        },
      });
      for (const [index, listener] of this.profile.listeners.entries()) {
        const adapter = await startAdapter({
          gatewayPort: this.gateway.port,
          prefix: routes[index].prefix,
          hostPort: listener.hostPort,
        });
        this.adapters.push({ ...adapter, name: listener.name, guestPort: listener.guestPort });
      }
      this.health = "healthy";
    } catch (error) {
      this.health = "failed";
      await this.close();
      throw error;
    }
  }

  status() {
    return {
      health: this.health,
      profileRoot: this.profile?.root ?? null,
      allowWebSockets: this.profile?.allowWebSockets ?? false,
      listeners: this.adapters.map((adapter) => ({
        name: adapter.name,
        url: `http://${LISTEN_HOST}:${adapter.actualPort}`,
        preferredPort: adapter.hostPort,
        actualPort: adapter.actualPort,
        guestPort: adapter.guestPort,
        fallback: adapter.fallback,
      })),
    };
  }

  async close() {
    const adapters = this.adapters.splice(0);
    for (const adapter of adapters) {
      for (const socket of adapter.sockets) socket.destroy();
      await closeServer(adapter.server).catch(() => {});
    }
    if (this.gateway) {
      const gateway = this.gateway;
      this.gateway = null;
      await gateway.close().catch(() => {});
    }
    if (this.health !== "disabled") this.health = "stopped";
  }
}

export const ingressInternals = Object.freeze({
  LISTEN_HOST,
  MAX_REQUEST_LINE_BYTES,
  rewriteInitialRequest,
  startAdapter,
});
