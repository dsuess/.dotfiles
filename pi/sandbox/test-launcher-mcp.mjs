import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const launcher = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/pi");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-launcher-mcp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const bin = path.join(root, "bin");
  for (const directory of [home, workspace, bin]) fs.mkdirSync(directory);
  const observed = path.join(root, "observed.json");
  const realPi = path.join(bin, "pi");
  fs.writeFileSync(realPi, `#!${process.execPath}
import fs from "node:fs";
fs.writeFileSync(process.env.PI_TEST_OBSERVED, JSON.stringify({ args: process.argv.slice(2), home: process.env.HOME, cwd: process.cwd(), cache: process.env.NPM_CONFIG_CACHE }));
process.exit(Number(process.env.PI_TEST_EXIT || 0));
`);
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.chmodSync(realPi, 0o755);
  // Session startup must still fail closed on either platform. MCP must not
  // require even the SRT platform prerequisite.
  fs.writeFileSync(path.join(bin, "uname"), '#!/bin/sh\nprintf "Linux\\n"\n');
  fs.chmodSync(path.join(bin, "uname"), 0o755);
  const env = { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`, PI_TEST_OBSERVED: observed, PI_LAUNCHER_CHAIN: "", NPM_CONFIG_CACHE: "/tmp/caller-npm" };
  return { home, workspace, bin, observed, realPi, env, run: (args, overrides = {}) => spawnSync(launcher, args, { cwd: workspace, env: { ...env, ...overrides }, encoding: "utf8" }) };
}

for (const args of [["mcp", "list"], ["mcp", "list", "--json"], ["mcp", "--help"], ["mcp", "remove", "server with spaces"], ["mcp", "list", ""]]) {
  test(`leading MCP command forwards unchanged: ${JSON.stringify(args)}`, (t) => {
    const f = fixture(t);
    const result = f.run(args, { PI_TEST_EXIT: "23" });
    assert.equal(result.status, 23, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.observed, "utf8")), { args, home: f.home, cwd: fs.realpathSync(f.workspace), cache: "/tmp/caller-npm" });
    assert.equal(result.stderr, "");
    assert.equal(fs.existsSync(path.join(f.home, ".pi")), false);
  });
}

for (const args of [[], ["-p", "mcp"], ["tell me about mcp"], ["--help", "mcp"], ["mcp-other"]]) {
  test(`non-leading MCP does not bypass session checks: ${JSON.stringify(args)}`, (t) => {
    const f = fixture(t);
    // Pass the platform check to exercise the original missing-controller error.
    fs.writeFileSync(path.join(f.bin, "uname"), '#!/bin/sh\nprintf "Darwin\\n"\n');
    const result = f.run(args, { PATH: `${f.bin}:${process.env.PATH}` });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /controller client is missing/);
    assert.equal(fs.existsSync(f.observed), false);
  });
}

test("MCP retains executable recursion and workspace protections", (t) => {
  const f = fixture(t);
  const untrustedBin = path.join(f.workspace, "bin");
  fs.mkdirSync(untrustedBin);
  fs.writeFileSync(path.join(untrustedBin, "pi"), '#!/bin/sh\nexit 99\n');
  fs.chmodSync(path.join(untrustedBin, "pi"), 0o755);
  const result = f.run(["mcp", "list"], { PATH: `${path.dirname(launcher)}:${untrustedBin}:${f.env.PATH}` });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.observed, "utf8")).args, ["mcp", "list"]);
  fs.rmSync(f.observed);
  const loop = f.run(["mcp", "list"], { PI_LAUNCHER_CHAIN: fs.realpathSync(f.realPi) });
  assert.equal(loop.status, 1);
  assert.match(loop.stderr, /cannot resolve the installed Pi binary/);
  assert.equal(fs.existsSync(f.observed), false);
});

test("explicit --yolo keeps its warning and wrapper-only flag semantics for MCP", (t) => {
  const f = fixture(t);
  const result = f.run(["--yolo", "mcp", "list", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /SRT disabled by --yolo/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.observed, "utf8")).args, ["mcp", "list", "--json"]);
});
