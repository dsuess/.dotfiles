import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createPiJiti } from "../../../../test-helpers.mjs";

const jiti = await createPiJiti(import.meta.url);
const extension = await jiti.import(new URL("../index.ts", import.meta.url).pathname);

const ctrlT = "\x14";
const kittyCtrlT = "\x1b[116;5u";

function active(text, col = text.length) {
  return extension.findActiveFileReference([text], 0, col);
}

function createHarness({ mode = "insert", pickerResult = { kind: "cancelled" } } = {}) {
  const handlers = new Map();
  const calls = { factories: [], providers: [], notifications: [], picker: 0, originalInputs: [], cancelled: 0 };
  const editor = {
    getLines: () => ["@src"],
    getCursor: () => ({ line: 0, col: 4 }),
    getMode: () => mode,
    isShowingAutocomplete: () => true,
    cancelAutocomplete: () => { calls.cancelled++; },
    handleInput(data) { calls.originalInputs.push(data); },
  };
  const pi = { on(name, handler) { handlers.set(name, handler); } };
  extension.createFzfFilePickerExtension({
    async pick() { calls.picker++; return pickerResult; },
  })(pi);
  const ctx = {
    mode: "tui",
    cwd: "/repo",
    ui: {
      addAutocompleteProvider(factory) { calls.providers.push(factory); },
      getEditorComponent() { return () => editor; },
      setEditorComponent(factory) { calls.factories.push(factory); },
      notify(message, type) { calls.notifications.push({ message, type }); },
    },
  };
  return { calls, ctx, editor, handlers };
}

test("finds bare, partial, quoted, and cursor-middle file references", () => {
  assert.deepEqual(active("@"), { prefix: "@", query: "", quoted: false });
  assert.deepEqual(active("before @src/par"), { prefix: "@src/par", query: "src/par", quoted: false });
  assert.deepEqual(active('before @"docs/my f'), { prefix: '@"docs/my f', query: "docs/my f", quoted: true });
  assert.deepEqual(active("@source", 4), { prefix: "@sou", query: "sou", quoted: false });
  assert.deepEqual(active('@"source"', 6), { prefix: '@"sour', query: "sour", quoted: true });
});

test("rejects invalid @ contexts", () => {
  assert.equal(active("email@example.com"), null);
  assert.equal(active("before @ source"), null);
  assert.equal(active('@"closed"'), null);
  assert.equal(active("before foo@bar"), null);
});

test("builds Pi-compatible file completion values and fzf arguments", () => {
  assert.equal(extension.buildFileCompletionValue("src/main.ts", { quoted: false }), "@src/main.ts");
  assert.equal(extension.buildFileCompletionValue("docs/my file.md", { quoted: false }), '@"docs/my file.md"');
  assert.equal(extension.buildFileCompletionValue("src/main.ts", { quoted: true }), '@"src/main.ts"');
  assert.deepEqual(extension.buildFdArgs("/repo"), [
    "--base-directory", "/repo", "--type", "f", "--type", "d", "--follow", "--hidden",
    "--exclude", ".git", "--exclude", ".git/*", "--exclude", ".git/**", "--print0",
  ]);
  assert.deepEqual(extension.buildFzfArgs("src/par"), [
    "--read0", "--print0", "--no-multi", "--reverse", "--height", "40%", "--scheme", "path", "--query", "src/par",
  ]);
  assert.equal(extension.readNulSelection(Buffer.from("src/a\0ignored\0")), "src/a");
  assert.equal(extension.readNulSelection(Buffer.alloc(0)), null);
});

test("composes after the active editor, delegates outside @ and in non-insert modes", async () => {
  for (const mode of ["insert", "normal", "visual"]) {
    const harness = createHarness({ mode });
    await harness.handlers.get("session_start")({}, harness.ctx);
    const wrapped = harness.calls.factories[0](null, null, null);
    wrapped.getLines = () => [mode === "insert" ? "plain text" : "@src"];
    wrapped.getCursor = () => ({ line: 0, col: wrapped.getLines()[0].length });
    wrapped.handleInput(ctrlT);
    assert.deepEqual(harness.calls.originalInputs, [ctrlT], `${mode} must delegate Ctrl+T`);
    assert.equal(harness.calls.cancelled, 0);
  }
});

test("arms one forced request for legacy and Kitty Ctrl+T, then returns the selected completion", async () => {
  for (const input of [ctrlT, kittyCtrlT]) {
    const harness = createHarness({ pickerResult: { kind: "selected", path: "docs/my file.md" } });
    await harness.handlers.get("session_start")({}, harness.ctx);
    const wrapped = harness.calls.factories[0](null, null, null);
    wrapped.handleInput(input);
    assert.equal(harness.calls.cancelled, 1);
    assert.deepEqual(harness.calls.originalInputs, ["\t"]);

    const provider = harness.calls.providers[0]({
      async getSuggestions() { throw new Error("delegate should not run"); },
      applyCompletion() {},
    });
    const suggestions = await provider.getSuggestions(["@src"], 0, 4, { force: true, signal: new AbortController().signal });
    assert.deepEqual(suggestions, {
      prefix: "@src",
      items: [{ value: '@"docs/my file.md"', label: "docs/my file.md" }],
    });
    assert.equal(harness.calls.picker, 1);
  }
});

test("picker cancellation and errors are lossless, and errors notify", async () => {
  for (const pickerResult of [
    { kind: "cancelled" },
    { kind: "error", message: "fzf is not available" },
  ]) {
    const harness = createHarness({ pickerResult });
    await harness.handlers.get("session_start")({}, harness.ctx);
    const wrapped = harness.calls.factories[0](null, null, null);
    wrapped.handleInput(ctrlT);
    const provider = harness.calls.providers[0]({
      async getSuggestions() { throw new Error("delegate should not run"); },
      applyCompletion() {},
    });
    assert.equal(
      await provider.getSuggestions(["@src"], 0, 4, { force: true, signal: new AbortController().signal }),
      null,
    );
    if (pickerResult.kind === "error") {
      assert.deepEqual(harness.calls.notifications, [{ message: "File picker: fzf is not available", type: "warning" }]);
    }
  }
});

test("settings place the fzf wrapper directly after pi-vim", async () => {
  const settings = JSON.parse(await readFile(new URL("../../../settings.json", import.meta.url), "utf8"));
  const piVim = settings.packages.findIndex(
    (source) => typeof source === "string" && /(?:^npm:pi-vim(?:@|$)|github\.com\/(?:lajarre|peloyeje)\/pi-vim@)/.test(source),
  );
  assert.ok(piVim >= 0);
  assert.equal(settings.packages[piVim + 1], "extensions/fzf-file-picker");
});
