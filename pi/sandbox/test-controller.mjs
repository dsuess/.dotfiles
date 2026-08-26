import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { clientInternals, configureRuntimeCaches, ControllerClient } from "./client.mjs";
import {
  controllerInternals,
  GUEST_ENVIRONMENT,
  WorkspaceController,
} from "./controller.mjs";
import { IngressManager } from "./ingress.mjs";

const GENERATION_A = "a".repeat(64);
const GENERATION_B = "b".repeat(64);
const WORKSPACE_KEY = "c".repeat(64);
const CONTROLLER_TOKEN = "d".repeat(64);

test("guest defaults do not propagate Gondolin MITM CA overrides", () => {
  for (const name of ["SSL_CERT_FILE", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS"]) {
    assert.equal(GUEST_ENVIRONMENT[name], undefined);
  }
});

function sleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function fakeProcess(run) {
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  let started = false;
  return {
    output() {
      if (started) throw new Error("output already consumed");
      started = true;
      return (async function* () {
        try {
          const final = await run(async (stream, data) => ({ stream, data: Buffer.from(data) }));
          for (const chunk of final.chunks ?? []) yield chunk;
          resolveResult({
            ok: final.exitCode === 0,
            exitCode: final.exitCode,
            signal: undefined,
            stdout: final.stdout ?? "",
            stderr: final.stderr ?? "",
          });
        } catch (error) {
          rejectResult(error);
          throw error;
        }
      })();
    },
    then(onFulfilled, onRejected) {
      return result.then(onFulfilled, onRejected);
    },
  };
}

function createFakeVmFactory(state) {
  return async () => {
    const id = `fake-vm-${++state.vmCount}`;
    const files = state.files;
    const vm = {
      id,
      closed: false,
      async start() {
        state.starts.push(id);
      },
      async close() {
        vm.closed = true;
        state.closes.push(id);
      },
      exec(argv, options = {}) {
        state.execs.push({ vmId: id, argv });
        if (argv[0] === "/usr/bin/docker") {
          return Promise.resolve({
            ok: true,
            exitCode: 0,
            stdout: argv[1] === "info" ? state.dockerInfo : state.dockerBridge,
            stderr: "",
          });
        }
        return fakeProcess(async (chunk) => {
          state.concurrent += 1;
          state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
          try {
            if (argv[0] === "/bin/delay") {
              await sleep(Number(argv[1]), options.signal);
            } else if (argv[0] === "/bin/hang") {
              await sleep(60_000, options.signal);
            }
            return {
              exitCode: 0,
              stdout: argv[0] === "/usr/bin/docker" && argv[1] === "info"
                ? state.dockerInfo
                : argv[0] === "/usr/bin/docker" && argv[1] === "network"
                  ? state.dockerBridge
                  : "",
              chunks: argv[0] === "/bin/echo" ? [await chunk("stdout", argv.slice(1).join(" "))] : [],
            };
          } finally {
            state.concurrent -= 1;
          }
        });
      },
      fs: {
        async access(filePath) {
          if (!files.has(filePath)) throw new Error("ENOENT");
        },
        async mkdir(filePath) {
          files.set(filePath, Buffer.alloc(0));
        },
        async listDir(directory) {
          const prefix = directory.endsWith("/") ? directory : `${directory}/`;
          return [...files.keys()]
            .filter((entry) => entry.startsWith(prefix))
            .map((entry) => entry.slice(prefix.length).split("/")[0])
            .filter((entry, index, all) => entry && all.indexOf(entry) === index);
        },
        async stat(filePath) {
          const value = files.get(filePath);
          if (!value) throw new Error("ENOENT");
          return {
            mode: 0o100644,
            size: value.length,
            mtimeMs: 1,
            isFile: () => true,
            isDirectory: () => false,
            isSymbolicLink: () => false,
          };
        },
        async rename(oldPath, newPath) {
          const value = files.get(oldPath);
          if (!value) throw new Error("ENOENT");
          files.delete(oldPath);
          files.set(newPath, value);
        },
        async writeFile(filePath, data) {
          files.set(filePath, Buffer.from(data));
        },
        async deleteFile(filePath) {
          files.delete(filePath);
        },
        async readFileStream(filePath) {
          const value = files.get(filePath);
          if (!value) throw new Error("ENOENT");
          return fs.createReadStream(await writeTemporary(state, value));
        },
      },
    };
    state.vms.push(vm);
    return vm;
  };
}

async function writeTemporary(state, value) {
  const filePath = path.join(state.root, `read-${state.readCount++}`);
  fs.writeFileSync(filePath, value);
  return filePath;
}

function makeState(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-controller-unit-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    vmCount: 0,
    readCount: 0,
    starts: [],
    closes: [],
    vms: [],
    concurrent: 0,
    maxConcurrent: 0,
    execs: [],
    clockSyncs: [],
    dockerInfo: "vfs|/var/lib/docker",
    dockerBridge: "bridge|bridge\n",
    files: new Map(),
  };
}

function policy(generation = GENERATION_A) {
  return {
    policyGeneration: generation,
    imageGeneration: "e".repeat(64),
    scope: {
      workspaceKey: WORKSPACE_KEY,
      canonicalWorkspaceRoot: "/workspace",
      bareCommonDirectory: null,
    },
    mounts: [{ kind: "workspace", guestPath: "/workspace", access: "rw" }],
    network: {
      mode: "public-http",
      allowedHosts: [],
      allowWebSockets: false,
      tcpMappings: [],
    },
  };
}

function makeController(t, options = {}) {
  const state = makeState(t);
  const controller = new WorkspaceController({
    policy: options.policy ?? options.policyFactory?.(state) ?? policy(),
    policyLoader: options.policyLoader,
    imageDir: "/fake-image",
    vmFactory: createFakeVmFactory(state),
    dockerHealthCheck: options.dockerHealthCheck ?? false,
    clockSynchronizer: options.clockSynchronizer ?? (async (vm) => { state.clockSyncs.push(vm.id); }),
    cancelGraceMs: 10,
    leaseTtlMs: options.leaseTtlMs ?? 1000,
    onIdle: options.onIdle,
  });
  t.after(() => controller.close());
  return { controller, state };
}

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server.address().port;
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(() => resolve()));
}

function socketRequest(port, chunks, end = true) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const received = [];
    socket.on("connect", async () => {
      for (const chunk of chunks) {
        socket.write(chunk);
        await sleep(1);
      }
      if (end) socket.end();
    });
    socket.on("data", (chunk) => received.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(received)));
    socket.on("error", reject);
  });
}

function fakeIngressVm(t, onRequest) {
  let server = null;
  return {
    routes: null,
    setIngressRoutes(routes) { this.routes = routes; },
    async enableIngress(options) {
      assert.equal(options.listenHost, "127.0.0.1");
      server = net.createServer((socket) => onRequest(socket));
      const port = await listen(server);
      return { host: "127.0.0.1", port, url: `http://127.0.0.1:${port}`, close: () => closeServer(server) };
    },
    async close() { await closeServer(server); },
  };
}

test("ingress adapters rewrite only the HTTP request target and stream bytes", async (t) => {
  let rawRequest = Buffer.alloc(0);
  const requestDone = new Promise((resolve) => {
    const vm = fakeIngressVm(t, (socket) => {
      socket.on("data", (chunk) => {
        rawRequest = Buffer.concat([rawRequest, chunk]);
        if (rawRequest.toString().endsWith("test")) {
          socket.end("HTTP/1.1 201 Created\r\nContent-Length: 2\r\n\r\nok");
          resolve();
        }
      });
    });
    t.vm = vm;
  });
  const manager = new IngressManager({
    root: "/workspace", allowWebSockets: true,
    listeners: [{ name: "api", hostPort: 0, guestPort: 8080 }],
  });
  const vm = t.vm;
  await manager.start(vm);
  t.after(() => manager.close());
  const status = manager.status();
  assert.equal(status.health, "healthy");
  assert.equal(status.listeners[0].preferredPort, 0);
  assert.equal(status.listeners[0].fallback, false);
  const response = await socketRequest(status.listeners[0].actualPort, [
    "POST /items?q=one HTTP/", "1.1\r\nHost: preserved.test\r\nContent-Length: 4\r\n\r\nte", "st",
  ], false);
  await requestDone;
  assert.match(response.toString(), /^HTTP\/1\.1 201 Created/);
  assert.match(rawRequest.toString(), /^POST \/__pi_ingress_[a-f0-9]+\/0\/items\?q=one HTTP\/1\.1\r\nHost: preserved\.test\r\n/);
  assert.match(rawRequest.toString(), /\r\n\r\ntest$/);
  assert.equal(vm.routes[0].port, 8080);
});

test("ingress adapters tunnel WebSocket upgrade bytes when the profile permits them", async (t) => {
  let ingressOptions = null;
  const vm = fakeIngressVm(t, (socket) => {
    let initial = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      initial = Buffer.concat([initial, chunk]);
      if (!initial.includes(Buffer.from("\r\n\r\n"))) return;
      socket.removeAllListeners("data");
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
      socket.once("data", (message) => socket.end(Buffer.concat([Buffer.from("pong:"), message])));
    });
  });
  const enableIngress = vm.enableIngress.bind(vm);
  vm.enableIngress = async (options) => { ingressOptions = options; return enableIngress(options); };
  const manager = new IngressManager({ root: "/workspace", allowWebSockets: true, listeners: [{ name: "socket", hostPort: 0, guestPort: 8080 }] });
  await manager.start(vm);
  t.after(() => manager.close());
  const response = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: manager.status().listeners[0].actualPort });
    let received = Buffer.alloc(0);
    let sentMessage = false;
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error("WebSocket adapter timed out")); }, 2_000);
    socket.on("connect", () => socket.write("GET /socket HTTP/1.1\r\nHost: socket.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"));
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (!sentMessage && received.includes(Buffer.from("\r\n\r\n"))) {
        sentMessage = true;
        socket.write("ping");
      }
      if (received.includes(Buffer.from("pong:ping"))) {
        clearTimeout(timeout);
        socket.destroy();
        resolve(received);
      }
    });
    socket.on("error", (error) => { clearTimeout(timeout); reject(error); });
  });
  assert.match(response.toString(), /^HTTP\/1\.1 101 Switching Protocols/);
  assert.equal(ingressOptions.allowWebSockets, true);
});

test("ingress listener falls back only from an occupied preferred port and cleans up", async (t) => {
  const occupied = net.createServer();
  const preferredPort = await listen(occupied);
  t.after(() => closeServer(occupied));
  const vm = fakeIngressVm(t, (socket) => socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"));
  const manager = new IngressManager({
    root: "/workspace", allowWebSockets: false,
    listeners: [{ name: "api", hostPort: preferredPort, guestPort: 8080 }],
  });
  await manager.start(vm);
  const listener = manager.status().listeners[0];
  assert.equal(listener.preferredPort, preferredPort);
  assert.notEqual(listener.actualPort, preferredPort);
  assert.equal(listener.fallback, true);
  await manager.close();
  await assert.rejects(() => new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: listener.actualPort });
    socket.once("connect", () => { socket.destroy(); resolve(); });
    socket.once("error", reject);
  }), /ECONNREFUSED/);
});

test("ingress adapters reject raw and absolute-form request lines", async (t) => {
  const vm = fakeIngressVm(t, () => assert.fail("raw input must not reach the private gateway"));
  const manager = new IngressManager({ root: "/workspace", allowWebSockets: false, listeners: [{ name: "api", hostPort: 0, guestPort: 8080 }] });
  await manager.start(vm);
  t.after(() => manager.close());
  for (const input of ["debugpy\0raw", "GET http://example.test/ HTTP/1.1\r\n"]) {
    const result = await socketRequest(manager.status().listeners[0].actualPort, [input]);
    assert.match(result.toString(), /^HTTP\/1\.1 400 Bad Request/);
  }
});

test("controller publishes ingress status and replaces listeners with its VM", async (t) => {
  const privateServers = [];
  let vmNumber = 0;
  const vmFactory = async () => {
    const id = `ingress-vm-${++vmNumber}`;
    let server = null;
    return {
      id,
      async start() {},
      async close() { if (server) await closeServer(server); },
      setIngressRoutes(routes) { assert.equal(routes.length, 1); },
      async enableIngress() {
        server = net.createServer((socket) => socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"));
        privateServers.push(server);
        const port = await listen(server);
        return { port, close: () => closeServer(server) };
      },
    };
  };
  const ingressPolicy = { ...policy(), ingress: {
    root: "/workspace", allowWebSockets: false,
    listeners: [{ name: "api", hostPort: 0, guestPort: 8080 }],
  } };
  const controller = new WorkspaceController({
    policy: ingressPolicy, imageDir: "/fake-image", vmFactory, dockerHealthCheck: false,
    clockSynchronizer: async () => {},
  });
  t.after(() => controller.close());
  await controller.start();
  const first = controller.status().ingress.listeners[0];
  assert.deepEqual(Object.keys(first).sort(), ["actualPort", "fallback", "guestPort", "name", "preferredPort", "url"]);
  assert.equal(first.guestPort, 8080);
  await controller.restart(ingressPolicy.policyGeneration);
  const second = controller.status().ingress.listeners[0];
  assert.equal(controller.status().ingress.health, "healthy");
  await assert.rejects(() => new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: first.actualPort });
    socket.once("connect", () => { socket.destroy(); resolve(); });
    socket.once("error", reject);
  }), /ECONNREFUSED/);
  assert.notEqual(controller.status().vmId, "ingress-vm-1");
  assert.ok(second.actualPort > 0);
});

test("guest rootfs defaults to 64G and accepts a configured override", () => {
  assert.equal(controllerInternals.getRootfsSize({}), "64G");
  assert.equal(controllerInternals.getRootfsSize({ PI_GONDOLIN_ROOTFS_SIZE: "96G" }), "96G");
});

test("controller startup forwards the configured rootfs size only through its allowlist", () => {
  const env = clientInternals.controllerEnvironment("/runtime", {
    PATH: "/trusted/bin",
    TMPDIR: "/temporary",
    PI_GONDOLIN_ROOTFS_SIZE: "64G",
    PI_GONDOLIN_MEMORY: "4G",
    UNRELATED_SECRET: "must-not-leak",
  });
  assert.equal(env.PI_GONDOLIN_ROOTFS_SIZE, "64G");
  assert.equal(env.PI_GONDOLIN_MEMORY, "4G");
  assert.equal(env.UNRELATED_SECRET, undefined);
  assert.equal(env.PI_GONDOLIN_RUNTIME_DIR, "/runtime");
});

test("host code caches are private and use fixed private paths", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-code-cache-"));
  const previousNode = process.env.NODE_COMPILE_CACHE;
  const previousJiti = process.env.JITI_FS_CACHE;
  t.after(() => {
    if (previousNode === undefined) delete process.env.NODE_COMPILE_CACHE;
    else process.env.NODE_COMPILE_CACHE = previousNode;
    if (previousJiti === undefined) delete process.env.JITI_FS_CACHE;
    else process.env.JITI_FS_CACHE = previousJiti;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const caches = configureRuntimeCaches(root);
  assert.equal(caches.nodeCompile, path.join(root, "node-compile"));
  assert.equal(caches.jiti, path.join(root, "jiti"));
  for (const directory of [caches.root, caches.nodeCompile, caches.jiti]) {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  }
});

test("exec calls are serialized and preserve streamed output", async (t) => {
  const { controller, state } = makeController(t);
  await controller.start();
  const output = [];
  const first = controller.execute(
    "one",
    {
      argv: ["/bin/delay", "30"],
      cwd: "/workspace",
      env: {},
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      policyGeneration: GENERATION_A,
    },
    async (stream, data) => output.push([stream, data.toString()]),
  );
  const second = controller.execute(
    "two",
    {
      argv: ["/bin/echo", "hello"],
      cwd: "/workspace",
      env: {},
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      policyGeneration: GENERATION_A,
    },
    async (stream, data) => output.push([stream, data.toString()]),
  );
  await Promise.all([first, second]);
  assert.equal(state.maxConcurrent, 1);
  assert.deepEqual(output, [["stdout", "hello"]]);
});

test("Docker readiness requires vfs storage and the predefined bridge network", async (t) => {
  const { controller, state } = makeController(t, { dockerHealthCheck: true });
  await controller.start();
  assert.deepEqual(
    state.execs.filter(({ argv }) => argv[0] === "/usr/bin/docker").map(({ argv }) => argv.slice(1, 3)),
    [["info", "--format"], ["network", "inspect"]],
  );

  const failed = makeController(t, { dockerHealthCheck: true });
  failed.state.dockerBridge = "null|null\n";
  await assert.rejects(() => failed.controller.start(), /bridge readiness check failed/);
  assert.equal(failed.controller.status().health, "failed");
});

test("RTC synchronizes at boot and immediately before each requested execution", async (t) => {
  const sequence = [];
  const { controller, state } = makeController(t, {
    clockSynchronizer: async (vm) => {
      state.clockSyncs.push(vm.id);
      sequence.push("clock");
    },
  });
  await controller.start();
  const result = await controller.execute("clock", {
    argv: ["/bin/echo", "after-clock"],
    cwd: "/workspace",
    env: {},
    timeoutMs: 1000,
    maxOutputBytes: 1024,
    policyGeneration: GENERATION_A,
  }, async () => sequence.push("workload"));
  assert.equal(result.exitCode, 0);
  assert.deepEqual(state.clockSyncs, [controller.status().vmId, controller.status().vmId]);
  assert.deepEqual(sequence, ["clock", "clock", "workload"]);
});

test("RTC synchronization failure fails closed before the requested workload", async (t) => {
  let calls = 0;
  const { controller, state } = makeController(t, {
    clockSynchronizer: async () => {
      calls += 1;
      if (calls > 1) throw new Error("RTC unavailable");
    },
  });
  await controller.start();
  await assert.rejects(
    () => controller.execute("clock-failure", {
      argv: ["/bin/echo", "must-not-run"],
      cwd: "/workspace",
      env: {},
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      policyGeneration: GENERATION_A,
    }),
    /RTC unavailable/,
  );
  assert.equal(state.execs.some(({ argv }) => argv[0] === "/bin/echo"), false);
});

test("active cancellation restarts the VM before the call completes", async (t) => {
  const { controller, state } = makeController(t);
  await controller.start();
  const firstVm = controller.status().vmId;
  const execution = controller.execute("hang", {
    argv: ["/bin/hang"],
    cwd: "/workspace",
    env: {},
    timeoutMs: 60_000,
    maxOutputBytes: 1024,
    policyGeneration: GENERATION_A,
  });
  while (!controller.activeExec) await sleep(1);
  const cancelled = await controller.cancel("hang", "test cancellation");
  assert.equal(cancelled.cancelled, true);
  await assert.rejects(execution, /test cancellation/);
  assert.notEqual(controller.status().vmId, firstVm);
  assert.deepEqual(state.closes, [firstVm]);
});

test("policy reload drains active execution and admits later work on one new VM", async (t) => {
  const nextPolicy = policy(GENERATION_B);
  const { controller, state } = makeController(t, { policyLoader: async () => nextPolicy });
  await controller.start();
  const firstVm = controller.status().vmId;
  const active = controller.execute("delay", {
    argv: ["/bin/delay", "30"],
    cwd: "/workspace",
    env: {},
    timeoutMs: 1000,
    maxOutputBytes: 1024,
    policyGeneration: GENERATION_A,
  });
  while (!controller.activeExec) await sleep(1);
  const reload = controller.reload(GENERATION_B);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.status().pendingRestart, true);
  await active;
  const status = await reload;
  assert.equal(status.policyGeneration, GENERATION_B);
  assert.notEqual(status.vmId, firstVm);
  assert.equal(state.vmCount, 2);
  await assert.rejects(
    () =>
      controller.execute("stale", {
        argv: ["/bin/echo", "stale"],
        cwd: "/workspace",
        env: {},
        timeoutMs: 1000,
        maxOutputBytes: 1024,
        policyGeneration: GENERATION_A,
      }),
    /generation mismatch/,
  );
});

test("lease sharing, release, and expiry notify idle once", async (t) => {
  let idleCount = 0;
  const { controller } = makeController(t, {
    leaseTtlMs: 20,
    onIdle: () => {
      idleCount += 1;
    },
  });
  const first = controller.acquireLease(WORKSPACE_KEY, "one");
  const second = controller.acquireLease(WORKSPACE_KEY, "two");
  assert.equal(controller.status().attachedRoots, 2);
  controller.releaseLease(first);
  assert.equal(idleCount, 0);
  controller.expireLeases(Date.now() + 100);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.status().attachedRoots, 0);
  assert.equal(idleCount, 1);
  controller.expireLeases(Date.now() + 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idleCount, 1);
  assert.throws(() => controller.heartbeatLease(second), /expired/);
});

test("filesystem methods stay generation-bound and bounded", async (t) => {
  const { controller, state } = makeController(t);
  await controller.start();
  await controller.fsWriteFile({
    path: "/workspace/value",
    data: Buffer.from("abcdef").toString("base64"),
    policyGeneration: GENERATION_A,
  });
  const read = await controller.fsReadFile({
    path: "/workspace/value",
    offset: 2,
    limit: 3,
    policyGeneration: GENERATION_A,
  });
  assert.equal(Buffer.from(read.data, "base64").toString(), "cde");
  assert.equal(read.truncated, true);
  assert.equal((await controller.fsStat({ path: "/workspace/value", policyGeneration: GENERATION_A })).size, 6);
  assert.equal(state.files.get("/workspace/value").toString(), "abcdef");
  await assert.rejects(
    () => controller.fsListDir({ path: "/workspace", policyGeneration: GENERATION_B }),
    /generation mismatch/,
  );
});

test("two socket clients share one controller VM and authenticated leases", async (t) => {
  const { controller, state } = makeController(t);
  await controller.start();
  const socketPath = path.join(state.root, "controller.sock");
  const socketServer = new controllerInternals.ControllerSocketServer({
    controller,
    controllerToken: CONTROLLER_TOKEN,
    socketPath,
  });
  await socketServer.listen();
  t.after(() => socketServer.close());
  const manifest = {
    socketPath,
    controllerToken: CONTROLLER_TOKEN,
    policyGeneration: GENERATION_A,
    imageGeneration: "e".repeat(64),
    workspaceKey: WORKSPACE_KEY,
    workspaceRoot: "/workspace",
    vmId: controller.status().vmId,
  };
  const first = await ControllerClient.acquire(manifest, { heartbeatIntervalMs: 1000 });
  const second = await ControllerClient.acquire(manifest, { heartbeatIntervalMs: 1000 });
  t.after(() => first.client.destroy());
  t.after(() => second.client.destroy());
  assert.equal(first.status.vmId, second.status.vmId);
  assert.equal((await first.client.status()).attachedRoots, 2);

  const chunks = [];
  const result = await second.client.exec(["/bin/echo", "shared"], {
    cwd: "/workspace",
    env: {},
    onEvent: (stream, data) => chunks.push([stream, data.toString()]),
  });
  assert.equal(result.vmId, first.status.vmId);
  assert.deepEqual(chunks, [["stdout", "shared"]]);

  await first.client.release();
  assert.equal((await second.client.status()).attachedRoots, 1);
  await second.client.release();
});

test("Docker reset replaces the VM without touching host Docker state", async (t) => {
  const { controller, state } = makeController(t, {
    policyFactory(current) {
      const workspaceState = path.join(current.root, "workspace-state");
      const legacyDocker = path.join(workspaceState, "docker");
      fs.mkdirSync(legacyDocker, { recursive: true });
      fs.writeFileSync(path.join(legacyDocker, "marker"), "legacy");
      return { ...policy(), workspaceState };
    },
  });
  await controller.start();
  const firstVm = controller.status().vmId;
  const status = await controller.resetDocker(GENERATION_A);
  assert.notEqual(status.vmId, firstVm);
  const legacyDocker = path.join(controller.policy.workspaceState, "docker");
  assert.equal(fs.readFileSync(path.join(legacyDocker, "marker"), "utf8"), "legacy");
  assert.deepEqual(state.closes, [firstVm]);
  assert.equal(state.vmCount, 2);
});

test("exclusive controller lock recovers stale owners without stealing live locks", (t) => {
  const state = makeState(t);
  const lockPath = path.join(state.root, "controller.lock");
  assert.equal(controllerInternals.acquireControllerLock(lockPath, WORKSPACE_KEY), true);
  assert.equal(controllerInternals.acquireControllerLock(lockPath, WORKSPACE_KEY), false);
  fs.writeFileSync(lockPath, `${JSON.stringify({ pid: 2147483647, workspaceKey: WORKSPACE_KEY })}\n`);
  assert.equal(controllerInternals.acquireControllerLock(lockPath, WORKSPACE_KEY), true);
});
