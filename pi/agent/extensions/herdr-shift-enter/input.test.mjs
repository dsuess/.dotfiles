import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createPiJiti, piPackageRoot } from "../../../test-helpers.mjs";

const jiti = await createPiJiti(import.meta.url);
const { default: extension } = await jiti.import(new URL("./index.ts", import.meta.url).pathname);
const runtime = (file) => import(pathToFileURL(path.join(piPackageRoot, file)).href);
const tuiRoot = "node_modules/@earendil-works/pi-tui/dist/";
const { TuiMainScreen, matchesKey, parseKey, setKittyProtocolActive, setKeybindings } = await runtime(`${tuiRoot}index.js`);
const { StdinBuffer } = await runtime(`${tuiRoot}stdin-buffer.js`);
const { CustomEditor } = await runtime("dist/modes/interactive/components/custom-editor.js");
const { ExtensionEditorComponent } = await runtime("dist/modes/interactive/components/extension-editor.js");
const { InteractiveMode } = await runtime("dist/modes/interactive/interactive-mode.js");
const { KeybindingsManager } = await runtime("dist/core/keybindings.js");
const { initTheme, getEditorTheme } = await runtime("dist/modes/interactive/theme/theme.js");
const { createFzfFilePickerExtension } = await jiti.import(new URL("../fzf-file-picker/index.ts", import.meta.url).pathname);
const { default: modalExtension } = await jiti.import(path.join(piPackageRoot, "examples/extensions/modal-editor.ts"));
initTheme("dark");
const kb = new KeybindingsManager();
setKeybindings(kb);
const legacy = "\x1b\r";
const shift = "\x1b[13;2u";
const alt = "\x1b[13;3u";

function harness({ term = "herdr", mode = "tui", normalize = true } = {}) {
  // Use the real interactive-mode subscription boundary without starting an agent.
  const tui = new TuiMainScreen({ columns: 80, rows: 24, write() {} });
  tui.requestImmediateRender = () => {};
  tui.requestRender = () => {};
  const interactive = Object.create(InteractiveMode.prototype);
  interactive.ui = tui;
  interactive.extensionTerminalInputSubscriptions = new Set();
  const ui = interactive.createExtensionUIContext();
  const handlers = new Map();
  const pi = { on(name, handler) { handlers.set(name, handler); } };
  if (normalize) extension(pi);
  function start(reason = "startup") {
    const previous = process.env.TERM_PROGRAM;
    try {
      if (term === undefined) delete process.env.TERM_PROGRAM;
      else process.env.TERM_PROGRAM = term;
      handlers.get("session_start")?.({ reason }, { mode, ui });
    } finally {
      if (previous === undefined) delete process.env.TERM_PROGRAM;
      else process.env.TERM_PROGRAM = previous;
    }
  }
  function shutdown(reason = "quit") { handlers.get("session_shutdown")?.({ reason }); }
  const buffer = new StdinBuffer();
  buffer.on("data", (data) => tui.handleTerminalInput(data));
  buffer.on("paste", (data) => tui.handleTerminalInput(`\x1b[200~${data}\x1b[201~`));
  const submissions = [];
  let followUps = 0;
  const editor = new CustomEditor(tui, getEditorTheme(), kb);
  editor.onSubmit = (text) => submissions.push(text);
  editor.onAction("app.message.followUp", () => { followUps++; });
  tui.setFocus(editor);
  start();
  return { tui, interactive, ui, pi, start, shutdown, editor, buffer, submissions, followUps: () => followUps };
}

function withKitty(active, fn) {
  setKittyProtocolActive(active);
  try { fn(); } finally { setKittyProtocolActive(false); }
}

test("reproduces legacy misclassification and follow-up before normalization", () => {
  withKitty(false, () => {
    assert.equal(parseKey(legacy), "alt+enter");
    assert.equal(matchesKey(legacy, "shift+enter"), false);
    const h = harness({ normalize: false });
    h.buffer.process("first");
    h.buffer.process(legacy);
    assert.equal(h.followUps(), 1);
    assert.equal(h.editor.getText(), "first");
    assert.deepEqual(h.submissions, []);
  });
  withKitty(true, () => assert.equal(matchesKey(legacy, "shift+enter"), true));
});

for (const kitty of [false, true]) {
  test(`normalization adds newline through framing, TUI, and actual editor (Kitty=${kitty})`, () => {
    withKitty(kitty, () => {
      const h = harness();
      const received = [];
      h.tui.addInputListener((data) => { received.push(data); });
      h.buffer.process(`first${legacy}second`);
      assert.equal(h.editor.getText(), "first\nsecond");
      assert.ok(received.includes(shift));
      assert.equal(h.followUps(), 0);
      assert.deepEqual(h.submissions, []);
      // Split stdin chunks still produce one event before Pi's escape timeout.
      h.buffer.process("\x1b");
      h.buffer.process("\r");
      assert.equal(h.editor.getText(), "first\nsecond\n");
      h.buffer.process("\n");
      h.buffer.process(shift);
      assert.equal(h.editor.getText(), "first\nsecond\n\n\n");
      h.buffer.process(alt);
      assert.equal(h.followUps(), 0);
      assert.equal(h.editor.getText(), "first\nsecond\n\n\n\n");
      h.buffer.process("\r");
      assert.deepEqual(h.submissions, ["first\nsecond"]);
      h.shutdown();
    });
  });

  test(`focused multiline dialog retains input ownership (Kitty=${kitty})`, () => {
    withKitty(kitty, () => {
      const h = harness();
      const submitted = [];
      let cancelled = false;
      const dialog = new ExtensionEditorComponent(h.tui, kb, "Draft", "", (text) => submitted.push(text), () => { cancelled = true; });
      h.tui.setFocus(dialog);
      h.buffer.process(`first${legacy}second`);
      assert.equal(dialog.editor.getText(), "first\nsecond");
      assert.equal(h.editor.getText(), "");
      assert.deepEqual(submitted, []);
      assert.equal(cancelled, false);
      h.buffer.process("\r");
      assert.deepEqual(submitted, ["first\nsecond"]);
      h.shutdown();
    });
  });
}

test("unrelated events and paste containing the byte pair remain unchanged", () => {
  const h = harness();
  const inputs = ["\r", "\n", shift, "\x1b[A", "\x1bx", `\x1b[200~before${legacy}after\x1b[201~`, `${legacy}suffix`, ""];
  const received = [];
  h.tui.setFocus({ handleInput() {} });
  h.tui.addInputListener((data) => { received.push(data); });
  for (const input of inputs) h.tui.handleTerminalInput(input);
  assert.deepEqual(received, inputs);
  received.length = 0;
  h.buffer.process(`\x1b[200~before${legacy}`);
  h.buffer.process("after\x1b[201~");
  assert.deepEqual(received, [`\x1b[200~before${legacy}after\x1b[201~`]);
  h.shutdown();
});

test("Herdr re-encoded Alt+Enter press and repeat events become newline, not follow-up", () => {
  for (const kitty of [false, true]) {
    withKitty(kitty, () => {
      const h = harness();
      for (const data of [legacy, alt, "\x1b[13;3:1u", "\x1b[13;3:2u", "\x1b[27;3;13~"]) {
        h.editor.setText("first");
        h.buffer.process(data);
        h.buffer.process("second");
        assert.equal(h.editor.getText(), "first\nsecond", JSON.stringify(data));
        assert.equal(h.followUps(), 0);
        assert.deepEqual(h.submissions, []);
      }
      const releases = [];
      h.tui.addInputListener((data) => { releases.push(data); });
      h.buffer.process("\x1b[13;3:3u");
      assert.deepEqual(releases, ["\x1b[13;3:3u"]);
      assert.equal(h.editor.getText(), "first\nsecond");
      h.shutdown();
    });
  }
});

test("activation requires Herdr and TUI, not merely hasUI", () => {
  for (const term of ["ghostty", "Apple_Terminal", "", "Herdr"]) {
    const h = harness({ term });
    assert.equal(h.tui.inputListeners.size, 0);
    h.shutdown();
  }
  for (const mode of ["rpc", "json", "print"]) {
    const h = harness({ mode });
    assert.equal(h.tui.inputListeners.size, 0);
    h.shutdown();
  }
});

test("repeated starts, UI rebind, replacement, reload, and shutdown do not accumulate subscriptions", () => {
  const h = harness();
  for (const reason of ["startup", "new", "resume", "fork", "reload"]) {
    h.start(reason);
    h.start(reason);
    h.interactive.rebindExtensionTerminalInputListeners();
    assert.equal(h.tui.inputListeners.size, 1);
    assert.equal(h.interactive.extensionTerminalInputSubscriptions.size, 1);
    h.shutdown(reason);
    h.shutdown(reason);
    assert.equal(h.tui.inputListeners.size, 0);
    assert.equal(h.interactive.extensionTerminalInputSubscriptions.size, 0);
    // Replacement loads a fresh factory into the same interactive UI.
    extension(h.pi);
  }
});

test("normalizer preserves modal-editor semantics and the actual fzf wrapper's editor ownership", () => {
  withKitty(false, () => {
    const h = harness();
    let factory;
    const providers = [];
    const ctx = { mode: "tui", ui: {
      getEditorComponent: () => factory,
      setEditorComponent: (next) => { factory = next; },
      addAutocompleteProvider: (next) => providers.push(next),
    } };
    const starts = [];
    const pi = { on(name, handler) { if (name === "session_start") starts.push(handler); } };
    modalExtension(pi);
    createFzfFilePickerExtension({ pick: async () => ({ kind: "cancelled" }) })(pi);
    for (const start of starts) start({}, ctx);
    const composed = factory(h.tui, getEditorTheme(), kb);
    composed.onSubmit = (text) => h.submissions.push(text);
    h.tui.setFocus(composed);
    h.buffer.process(`first${legacy}second`);
    assert.equal(composed.getText(), "first\nsecond");
    assert.deepEqual(h.submissions, []);
    assert.equal(h.editor.getText(), "");
    h.tui.handleTerminalInput("\x1b"); // normal mode
    h.buffer.process("zzz");
    assert.equal(composed.getText(), "first\nsecond");
    h.buffer.process("i");
    h.buffer.process(legacy);
    assert.equal(composed.getText(), "first\nsecond\n");
    assert.equal(providers.length, 1);
    h.shutdown();
  });
});
