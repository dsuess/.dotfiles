import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
const launcher = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/pi");
test("launcher accepts an interactive invocation with no arguments", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-launcher-empty-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), workspace = path.join(root, "workspace"), fakeBin = path.join(root, "bin");
  fs.mkdirSync(path.join(home, ".pi/sandbox"), { recursive: true }); fs.mkdirSync(path.join(home, ".pi/agent/extensions/srt-tool-routing"), { recursive: true }); fs.mkdirSync(workspace); fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(home, ".pi/agent/extensions/srt-tool-routing/index.ts"), "");
  fs.writeFileSync(path.join(home, ".pi/sandbox/client-cli.mjs"), `if (process.argv[2] === "preflight") process.stdout.write("ZGVzY3JpcHRvcg=="); else process.exit(2);`);
  const realPi = path.join(fakeBin, "pi"); fs.writeFileSync(realPi, "#!/bin/sh\necho interactive-pi\n"); fs.chmodSync(realPi, 0o755);
  const output = execFileSync(launcher, [], { cwd: workspace, env: { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}` }, encoding: "utf8" });
  assert.equal(output, "interactive-pi\n");
});

test("print leading-bang prompt after options executes controller Bash instead of Pi", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-launcher-print-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), workspace = path.join(root, "workspace"), fakeBin = path.join(root, "bin");
  fs.mkdirSync(path.join(home, ".pi/sandbox"), { recursive: true }); fs.mkdirSync(path.join(home, ".pi/agent/extensions/srt-tool-routing"), { recursive: true }); fs.mkdirSync(workspace); fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(home, ".pi/agent/extensions/srt-tool-routing/index.ts"), "");
  fs.writeFileSync(path.join(home, ".pi/sandbox/client-cli.mjs"), `const [command, ...args] = process.argv.slice(2); if (command === "preflight") process.stdout.write("ZGVzY3JpcHRvcg=="); else if (command === "bash") process.stdout.write(args[2]); else process.exit(2);`);
  const realPi = path.join(fakeBin, "pi"); fs.writeFileSync(realPi, "#!/bin/sh\necho model-must-not-run\n"); fs.chmodSync(realPi, 0o755);
  const output = execFileSync(launcher, ["-p", "--no-session", "!docker ps"], { cwd: workspace, env: { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}` }, encoding: "utf8" });
  assert.equal(output, "docker ps");
});
