import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureGondolinImage } from "./build-gondolin-image.mjs";
import { ensureControllerLease } from "./client.mjs";
import { loadSandboxPolicy } from "./policy.mjs";

function settings(mode = "public-http", workspaceRoot = null, fallbackPort = 0) {
  return {
    version: 1,
    filesystem: {
      workspace: { access: "rw", writeProtectedPaths: [".git/config"] },
      workspaceOverrides: [],
      bareCommon: { access: "rw", writeProtectedPaths: ["hooks", "config"] },
      externalMounts: [],
    },
    network: {
      mode,
      allowedHosts: [],
      allowWebSockets: false,
      tcpMappings: [],
    },
    ingress: {
      workspaceProfiles: workspaceRoot ? [{
        root: workspaceRoot,
        allowWebSockets: true,
        listeners: [
          { name: "guest-http", hostPort: 0, guestPort: 18080 },
          { name: "docker-http", hostPort: fallbackPort, guestPort: 18081 },
        ],
      }] : [],
    },
  };
}

async function guestCommandOutput(client, argv, cwd) {
  const chunks = [];
  await client.exec(argv, { cwd, env: {}, onEvent: (_stream, data) => chunks.push(data.toString()) });
  return chunks.join("");
}

async function hostRequest(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { headers }, (response) => {
      const body = [];
      response.on("data", (chunk) => body.push(chunk));
      response.on("end", () => resolve({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(body).toString() }));
    });
    request.once("error", reject);
    request.end();
  });
}

function listenHost(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

test(
  "two real clients share one QEMU VM and survive cancellation and policy restart",
  { timeout: 300_000 },
  async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-controller-native-")));
    const workspace = path.join(root, "workspace");
    const runtimeRoot = path.join(root, "runtime");
    const cacheRoot = path.join(root, "cache");
    const settingsPath = path.join(root, "settings.json");
    fs.mkdirSync(workspace);
    const occupiedListener = net.createServer();
    const occupiedPort = await listenHost(occupiedListener);
    t.after(async () => new Promise((resolve) => occupiedListener.close(resolve)));
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings("public-tcp", workspace, occupiedPort), null, 2)}\n`);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const image = await ensureGondolinImage({ verbose: false });
    const options = {
      launchDirectory: workspace,
      runtimeRoot,
      cacheRoot,
      settingsPath,
      imageDir: image.imageDir,
      heartbeatIntervalMs: 100,
      startTimeoutMs: 180_000,
    };
    const [first, second] = await Promise.all([
      ensureControllerLease({ ...options, clientId: "root-one" }),
      ensureControllerLease({ ...options, clientId: "root-two" }),
    ]);
    let firstReleased = false;
    let secondReleased = false;
    t.after(async () => {
      if (!firstReleased) await first.client.release().catch(() => {});
      if (!secondReleased) await second.client.release().catch(() => {});
    });

    assert.equal(first.manifest.pid, second.manifest.pid);
    assert.equal(first.status.vmId, second.status.vmId);
    assert.equal(first.status.policyGeneration, second.status.policyGeneration);
    assert.equal((await first.client.status()).attachedRoots, 2);
    assert.equal(first.status.dockerHealthy, true);
    assert.equal(first.status.mounts.some((mount) => mount.guestPath === "/var/lib/docker"), false);
    const guestListener = first.status.ingress.listeners.find((listener) => listener.name === "guest-http");
    const dockerListener = first.status.ingress.listeners.find((listener) => listener.name === "docker-http");
    assert.equal(first.status.ingress.health, "healthy");
    assert.equal(guestListener.fallback, false);
    assert.equal(dockerListener.fallback, true);
    assert.notEqual(dockerListener.actualPort, occupiedPort);
    assert.equal((await hostRequest(`${guestListener.url}/before-ready`)).statusCode, 502);
    assert.equal(fs.existsSync(path.join(cacheRoot, "workspaces", first.scope.workspaceKey, "docker")), false);

    const guestFile = path.join(workspace, "controller-write.txt");
    await first.client.writeFile(guestFile, "shared-vfs");
    assert.equal(fs.readFileSync(guestFile, "utf8"), "shared-vfs");
    const read = await second.client.readFile(guestFile, { offset: 0, limit: 64 });
    assert.equal(read.data.toString(), "shared-vfs");

    const dockerOutput = [];
    const docker = await second.client.exec(
      ["/usr/bin/docker", "info", "--format", "{{.Driver}}|{{.DockerRootDir}}"],
      {
        cwd: workspace,
        env: {},
        onEvent: (stream, data) => dockerOutput.push([stream, data.toString()]),
      },
    );
    assert.equal(docker.vmId, first.status.vmId);
    assert.match(dockerOutput.map((entry) => entry[1]).join(""), /^vfs\|\/var\/lib\/docker/m);

    const guestHttpCode = `const http=require("http");http.createServer((req,res)=>{res.writeHead(200,{"content-type":"text/plain","x-host":req.headers.host});res.end(req.method+" "+req.url);}).listen(18080,"127.0.0.1")`;
    await first.client.exec(["/bin/bash", "-lc", `node -e ${shellQuote(guestHttpCode)} >/tmp/pi-ingress-http.log 2>&1 &`], { cwd: workspace, env: {} });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const guestHttpLog = await guestCommandOutput(first.client, ["/bin/bash", "-lc", "cat /tmp/pi-ingress-http.log"], workspace);
    assert.equal(guestHttpLog, "");
    const guestLoopback = await guestCommandOutput(first.client, ["/bin/bash", "-lc", "node -e 'require(\"http\").get(\"http://127.0.0.1:18080/health\", r => { console.log(r.statusCode); r.resume(); })'"], workspace);
    assert.match(guestLoopback, /200/);
    let guestResponse;
    await waitFor(async () => {
      try {
        guestResponse = await hostRequest(`${guestListener.url}/nested/path?q=one`, { Host: "preserved.native.test" });
        return guestResponse.statusCode === 200;
      } catch { return false; }
    }, "guest-loopback HTTP service was not reachable through ingress");
    assert.equal(guestResponse.body, "GET /nested/path?q=one");
    assert.equal(guestResponse.headers["x-host"], "preserved.native.test");
    const dockerStartOutput = [];
    const dockerStart = await first.client.exec(["/bin/bash", "-lc", `docker run -d --name pi-ingress-http -p 18081:80 node:24-alpine node -e 'require("http").createServer((q,s)=>s.end("docker-ingress")).listen(80,"0.0.0.0")'`], {
      cwd: workspace, env: {}, onEvent: (_stream, data) => dockerStartOutput.push(data.toString()),
    });
    assert.equal(dockerStart.exitCode, 0, dockerStartOutput.join(""));
    const dockerState = await guestCommandOutput(first.client, ["/bin/bash", "-lc", "docker ps -a --format '{{.Status}}|{{.Ports}}'"], workspace);
    const dockerLogs = await guestCommandOutput(first.client, ["/bin/bash", "-lc", "docker logs pi-ingress-http"], workspace);
    assert.match(dockerState, /^Up .*18081->80\/tcp/m, `${dockerState}\n${dockerLogs}`);
    await waitFor(async () => {
      const dockerLoopback = await guestCommandOutput(first.client, ["/bin/bash", "-lc", "node -e 'require(\"http\").get(\"http://127.0.0.1:18081/\", r => { let b=\"\"; r.on(\"data\", c => b+=c); r.on(\"end\", () => console.log(r.statusCode+\":\"+b)); }).on(\"error\", () => {})'"], workspace);
      return /200:docker-ingress/.test(dockerLoopback);
    }, "guest Docker port publication was not ready", 30_000);
    await waitFor(async () => {
      try { return (await hostRequest(`${dockerListener.url}/`)).body.trim() === "docker-ingress"; } catch { return false; }
    }, "guest Docker published HTTP service was not reachable through ingress", 60_000);

    const rawProbe = await new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port: guestListener.actualPort });
      const chunks = [];
      socket.on("connect", () => socket.end(Buffer.from([0, 1, 2, 3])));
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("end", () => resolve(Buffer.concat(chunks).toString("latin1")));
      socket.on("error", reject);
    });
    assert.match(rawProbe, /^HTTP\/1\.1 400 Bad Request/);

    const oldIngressPort = guestListener.actualPort;
    const oldVmId = first.status.vmId;
    const abortController = new AbortController();
    const sleeping = first.client.exec(["/bin/bash", "-lc", "sleep 30"], {
      cwd: workspace,
      env: {},
      signal: abortController.signal,
      timeoutMs: 60_000,
    });
    setTimeout(() => abortController.abort(), 100).unref?.();
    await assert.rejects(sleeping, /cancel/i);
    const afterCancel = await second.client.status();
    assert.notEqual(afterCancel.vmId, oldVmId);
    assert.equal(afterCancel.dockerHealthy, true);
    await assert.rejects(() => new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port: oldIngressPort });
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", reject);
    }), /ECONNREFUSED/);

    fs.writeFileSync(settingsPath, `${JSON.stringify(settings("offline", workspace, occupiedPort), null, 2)}\n`);
    const expectedPolicy = loadSandboxPolicy({
      scope: first.scope,
      settingsPath,
      cacheRoot,
      runtimeRoot,
      imageGeneration: first.manifest.imageGeneration,
    });
    const afterReload = await first.client.reload();
    assert.equal(afterReload.policyGeneration, expectedPolicy.policyGeneration);
    assert.notEqual(afterReload.vmId, afterCancel.vmId);
    const converged = await second.client.status();
    assert.equal(converged.policyGeneration, expectedPolicy.policyGeneration);
    assert.equal(converged.vmId, afterReload.vmId);

    const legacyDockerDirectory = path.join(cacheRoot, "workspaces", first.scope.workspaceKey, "docker");
    fs.mkdirSync(legacyDockerDirectory, { recursive: true });
    const legacyMarker = path.join(legacyDockerDirectory, "legacy-marker");
    fs.writeFileSync(legacyMarker, "preserve-me");
    const afterReset = await first.client.resetDocker();
    assert.notEqual(afterReset.vmId, afterReload.vmId);
    assert.equal(fs.readFileSync(legacyMarker, "utf8"), "preserve-me");
    assert.equal((await second.client.status()).vmId, afterReset.vmId);

    await first.client.release();
    firstReleased = true;
    assert.equal((await second.client.status()).attachedRoots, 1);
    await second.client.release();
    secondReleased = true;
    await waitFor(
      () => !fs.existsSync(first.paths.manifestPath) && !fs.existsSync(first.paths.socketPath),
      "controller did not stop after the final lease",
    );
  },
);
