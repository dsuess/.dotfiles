import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { emptyDiscussionUsage } from "./types.js";
import { QuestionnaireSession } from "../state/questionnaire-session.js";
import type { QuestionParams, QuestionnaireResult } from "../tool/types.js";
import type { WrappingSelectItem } from "../view/components/wrapping-select.js";

const params: QuestionParams = {
  questions: [{ question: "Which?", header: "Pick", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }],
};
const items: WrappingSelectItem[][] = [[
  { kind: "option", label: "A" },
  { kind: "option", label: "B" },
  { kind: "discuss", label: "Discuss this" },
  { kind: "other", label: "Type something." },
]];
const keybindings = {
  matches(data: string, name: string): boolean {
    return (data === "down" && name === "tui.select.down") || (data === "enter" && name === "tui.select.confirm");
  },
};

describe("forked discussion outcome view", () => {
  it("keeps the ordinary question layout and renders a bounded outcome after the child returns", async () => {
    const done = vi.fn<(result: QuestionnaireResult) => void>();
    const session = new QuestionnaireSession({
      tui: { terminal: { columns: 100, rows: 40 }, requestRender: vi.fn() } as unknown as TUI,
      theme: makeTheme() as unknown as Theme,
      params,
      itemsByTab: items,
      done,
      keybindings,
      editInput: async () => undefined,
      collapseKey: "off",
      runDiscussion: async () => ({
        thread: { sessionFile: "/tmp/child", parentSessionFile: "/tmp/parent", forkAnchorId: "anchor", parentToolCallId: "call" },
        usage: emptyDiscussionUsage(),
        resolution: {
          id: "resolution",
          outcome: "A is smaller and needs fewer dependencies.",
          classification: "single_option",
          suggestion: { kind: "option", optionLabels: ["A"] },
          transcript: [{ role: "assistant", text: "A is smaller." }],
          classifierUsage: emptyDiscussionUsage(),
          createdAt: Date.now(),
        },
      }),
    });
    session.dispatch("down");
    session.dispatch("down");
    session.dispatch("enter");
    await Promise.resolve();
    await Promise.resolve();
    const text = session.component.render(100).join("\n");
    expect(text).toContain("Discussion outcome");
    expect(text).toContain("A is smaller and needs fewer dependencies.");
    expect(text).toContain("A");
    expect(done).not.toHaveBeenCalled();
  });
});
