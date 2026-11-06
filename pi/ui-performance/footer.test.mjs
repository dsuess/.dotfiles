import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { createPiJiti } from "../test-helpers.mjs";
const jiti = await createPiJiti(import.meta.url);
const { default: statusbar } = await jiti.import(process.env.PI_FOOTER_TEST_FIXTURE || "../agent/extensions/statusbar.ts");
const { SANDBOX_LIFECYCLE_EVENT } = await jiti.import("../agent/extensions/srt-tool-routing/events.ts");

export function footerHarness() {
 const handlers = new Map(), bus = new Map();
 let footer, scans = 0, projections = 0;
 let usage = { tokens: 1000, percent: 1 };
 let branch = Array.from({ length: 20000 }, () => ({ type: "message", message: { role: "assistant", usage: { cost: { total: 0.001 } } } }));
 const pi = { on: (name, fn) => handlers.set(name, fn), events: { on: (name, fn) => bus.set(name, fn) }, getThinkingLevel: () => "high" };
 const ctx = { cwd: "/fixture", model: { id: "local", contextWindow: 100000 }, getContextUsage: () => { projections++; return usage; },
  sessionManager: { getBranch: () => { scans++; return branch; } },
  ui: { setFooter: fn => { footer?.dispose(); footer = fn({ requestRender() {} }, {}, { onBranchChange: () => () => {} }); } } };
 statusbar(pi);
 return { ctx, fire: (name, event = {}) => handlers.get(name)?.(event, ctx), bus,
  get footer() { return footer; }, get counts() { return { scans, projections }; },
  setUsage: value => { usage = value; }, setBranch: value => { branch = value; } };
}

test("large-history redraws use cached state; lifecycle boundaries refresh finalized state", async () => {
 const h = footerHarness();
 await h.fire("session_start", { reason: "startup" });
 const before = h.counts;
 const start = performance.now();
 for (let i = 0; i < 200; i++) h.footer.render(i % 2 ? 160 : 80);
 const elapsed = performance.now() - start;
 assert.deepEqual(h.counts, before, "footer redraw must not scan history or project context");
 assert.ok(elapsed < 100, `cached footer batch stalled: ${elapsed.toFixed(1)}ms > 100ms`);
 console.log(`200 redraws, 20,000 entries: ${elapsed.toFixed(1)}ms; zero scans/projections`);
 assert.match(h.footer.render(200).join(), /1\.0k/);
 assert.match(h.footer.render(200).join(), /\$20\.00/);
 for (const event of ["turn_start", "turn_end", "agent_end", "agent_settled", "session_tree", "session_compact", "model_select"]) {
  const counts = h.counts;
  h.setUsage({ tokens: null, percent: null });
  h.setBranch([{ type: "message", message: { role: "assistant", usage: { cost: { total: 0.123 } } } }]);
  await h.fire(event, { model: { id: "replacement" } });
  assert.equal(h.counts.scans, counts.scans + 1, event);
  assert.equal(h.counts.projections, counts.projections + 1, event);
  assert.match(h.footer.render(200).join(), /\$0\.12/);
  assert.doesNotMatch(h.footer.render(200).join(), /1\.0k/);
 }
 h.setUsage({ tokens: 5000, percent: 5 });
 for (const reason of ["reload", "new", "resume", "fork"]) {
  await h.fire("session_start", { reason });
  assert.match(h.footer.render(200).join(), /5\.0k/);
 }
 h.bus.get(SANDBOX_LIFECYCLE_EVENT)({ mode: "off", state: "ready" });
 assert.match(h.footer.render(20).join(), /sandbox: off/);
 h.footer.dispose();
});
