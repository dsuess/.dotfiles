import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { buildSrtPolicy } from "./srt-policy.mjs";

const exec = promisify(execFile);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

test("native macOS TLS verifies a controlled certificate and rejects untrusted and wrong-host certificates", { skip: process.platform !== "darwin", timeout: 30000 }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-tls-")));
  const home = path.join(root, "home"), workspace = path.join(root, "workspace"), controller = path.join(root, "controller"), broker = path.join(root, "broker");
  for (const dir of [home, workspace, controller, broker]) fs.mkdirSync(dir, { recursive: true });
  const key = path.join(workspace, "key.pem"), cert = path.join(workspace, "cert.pem"), config = path.join(workspace, "openssl.cnf");
  fs.writeFileSync(config, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:TRUE\n");
  const generated = spawnSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key, "-out", cert, "-config", config], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (_req, res) => res.end("verified"));
  let initialized = false; const originalCwd = process.cwd();
  t.after(async () => {
    process.chdir(originalCwd);
    if (initialized) await SandboxManager.reset();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const socket = path.join(broker, "docker.sock"); fs.writeFileSync(socket, "");
  process.chdir(workspace);
  const policy = buildSrtPolicy({ home, workspaceRoot: workspace, controllerRoot: controller, dockerSocket: socket });
  await SandboxManager.initialize(policy, async () => true); initialized = true;
  const port = server.address().port;
  async function curl(args) {
    const command = ["/usr/bin/curl", "--silent", "--show-error", "--noproxy", "*", "--max-time", "5", ...args].map(quote).join(" ");
    const wrapped = await SandboxManager.wrapWithSandbox(command, "sh");
    try {
      const result = await exec("/bin/sh", ["-c", wrapped], { cwd: workspace, env: { HOME: workspace, PATH: process.env.PATH, TMPDIR: os.tmpdir() } });
      return { code: 0, ...result };
    } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  }
  const trusted = await curl(["--cacert", cert, `https://localhost:${port}/`]);
  assert.equal(trusted.code, 0, trusted.stderr); assert.equal(trusted.stdout, "verified");
  const untrusted = await curl([`https://localhost:${port}/`]);
  assert.equal(untrusted.code, 60, untrusted.stderr);
  const wrongHost = await curl(["--cacert", cert, `https://127.0.0.1:${port}/`]);
  assert.equal(wrongHost.code, 60, wrongHost.stderr);
});
