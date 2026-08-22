/**
 * Native select/input fallback for RPC and ACP hosts.
 *
 * A nested terminal Pi session cannot own an RPC host's terminal. Discuss this
 * therefore returns the existing non-cancellation handoff immediately; the
 * parent queues one normal-chat steering message and terminates this tool turn.
 */

import type { QuestionnaireHandoff } from "./discussion/types.js";
import { displayLabel, t } from "./state/i18n-bridge.js";
import type { QuestionAnswer, QuestionData, QuestionnaireResult, QuestionParams } from "./tool/types.js";

const MULTI_SELECT_INSTRUCTIONS =
  'Enter the numbers of all that apply, comma-separated (e.g. "1,3"), or type a custom answer as plain text.';
const CUSTOM_ANSWER_TITLE = "Type your answer:";
const MULTI_SELECT_PLACEHOLDER = "1,3";
const HANDOFF_REASON = "This host cannot open a nested terminal discussion thread";
const MAX_PREVIEW_CHARS = 600;

export type DialogUI = {
  select: (title: string, options: string[]) => Promise<string | undefined>;
  input: (title: string, placeholder?: string) => Promise<string | undefined>;
};

export function hasDialogUI(ui: unknown): ui is DialogUI {
  const value = ui as Partial<Record<"select" | "input", unknown>> | null | undefined;
  return typeof value?.select === "function" && typeof value?.input === "function";
}

type Option = QuestionData["options"][number];
type HandoffChoice = { kind: "handoff"; handoff: QuestionnaireHandoff };
type QuestionChoice = QuestionAnswer | HandoffChoice | undefined;

function formatOptionLine(option: Option, index: number): string {
  return `${index + 1}. ${option.label} — ${option.description}`;
}

function parseIndex(token: string, count: number): number | null {
  const index = Number.parseInt(token, 10) - 1;
  return index >= 0 && index < count ? index : null;
}

function buildPreviewBlock(question: QuestionData): string {
  const blocks = question.options.flatMap((option, index) =>
    option.preview && option.preview.length > 0
      ? [`--- ${index + 1}. ${option.label} preview ---\n${option.preview.slice(0, MAX_PREVIEW_CHARS)}`]
      : [],
  );
  return blocks.length > 0 ? `\n\n${blocks.join("\n\n")}` : "";
}

function handoff(question: QuestionData, questionIndex: number, partialAnswers: QuestionAnswer[]): HandoffChoice {
  return {
    kind: "handoff",
    handoff: {
      questionIndex,
      question: question.question,
      options: question.options.map(({ label, description }) => ({ label, description })),
      reason: HANDOFF_REASON,
      transcript: [],
      partialAnswers,
    },
  };
}

export async function runRpcQuestionnaire(ui: DialogUI, params: QuestionParams): Promise<QuestionnaireResult> {
  const answers: QuestionAnswer[] = [];
  for (let questionIndex = 0; questionIndex < params.questions.length; questionIndex++) {
    const question = params.questions[questionIndex]!;
    const header = question.header ? `[${question.header}] ` : "";
    const choice = question.multiSelect
      ? await askMultiSelect(ui, question, questionIndex, header, answers)
      : await askSingleSelect(ui, question, questionIndex, header, answers);
    if (choice === undefined) return { answers, cancelled: true };
    if ("kind" in choice && choice.kind === "handoff") {
      return { answers, cancelled: false, outcome: "handoff", handoff: choice.handoff };
    }
    answers.push(choice);
  }
  return { answers, cancelled: false };
}

async function askSingleSelect(
  ui: DialogUI,
  question: QuestionData,
  questionIndex: number,
  header: string,
  partialAnswers: QuestionAnswer[],
): Promise<QuestionChoice> {
  const options = question.options.map(formatOptionLine);
  const discussIndex = options.length;
  options.push(`${discussIndex + 1}. ${displayLabel("discuss")}`);
  const customIndex = options.length;
  options.push(`${customIndex + 1}. ${displayLabel("other")}`);
  const chosen = await ui.select(`${header}${question.question}${buildPreviewBlock(question)}`, options);
  if (chosen == null) return undefined;
  const index = parseIndex(chosen, options.length);
  if (index == null) return undefined;
  if (index < question.options.length) {
    const option = question.options[index]!;
    return {
      questionIndex,
      question: question.question,
      kind: "option",
      answer: option.label,
      preview: option.preview && option.preview.length > 0 ? option.preview : undefined,
    };
  }
  if (index === discussIndex) return handoff(question, questionIndex, partialAnswers);
  const typed = await ui.input(`${header}${question.question}\n\n${t("rpc.custom_answer_title", CUSTOM_ANSWER_TITLE)}`, "");
  return typed == null ? undefined : { questionIndex, question: question.question, kind: "custom", answer: typed };
}

async function askMultiSelect(
  ui: DialogUI,
  question: QuestionData,
  questionIndex: number,
  header: string,
  partialAnswers: QuestionAnswer[],
): Promise<QuestionChoice> {
  const options = question.options.map(formatOptionLine);
  const discussIndex = options.length;
  options.push(`${discussIndex + 1}. ${displayLabel("discuss")}`);
  const customIndex = options.length;
  options.push(`${customIndex + 1}. ${displayLabel("other")}`);
  const multipleIndex = options.length;
  options.push(`${multipleIndex + 1}. ${t("rpc.multi_choose", "Select multiple…")}`);
  const chosen = await ui.select(`${header}${question.question}`, options);
  if (chosen == null) return undefined;
  const index = parseIndex(chosen, options.length);
  if (index == null) return undefined;
  if (index < question.options.length) {
    return { questionIndex, question: question.question, kind: "multi", answer: null, selected: [question.options[index]!.label] };
  }
  if (index === discussIndex) return handoff(question, questionIndex, partialAnswers);
  if (index === customIndex) {
    const typed = await ui.input(`${header}${question.question}\n\n${t("rpc.custom_answer_title", CUSTOM_ANSWER_TITLE)}`, "");
    return typed == null ? undefined : { questionIndex, question: question.question, kind: "custom", answer: typed };
  }
  const list = question.options.map(formatOptionLine).join("\n");
  const value = await ui.input(
    `${header}${question.question}\n\n${list}\n\n${t("rpc.multi_instructions", MULTI_SELECT_INSTRUCTIONS)}`,
    MULTI_SELECT_PLACEHOLDER,
  );
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return { questionIndex, question: question.question, kind: "multi", answer: null, selected: [] };
  const tokens = trimmed.split(/[,\s]+/).filter(Boolean);
  const indices = tokens.map((token) => (/^\d+\.?$/.test(token) ? parseIndex(token, question.options.length) : null));
  if (indices.every((candidate): candidate is number => candidate != null)) {
    const selected: string[] = [];
    for (const item of indices) {
      const label = question.options[item]!.label;
      if (!selected.includes(label)) selected.push(label);
    }
    return { questionIndex, question: question.question, kind: "multi", answer: null, selected };
  }
  return { questionIndex, question: question.question, kind: "custom", answer: trimmed };
}
