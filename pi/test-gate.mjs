import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { piPackageRoot } from "./test-helpers.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const jitiRegister = path.join(piPackageRoot, "node_modules", "jiti", "lib", "jiti-register.mjs");
const jitiCli = path.join(piPackageRoot, "node_modules", "jiti", "lib", "jiti-cli.mjs");
const environment = { ...process.env, PI_PACKAGE_ROOT: piPackageRoot };

function run(label, command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    console.log(`\n==> ${label}`);
    const child = spawn(command, args, { cwd, env: environment, stdio: "inherit" });
    child.once("error", (error) => reject(new Error(`${label} could not start: ${error.message}`)));
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed${signal ? ` (${signal})` : ` (exit ${code})`}`));
    });
  });
}

const deterministic = [
  ["plan-mode", "npm", ["--prefix", "agent/extensions/plan-mode", "run", "check"]],
  ["fzf-file-picker", "npm", ["--prefix", "agent/extensions/fzf-file-picker", "run", "check"]],
  ["git-tree-checkpoints", "npm", ["--prefix", "agent/extensions/git-tree-checkpoints", "run", "check"]],
  ["RTK stale prompt guard", "node", ["--test", "agent/extensions/pi-rtk-optimizer/stale-status.test.mjs"]],
  ["subagent", "node", ["--test", "agent/extensions/subagent/test/extension.test.mjs", "agent/extensions/subagent/test/runtime.test.mjs", "agent/extensions/subagent/test/tui-smoke.mjs", "agent/extensions/subagent/test/smoke-load.mjs"]],
  ["statusbar context", "node", ["--import", jitiRegister, "--test", "agent/extensions/statusbar-context.test.ts"]],
  ["usage", "node", ["--import", jitiRegister, "--test", "agent/extensions/usage/test/usage.test.ts"]],
  ["Herdr feedback composition", "node", [jitiCli, "agent/extensions/herdr-feedback-state/test.mjs"]],
  ["command palette", "node", ["--test", "agent/extensions/command-palette-models.test.mjs"]],
  ["ask-user-question dependencies", "npm", ["ci", "--ignore-scripts"], path.join(root, "agent/packages/ask-user-question")],
  ["ask-user-question", "npm", ["--prefix", "agent/packages/ask-user-question", "test"]],
  ["ask-user-question typecheck", "npm", ["--prefix", "agent/packages/ask-user-question", "run", "typecheck"]],
  ["Gondolin deterministic sandbox", "npm", ["--prefix", "sandbox", "test"]],
];

async function main() {
  const mode = process.argv[2] ?? "all";
  if (mode !== "deterministic" && mode !== "all") throw new Error(`Unknown test-gate mode: ${mode}`);
  for (const [label, command, args, cwd] of deterministic) await run(label, command, args, cwd);
  if (mode === "all") await run("Gondolin native sandbox", "npm", ["--prefix", "sandbox", "run", "test:native"]);
}

main().catch((error) => {
  console.error(`\nPi test gate stopped: ${error.message}`);
  process.exitCode = 1;
});
