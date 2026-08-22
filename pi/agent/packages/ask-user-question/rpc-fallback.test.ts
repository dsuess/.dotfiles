import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import { hasDialogUI, runRpcQuestionnaire } from "./rpc-fallback.js";

const single = {
  questions: [{ question: "Which?", header: "Pick", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }],
};
const multi = {
  questions: [{ question: "Colors?", header: "Colors", multiSelect: true, options: [{ label: "red", description: "r" }, { label: "green", description: "g" }, { label: "blue", description: "b" }] }],
};

function dialog(select: (title: string, options: string[]) => Promise<string | undefined>, input = async () => "") {
  return { select: vi.fn(select), input: vi.fn(input) };
}

describe("RPC questionnaire fallback", () => {
  it("requires native select and input primitives", () => {
    expect(hasDialogUI({ select: async () => undefined, input: async () => "" })).toBe(true);
    expect(hasDialogUI({ select: async () => undefined })).toBe(false);
  });

  it("preserves normal structured single and multi answers", async () => {
    const singleUi = dialog(async (_title, options) => options[1]);
    await expect(runRpcQuestionnaire(singleUi, single)).resolves.toMatchObject({ answers: [{ answer: "B" }], cancelled: false });
    const multiUi = dialog(async (_title, options) => options.at(-1), async () => "1,3");
    await expect(runRpcQuestionnaire(multiUi, multi)).resolves.toMatchObject({ answers: [{ kind: "multi", selected: ["red", "blue"] }], cancelled: false });
  });

  it("turns Discuss this directly into one non-cancelled normal-chat handoff", async () => {
    const ui = dialog(async (_title, options) => options[2]);
    const result = await runRpcQuestionnaire(ui, single);
    expect(result).toMatchObject({
      cancelled: false,
      outcome: "handoff",
      handoff: { question: "Which?", transcript: [], partialAnswers: [] },
    });
    expect(ui.input).not.toHaveBeenCalled();
  });

  it("the tool queues exactly one steering message and terminates an RPC handoff", async () => {
    const { pi, captured } = createMockPi();
    registerAskUserQuestionTool(pi);
    const tool = captured.tools.get("ask_user_question")!;
    const ui = dialog(async (_title, options) => options[2]);
    const ctx = createMockCtx({ hasUI: true, mode: "rpc", ui: ui as never });
    const result = await tool.execute?.("call", single as never, undefined, undefined, ctx as never);
    expect(result).toMatchObject({ details: { cancelled: false, outcome: "handoff" }, terminate: true });
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("[Questionnaire handoff]"), { deliverAs: "steer" });
  });
});
