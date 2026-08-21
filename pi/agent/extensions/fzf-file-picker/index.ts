import { spawn } from "node:child_process";
import { basename } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
  Component,
  EditorComponent,
  EditorTheme,
  KeybindingsManager,
  TUI,
} from "@earendil-works/pi-tui";

type ActiveFileReference = {
  prefix: string;
  query: string;
  quoted: boolean;
};

type PickerResult =
  | { kind: "selected"; path: string }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

type PickerOptions = {
  cwd: string;
  query: string;
};

type PickerDependencies = {
  pick?: (options: PickerOptions, ctx: ExtensionContext) => Promise<PickerResult>;
};

type DecoratedEditor = EditorComponent & {
  getLines?: () => string[];
  getCursor?: () => { line: number; col: number };
  getMode?: () => unknown;
  isShowingAutocomplete?: () => boolean;
  cancelAutocomplete?: () => void;
};

type ArmedPicker = {
  line: number;
  col: number;
  prefix: string;
};

type PickerState = {
  armed: ArmedPicker | null;
  active: boolean;
};

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

/** Return the @ file-reference prefix immediately before the cursor, if any. */
export function findActiveFileReference(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
): ActiveFileReference | null {
  const line = lines[cursorLine] ?? "";
  const beforeCursor = line.slice(0, cursorCol);

  let quoteStart = -1;
  let inQuote = false;
  for (let index = 0; index < beforeCursor.length; index += 1) {
    if (beforeCursor[index] === '"') {
      inQuote = !inQuote;
      if (inQuote) quoteStart = index;
    }
  }
  if (
    inQuote &&
    quoteStart > 0 &&
    beforeCursor[quoteStart - 1] === "@" &&
    (quoteStart === 1 || PATH_DELIMITERS.has(beforeCursor[quoteStart - 2] ?? ""))
  ) {
    const prefix = beforeCursor.slice(quoteStart - 1);
    return { prefix, query: prefix.slice(2), quoted: true };
  }

  let tokenStart = beforeCursor.length;
  while (tokenStart > 0 && !PATH_DELIMITERS.has(beforeCursor[tokenStart - 1] ?? "")) {
    tokenStart -= 1;
  }
  const prefix = beforeCursor.slice(tokenStart);
  if (!prefix.startsWith("@")) return null;
  return { prefix, query: prefix.slice(1), quoted: false };
}

/** Match Pi's native file-completion quoting for an @ file reference. */
export function buildFileCompletionValue(
  path: string,
  token: Pick<ActiveFileReference, "quoted">,
): string {
  if (!token.quoted && !path.includes(" ")) return `@${path}`;
  return `@"${path}"`;
}

/** Arguments intentionally mirror Pi's fd-backed @ autocomplete discovery. */
export function buildFdArgs(cwd: string): string[] {
  return [
    "--base-directory", cwd,
    "--type", "f",
    "--type", "d",
    "--follow",
    "--hidden",
    "--exclude", ".git",
    "--exclude", ".git/*",
    "--exclude", ".git/**",
    "--print0",
  ];
}

/** FZF_DEFAULT_OPTS is inherited from the environment; these are picker-specific options. */
export function buildFzfArgs(query: string): string[] {
  return [
    "--read0",
    "--print0",
    "--no-multi",
    "--reverse",
    "--height", "40%",
    "--scheme", "path",
    "--query", query,
  ];
}

export function readNulSelection(output: Buffer): string | null {
  const end = output.indexOf(0);
  const selected = output.subarray(0, end === -1 ? output.length : end).toString("utf8");
  return selected || null;
}

function processError(program: string, error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
    return `${program} is not available`;
  }
  return `${program} failed`;
}

function runFzf(options: PickerOptions): Promise<PickerResult> {
  return new Promise((resolve) => {
    let settled = false;
    let fdError: unknown;
    let fzfError: unknown;
    let fdClosed = false;
    let fzfClosed = false;
    let fzfCode: number | null = null;
    const output: Buffer[] = [];

    const finish = (result: PickerResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const fd = spawn("fd", buildFdArgs(options.cwd), {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const fzf = spawn("fzf", buildFzfArgs(options.query), {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "inherit"],
    });

    fd.stdout?.pipe(fzf.stdin!);
    fd.stdout?.on("error", () => fzf.stdin?.end());
    fzf.stdout?.on("data", (chunk: Buffer) => output.push(Buffer.from(chunk)));

    fd.on("error", (error) => {
      fdError = error;
      fzf.stdin?.end();
    });
    fzf.on("error", (error) => {
      fzfError = error;
      if (fd.exitCode === null) fd.kill();
    });
    fd.on("close", () => {
      fdClosed = true;
      fzf.stdin?.end();
      settleIfReady();
    });
    fzf.on("close", (code) => {
      fzfClosed = true;
      fzfCode = code;
      settleIfReady();
    });

    function settleIfReady(): void {
      if (settled || !fzfClosed || !fdClosed) return;
      if (fzfError) {
        finish({ kind: "error", message: processError("fzf", fzfError) });
        return;
      }
      if (fdError) {
        finish({ kind: "error", message: processError("fd", fdError) });
        return;
      }
      // Escape and no-match exits are intentionally lossless, even if fd then
      // observes a broken pipe because fzf exited first.
      if (fzfCode === 1 || fzfCode === 130) {
        finish({ kind: "cancelled" });
        return;
      }
      if (fzfCode !== 0) {
        finish({ kind: "error", message: `fzf exited with status ${fzfCode ?? "unknown"}` });
        return;
      }
      const path = readNulSelection(Buffer.concat(output));
      finish(path ? { kind: "selected", path } : { kind: "cancelled" });
    }
  });
}

function pickerComponent(): Component {
  return { render: () => [], invalidate: () => {} };
}

async function pickWithTui(options: PickerOptions, ctx: ExtensionContext): Promise<PickerResult> {
  try {
    return await ctx.ui.custom<PickerResult>((tui: TUI, _theme: unknown, _keybindings: unknown, done) => {
      tui.stop({ preserveScreen: true });
      void runFzf(options)
        .then((result) => {
          tui.start();
          tui.requestRender(true);
          done(result);
        })
        .catch(() => {
          tui.start();
          tui.requestRender(true);
          done({ kind: "error", message: "picker failed" });
        });
      return pickerComponent();
    }, {
      // Avoid custom() restoring its entry snapshot after Pi applies a completion.
      overlay: true,
      overlayOptions: { nonCapturing: true },
    });
  } catch {
    return { kind: "error", message: "picker failed" };
  }
}

function isInsertMode(editor: DecoratedEditor): boolean {
  const mode = editor.getMode?.();
  return mode === undefined || mode === "insert";
}

function decorateEditor(
  editor: DecoratedEditor,
  ctx: ExtensionContext,
  state: PickerState,
): DecoratedEditor {
  const originalHandleInput = editor.handleInput.bind(editor);
  editor.handleInput = (data: string): void => {
    const cursor = editor.getCursor?.();
    const token = cursor && editor.getLines
      ? findActiveFileReference(editor.getLines(), cursor.line, cursor.col)
      : null;
    if (!matchesKey(data, Key.ctrl("t")) || state.active || !isInsertMode(editor) || !cursor || !token) {
      originalHandleInput(data);
      return;
    }

    if (editor.isShowingAutocomplete?.()) editor.cancelAutocomplete?.();
    state.active = true;
    state.armed = { line: cursor.line, col: cursor.col, prefix: token.prefix };
    // Pi's forced file-completion path owns application, cursor movement, undo,
    // and quoting. The one-shot provider below supplies its sole item.
    originalHandleInput("\t");
  };
  return editor;
}

export function createFzfFilePickerExtension(dependencies: PickerDependencies = {}) {
  const pick = dependencies.pick ?? pickWithTui;

  return function fzfFilePickerExtension(pi: ExtensionAPI): void {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.mode !== "tui") return;

      const state: PickerState = { armed: null, active: false };
      ctx.ui.addAutocompleteProvider((current: AutocompleteProvider): AutocompleteProvider => ({
        triggerCharacters: current.triggerCharacters,
        getSuggestions: async (
          lines,
          cursorLine,
          cursorCol,
          options,
        ): Promise<AutocompleteSuggestions | null> => {
          const armed = state.armed;
          if (!armed || !options.force) {
            return current.getSuggestions(lines, cursorLine, cursorCol, options);
          }
          state.armed = null;
          const token = findActiveFileReference(lines, cursorLine, cursorCol);
          if (
            armed.line !== cursorLine ||
            armed.col !== cursorCol ||
            !token ||
            token.prefix !== armed.prefix
          ) {
            state.active = false;
            return null;
          }

          try {
            const result = await pick({ cwd: ctx.cwd, query: token.query }, ctx);
            if (result.kind === "selected") {
              const item: AutocompleteItem = {
                value: buildFileCompletionValue(result.path, token),
                label: result.path || basename(result.path),
              };
              return { prefix: token.prefix, items: [item] };
            }
            if (result.kind === "error") {
              ctx.ui.notify(`File picker: ${result.message}`, "warning");
            }
            return null;
          } finally {
            state.active = false;
          }
        },
        applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
          current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
        shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
          current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true,
      }));

      const currentFactory = ctx.ui.getEditorComponent();
      if (!currentFactory) return;
      ctx.ui.setEditorComponent((tui, theme: EditorTheme, keybindings: KeybindingsManager) =>
        decorateEditor(
          currentFactory(tui, theme, keybindings) as DecoratedEditor,
          ctx,
          state,
        ),
      );
    });
  };
}

export default createFzfFilePickerExtension();
