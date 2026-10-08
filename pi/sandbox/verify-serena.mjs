#!/usr/bin/env node
// Manual, model-driven acceptance. Never runs as part of deterministic tests.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { readReviewedSerena, SERENA_PROFILE } from "../agent/extensions/srt-tool-routing/serena-profile.mjs";

const workspace = SERENA_PROFILE.workspace;
const id = randomUUID().replaceAll("-", "");
const fixtureName = `pi_serena_acceptance_${id}`;
const relative = `conductor/visonic_conductor/${fixtureName}.py`;
const fixture = path.join(workspace, relative);
const outside = fs.mkdtempSync(path.join(os.homedir(), ".pi-serena-outside-"));
const sentinel = path.join(outside, `${fixtureName}.py`);
const linkRelative = `conductor/visonic_conductor/${fixtureName}_escape.py`;
const link = path.join(workspace, linkRelative);
const header = `# Test-owned Pi Serena acceptance ${id}\n`;
const beforeBody = `def ${fixtureName}():\n    return "before_${id}"\n`;
const afterBody = `def ${fixtureName}():\n    return "after_${id}"\n`;
const outsideBytes = `${header}def ${fixtureName}():\n    return "outside_original_${id}"\n`;
const gitSnapshot = () => ({
  status: execFileSync("/usr/bin/git", ["-C", workspace, "status", "--porcelain=v1"], { encoding: "utf8" }),
  diff: createHash("sha256").update(execFileSync("/usr/bin/git", ["-C", workspace, "diff", "--binary", "HEAD"], { maxBuffer: 32 * 1024 * 1024 })).digest("hex"),
});
const before = gitSnapshot();
const evidence = [];
let fixtureOwned = false, linkOwned = false;
const report = path.join(os.tmpdir(), `pi-serena-acceptance-${id}.json`);

function processEvidence() {
  try {
    const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).split("\n").flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      return match ? [{ pid: +match[1], parent: +match[2], group: +match[3], command: match[4] }] : [];
    });
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    return rows.filter((row) => row.command.includes("serena start-mcp-server") && row.command.includes(`--project=${workspace}`)).map((row) => {
      const ancestry = [];
      let current = row;
      while (current && ancestry.length < 12) {
        ancestry.push({ pid: current.pid, parent: current.parent, group: current.group, kind: current.command.includes("/controller.mjs ") ? "SRT controller" : current.command.includes("sandbox-exec") ? "SRT native wrapper" : current.pid === row.pid ? "Serena" : "ancestor" });
        current = byPid.get(current.parent);
      }
      return { pid: row.pid, group: row.group, controllerAncestor: ancestry.some((item) => item.kind === "SRT controller"), ancestry };
    });
  } catch (error) { return [{ unavailable: error.code ?? "process inspection failed" }]; }
}

async function launch(label, instruction) {
  const env = { ...process.env };
  delete env.PI_LAUNCHER_CHAIN; // Independent launcher chain, not a bypass.
  const child = spawn(path.join(os.homedir(), "bin/pi"), ["-p", "--no-session", "--mode", "json", `test serena: ${instruction}\nUse only the named direct Serena tools. Do not use core tools, shell MCP clients, nested Pi, installation, configuration changes, sandbox changes, or trust overrides. Do not edit any file except the explicitly named test-owned fixtures. Report errors without substituting other tools.`], { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
  const events = [];
  let stderr = "", killed = false;
  const timer = setTimeout(() => { killed = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 2000).unref(); }, 120000);
  child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-8192); });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (!["tool_execution_start", "tool_execution_end"].includes(event.type)) return;
    events.push(event);
    if (event.type === "tool_execution_start") evidence.push({ label, processEvidence: processEvidence() });
    console.log(JSON.stringify({ label, type: event.type, toolName: event.toolName, args: event.args, isError: event.isError, content: event.result?.content }));
  });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  clearTimeout(timer);
  const result = { label, code, killed, stderr, events };
  evidence.push(result);
  assert.equal(killed, false, `${label} exceeded 120 seconds`);
  assert.equal(code, 0, `${label}: ${stderr}`);
  const expected = label === "lookup" ? ["mcp__serena__get_symbols_overview"] : ["mcp__serena__get_symbols_overview", "mcp__serena__replace_symbol_body"];
  assert.ok(events.every((event) => expected.includes(event.toolName)), `${label} used an unexpected tool`);
  const serverProcesses = evidence.filter((item) => item.label === label && item.processEvidence).flatMap((item) => item.processEvidence);
  assert.ok(serverProcesses.length > 0 && serverProcesses.every((item) => item.controllerAncestor === true), `${label} lacks controller-owned server process evidence`);
  return result;
}
const ended = (run, name) => run.events.filter((event) => event.type === "tool_execution_end" && event.toolName === name);
const text = (event) => JSON.stringify(event.result?.content ?? []);

try {
  fs.writeFileSync(fixture, header + beforeBody, { flag: "wx" });
  fixtureOwned = true;
  fs.writeFileSync(sentinel, outsideBytes, { flag: "wx" });
  fs.symlinkSync(sentinel, link); // Test-only escape probe, not a deployment link.
  linkOwned = true;
  const lookup = await launch("lookup", 'Call mcp__serena__get_symbols_overview exactly once with {"relative_path":"conductor/visonic_conductor/job.py","depth":0,"max_answer_chars":3000}. This is read-only.');
  const overview = ended(lookup, "mcp__serena__get_symbols_overview");
  assert.equal(overview.length, 1);
  assert.equal(overview[0].isError, false, text(overview[0]));
  const symbols = JSON.parse(overview[0].result.content.find((block) => block.type === "text").text);
  assert.ok(symbols.Function?.includes("process_action"), "result must contain real job.py symbols");
  const edit = await launch("edit", `First call mcp__serena__get_symbols_overview on ${relative}. Then call mcp__serena__replace_symbol_body with exactly ${JSON.stringify({ relative_path: relative, name_path: fixtureName, body: afterBody.trimEnd() })}. This edit is authorized only for this disposable fixture. Do not edit job.py.`);
  const edited = ended(edit, "mcp__serena__replace_symbol_body");
  assert.equal(edited.length, 1);
  assert.equal(edited[0].isError, false, text(edited[0]));
  assert.equal(fs.readFileSync(fixture, "utf8"), header + afterBody, "independent fixture byte verification");
  const denial = await launch("outside-denial", `Expected-denial acceptance: attempt exactly four calls, even if earlier calls fail. For each path ${JSON.stringify(sentinel)} and ${JSON.stringify(linkRelative)}, call mcp__serena__get_symbols_overview with that relative_path, then mcp__serena__replace_symbol_body with that relative_path, name_path=${JSON.stringify(fixtureName)}, body=${JSON.stringify(`def ${fixtureName}():\n    return "outside_tampered"`)}. These harmless test-owned read/write probes are authorized. Access must fail. Do not bypass a denial or edit other files.`);
  assert.equal(ended(denial, "mcp__serena__get_symbols_overview").length, 2);
  assert.equal(ended(denial, "mcp__serena__replace_symbol_body").length, 2);
  for (const event of denial.events.filter((event) => event.type === "tool_execution_end")) assert.match(text(event), /Error executing tool|not.*(?:exist|found)|Permission denied|not allowed|Operation not permitted/i);
  assert.equal(fs.readFileSync(sentinel, "utf8"), outsideBytes);
  evidence.push({ fixtureEditBytesVerified: true, outsideBytesUnchanged: true });
} finally {
  // Delete only paths created with exclusive ownership by this run.
  if (fixtureOwned && fs.existsSync(fixture)) {
    assert.ok(fs.readFileSync(fixture, "utf8").startsWith(header), "fixture ownership marker changed; refusing cleanup");
    fs.unlinkSync(fixture);
  }
  try { if (linkOwned && fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === sentinel) fs.unlinkSync(link); } catch (error) { if (error.code !== "ENOENT") throw error; }
  fs.rmSync(outside, { recursive: true, force: true });
  const after = gitSnapshot();
  evidence.push({ statusUnchanged: before.status === after.status, trackedDiffUnchanged: before.diff === after.diff, processEvidence: processEvidence() });
  fs.writeFileSync(report, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ report, statusUnchanged: before.status === after.status, trackedDiffUnchanged: before.diff === after.diff }));
  assert.deepEqual(after, before);
  readReviewedSerena({ cwd: workspace, projectTrusted: true }); // Original fingerprints must still match.
}
