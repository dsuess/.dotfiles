import assert from "node:assert/strict";
import { chmod } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { captureCheckpoint, findGitRepository } from "../git-checkpoints.js";
import { createRepository, runCommand, write, git } from "./fixtures.mjs";

test("capture enumerates once and reuses its alternate index", async (t) => {
 const root = await createRepository(t);
 const repository = await findGitRepository(root);
 const commands = [];
 const runner = async (command, args, options) => {
  commands.push(args);
  return runCommand(command, args, options);
 };
 for (const scenario of ["cold", "repeat", "edit", "mixed"]) {
  if (scenario === "edit") await write(root, "tracked.txt", "changed\n");
  if (scenario === "mixed") {
   for (let i = 0; i < 128; i++) await write(root, `mixed-${i}`, i % 2 ? Buffer.from([0, 255]) : "text\n".repeat(1024));
  }
  commands.length = 0;
  const start = performance.now();
  const cp = await captureCheckpoint(repository, { sessionId: "perf", reason: "before-prompt" }, { runner });
  console.log(`${scenario}: ${(performance.now() - start).toFixed(1)}ms, ${commands.length} Git operations`);
  assert.equal(commands.filter(a => a[0] === "ls-files" && a.includes("--cached")).length, 1, "capture must share tracked enumeration");
  assert.equal(commands.filter(a => a[0] === "read-tree").length, 1, "worktree capture must reuse the filtered alternate index");
  assert.ok(cp.anchorCommit);
 }
});

test("uncertain content is excluded, including invalid UTF-8 beyond the first chunk", async (t) => {
 const root = await createRepository(t);
 await write(root, "invalid", Buffer.concat([Buffer.alloc(65536, 65), Buffer.from([255])]));
 await write(root, "nul", Buffer.concat([Buffer.alloc(65536, 65), Buffer.from([0])]));
 await write(root, "unreadable", "secret\n");
 await chmod(path.join(root, "unreadable"), 0);
 await write(root, "forced", Buffer.from([255]));
 await write(root, ".gitattributes", "forced text\n");
 const cp = await captureCheckpoint(await findGitRepository(root), { sessionId: "classification", reason: "before-prompt" });
 assert.ok(!cp.textPaths.includes("unreadable"));
 assert.ok(!cp.textPaths.includes("invalid"));
 assert.ok(!cp.textPaths.includes("nul"));
 assert.ok(cp.textPaths.includes("forced"));
});
