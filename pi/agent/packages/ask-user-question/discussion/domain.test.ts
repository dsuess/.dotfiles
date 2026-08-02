import { describe, expect, it } from "vitest";
import { makeApplyContext, makeQuestion, makeQuestionnaireState } from "../test-fixtures.js";
import type { QuestionAnswer } from "../tool/types.js";
import { validateQuestionnaire } from "../tool/validate-questionnaire.js";
import { routeKey, type QuestionnaireAction } from "../state/key-router.js";
import { reduce } from "../state/state-reducer.js";
import type { WrappingSelectItem } from "../view/components/wrapping-select.js";
import {
  boundDiscussionTranscript,
  emptyDiscussionUsage,
  MAX_DISCUSSION_CONTEXT_CHARS,
  MAX_DISCUSSION_MESSAGES,
} from "./types.js";

const items: WrappingSelectItem[] = [
  { kind: "option", label: "A" },
  { kind: "option", label: "B" },
  { kind: "discuss", label: "Discuss this" },
  { kind: "other", label: "Type something." },
];

function apply(state: ReturnType<typeof makeQuestionnaireState>, action: QuestionnaireAction) {
  return reduce(state, action, makeApplyContext({ itemsByTab: [items] }));
}

describe("discussion domain", () => {
  it("routes Enter to discussion and never treats the sentinel as a checkbox", () => {
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
    expect(routeKey(" ", state, runtime)).toEqual({ kind: "ignore" });
    expect(state.answers.size).toBe(0);
    expect(state.multiSelectChecked.size).toBe(0);
  });

  it("reserves the canonical sentinel label", () => {
    const question = makeQuestion({
      options: [
        { label: "Discuss this", description: "collision" },
        { label: "B", description: "b" },
      ],
    });
    expect(validateQuestionnaire({ questions: [question] })).toMatchObject({
      ok: false,
      error: "reserved_label",
    });
  });

  it("opens without changing answers, notes, custom drafts, checkbox state, tab, or collapse", () => {
    const answer: QuestionAnswer = {
      questionIndex: 0,
      question: "Pick one",
      kind: "multi",
      answer: null,
      selected: ["A"],
    };
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
    const opened = apply(before, { kind: "discussion_enter" }).state;
    expect(opened.discussionOpenTab).toBe(0);
    expect(opened.answers).toEqual(before.answers);
    expect(opened.multiSelectChecked).toEqual(before.multiSelectChecked);
    expect(opened.customDraftsByTab).toEqual(before.customDraftsByTab);
    expect(opened.notesByTab).toEqual(before.notesByTab);
    expect(opened.currentTab).toBe(before.currentTab);
    expect(opened.optionIndex).toBe(before.optionIndex);
    expect(opened.inputMode).toBe(true);
    expect(opened.notesVisible).toBe(true);
    expect(opened.collapsed).toBe(true);
  });

  it("keeps drafts on failure and cancellation, then appends a successful turn and usage", () => {
    let state = apply(makeQuestionnaireState({ optionIndex: 2 }), { kind: "discussion_enter" }).state;
    state = apply(state, { kind: "discussion_draft", value: "Why A?" }).state;
    state = apply(state, { kind: "discussion_start" }).state;
    expect(state.discussionsByTab?.get(0)?.running).toBe(true);

    state = apply(state, { kind: "discussion_failure", error: "provider unavailable" }).state;
    expect(state.discussionsByTab?.get(0)).toMatchObject({
      draft: "Why A?",
      running: false,
      error: "provider unavailable",
    });

    state = apply(state, { kind: "discussion_start" }).state;
    state = apply(state, { kind: "discussion_cancel" }).state;
    expect(state.discussionsByTab?.get(0)).toMatchObject({ draft: "Why A?", error: "Turn cancelled" });

    state = apply(state, { kind: "discussion_start" }).state;
    const usage = { ...emptyDiscussionUsage(), input: 10, output: 4, totalTokens: 14 };
    state = apply(state, { kind: "discussion_success", response: "A is simpler.", usage }).state;
    expect(state.discussionsByTab?.get(0)?.transcript).toEqual([
      { role: "user", text: "Why A?" },
      { role: "assistant", text: "A is simpler." },
    ]);
    expect(state.discussionsByTab?.get(0)?.draft).toBe("");
    expect(state.discussionsByTab?.get(0)?.usage.totalTokens).toBe(14);
  });

  it("requires Back before tab switching and restores the same structured row", () => {
    const questions = [makeQuestion(), makeQuestion({ question: "Second?" })];
    const ctx = makeApplyContext({ questions, itemsByTab: [items, items] });
    let state = reduce(makeQuestionnaireState({ optionIndex: 2 }), { kind: "discussion_enter" }, ctx).state;
    state = reduce(state, { kind: "tab_switch", nextTab: 1 }, ctx).state;
    expect(state.currentTab).toBe(0);
    state = reduce(state, { kind: "discussion_back" }, ctx).state;
    expect(state.discussionOpenTab).toBeNull();
    expect(state.optionIndex).toBe(2);
    state = reduce(state, { kind: "tab_switch", nextTab: 1 }, ctx).state;
    expect(state.currentTab).toBe(1);
  });

  it("attaches bounded discussion context to a later normal answer", () => {
    let state = apply(makeQuestionnaireState({ optionIndex: 2 }), { kind: "discussion_enter" }).state;
    state = apply(state, { kind: "discussion_draft", value: "What is safer?" }).state;
    state = apply(state, {
      kind: "discussion_success",
      response: "A has fewer dependencies.",
      usage: emptyDiscussionUsage(),
    }).state;
    state = apply(state, { kind: "discussion_back" }).state;
    const answer: QuestionAnswer = {
      questionIndex: 0,
      question: "Pick one",
      kind: "option",
      answer: "A",
    };
    const result = apply(state, { kind: "confirm", answer }).effects[0];
    expect(result).toMatchObject({
      kind: "done",
      result: {
        cancelled: false,
        discussions: [
          {
            questionIndex: 0,
            messages: [
              { role: "user", text: "What is safer?" },
              { role: "assistant", text: "A has fewer dependencies." },
            ],
          },
        ],
      },
    });
  });

  it("represents handoff as non-cancellation with the question, choices, draft, and partial answers", () => {
    const questions = [makeQuestion(), makeQuestion({ question: "Second?", header: "Second" })];
    const partial: QuestionAnswer = {
      questionIndex: 0,
      question: "Pick one",
      kind: "option",
      answer: "A",
    };
    const ctx = makeApplyContext({ questions, itemsByTab: [items, items] });
    let state = makeQuestionnaireState({ currentTab: 1, optionIndex: 2, answers: new Map([[0, partial]]) });
    state = reduce(state, { kind: "discussion_enter" }, ctx).state;
    state = reduce(state, { kind: "discussion_draft", value: "These choices do not cover it" }, ctx).state;
    const effect = reduce(state, { kind: "discussion_handoff", reason: "Need broader investigation" }, ctx).effects[0];
    expect(effect).toMatchObject({
      kind: "done",
      result: {
        cancelled: false,
        outcome: "handoff",
        answers: [partial],
        handoff: {
          questionIndex: 1,
          question: "Second?",
          reason: "Need broader investigation",
          transcript: [{ role: "user", text: "These choices do not cover it" }],
          partialAnswers: [partial],
        },
      },
    });
  });

  it("bounds transcript count and total characters from the newest messages", () => {
    const transcript = Array.from({ length: MAX_DISCUSSION_MESSAGES + 5 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `${i}:` + "x".repeat(MAX_DISCUSSION_CONTEXT_CHARS / 2),
    }));
    const bounded = boundDiscussionTranscript(transcript);
    expect(bounded.truncated).toBe(true);
    expect(bounded.messages.length).toBeLessThanOrEqual(MAX_DISCUSSION_MESSAGES);
    expect(bounded.messages.reduce((sum, message) => sum + message.text.length, 0)).toBeLessThanOrEqual(
      MAX_DISCUSSION_CONTEXT_CHARS,
    );
    expect(bounded.messages.at(-1)?.text.startsWith(`${transcript.length - 1}:`)).toBe(true);
  });
});
