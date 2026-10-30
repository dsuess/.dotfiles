import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPiJiti, piPackageRoot } from "../../../test-helpers.mjs";
import { pathToFileURL } from "node:url";
import { ArchiveStore, authorizedReferences } from "./archive.js";
import { setup, seed } from "./runtime.test.mjs";
const jiti = await createPiJiti(import.meta.url);
const { SessionManager } = await import(pathToFileURL(path.join(piPackageRoot, "dist/index.js")));

test("deployed extension canary executes session_history after real compaction and reload", async () => {
  const deployed = path.join(os.homedir(), ".pi/agent/extensions/session-archive/index.ts");
  assert.ok(fs.existsSync(deployed), "Deploy through ./install.sh config before running the canary");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-archive-deployed-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  let session;
  try {
    const manager = SessionManager.create(dir, dir); seed(manager, "deployed");
    const deployedExtension = (await jiti.import(deployed)).default;
    session = await setup(dir, manager, [deployedExtension]);
    await session.compact();
    const reference = authorizedReferences(manager.getBranch()).at(-1);
    assert.ok(reference);
    const tool = session.agent.state.tools.find((t) => t.name === "session_history");
    assert.ok(tool, "tool is active in the installed agent");
    const search = await tool.execute("canary", { archiveId: reference.archiveId, operation: "search", query: "EXACT END" }, new AbortController().signal);
    const parsed = JSON.parse(search.content[0].text);
    assert.equal(parsed.matches.length, 1);
    assert.ok(parsed.matches[0].start > 2000);
    const read = await tool.execute("canary-read", { archiveId: reference.archiveId, operation: "read", start: parsed.matches[0].start, length: 9 }, new AbortController().signal);
    assert.equal(JSON.parse(read.content[0].text).text, "EXACT END");
    assert.ok(session.messages.some((m) => m.role === "user" && m.content === "recent deployed"));
    const early = await tool.execute("early", { archiveId: reference.archiveId, operation: "search", query: "cobalt otter fact deployed" }, new AbortController().signal);
    assert.equal(JSON.parse(early.content[0].text).matches.length, 1);
    const unrelated = await tool.execute("denied", { archiveId: "f".repeat(32), operation: "index" }, new AbortController().signal);
    assert.equal(unrelated.isError, true);
    session.dispose();
    const restored = SessionManager.open(manager.getSessionFile());
    session = await setup(dir, restored, [deployedExtension]);
    const restoredTool = session.agent.state.tools.find((t) => t.name === "session_history");
    const result = await restoredTool.execute("restored", { archiveId: reference.archiveId, operation: "search", query: "cobalt otter fact deployed" }, new AbortController().signal);
    assert.equal(JSON.parse(result.content[0].text).matches.length, 1);
    const fork = SessionManager.forkFrom(manager.getSessionFile(), dir, dir);
    assert.equal(new ArchiveStore(dir).retrieve({ archiveId: reference.archiveId, operation: "search", query: "cobalt otter fact deployed" }, fork.getBranch()).matches.length, 1);
  } finally {
    session?.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
