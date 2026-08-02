import { formatAnswerScalar } from "./format-answer.js";
import type { QuestionAnswer, QuestionnaireResult, QuestionParams } from "./types.js";

export const DECLINE_MESSAGE = "User declined to answer questions";
export const HANDOFF_PREFIX = "User chose to continue this clarification in normal chat.";
export const ENVELOPE_PREFIX = "User has answered your questions:";
export const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";

function formatDiscussionContext(result: QuestionnaireResult): string {
	const contexts = result.discussions ?? [];
	if (contexts.length === 0) return "";
	const segments = contexts.map((context) => {
		const transcript = context.messages
			.map((message) => `${message.role === "user" ? "User" : "Discussion agent"}: ${message.text}`)
			.join(" | ");
		return `\"${context.question}\": ${transcript}${context.truncated ? " [context truncated]" : ""}`;
	});
	return ` Discussion context: ${segments.join(" ")}`;
}

function formatHandoff(result: QuestionnaireResult): string {
	const handoff = result.handoff;
	if (!handoff) return HANDOFF_PREFIX;
	const choices = handoff.options.map((option) => `${option.label} — ${option.description}`).join("; ");
	const transcript = handoff.transcript
		.map((message) => `${message.role === "user" ? "User" : "Discussion agent"}: ${message.text}`)
		.join(" | ");
	return `${HANDOFF_PREFIX} Question: ${handoff.question} Choices: ${choices}. Reason: ${handoff.reason}.${
		transcript ? ` Discussion: ${transcript}.` : ""
	}${handoff.truncated ? " [discussion context truncated]" : ""}`;
}

/**
 * Map a `QuestionnaireResult` (or null/cancelled) to the LLM-facing tool envelope.
 * Pure of `(result, params)`; cancelled and "no segments" both fall to `DECLINE_MESSAGE`
 * so the model sees a single canonical "didn't answer" signal regardless of why.
 */
export function buildQuestionnaireResponse(result: QuestionnaireResult | null | undefined, params: QuestionParams) {
	if (result?.outcome === "handoff") {
		return buildToolResult(formatHandoff(result), result, result.discussionUsage);
	}
	if (!result || result.cancelled) {
		const details: QuestionnaireResult = result
			? { ...result, cancelled: true }
			: { answers: [], cancelled: true };
		return buildToolResult(DECLINE_MESSAGE, details, details.discussionUsage);
	}
	const segments: string[] = [];
	for (let i = 0; i < params.questions.length; i++) {
		const a = result.answers.find((x) => x.questionIndex === i);
		if (a) segments.push(buildAnswerSegment(a));
	}
	if (segments.length === 0) {
		return buildToolResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true });
	}
	return buildToolResult(
		`${ENVELOPE_PREFIX} ${segments.join(" ")}${formatDiscussionContext(result)} ${ENVELOPE_SUFFIX}`,
		result,
		result.discussionUsage,
	);
}

/**
 * Format a single answer segment for the envelope. Pure of `a`. The `"Q"="A"` shape and
 * the optional `selected preview:` / `user notes:` suffixes are pinned by envelope tests.
 */
export function buildHandoffUserMessage(result: QuestionnaireResult): string {
	const handoff = result.handoff;
	if (!handoff) return "Continue this questionnaire clarification in normal chat.";
	const choices = handoff.options.map((option, index) => `${index + 1}. ${option.label} — ${option.description}`).join("\n");
	const transcript = handoff.transcript.length
		? handoff.transcript
				.map((message) => `${message.role === "user" ? "Me" : "Discussion agent"}: ${message.text}`)
				.join("\n")
		: "(no completed discussion turns)";
	const partial = handoff.partialAnswers.length
		? handoff.partialAnswers.map((answer) => buildAnswerSegment(answer)).join(" ")
		: "(none)";
	return [
		"[Questionnaire handoff] Continue this unresolved question in normal chat; do not treat this as a decline or silently reuse the same invalid choices.",
		`Question: ${handoff.question}`,
		"Choices:",
		choices,
		`Reason for leaving structured mode: ${handoff.reason}`,
		"Discussion:",
		transcript,
		"Partial answers from other questions:",
		partial,
		handoff.truncated ? "[Discussion context was truncated.]" : "",
	]
		.filter(Boolean)
		.join("\n");
}

export function buildAnswerSegment(a: QuestionAnswer): string {
	const parts: string[] = [`"${a.question}"="${formatAnswerScalar(a, "envelope")}"`];
	if (a.preview && a.preview.length > 0) parts.push(`selected preview: ${a.preview}`);
	if (a.notes && a.notes.length > 0) parts.push(`user notes: ${a.notes}`);
	return `${parts.join(". ")}.`;
}

export function buildToolResult(text: string, details: QuestionnaireResult, usage = details.discussionUsage) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		...(usage ? { usage } : {}),
	};
}
