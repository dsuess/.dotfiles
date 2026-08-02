/**
 * Native select/input fallback for hosts without Pi's custom terminal UI.
 *
 * The walker preserves the questionnaire's three outcomes and the per-question
 * discussion lifecycle. Discussion is represented as a small native-dialog loop:
 * ask another clarification, return to the original choices, or continue in chat.
 */

import type { DiscussionTurnResult } from "./discussion/runtime.js";
import {
	aggregateDiscussionUsage,
	boundDiscussionTranscript,
	buildDiscussionContexts,
	emptyQuestionDiscussion,
	mergeDiscussionUsage,
	type QuestionDiscussionState,
	type QuestionnaireHandoff,
} from "./discussion/types.js";
import { displayLabel, t } from "./state/i18n-bridge.js";
import type { QuestionnaireDiscussionRequest } from "./state/questionnaire-session.js";
import type {
	QuestionAnswer,
	QuestionData,
	QuestionnaireResult,
	QuestionParams,
} from "./tool/types.js";

const MULTI_SELECT_INSTRUCTIONS =
	'Enter the numbers of all that apply, comma-separated (e.g. "1,3"), or type a custom answer as plain text.';
const CUSTOM_ANSWER_TITLE = "Type your answer:";
const MULTI_SELECT_PLACEHOLDER = "1,3";
const DISCUSSION_ASK = "Ask a clarification";
const DISCUSSION_BACK = "Back to question";
const DISCUSSION_CONTINUE = "Continue in chat";
const DISCUSSION_INPUT = "What would you like clarified?";
const HANDOFF_REASON = "The structured choices need broader investigation";
const MAX_PREVIEW_CHARS = 600;
const MAX_DIALOG_DISCUSSION_CHARS = 1_200;

export type DialogUI = {
	select: (title: string, options: string[]) => Promise<string | undefined>;
	input: (title: string, placeholder?: string) => Promise<string | undefined>;
};

export type RpcDiscussionRunner = (request: QuestionnaireDiscussionRequest) => Promise<DiscussionTurnResult>;

export function hasDialogUI(ui: unknown): ui is DialogUI {
	const u = ui as Partial<Record<"select" | "input", unknown>> | null | undefined;
	return typeof u?.select === "function" && typeof u?.input === "function";
}

type Option = QuestionData["options"][number];
type HandoffChoice = { kind: "handoff"; handoff: QuestionnaireHandoff };
type QuestionChoice = QuestionAnswer | HandoffChoice | undefined;

function formatOptionLine(option: Option, index: number): string {
	return `${index + 1}. ${option.label} — ${option.description}`;
}

function parseIndex(token: string, count: number): number | null {
	const i = Number.parseInt(token, 10) - 1;
	return i >= 0 && i < count ? i : null;
}

function buildPreviewBlock(question: QuestionData): string {
	const blocks = question.options.flatMap((o, i) =>
		o.preview && o.preview.length > 0
			? [`--- ${i + 1}. ${o.label} preview ---\n${o.preview.slice(0, MAX_PREVIEW_CHARS)}`]
			: [],
	);
	return blocks.length > 0 ? `\n\n${blocks.join("\n\n")}` : "";
}

function addDiscussionMetadata(
	result: QuestionnaireResult,
	discussions: ReadonlyMap<number, QuestionDiscussionState>,
	questions: readonly QuestionData[],
): QuestionnaireResult {
	const contexts = buildDiscussionContexts(discussions, questions);
	if (contexts.length === 0) return result;
	return {
		...result,
		discussions: contexts,
		discussionUsage: aggregateDiscussionUsage(discussions),
	};
}

function discussionTitle(question: QuestionData, discussion: QuestionDiscussionState): string {
	const transcript = discussion.transcript
		.slice(-4)
		.map((message) => `${message.role === "user" ? "You" : "Agent"}: ${message.text}`)
		.join("\n\n")
		.slice(-MAX_DIALOG_DISCUSSION_CHARS);
	const status = discussion.error ? `\n\nError: ${discussion.error}` : "";
	return `${question.question}${transcript ? `\n\n${transcript}` : ""}${status}`;
}

function buildHandoff(
	question: QuestionData,
	questionIndex: number,
	discussion: QuestionDiscussionState,
	partialAnswers: QuestionAnswer[],
): QuestionnaireHandoff {
	const pending = discussion.draft.trim();
	const transcript = pending
		? [...discussion.transcript, { role: "user" as const, text: pending }]
		: discussion.transcript;
	const bounded = boundDiscussionTranscript(transcript);
	return {
		questionIndex,
		question: question.question,
		options: question.options.map(({ label, description }) => ({ label, description })),
		reason: HANDOFF_REASON,
		transcript: bounded.messages,
		partialAnswers,
		...(bounded.truncated ? { truncated: true } : {}),
	};
}

async function discussQuestion(
	ui: DialogUI,
	question: QuestionData,
	questionIndex: number,
	discussion: QuestionDiscussionState,
	partialAnswers: QuestionAnswer[],
	runDiscussion: RpcDiscussionRunner | undefined,
): Promise<"back" | HandoffChoice> {
	while (true) {
		const action = await ui.select(discussionTitle(question, discussion), [
		t("discussion.ask", DISCUSSION_ASK),
		t("discussion.back", DISCUSSION_BACK),
		t("discussion.continue", DISCUSSION_CONTINUE),
	]);
		if (action == null || action === t("discussion.back", DISCUSSION_BACK)) return "back";
		if (action === t("discussion.continue", DISCUSSION_CONTINUE)) {
			return { kind: "handoff", handoff: buildHandoff(question, questionIndex, discussion, partialAnswers) };
		}
		if (action !== t("discussion.ask", DISCUSSION_ASK)) return "back";
		const prompt = await ui.input(discussionTitle(question, discussion), t("discussion.input", DISCUSSION_INPUT));
		if (prompt == null) continue;
		discussion.draft = prompt;
		discussion.error = undefined;
		if (!runDiscussion) {
			discussion.error = "Discussion agent is unavailable";
			continue;
		}
		const controller = new AbortController();
		discussion.running = true;
		discussion.activity = [];
		try {
			const result = await runDiscussion({
				questionIndex,
				question: question.question,
				options: question.options,
				userPrompt: prompt,
				transcript: discussion.transcript,
				signal: controller.signal,
				onActivity: (message) => {
					discussion.activity = [...discussion.activity, message].slice(-8);
				},
			});
			discussion.transcript = [
				...discussion.transcript,
				{ role: "user", text: prompt },
				{ role: "assistant", text: result.response, ...(result.truncated ? { truncated: true } : {}) },
			];
			discussion.usage = mergeDiscussionUsage(discussion.usage, result.usage);
			discussion.draft = "";
			discussion.error = undefined;
		} catch (error) {
			discussion.error = error instanceof Error ? error.message : String(error);
		} finally {
			discussion.running = false;
			discussion.activity = [];
		}
	}
}

export async function runRpcQuestionnaire(
	ui: DialogUI,
	params: QuestionParams,
	runDiscussion?: RpcDiscussionRunner,
): Promise<QuestionnaireResult> {
	const answers: QuestionAnswer[] = [];
	const discussions = new Map<number, QuestionDiscussionState>();
	for (let qi = 0; qi < params.questions.length; qi++) {
		const q = params.questions[qi]!;
		const discussion = emptyQuestionDiscussion();
		discussions.set(qi, discussion);
		const header = q.header ? `[${q.header}] ` : "";
		const choice = q.multiSelect
			? await askMultiSelect(ui, q, qi, header, discussion, answers, runDiscussion)
			: await askSingleSelect(ui, q, qi, header, discussion, answers, runDiscussion);
		if (choice === undefined) return addDiscussionMetadata({ answers, cancelled: true }, discussions, params.questions);
		if ("kind" in choice && choice.kind === "handoff") {
			return addDiscussionMetadata(
				{ answers, cancelled: false, outcome: "handoff", handoff: choice.handoff },
				discussions,
				params.questions,
			);
		}
		answers.push(choice);
	}
	return addDiscussionMetadata({ answers, cancelled: false }, discussions, params.questions);
}

async function askSingleSelect(
	ui: DialogUI,
	q: QuestionData,
	questionIndex: number,
	header: string,
	discussion: QuestionDiscussionState,
	partialAnswers: QuestionAnswer[],
	runDiscussion: RpcDiscussionRunner | undefined,
): Promise<QuestionChoice> {
	while (true) {
		const options = q.options.map(formatOptionLine);
		const discussIndex = options.length;
		options.push(`${discussIndex + 1}. ${displayLabel("discuss")}`);
		const customIndex = options.length;
		options.push(`${customIndex + 1}. ${displayLabel("other")}`);
		const chosen = await ui.select(`${header}${q.question}${buildPreviewBlock(q)}`, options);
		if (chosen == null) return undefined;
		const idx = parseIndex(chosen, options.length);
		if (idx == null) return undefined;
		if (idx < q.options.length) {
			const o = q.options[idx]!;
			return {
				questionIndex,
				question: q.question,
				kind: "option",
				answer: o.label,
				preview: o.preview && o.preview.length > 0 ? o.preview : undefined,
			};
		}
		if (idx === discussIndex) {
			const result = await discussQuestion(ui, q, questionIndex, discussion, partialAnswers, runDiscussion);
			if (result !== "back") return result;
			continue;
		}
		const typed = await ui.input(`${header}${q.question}\n\n${t("rpc.custom_answer_title", CUSTOM_ANSWER_TITLE)}`, "");
		if (typed == null) return undefined;
		return { questionIndex, question: q.question, kind: "custom", answer: typed };
	}
}

async function askMultiSelect(
	ui: DialogUI,
	q: QuestionData,
	questionIndex: number,
	header: string,
	discussion: QuestionDiscussionState,
	partialAnswers: QuestionAnswer[],
	runDiscussion: RpcDiscussionRunner | undefined,
): Promise<QuestionChoice> {
	while (true) {
		const options = q.options.map(formatOptionLine);
		const discussIndex = options.length;
		options.push(`${discussIndex + 1}. ${displayLabel("discuss")}`);
		const customIndex = options.length;
		options.push(`${customIndex + 1}. ${displayLabel("other")}`);
		const multipleIndex = options.length;
		options.push(`${multipleIndex + 1}. ${t("rpc.multi_choose", "Select multiple…")}`);
		const chosen = await ui.select(`${header}${q.question}`, options);
		if (chosen == null) return undefined;
		const idx = parseIndex(chosen, options.length);
		if (idx == null) return undefined;
		if (idx < q.options.length) {
			return { questionIndex, question: q.question, kind: "multi", answer: null, selected: [q.options[idx]!.label] };
		}
		if (idx === discussIndex) {
			const result = await discussQuestion(ui, q, questionIndex, discussion, partialAnswers, runDiscussion);
			if (result !== "back") return result;
			continue;
		}
		if (idx === customIndex) {
			const typed = await ui.input(`${header}${q.question}\n\n${t("rpc.custom_answer_title", CUSTOM_ANSWER_TITLE)}`, "");
			if (typed == null) return undefined;
			return { questionIndex, question: q.question, kind: "custom", answer: typed };
		}
		const list = q.options.map(formatOptionLine).join("\n");
		const value = await ui.input(
			`${header}${q.question}\n\n${list}\n\n${t("rpc.multi_instructions", MULTI_SELECT_INSTRUCTIONS)}`,
			MULTI_SELECT_PLACEHOLDER,
		);
		if (value == null) return undefined;
		const trimmed = value.trim();
		if (trimmed.length === 0) {
			return { questionIndex, question: q.question, kind: "multi", answer: null, selected: [] };
		}
		const tokens = trimmed.split(/[,\s]+/).filter((token) => token.length > 0);
		const indices = tokens.map((token) => (/^\d+\.?$/.test(token) ? parseIndex(token, q.options.length) : null));
		if (indices.every((index): index is number => index != null)) {
			const selected: string[] = [];
			for (const index of indices) {
				const label = q.options[index]!.label;
				if (!selected.includes(label)) selected.push(label);
			}
			return { questionIndex, question: q.question, kind: "multi", answer: null, selected };
		}
		return { questionIndex, question: q.question, kind: "custom", answer: trimmed };
	}
}
