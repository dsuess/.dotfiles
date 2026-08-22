import { describe, expect, it } from "vitest";
import { validateResolutionSuggestion } from "./child.js";
import type { DiscussionThreadMetadata } from "./runtime.js";

const single: DiscussionThreadMetadata = {
  questionIndex: 0,
  question: "Which?",
  options: [{ label: "A", description: "a" }, { label: "B", description: "b" }],
  multiSelect: false,
  parentSessionFile: "/tmp/parent",
  parentToolCallId: "tool",
  forkAnchorId: "anchor",
};
const multi = { ...single, multiSelect: true };

describe("/resolve classification validation", () => {
  it("accepts exact authored single, multi, and custom suggestions", () => {
    expect(validateResolutionSuggestion(single, {
      outcome: "Choose A",
      fullyAnswers: true,
      classification: "single_option",
      optionLabels: ["A"],
    })).toEqual({ kind: "option", optionLabels: ["A"] });
    expect(validateResolutionSuggestion(multi, {
      outcome: "Both",
      fullyAnswers: true,
      classification: "multi_options",
      optionLabels: ["A", "B"],
    })).toEqual({ kind: "multi", optionLabels: ["A", "B"] });
    expect(validateResolutionSuggestion(single, {
      outcome: "Use hybrid",
      fullyAnswers: true,
      classification: "custom_answer",
      customAnswer: " hybrid ",
    })).toEqual({ kind: "custom", customAnswer: "hybrid" });
  });

  it("degrades malformed, unknown, wrong-shape, incomplete, and blank values to context-only", () => {
    expect(validateResolutionSuggestion(single, {
      outcome: "Choose C",
      fullyAnswers: true,
      classification: "single_option",
      optionLabels: ["C"],
    })).toBeUndefined();
    expect(validateResolutionSuggestion(single, {
      outcome: "Both",
      fullyAnswers: true,
      classification: "multi_options",
      optionLabels: ["A", "B"],
    })).toBeUndefined();
    expect(validateResolutionSuggestion(multi, {
      outcome: "Duplicate",
      fullyAnswers: true,
      classification: "multi_options",
      optionLabels: ["A", "A"],
    })).toBeUndefined();
    expect(validateResolutionSuggestion(single, {
      outcome: "Need more context",
      fullyAnswers: false,
      classification: "single_option",
      optionLabels: ["A"],
    })).toBeUndefined();
    expect(validateResolutionSuggestion(single, {
      outcome: "Blank",
      fullyAnswers: true,
      classification: "custom_answer",
      customAnswer: "  ",
    })).toBeUndefined();
  });
});
