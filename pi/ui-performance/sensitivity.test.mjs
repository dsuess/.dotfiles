import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("disposable expensive footer fixture fails with an explanatory structural assertion", async () => {
 const temp = await mkdtemp(path.join(os.tmpdir(), "pi-ui-sensitivity-"));
 try {
  const original = fileURLToPath(new URL("../agent/extensions/statusbar.ts", import.meta.url));
  let source = await readFile(original, "utf8");
  source = source.replaceAll('from "./', `from "${path.dirname(original)}/`);
  source = source.replace('render(width: number): string[] {', 'render(width: number): string[] { ctx.getContextUsage(); ctx.sessionManager.getBranch();');
  const fixture = path.join(temp, "expensive.ts"); await writeFile(fixture, source);
  const env = { ...process.env, PI_FOOTER_TEST_FIXTURE: fixture };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", fileURLToPath(new URL("footer.test.mjs", import.meta.url))], { encoding: "utf8", timeout: 10000, env });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /footer redraw must not scan history or project context/);
 } finally { await rm(temp, { recursive: true, force: true }); }
});
