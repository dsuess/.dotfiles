import assert from "node:assert/strict";
import test from "node:test";

import { FilesystemPermissionBroker } from "./permission-broker.ts";

const request = (overrides = {}) => ({
  source: "tool-preflight",
  operation: "read file",
  canonicalPath: "/workspace/README.md",
  toolName: "read",
  toolCallId: "call-1",
  requestedAccess: "read",
  grantLifetimes: ["once", "session", "persistent"],
  consequences: "The tool will read a path outside the cwd-only profile.",
  ...overrides,
});

test("serializes dialogs and coalesces equivalent pending requests", async () => {
  const broker = new FilesystemPermissionBroker();
  const entered = [];
  let releaseFirst;
  const dialog = {
    hasUI: true,
    async select(title, options) {
      entered.push({ title, options });
      if (entered.length === 1) await new Promise((resolve) => { releaseFirst = resolve; });
      return options[0];
    },
  };
  const first = broker.request(request(), dialog);
  const duplicate = broker.request(request({ toolCallId: "call-2" }), dialog);
  const later = broker.request(request({ canonicalPath: "/workspace/package.json", toolCallId: "call-3" }), dialog);
  assert.strictEqual(first, duplicate);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(entered.length, 1);
  releaseFirst();
  assert.deepEqual(await first, { allowed: true, lifetime: "once" });
  assert.deepEqual(await later, { allowed: true, lifetime: "once" });
  assert.equal(entered.length, 2);
  assert.match(entered[0].title, /read file via read/);
  assert.deepEqual(entered[0].options, ["Allow once", "Allow for this session", "Always allow", "Deny"]);
});

test("fails closed for missing UI, cancellation, timeout, shutdown, and malformed paths", async () => {
  const noUi = { hasUI: false, async select() { throw new Error("must not prompt"); } };
  assert.deepEqual(await new FilesystemPermissionBroker().request(request(), noUi), { allowed: false, reason: "no-ui" });

  const aborted = new AbortController(); aborted.abort();
  const ui = { hasUI: true, async select() { return "Allow once"; } };
  assert.deepEqual(await new FilesystemPermissionBroker().request(request(), ui, aborted.signal), { allowed: false, reason: "cancelled" });

  const timeout = new FilesystemPermissionBroker({ timeoutMs: 5 });
  const waitingUi = { hasUI: true, select(_title, _options, options) { return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); } };
  assert.deepEqual(await timeout.request(request(), waitingUi), { allowed: false, reason: "timeout" });

  const stopped = new FilesystemPermissionBroker(); stopped.shutdown();
  assert.deepEqual(await stopped.request(request(), ui), { allowed: false, reason: "shutdown" });
  assert.deepEqual(await new FilesystemPermissionBroker().request(request({ canonicalPath: "/workspace/../secret" }), ui), { allowed: false, reason: "invalid-request" });
});
