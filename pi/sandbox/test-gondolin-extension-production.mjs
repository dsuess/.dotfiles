import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureGondolinImage } from "./build-gondolin-image.mjs";
import { ensureControllerLease } from "./client.mjs";

const REAL_PI = process.env.PI_REAL_BINARY ?? "/opt/homebrew/bin/pi";
const AUDITED_HOST_TOOLS = [
  "ketch_search", "ketch_scrape", "ketch_code", "ketch_docs", "ketch_crawl",
  "ask_user_question", "subagent", "submit_plan", "plan_progress", "complete_plan", "complete_stage",
].join(",");

function settings() {
  return {
    version: 1,
    externalMounts: [],
    network: {
      mode: "public-http",
      allowedHosts: [],
      allowWebSockets: false,
      tcpMappings: [],
    },
  };
}

async function runChild({ root, lease, planning = false, invalidLease = false }) {
  const id = planning ? "planning" : invalidLease ? "invalid" : "normal";
  const inventoryPath = path.join(root, `${id}-inventory.json`);
  const handshakePath = path.join(root, `${id}-handshake.json`);
  const inspectorPath = path.join(root, `${id}-inspector.ts`);
  const unknownPath = path.join(root, `${id}-unknown.ts`);
  fs.writeFileSync(
    inspectorPath,
    `import fs from "node:fs";\nexport default function(pi){pi.on("before_agent_start",()=>{fs.writeFileSync(${JSON.stringify(inventoryPath)},JSON.stringify({active:pi.getActiveTools(),tools:pi.getAllTools()},null,2));process.exit(0);});}\n`,
  );
  fs.writeFileSync(
    unknownPath,
    'import { Type } from "typebox"; export default function(pi){pi.registerTool({name:"unknown_child_tool",label:"unknown",description:"unknown",parameters:Type.Object({}),async execute(){return {content:[{type:"text",text:"bad"}]};}});}\n',
  );
  const requested = planning ? "read,bash,grep,find,ls" : "read,bash";
  const args = [
    "--no-builtin-tools",
    "--no-session",
    "--print",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "-e",
    inspectorPath,
    "-e",
    unknownPath,
  ];
  args.push("inspect child tools");
  const env = {
    ...process.env,
    PI_GONDOLIN_SANDBOX: "1",
    PI_GONDOLIN_SOCKET: lease.paths.socketPath,
    PI_GONDOLIN_LEASE: invalidLease ? "f".repeat(64) : lease.leaseToken,
    PI_GONDOLIN_WORKSPACE_KEY: lease.scope.workspaceKey,
    PI_GONDOLIN_WORKSPACE_ROOT: lease.scope.canonicalWorkspaceRoot,
    PI_GONDOLIN_POLICY_GENERATION: lease.status.policyGeneration,
    PI_GONDOLIN_IMAGE_GENERATION: lease.status.imageGeneration,
    PI_GONDOLIN_VM_ID: lease.status.vmId,
    PI_GONDOLIN_BUILTIN_TOOLS: requested,
    PI_GONDOLIN_HOST_TOOLS: AUDITED_HOST_TOOLS,
    PI_GONDOLIN_HANDSHAKE_FILE: handshakePath,
    ...(planning ? { PI_SUBAGENT_PLANNING: "1" } : {}),
  };

  delete env.NODE_TEST_CONTEXT;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(REAL_PI, args, {
      cwd: lease.scope.canonicalWorkspaceRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("production child inventory timed out"));
    }, 60_000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
  assert.equal(result.code, 0, result.stderr);
  if (!fs.existsSync(inventoryPath)) {
    if (!invalidLease && !fs.existsSync(handshakePath)) {
      throw new Error(`child inventory missing (${id})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }
    // Non-interactive startup now blocks on readiness. A rejected inherited
    // lease therefore handles the submission before before_agent_start runs.
    return {
      inventory: { active: [], tools: [] },
      handshake: JSON.parse(fs.readFileSync(handshakePath, "utf8")),
    };
  }
  return {
    inventory: JSON.parse(fs.readFileSync(inventoryPath, "utf8")),
    handshake: JSON.parse(fs.readFileSync(handshakePath, "utf8")),
  };
}

function assertReplacementSources(inventory, expectedNames) {
  const byName = new Map(inventory.tools.map((tool) => [tool.name, tool]));
  for (const name of ["read", "write", "edit", "bash", "grep", "find", "ls"]) {
    const tool = byName.get(name);
    assert.ok(tool, `missing replacement ${name}`);
    assert.equal(tool.sourceInfo.source, "auto");
    assert.match(fs.realpathSync(tool.sourceInfo.path), /gondolin-sandbox\/index\.ts$/);
  }
  for (const name of expectedNames) assert.ok(inventory.active.includes(name), `${name} is inactive`);
  assert.equal(inventory.active.includes("unknown_child_tool"), false);
  const ketch = byName.get("ketch_search");
  assert.equal(ketch.sourceInfo.source, "npm:pi-ketch@0.1.6");
  assert.equal(inventory.active.includes("ketch_search"), true);
}

test(
  "production-shaped normal and planning children inherit one controller without native built-ins",
  { timeout: 180_000 },
  async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-gondolin-child-")));
    const workspace = path.join(root, "workspace");
    const settingsPath = path.join(root, "settings.json");
    const cacheRoot = path.join(root, "cache");
    const runtimeRoot = path.join(root, "runtime");
    fs.mkdirSync(workspace);
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings(), null, 2)}\n`);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    const image = await ensureGondolinImage({ verbose: false });
    const lease = await ensureControllerLease({
      launchDirectory: workspace,
      settingsPath,
      cacheRoot,
      runtimeRoot,
      imageDir: image.imageDir,
      heartbeatIntervalMs: 100,
      startTimeoutMs: 150_000,
    });
    t.after(() => lease.client.release().catch(() => {}));

    const normal = await runChild({ root, lease });
    assert.equal(
      normal.handshake.ok,
      true,
      `${normal.handshake.error}\n${JSON.stringify(normal.inventory.tools.filter((tool) => ["read", "write", "edit", "bash", "grep", "find", "ls"].includes(tool.name)).map((tool) => ({ name: tool.name, sourceInfo: tool.sourceInfo })), null, 2)}`,
    );
    assert.equal(normal.handshake.vmId, lease.status.vmId);
    assertReplacementSources(normal.inventory, ["read", "bash"]);
    assert.equal(normal.inventory.active.includes("write"), false);
    const expectedInventory = [
      "read", "write", "edit", "bash", "grep", "find", "ls",
      "ketch_search", "ketch_scrape", "ketch_code", "ketch_docs", "ketch_crawl",
      "ask_user_question", "subagent", "submit_plan", "plan_progress", "complete_plan", "complete_stage",
    ].sort();
    assert.deepEqual(
      normal.inventory.tools
        .map((tool) => tool.name)
        .filter((name) => name !== "unknown_child_tool")
        .sort(),
      expectedInventory,
      "production tool resources must match the audited adapter manifest exactly",
    );

    const planning = await runChild({ root, lease, planning: true });
    assert.equal(planning.handshake.ok, true, planning.handshake.error);
    assert.equal(planning.handshake.vmId, lease.status.vmId);
    assertReplacementSources(planning.inventory, ["read", "bash", "grep", "find", "ls"]);
    assert.equal(planning.inventory.active.includes("write"), false);
    assert.equal(planning.inventory.active.includes("edit"), false);

    const failed = await runChild({ root, lease, invalidLease: true });
    assert.equal(failed.handshake.ok, false);
    assert.equal(failed.inventory.active.includes("read"), false);
    assert.equal(failed.inventory.active.includes("bash"), false);
    assert.equal(failed.inventory.active.includes("unknown_child_tool"), false);

    const status = await lease.client.status();
    assert.equal(status.vmId, lease.status.vmId);
    assert.equal(status.attachedRoots, 1);
  },
);
