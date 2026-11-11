import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { piPackageRoot } from "../../../test-helpers.mjs";

// Drives Pi's real InteractiveMode, extension loader, TUI input dispatch and
// keybindings. Only the terminal device is replaced.
const imp = (file) => import(pathToFileURL(path.join(piPackageRoot, file)).href);
const sdk = await imp("dist/index.js");
const { InteractiveMode } = await imp("dist/modes/interactive/interactive-mode.js");
const here = (name) => new URL(name, import.meta.url).pathname;
const palette = here("../command-palette.ts");
const fzf = here("../fzf-file-picker/index.ts");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const press = "\x1b[46;5u", repeat = "\x1b[46;5:2u", release = "\x1b[46;5:3u";

async function run(order, script) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-palette-runtime-"));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "cwd");
  await fs.mkdir(agentDir, { recursive: true }); await fs.mkdir(cwd);
  await fs.copyFile(here("../../keybindings.json"), path.join(agentDir, "keybindings.json"));
  await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fake: {
    baseUrl: "http://127.0.0.1:9", api: "openai-completions", apiKey: "x", models: [{ id: "m1" }, { id: "m2" }] } } }));
  await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "fake", defaultModel: "m1", enabledModels: ["fake/m1", "fake/m2"], quietStartup: true }));
  // Stand-in for pi-vim: it replaces the editor and ignores any earlier factory.
  const editor = path.join(root, "editor.ts");
  await fs.writeFile(editor, `import { CustomEditor } from "@earendil-works/pi-coding-agent";
export default (pi) => pi.on("session_start", (_e, ctx) => ctx.ui.setEditorComponent((t, th, kb) => new CustomEditor(t, th, kb, { embedWorkingStatus: true })));`);
  const paths = { editor, fzf, palette };
  const previous = { TERM_PROGRAM: process.env.TERM_PROGRAM, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let onInput;
  const terminal = { columns: 100, rows: 40, kittyProtocolActive: true, modifyOtherKeysActive: false,
    start(input) { onInput = input; }, stop() {}, drainInput: async () => {}, write() {}, moveBy() {}, hideCursor() {},
    showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} };
  const runtime = await sdk.createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const services = await sdk.createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: {
      noExtensions: true, additionalExtensionPaths: order.map((name) => paths[name]) } });
    return { ...(await sdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })), services, diagnostics: services.diagnostics };
  }, { cwd, agentDir, sessionManager: sdk.SessionManager.inMemory(cwd) });
  const mode = new InteractiveMode(runtime, { terminal });
  const cycles = [];
  mode.cycleModel = async (direction) => { cycles.push(direction); };
  try {
    await mode.init();
    onInput("\x1b[97;1:3u");
    await script({ mode, cycles, send: (data) => onInput(data) });
  } finally {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : (process.env[key] = value);
    await runtime.dispose?.();
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("real runtime: tap cycles once on release; hold opens one selector without cycling", async () => {
  await run(["editor", "fzf", "palette"], async ({ mode, cycles, send }) => {
    send(press); await wait(50);
    assert.deepEqual(cycles, []);
    send(release); await wait(20);
    assert.deepEqual(cycles, ["forward"]);
    send(press); await wait(260);
    assert.equal(mode.ui.hasOverlay(), true);
    send(repeat); send(release); await wait(20);
    assert.equal(mode.ui.hasOverlay(), true);
    assert.deepEqual(cycles, ["forward"]);
    send("\x1b"); await wait(30);
    assert.equal(mode.ui.hasOverlay(), false);
    assert.deepEqual(cycles, ["forward"]);
  });
});

test("real runtime: palette loaded before the editor extension cannot see the final editor", async () => {
  await run(["palette", "editor", "fzf"], async ({ mode, send }) => {
    send(press); await wait(260);
    assert.equal(mode.ui.hasOverlay(), false);
    send(release);
  });
});
