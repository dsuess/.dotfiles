import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireControllerLease, beginControllerStartup, ControllerClient, stopStartedController } from "./client.mjs";

function waitFor(predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error("stdio fixture timed out"));
      setTimeout(poll, 20);
    };
    poll();
  });
}

test("native stdio streams immediately, confines descendants and retires before policy activation", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stdio-native-"));
  const outside = fs.mkdtempSync(path.join(os.homedir(), ".pi-stdio-outside-"));
  const sentinel = path.join(outside, "sentinel");
  fs.writeFileSync(sentinel, "unchanged");
  fs.symlinkSync(sentinel, path.join(workspace, "escape")); // Test-only escape probe, not deployment.
  const startup = beginControllerStartup({ launchDirectory: workspace });
  const { client, leaseToken } = await acquireControllerLease({ startup, clientId: "stdio-native" });
  t.after(async () => {
    await client.release().catch(() => {});
    stopStartedController(startup);
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const sibling = await ControllerClient.connectInherited({ ...startup, leaseToken });
  t.after(() => sibling.client.destroy());
  let output = "", exited = false;
  const script = `printf 'ready:%s:%s\\n' "\${PI_LAUNCHER_CHAIN-unset}" "\${PI_SRT_TEST_AUTHORITY-unset}"; printf 'npm:%s\\n' "$NPM_CONFIG_CACHE"; mkdir -p "$NPM_CONFIG_CACHE"; printf generated > "$NPM_CONFIG_CACHE/probe"; while IFS= read -r line; do
    if [ "$line" = probe ]; then
      if /bin/cat "$OUTSIDE" >/dev/null 2>&1; then printf 'READ-ESCAPE\\n'; else printf 'read-denied\\n'; fi
      if (printf bad > "$OUTSIDE") 2>/dev/null; then printf 'WRITE-ESCAPE\\n'; else printf 'write-denied\\n'; fi
      if /bin/cat escape >/dev/null 2>&1; then printf 'LINK-ESCAPE\\n'; else printf 'link-denied\\n'; fi
      /bin/bash -c 'if /bin/cat "$OUTSIDE" >/dev/null 2>&1; then echo CHILD-READ-ESCAPE; else echo child-read-denied; fi; if (echo bad > "$OUTSIDE") 2>/dev/null; then echo CHILD-WRITE-ESCAPE; else echo child-write-denied; fi'
      printf 'inside' > fixture
      printf 'done\\n'
    else printf 'echo:%s\\n' "$line"; fi
  done`;
  const channel = await client.openProcess(["/bin/bash", "-c", script], {
    cwd: workspace, env: { OUTSIDE: sentinel, PI_LAUNCHER_CHAIN: "blocked", PI_SRT_TEST_AUTHORITY: "blocked", NPM_CONFIG_CACHE: path.join(outside, "forbidden-cache") },
    onEvent: (name, data) => { if (name === "stdout") output += data; if (name === "exit") exited = true; },
  });
  await waitFor(() => output.includes("ready"));
  assert.ok(output.includes("ready:unset:unset"), output);
  const npmCache = path.join("/tmp", `pi-srt-${process.getuid()}`, "g", startup.workspaceKey, String(startup.generation), "cache", "npm");
  await waitFor(() => output.includes(`npm:${npmCache}`) && fs.existsSync(path.join(npmCache, "probe")));
  assert.equal(fs.readFileSync(path.join(npmCache, "probe"), "utf8"), "generated");
  assert.equal(fs.existsSync(path.join(outside, "forbidden-cache")), false);
  await assert.rejects(sibling.client.request("process.input", { handle: channel.handle, policyGeneration: channel.policyGeneration, data: "" }), { code: "stdio_owner" });
  await channel.send("probe\n");
  await waitFor(() => output.includes("done"));
  assert.ok(!output.includes("ESCAPE"), output);
  for (const line of ["read-denied", "write-denied", "link-denied", "child-read-denied", "child-write-denied"]) assert.ok(output.includes(line), output);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "unchanged");
  assert.equal(fs.readFileSync(path.join(workspace, "fixture"), "utf8"), "inside");
  // Idle stdio does not prevent core operations or policy controls.
  assert.equal((await client.exec(["/bin/echo", "core"], { cwd: workspace })).exitCode, 0);
  const saved = (await client.status()).effectiveConfiguration;
  const prepared = await client.preparePolicy(saved);
  await client.activatePolicy(prepared, saved);
  await waitFor(() => exited);
  await assert.rejects(channel.send("must-not-run\n"), { code: "stdio_owner" });
  let echo = "";
  const fresh = await client.openProcess(["/bin/cat"], { cwd: workspace, onEvent: (name, data) => { if (name === "stdout") echo += data; } });
  await fresh.send("fresh\n");
  await waitFor(() => echo === "fresh\n");
  await fresh.close();
  await fresh.close();
  let processOutput = "";
  const descendant = await client.openProcess(["/bin/bash", "-c", "(trap '' TERM; exec /bin/sleep 30) & printf 'pid:%s\\n' \"$!\"; wait"], {
    cwd: workspace, onEvent: (name, data) => { if (name === "stdout") processOutput += data; },
  });
  await waitFor(() => /pid:\d+/.test(processOutput));
  const pid = Number(processOutput.match(/pid:(\d+)/)[1]);
  process.kill(pid, 0);
  await descendant.close();
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; } });
  // A disconnected owner also retires its TERM-resistant descendants.
  processOutput = "";
  await sibling.client.openProcess(["/bin/bash", "-c", "(trap '' TERM; exec /bin/sleep 30) & printf 'pid:%s\\n' \"$!\"; wait"], {
    cwd: workspace, onEvent: (name, data) => { if (name === "stdout") processOutput += data; },
  });
  await waitFor(() => /pid:\d+/.test(processOutput));
  const disconnectedPid = Number(processOutput.match(/pid:(\d+)/)[1]);
  sibling.client.destroy();
  await waitFor(() => { try { process.kill(disconnectedPid, 0); return false; } catch (error) { return error.code === "ESRCH"; } });
});
