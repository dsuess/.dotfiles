import assert from "node:assert/strict";
import test from "node:test";
import { createPiJiti } from "../../../test-helpers.mjs";

const jiti = await createPiJiti(import.meta.url);
const { createSandboxCommand, parseSandboxCommand, sandboxArgumentCompletions, SANDBOX_HELP } =
  await jiti.import(new URL("./command-ui.ts", import.meta.url).pathname);

function fixture({ hasUI = true, mode = "tui", selections = [], inputs = [], sandboxMode = "off" } = {}) {
  const calls = [];
  const reports = [];
  const dialogs = [];
  const ctx = {
    hasUI, mode,
    ui: {
      async select(title, options) { dialogs.push({ title, options }); return selections.shift(); },
      async input(title, placeholder) { dialogs.push({ title, placeholder }); return inputs.shift(); },
    },
  };
  const status = { mode: sandboxMode, summary: "OFF — host access; saved/effective differ", message: "Execution: OFF — host access\nRefresh needed: yes" };
  const actions = {
    async status(context) { assert.equal(context, ctx); calls.push(["status"]); return status; },
    async listGrants(context) { assert.equal(context, ctx); calls.push(["list"]); return { message: "Saved: ro /shared\nEffective: none" }; },
    async setMode(mode, context) { assert.equal(context, ctx); calls.push(["mode", mode]); return { message: `Mode: ${mode}`, level: mode === "off" ? "warning" : "info" }; },
    async addGrant(access, path, context) { assert.equal(context, ctx); calls.push(["add", access, path]); return { message: "Saved and effective grants updated." }; },
    async removeGrant(path, context) { assert.equal(context, ctx); calls.push(["remove", path]); return { message: "Configured grant removed." }; },
    async reloadGrants(context) { assert.equal(context, ctx); calls.push(["reloadGrants"]); return { message: "Saved grants reloaded." }; },
    report(result, context) { assert.equal(context, ctx); reports.push(result); },
  };
  return { calls, reports, dialogs, ctx, actions, command: createSandboxCommand(actions) };
}

test("parser recognizes exact syntax and treats the path remainder as one literal path", () => {
  for (const kind of ["status", "on", "off", "reload", "help"]) {
    assert.deepEqual(parseSandboxCommand(` ${kind} `), { kind });
  }
  assert.deepEqual(parseSandboxCommand("  "), { kind: "menu" });
  assert.deepEqual(parseSandboxCommand("grants list"), { kind: "list" });
  assert.deepEqual(parseSandboxCommand("grants add ro /Users/me/shared skills"), { kind: "add", access: "ro", path: "/Users/me/shared skills" });
  assert.deepEqual(parseSandboxCommand("grants\tadd\trw\t~/scratch  space"), { kind: "add", access: "rw", path: "~/scratch  space" });
  assert.deepEqual(parseSandboxCommand("grants remove /a path/with more spaces"), { kind: "remove", path: "/a path/with more spaces" });
});

test("unsupported and incomplete syntax never falls back to status", () => {
  for (const args of ["unknown", "status extra", "on extra", "off yes", "reload controller", "help extra", "grants", "grants list extra", "grants add", "grants add ro", "grants add rx /tmp", "grants remove", "grants reset /tmp", "grants add rw /a\n/b", "status\0"]) {
    assert.throws(() => parseSandboxCommand(args), /Invalid \/sandbox syntax.*\/sandbox help/s, args);
  }
});

test("completion offers supported subcommands but does not reinterpret path text", () => {
  assert.deepEqual(sandboxArgumentCompletions("o").map((item) => item.value), ["on", "off"]);
  assert.deepEqual(sandboxArgumentCompletions("grants a").map((item) => item.value), ["grants add ro", "grants add rw"]);
  assert.deepEqual(sandboxArgumentCompletions("grants add r").map((item) => item.value), ["grants add ro", "grants add rw"]);
  assert.equal(sandboxArgumentCompletions("grants add ro /path with spaces"), null);
  assert.equal(sandboxArgumentCompletions("wat"), null);
  for (const value of ["status", "on", "off", "grants list", "grants add ro", "grants add rw", "grants remove", "reload", "help"]) {
    assert.ok(SANDBOX_HELP.includes(`/sandbox ${value}`));
    assert.ok(sandboxArgumentCompletions("").some((item) => item.value === value));
  }
});

test("explicit commands dispatch to the injected services with no dialogs", async () => {
  const f = fixture();
  for (const args of ["status", "on", "off", "grants list", "grants add ro /shared skills", "grants add rw ~/some scratch", "grants remove /shared skills", "reload", "help"]) {
    await f.command.handler(args, f.ctx);
  }
  assert.deepEqual(f.calls, [["status"], ["mode", "on"], ["mode", "off"], ["list"], ["add", "ro", "/shared skills"], ["add", "rw", "~/some scratch"], ["remove", "/shared skills"], ["reloadGrants"]]);
  assert.deepEqual(f.dialogs, []);
  assert.equal(f.reports[2].level, "warning");
  assert.equal(f.reports.at(-1).message, SANDBOX_HELP);
});

test("menu combines compact injected status with only supported actions", async () => {
  const f = fixture({ selections: ["Show status"] });
  await f.command.handler("", f.ctx);
  assert.deepEqual(f.calls, [["status"]]);
  assert.match(f.dialogs[0].title, /OFF — host access; saved\/effective differ/);
  assert.deepEqual(f.dialogs[0].options, ["Show status", "Turn sandbox on", "List saved and effective grants", "Add or change a saved grant", "Remove a saved grant", "Reload saved grants for this client", "Help"]);
  assert.equal(f.reports[0].message, "Execution: OFF — host access\nRefresh needed: yes");
});

test("menu actions use the same services as subcommands, including literal spaced paths", async () => {
  const cases = [
    { selections: ["Turn sandbox on"], expected: ["mode", "on"] },
    { sandboxMode: "on", selections: ["Turn sandbox off — host access"], expected: ["mode", "off"] },
    { selections: ["List saved and effective grants"], expected: ["list"] },
    { selections: ["Add or change a saved grant", "Read-only (ro)"], inputs: [" /a  spaced path "], expected: ["add", "ro", "/a  spaced path"] },
    { selections: ["Add or change a saved grant", "Read-write (rw)"], inputs: ["~/a spaced path"], expected: ["add", "rw", "~/a spaced path"] },
    { selections: ["Remove a saved grant"], inputs: ["/a spaced path"], expected: ["remove", "/a spaced path"] },
    { selections: ["Reload saved grants for this client"], expected: ["reloadGrants"] },
  ];
  for (const options of cases) {
    const f = fixture(options);
    await f.command.handler("", f.ctx);
    assert.deepEqual(f.calls, [["status"], options.expected]);
  }
  const f = fixture({ selections: ["Help"] });
  await f.command.handler("", f.ctx);
  assert.deepEqual(f.calls, [["status"]]);
  assert.equal(f.reports[0].message, SANDBOX_HELP);
});

test("cancellation at each dialog is a no-op", async () => {
  for (const options of [
    {},
    { selections: ["Add or change a saved grant"] },
    { selections: ["Add or change a saved grant", "Read-only (ro)"] },
    { selections: ["Remove a saved grant"] },
  ]) {
    const f = fixture(options);
    await f.command.handler("", f.ctx);
    assert.deepEqual(f.calls, [["status"]]);
    assert.deepEqual(f.reports, []);
  }
});

test("invalid input and service failures report errors without claiming success", async () => {
  const blank = fixture({ selections: ["Add or change a saved grant", "Read-write (rw)"], inputs: ["  "] });
  await blank.command.handler("", blank.ctx);
  assert.deepEqual(blank.calls, [["status"]]);
  assert.equal(blank.reports[0].level, "error");
  const f = fixture();
  await f.command.handler("grants list extra", f.ctx);
  assert.deepEqual(f.calls, []);
  assert.equal(f.reports[0].level, "error");
  f.actions.addGrant = async () => { throw new Error("Protected directory. Saved and effective grants are unchanged."); };
  await f.command.handler("grants add rw /protected", f.ctx);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.reports.at(-1), { message: "Protected directory. Saved and effective grants are unchanged.", level: "error" });
});

test("non-interactive empty command is deterministic status, with read-only list/help available", async () => {
  const f = fixture({ hasUI: false, mode: "print" });
  for (const args of ["", "status", "grants list", "help"]) await f.command.handler(args, f.ctx);
  assert.deepEqual(f.calls, [["status"], ["status"], ["list"]]);
  assert.deepEqual(f.dialogs, []);
  assert.equal(f.reports[0].message, f.reports[1].message);
  assert.equal(f.reports.at(-1).message, SANDBOX_HELP);
});

test("non-interactive mutations fail clearly without calling services", async () => {
  const f = fixture({ hasUI: false, mode: "json" });
  for (const args of ["on", "off", "grants add ro /tmp", "grants add rw /tmp", "grants remove /tmp", "reload"]) {
    await f.command.handler(args, f.ctx);
    assert.match(f.reports.at(-1).message, /requires interactive or RPC UI/);
    assert.equal(f.reports.at(-1).level, "error");
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.dialogs, []);
});

test("RPC-supported dialogs use the same menu, without terminal components", async () => {
  const f = fixture({ mode: "rpc", selections: ["Add or change a saved grant", "Read-only (ro)"], inputs: ["/RPC spaced path"] });
  await f.command.handler("", f.ctx);
  assert.deepEqual(f.calls, [["status"], ["add", "ro", "/RPC spaced path"]]);
  assert.equal(f.dialogs.length, 3);
});

test("each mode offers only its opposite action; cancellation changes nothing", async () => {
  for (const sandboxMode of ["on", "off"]) {
    const f = fixture({ sandboxMode });
    await f.command.handler("", f.ctx);
    assert.deepEqual(f.dialogs[0].options.filter((row) => row.startsWith("Turn sandbox")),
      [sandboxMode === "on" ? "Turn sandbox off — host access" : "Turn sandbox on"]);
    assert.equal(f.dialogs[0].options[1], sandboxMode === "on" ? "Turn sandbox off — host access" : "Turn sandbox on");
    assert.deepEqual(f.calls, [["status"]]);
    assert.deepEqual(f.reports, []);
  }
});
