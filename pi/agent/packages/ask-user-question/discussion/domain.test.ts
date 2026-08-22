import { describe, expect, it } from "vitest";
import { makeApplyContext, makeQuestion, makeQuestionnaireState } from "../test-fixtures.js";
import type { QuestionAnswer } from "../tool/types.js";
import { validateQuestionnaire } from "../tool/validate-questionnaire.js";
import { routeKey, type QuestionnaireAction } from "../state/key-router.js";
import { reduce } from "../state/state-reducer.js";
import type { WrappingSelectItem } from "../view/components/wrapping-select.js";
import { boundDiscussionTranscript, emptyDiscussionUsage, type DiscussionThread } from "./types.js";

const items: WrappingSelectItem[] = [
  { kind: "option", label: "A" },
  { kind: "option", label: "B" },
  { kind: "discuss", label: "Discuss this" },
  { kind: "other", label: "Type something." },
];
const thread: DiscussionThread = {
  sessionFile: "/tmp/child.jsonl",
  parentSessionFile: "/tmp/parent.jsonl",
  forkAnchorId: "anchor",
  parentToolCallId: "tool",
};

function apply(state: ReturnType<typeof makeQuestionnaireState>, action: QuestionnaireAction) {
  return reduce(state, action, makeApplyContext({ itemsByTab: [items] }));
}

describe("forked discussion domain", () => {
  it("routes Enter to a one-shot launch effect and never treats the sentinel as a checkbox", () => {
    const question = makeQuestion({ multiSelect: true });
    const state = makeQuestionnaireState({ optionIndex: 2 });
    const runtime = {
      keybindings: { matches: (data: string, name: string) => data === "enter" && name === "tui.select.confirm" },
      inputBuffer: "",
      canMoveInputUp: false,
      canMoveInputDown: false,
      questions: [question],
      isMulti: false,
      currentItem: items[2],
      items,
      collapseKey: "off",
    };
    expect(routeKey("enter", state, runtime)).toEqual({ kind: "discussion_enter" });
    const result = apply(state, { kind: "discussion_enter" });
    expect(result.state.discussionsByTab?.get(0)?.launching).toBe(true);
    expect(result.effects).toEqual([{ kind: "launch_discussion", questionIndex: 0 }]);
    expect(routeKey(" ", state, runtime)).toEqual({ kind: "ignore" });
  });

  it("keeps authored candidate state intact while launching and while context-only resolution returns", () => {
    const answer: QuestionAnswer = { questionIndex: 0, question: "Pick one", kind: "multi", answer: null, selected: ["A"] };
    const before = makeQuestionnaireState({
      optionIndex: 2,
      inputMode: true,
      notesVisible: true,
      answers: new Map([[0, answer]]),
      multiSelectChecked: new Set([0]),
      customDraftsByTab: new Map([[0, "custom draft"]]),
      notesByTab: new Map([[0, "note"]]),
      notesDraft: "note",
      collapsed: true,
    });
    const launching = apply(before, { kind: "discussion_enter" }).state;
    expect(launching.answers).toEqual(before.answers);
    expect(launching.multiSelectChecked).toEqual(before.multiSelectChecked);
    expect(launching.customDraftsByTab).toEqual(before.customDraftsByTab);
    const returned = apply(launching, {
      kind: "discussion_finished",
      thread,
      usage: emptyDiscussionUsage(),
      resolution: {
        id: "r1",
        outcome: "A has less maintenance.",
        classification: "context_only",
        transcript: [{ role: "assistant", text: "A has less maintenance." }],
        classifierUsage: emptyDiscussionUsage(),
        createdAt: Date.now(),
      },
    }).state;
    expect(returned.multiSelectChecked).toEqual(before.multiSelectChecked);
    expect(returned.customDraftsByTab).toEqual(before.customDraftsByTab);
    expect(returned.collapsed).toBe(true);
    expect(returned.optionIndex).toBe(2);
  });

  it("preselects a valid single option but still requires normal Enter confirmation", () => {
    let state = apply(makeQuestionnaireState({ optionIndex: 2 }), { kind: "discussion_enter" }).state;
    state = apply(state, {
      kind: "discussion_finished",
      thread,
      usage: emptyDiscussionUsage(),
      resolution: {
        id: "r1",
        outcome: "Choose B.",
        classification: "single_option",
        suggestion: { kind: "option", optionLabels: ["B"] },
        transcript: [],
        classifierUsage: emptyDiscussionUsage(),
        createdAt: Date.now(),
      },
    }).state;
    expect(state.optionIndex).toBe(1);
    expect(state.answers.size).toBe(0);
    const answer: QuestionAnswer = { questionIndex: 0, question: "Pick one", kind: "option", answer: "B" };
    expect(apply(state, { kind: "confirm", answer }).effects[0]).toMatchObject({ kind: "done", result: { answers: [answer] } });
  });

  it("projects validated multi and custom suggestions into the ordinary controls", () => {
    const multiQuestion = makeQuestion({ multiSelect: true });
    const multiItems: WrappingSelectItem[] = [...items, { kind: "next", label: "Next" }];
    let multi = reduce(makeQuestionnaireState({ optionIndex: 2 }), { kind: "discussion_enter" }, makeApplyContext({ questions: [multiQuestion], itemsByTab: [multiItems] })).state;
    multi = reduce(multi, {
      kind: "discussion_finished",
      thread,
      usage: emptyDiscussionUsage(),
      resolution: {
        id: "multi",
        outcome: "Both apply.",
        classification: "multi_options",
        suggestion: { kind: "multi", optionLabels: ["A", "B"] },
        transcript: [],
        classifierUsage: emptyDiscussionUsage(),
        createdAt: Date.now(),
      },
    }, makeApplyContext({ questions: [multiQuestion], itemsByTab: [multiItems] })).state;
    expect(multi.multiSelectChecked).toEqual(new Set([0, 1]));
    expect(multi.optionIndex).toBe(4);

    let custom = apply(makeQuestionnaireState({ optionIndex: 2 }), { kind: "discussion_enter" }).state;
    const customResult = apply(custom, {
      kind: "discussion_finished",
      thread,
      usage: emptyDiscussionUsage(),
      resolution: {
        id: "custom",
        outcome: "Use a hybrid.",
        classification: "custom_answer",
        suggestion: { kind: "custom", customAnswer: "Hybrid" },
        transcript: [],
        classifierUsage: emptyDiscussionUsage(),
        createdAt: Date.now(),
      },
    });
    custom = customResult.state;
    expect(custom.inputMode).toBe(true);
    expect(custom.optionIndex).toBe(3);
    expect(custom.customDraftsByTab.get(0)).toBe("Hybrid");
    expect(customResult.effects).toContainEqual({ kind: "set_input_buffer", value: "Hybrid" });
  });

  it("reserves the canonical sentinel label and bounds observable transcripts", () => {
    expect(validateQuestionnaire({ questions: [makeQuestion({ options: [{ label: "Discuss this", description: "collision" }, { label: "B", description: "b" }] })] })).toMatchObject({ ok: false, error: "reserved_label" });
    const bounded = boundDiscussionTranscript(Array.from({ length: 30 }, (_, index) => ({ role: "assistant" as const, text: `${index}: ${"x".repeat(4_000)}` })));
    expect(bounded.truncated).toBe(true);
    expect(bounded.messages.at(-1)?.text).toContain("29:");
  });
});
