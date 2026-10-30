import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import factory from "../index.js";
import { registerDiscussionChildRuntime, validateResolutionSuggestion } from "./child.js";
import { CHILD_TOOL_EXCLUSIONS, DISCUSSION_CHILD_MARKER, type DiscussionThreadMetadata } from "./runtime.js";

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

describe("discussion child runtime lifecycle", () => {
  afterEach(() => vi.unstubAllEnvs());

  function uninitializedRuntime() {
    const { pi, captured } = createMockPi();
    let initialized = false;
    vi.mocked(pi.getActiveTools).mockImplementation(() => {
      if (!initialized) throw new Error("Extension runtime not initialized. Cannot call getActiveTools() during extension loading.");
      return [...captured.activeTools];
    });
    vi.mocked(pi.setActiveTools).mockImplementation((names) => {
      if (!initialized) throw new Error("Extension runtime not initialized. Cannot call setActiveTools() during extension loading.");
      captured.activeTools = [...names];
    });
    return { pi, captured, initialize: () => { initialized = true; } };
  }

  it("registers child controls without reading or writing active tools before initialization", () => {
    vi.stubEnv(DISCUSSION_CHILD_MARKER, "1");
    const { pi, captured } = uninitializedRuntime();
    expect(() => registerDiscussionChildRuntime(pi)).not.toThrow();
    expect(pi.getActiveTools).not.toHaveBeenCalled();
    expect(pi.setActiveTools).not.toHaveBeenCalled();
    expect([...captured.commands.keys()]).toEqual(["resolve"]);
    expect([...captured.events.keys()]).toEqual(["session_start", "before_agent_start", "tool_call"]);
    for (const handlers of captured.events.values()) expect(handlers).toHaveLength(1);
  });

  it("registers no child controls in parent sessions", () => {
    vi.stubEnv(DISCUSSION_CHILD_MARKER, undefined);
    const { pi, captured } = uninitializedRuntime();
    registerDiscussionChildRuntime(pi);
    expect(pi.getActiveTools).not.toHaveBeenCalled();
    expect(pi.setActiveTools).not.toHaveBeenCalled();
    expect(captured.commands.size).toBe(0);
    expect(captured.events.size).toBe(0);
  });

  it("filters after package registration and before each run without reconciler restoration", async () => {
    vi.stubEnv(DISCUSSION_CHILD_MARKER, "1");
    vi.stubEnv("PI_ASK_USER_QUESTION_DISCUSSION_SYSTEM_PROMPT", undefined);
    const { pi, captured, initialize } = uninitializedRuntime();
    const compatible = ["read", "bash", "ketch_search"];
    captured.activeTools = [...compatible, ...CHILD_TOOL_EXCLUSIONS];
    factory(pi);
    expect(captured.tools.has("ask_user_question")).toBe(true);
    expect(pi.getActiveTools).not.toHaveBeenCalled();
    expect(pi.setActiveTools).not.toHaveBeenCalled();
    initialize();
    const ctx = createMockCtx({ hasUI: true });
    for (const handler of captured.events.get("session_start")!) await handler({}, ctx);
    expect(captured.activeTools).toEqual(compatible);
    expect(captured.events.get("before_agent_start")).toHaveLength(2);
    for (let run = 0; run < 2; run++) {
      // Simulate another extension reactivating excluded tools between runs.
      captured.activeTools = [...compatible, ...CHILD_TOOL_EXCLUSIONS];
      for (const handler of captured.events.get("before_agent_start")!) {
        await handler({ systemPrompt: "Parent prompt" }, ctx);
      }
      expect(captured.activeTools).toEqual(compatible);
    }
  });

  it("blocks every excluded tool at execution time and permits compatible tools", async () => {
    vi.stubEnv(DISCUSSION_CHILD_MARKER, "1");
    const { pi, captured } = uninitializedRuntime();
    registerDiscussionChildRuntime(pi);
    const guard = captured.events.get("tool_call")![0]!;
    for (const toolName of CHILD_TOOL_EXCLUSIONS) {
      expect(await guard({ toolName }, createMockCtx())).toEqual({
        block: true,
        terminate: true,
        reason: "This tool is unavailable inside a questionnaire discussion child.",
      });
    }
    expect(await guard({ toolName: "read" }, createMockCtx())).toBeUndefined();
  });
});

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
