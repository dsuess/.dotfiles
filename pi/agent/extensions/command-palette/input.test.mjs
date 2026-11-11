import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createPiJiti, piPackageRoot } from "../../../test-helpers.mjs";

const jiti = await createPiJiti(import.meta.url);
const { default: extension } = await jiti.import(new URL("../command-palette.ts", import.meta.url).pathname);
const runtime = (file) => import(pathToFileURL(path.join(piPackageRoot, file)).href);
const tuiRoot = "node_modules/@earendil-works/pi-tui/dist/";
const { TuiMainScreen, setKittyProtocolActive, setKeybindings } = await runtime(`${tuiRoot}index.js`);
const { StdinBuffer } = await runtime(`${tuiRoot}stdin-buffer.js`);
const { CustomEditor } = await runtime("dist/modes/interactive/components/custom-editor.js");
const { InteractiveMode } = await runtime("dist/modes/interactive/interactive-mode.js");
const { KeybindingsManager } = await runtime("dist/core/keybindings.js");
const { initTheme, getEditorTheme } = await runtime("dist/modes/interactive/theme/theme.js");
initTheme("dark");
const kb = new KeybindingsManager({ "app.model.cycleForward": ["ctrl+."], "app.model.cycleBackward": ["ctrl+shift+."] });
setKeybindings(kb);
const press = "\x1b[46;5u", repeat = "\x1b[46;5:2u", release = "\x1b[46;5:3u";
const models = [{ provider: "a", id: "first" }, { provider: "b", id: "second" }];

function harness({ vimFirst = false } = {}) {
  const terminal = { columns: 80, rows: 24, kittyProtocolActive: true, write() {}, hideCursor() {}, showCursor() {} };
  const tui = new TuiMainScreen(terminal);
  tui.requestImmediateRender = () => {};
  tui.requestRender = () => {};
  const interactive = Object.create(InteractiveMode.prototype);
  interactive.ui = tui;
  interactive.extensionTerminalInputSubscriptions = new Set();
  const ui = interactive.createExtensionUIContext();
  let editor, factory;
  ui.getEditorComponent = () => factory;
  ui.setEditorComponent = (next) => { factory = next; editor = next(tui, getEditorTheme(), kb); tui.setFocus(editor); };
  const callbacks = new Map(), shortcuts = new Map(), selected = [], notifications = [];
  const pi = { on(name, fn) { callbacks.set(name, fn); }, registerShortcut(name, spec) { shortcuts.set(name, spec); },
    async setModel(model) { selected.push(model); ctx.model = model; return true; }, getCommands() { return []; } };
  const ctx = { mode: "tui", hasUI: true, ui, model: models[0], scopedModels: models.map(model => ({ model })),
    modelRegistry: { getAvailable: () => models } };
  ui.notify = (message) => notifications.push(message);
  ui.custom = (create, options) => interactive.showExtensionCustom(create, options);
  interactive.editor = { getText: () => editor.getText() };
  extension(pi);
  if (vimFirst) ui.setEditorComponent((ui, theme, keybindings) => new CustomEditor(ui, theme, keybindings));
  callbacks.get("session_start")({}, ctx);
  const cycles = [];
  editor.onAction("app.model.cycleForward", () => cycles.push("forward"));
  editor.onAction("app.model.cycleBackward", () => cycles.push("backward"));
  editor.setText("draft");
  const buffer = new StdinBuffer();
  buffer.on("data", (data) => tui.handleTerminalInput(data));
  buffer.on("paste", (data) => tui.handleTerminalInput(`\x1b[200~${data}\x1b[201~`));
  tui.handleTerminalInput("\x1b[97;1:3u");
  return { tui, ctx, editor, buffer, cycles, selected, callbacks, terminal, cleanup() {
    callbacks.get("session_shutdown")();
  } };
}
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test("gesture wraps the editor installed by an earlier extension", async () => {
  setKittyProtocolActive(true);
  const h = harness({ vimFirst: true });
  try {
    h.buffer.process(press);
    assert.deepEqual(h.cycles, []);
    await wait(230);
    assert.equal(h.tui.hasOverlay(), true);
    assert.deepEqual(h.cycles, []);
    h.tui.handleTerminalInput("\x1b");
    h.buffer.process(release);
  } finally { h.cleanup(); setKittyProtocolActive(false); }
});

test("installed TUI frames taps and backward cycling through native editor", () => {
  setKittyProtocolActive(true);
  const h = harness();
  try {
    h.buffer.process(press); assert.deepEqual(h.cycles, []);
    h.buffer.process(release); assert.deepEqual(h.cycles, ["forward"]);
    h.buffer.process("\x1b[46;6u"); assert.deepEqual(h.cycles, ["forward", "backward"]);
    assert.equal(h.editor.getText(), "draft");
  } finally { h.cleanup(); setKittyProtocolActive(false); }
});

test("dialogs retain focus and unsupported protocols keep native input", async () => {
  setKittyProtocolActive(true);
  const h = harness();
  try {
    const received = [];
    h.tui.setFocus({ focused: false, handleInput: data => received.push(data), invalidate() {}, render: () => [] });
    h.buffer.process(press);
    await wait(230);
    assert.deepEqual(received, [press]);
    assert.equal(h.tui.hasOverlay(), false);
    h.tui.setFocus(h.editor);
    h.terminal.kittyProtocolActive = false;
    h.buffer.process(press);
    assert.deepEqual(h.cycles, ["forward"]);
  } finally { h.cleanup(); setKittyProtocolActive(false); }
});

test("hold opens one real selector, escape keeps model and repeat cannot leak", async () => {
  setKittyProtocolActive(true);
  const h = harness();
  try {
    h.buffer.process(press);
    await wait(230);
    assert.equal(h.tui.hasOverlay(), true);
    assert.deepEqual(h.cycles, []);
    h.buffer.process(repeat);
    h.tui.handleTerminalInput("\x1b");
    await wait(0);
    assert.equal(h.tui.hasOverlay(), false);
    h.buffer.process(repeat + release);
    assert.deepEqual(h.cycles, []);
    assert.deepEqual(h.selected, []);
    assert.equal(h.editor.getText(), "draft");
  } finally { h.cleanup(); setKittyProtocolActive(false); }
});

test("repeated lifecycle transitions remove pending timers and subscriptions", async () => {
  setKittyProtocolActive(true);
  const h = harness();
  try {
    h.buffer.process(press);
    h.callbacks.get("session_shutdown")();
    assert.equal(h.tui.inputListeners.size, 0);
    await wait(230);
    assert.equal(h.tui.hasOverlay(), false);
    h.callbacks.get("session_start")({ reason: "reload" }, h.ctx);
    assert.equal(h.tui.inputListeners.size, 1);
    h.callbacks.get("session_start")({ reason: "resume" }, h.ctx);
    assert.equal(h.tui.inputListeners.size, 1);
    h.buffer.process(press); h.buffer.process(release);
  } finally { h.cleanup(); setKittyProtocolActive(false); }
});

test("selector applies scoped model once; shutdown prevents stale selection", async () => {
  setKittyProtocolActive(true);
  const h = harness();
  try {
    h.buffer.process(press); await wait(230);
    h.buffer.process("\x1b[B\r"); await wait(0);
    assert.deepEqual(h.selected, [models[1]]);
    h.buffer.process(release);
    h.buffer.process(press); await wait(230);
    h.callbacks.get("session_shutdown")();
    h.buffer.process("\r"); await wait(0);
    assert.deepEqual(h.selected, [models[1]]);
  } finally { h.cleanup(); setKittyProtocolActive(false); }
});
