import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { readdir } from "node:fs/promises";
import { createPiJiti } from "../test-helpers.mjs";
import { createRepository, runCommand, write } from "../agent/extensions/git-tree-checkpoints/test/fixtures.mjs";
import { captureCheckpoint, findGitRepository } from "../agent/extensions/git-tree-checkpoints/git-checkpoints.js";
const jiti = await createPiJiti(import.meta.url);
const { createGitTreeCheckpointsExtension } = await jiti.import("../agent/extensions/git-tree-checkpoints/index.ts");

export async function captureHarness(root, overrides = {}) {
 const handlers = new Map(), entries = [], warnings = [], commands = [];
 const pi = { on: (name, handler) => handlers.set(name, handler), appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
  exec: async (command, args, options) => { commands.push(command === "env" ? args.slice(args.indexOf("git") + 1) : args); return runCommand(command, args, options); } };
 const ctx = { cwd: root, hasUI: true, sessionManager: { getSessionId: () => "ui-perf", getLeafId: () => null, getLeafEntry: () => undefined, getEntries: () => entries }, ui: { notify: text => warnings.push(text) } };
 createGitTreeCheckpointsExtension(overrides)(pi);
 await handlers.get("session_start")({}, ctx);
 return { entries, warnings, commands, ctx, submit: () => handlers.get("before_agent_start")({ prompt: "local", messageType: "user" }, ctx) };
}

test("actual pre-prompt hooks: fixed small fixture, consecutive prompts and transitions", async (t) => {
 const root = await createRepository(t); // seven small tracked text files
 const h = await captureHarness(root);
 let start = performance.now();
 await h.submit();
 console.log(`cold pre-prompt: ${(performance.now() - start).toFixed(1)}ms (discovery excluded)`);
 h.commands.length = 0;
 start = performance.now();
 await Promise.all([h.submit(), h.submit(), h.submit()]);
 const elapsed = performance.now() - start;
 assert.ok(elapsed < 1000, `three repeated small-workspace preparations stalled: ${elapsed.toFixed(1)}ms > 1000ms`);
 assert.equal(h.entries.length, 4);
 assert.equal(h.commands.filter(a => a[0] === "read-tree").length, 3, "one alternate-index load per capture");
 assert.equal(h.commands.filter(a => a[0] === "ls-files" && a.includes("--cached")).length, 3, "shared enumeration per capture");
 console.log(`three serialized pre-prompts: ${elapsed.toFixed(1)}ms; ${h.commands.length} Git operations`);
 await write(root, "tracked.txt", "changed\n"); await h.submit();
 assert.notEqual(h.entries.at(-1).data.worktreeTree, h.entries[0].data.worktreeTree);
 await write(root, "tracked.txt", Buffer.from([0, 255])); await h.submit();
 assert.ok(!h.entries.at(-1).data.textPaths.includes("tracked.txt"));
 await write(root, ".gitattributes", "tracked.txt text\n"); await h.submit();
 assert.ok(h.entries.at(-1).data.textPaths.includes("tracked.txt"));
 assert.deepEqual(h.warnings, []);
});

test("cancellation cleans alternate indexes and publishes no ref", async (t) => {
 const root = await createRepository(t), repository = await findGitRepository(root);
 const controller = new AbortController();
 const runner = async (command, args, options) => {
  if (args[0] === "read-tree") controller.abort();
  return runCommand(command, args, options);
 };
 await assert.rejects(captureCheckpoint(repository, { sessionId: "cancel", reason: "before-prompt" }, { signal: controller.signal, runner, tempDir: root }), /cancel/);
 assert.ok(!(await readdir(root)).some(name => name.startsWith("pi-git-checkpoint-index")));
 const ref = await runCommand("git", ["rev-parse", "--verify", "refs/pi/checkpoints/cancel"], { cwd: root });
 assert.notEqual(ref.code, 0);
});
