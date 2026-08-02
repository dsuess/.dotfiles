import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import type { QuestionnaireResult, QuestionParams } from "../tool/types.js";
import { QuestionnaireSession, type QuestionnaireDiscussionRequest } from "../state/questionnaire-session.js";
import type { WrappingSelectItem } from "../view/components/wrapping-select.js";
import { emptyDiscussionUsage } from "./types.js";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "<ENTER>";
const ESC = "\x1b";
const TAB = "\t";
const SHIFT_ENTER = "\x1b\r";
const CTRL_G = "\x07";

const params: QuestionParams = {
  questions: [
    {
      question: "Which implementation?",
      header: "Approach",
      options: [
        { label: "A", description: "Simple" },
        { label: "B", description: "Flexible" },
      ],
    },
  ],
};

const items: WrappingSelectItem[][] = [[
  { kind: "option", label: "A", description: "Simple" },
  { kind: "option", label: "B", description: "Flexible" },
  { kind: "discuss", label: "Discuss this" },
  { kind: "other", label: "Type something." },
]];

const keybindings = {
  matches(data: string, name: string): boolean {
    return (
      (name === "tui.select.up" && data === UP) ||
      (name === "tui.select.down" && data === DOWN) ||
      (name === "tui.select.confirm" && data === ENTER) ||
      (name === "tui.select.cancel" && data === ESC) ||
      (name === "tui.input.newLine" && data === SHIFT_ENTER) ||
      (name === "app.editor.external" && data === CTRL_G)
    );
  },
};

interface HarnessOptions {
  rows?: number;
  runDiscussion?: (request: QuestionnaireDiscussionRequest) => Promise<{
    response: string;
    usage: ReturnType<typeof emptyDiscussionUsage>;
    truncated: boolean;
    tools: string[];
  }>;
  editInput?: (value: string) => Promise<string | undefined>;
}

function harness(options: HarnessOptions = {}) {
  const done = vi.fn<(result: QuestionnaireResult) => void>();
  const tui = { terminal: { columns: 100, rows: options.rows ?? 40 }, requestRender: vi.fn() } as unknown as TUI;
  const session = new QuestionnaireSession({
    tui,
    theme: makeTheme() as unknown as Theme,
    params,
    itemsByTab: items,
    done,
    keybindings,
    editInput: options.editInput ?? (async () => undefined),
    collapseKey: "off",
    runDiscussion: options.runDiscussion,
  });
  session.component.focused = true;
  session.dispatch(DOWN);
  session.dispatch(DOWN);
  session.dispatch(ENTER);
  return { session, done, tui };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("terminal discussion panel", () => {
  it("shows original context, multiline input, actions, and an IME cursor", () => {
    const { session } = harness();
    session.dispatch("Why A?");
    session.dispatch(SHIFT_ENTER);
    session.dispatch("What changes later?");
    const lines = session.component.render(100);
    const text = lines.join("\n");
    expect(text).toContain("Which implementation?");
    expect(text).toContain("1. A — Simple");
    expect(text).toContain("Why A?");
    expect(text).toContain("What changes later?");
    expect(text).toContain("Back to question");
    expect(text).toContain("Continue in chat");
    expect(text).toContain(CURSOR_MARKER);
  });

  it("prevents duplicate turns, shows activity, returns, and submits the unchanged question with context", async () => {
    let resolveTurn!: (value: { response: string; usage: ReturnType<typeof emptyDiscussionUsage>; truncated: boolean; tools: string[] }) => void;
    const runDiscussion = vi.fn(
      (_request: QuestionnaireDiscussionRequest) =>
        new Promise<Parameters<typeof resolveTurn>[0]>((resolve) => { resolveTurn = resolve; }),
    );
    const { session, done } = harness({ runDiscussion });
    session.dispatch("Which is cheaper to maintain?");
    session.dispatch(ENTER);
    session.dispatch(ENTER);
    expect(runDiscussion).toHaveBeenCalledTimes(1);
    const request = runDiscussion.mock.calls[0]![0];
    request.onActivity("Using read");
    expect(session.component.render(100).join("\n")).toContain("Using read");

    resolveTurn({ response: "A is smaller.", usage: emptyDiscussionUsage(), truncated: false, tools: ["read"] });
    await flush();
    expect(session.component.render(100).join("\n")).toContain("Discussion agent: A is smaller.");

    session.dispatch(TAB);
    session.dispatch(DOWN);
    session.dispatch(ENTER);
    const restored = session.component.render(100).join("\n");
    expect(restored).toContain("Discuss this");
    expect(restored).toContain("Type something.");
    session.dispatch(UP);
    session.dispatch(UP);
    session.dispatch(ENTER);
    expect(done).toHaveBeenCalledWith(expect.objectContaining({
      cancelled: false,
      answers: [expect.objectContaining({ answer: "A" })],
      discussions: [expect.objectContaining({ question: "Which implementation?" })],
    }));
  });

  it("cancels a running child without losing the draft or closing the questionnaire", async () => {
    const runDiscussion = vi.fn((request: QuestionnaireDiscussionRequest) => new Promise<never>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const { session, done } = harness({ runDiscussion });
    session.dispatch("Keep this draft");
    session.dispatch(ENTER);
    session.dispatch(ESC);
    await flush();
    const view = session.component.render(100).join("\n");
    expect(view).toContain("Keep this draft");
    expect(view).toContain("Turn cancelled");
    expect(done).not.toHaveBeenCalled();
  });

  it("round-trips the discussion draft through the external editor", async () => {
    const editInput = vi.fn(async (value: string) => `${value} edited`);
    const { session } = harness({ editInput });
    session.dispatch("draft");
    session.dispatch(CTRL_G);
    await flush();
    expect(editInput).toHaveBeenCalledWith("draft");
    expect(session.component.render(100).join("\n")).toContain("draft edited");
  });

  it("keeps every line and the panel height within narrow terminal bounds", () => {
    const { session } = harness({ rows: 12 });
    session.dispatch("A long clarification ".repeat(20));
    for (const width of [12, 24, 60]) {
      const lines = session.component.render(width);
      expect(lines.length).toBeLessThanOrEqual(12);
      expect(lines.join("\n")).toContain("Which");
      expect(lines.join("\n")).toContain("Continue");
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});
