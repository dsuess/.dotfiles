import type { QuestionAnswer, QuestionData } from "../tool/types.js";

export const MAX_DISCUSSION_MESSAGES = 12;
export const MAX_DISCUSSION_MESSAGE_CHARS = 4_000;
export const MAX_DISCUSSION_CONTEXT_CHARS = 16_000;
export const MAX_DISCUSSION_OUTCOME_CHARS = 1_200;

export interface DiscussionCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** Pi-compatible usage returned by the child conversation and its resolver. */
export interface DiscussionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: DiscussionCost;
}

/** Observable-only discussion context. Thinking and image blocks are never copied here. */
export interface DiscussionMessage {
  role: "user" | "assistant";
  text: string;
  truncated?: boolean;
}

export type DiscussionClassification =
  | "context_only"
  | "single_option"
  | "multi_options"
  | "custom_answer";

export interface DiscussionAnswerSuggestion {
  kind: "option" | "multi" | "custom";
  optionLabels?: string[];
  customAnswer?: string;
}

export interface DiscussionResolution {
  id: string;
  outcome: string;
  classification: DiscussionClassification;
  suggestion?: DiscussionAnswerSuggestion;
  transcript: DiscussionMessage[];
  truncated?: boolean;
  classifierUsage: DiscussionUsage;
  classifierFailed?: boolean;
  createdAt: number;
}

/** Durable identity of the per-question child session. */
export interface DiscussionThread {
  sessionFile: string;
  sessionId?: string;
  parentSessionFile: string;
  forkAnchorId: string;
  parentToolCallId: string;
  metadataEntryId?: string;
}

/** Per-question parent state. It intentionally has no embedded-editor/panel state. */
export interface QuestionDiscussionState {
  thread?: DiscussionThread;
  lastConsumedResolutionId?: string;
  resolution?: DiscussionResolution;
  /** Cumulative child-conversation plus classifier usage for this thread. */
  usage: DiscussionUsage;
  launching: boolean;
  error?: string;
}

export interface QuestionDiscussionContext {
  questionIndex: number;
  question: string;
  thread: DiscussionThread;
  outcome?: string;
  classification?: DiscussionClassification;
  suggestion?: DiscussionAnswerSuggestion;
  messages: DiscussionMessage[];
  truncated?: boolean;
  usage: DiscussionUsage;
}

export interface QuestionnaireHandoff {
  questionIndex: number;
  question: string;
  options: Array<{ label: string; description: string }>;
  reason: string;
  transcript: DiscussionMessage[];
  partialAnswers: QuestionAnswer[];
  truncated?: boolean;
}

export function emptyDiscussionUsage(): DiscussionUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function emptyQuestionDiscussion(): QuestionDiscussionState {
  return { launching: false, usage: emptyDiscussionUsage() };
}

export function mergeDiscussionUsage(a: DiscussionUsage, b: DiscussionUsage): DiscussionUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

function boundedMessage(message: DiscussionMessage): DiscussionMessage {
  if (message.text.length <= MAX_DISCUSSION_MESSAGE_CHARS) return { ...message };
  return {
    ...message,
    text: `${message.text.slice(0, MAX_DISCUSSION_MESSAGE_CHARS)}\n[truncated]`,
    truncated: true,
  };
}

export function boundDiscussionTranscript(messages: readonly DiscussionMessage[]): {
  messages: DiscussionMessage[];
  truncated: boolean;
} {
  const tail = messages.slice(-MAX_DISCUSSION_MESSAGES).map(boundedMessage);
  let total = 0;
  const bounded: DiscussionMessage[] = [];
  let truncated = messages.length > tail.length;
  for (let i = tail.length - 1; i >= 0; i--) {
    const message = tail[i]!;
    if (total + message.text.length > MAX_DISCUSSION_CONTEXT_CHARS) {
      truncated = true;
      break;
    }
    bounded.unshift(message);
    total += message.text.length;
    truncated ||= message.truncated === true;
  }
  return { messages: bounded, truncated };
}

export function buildDiscussionContexts(
  discussions: ReadonlyMap<number, QuestionDiscussionState>,
  questions: readonly QuestionData[],
): QuestionDiscussionContext[] {
  const contexts: QuestionDiscussionContext[] = [];
  for (let questionIndex = 0; questionIndex < questions.length; questionIndex++) {
    const discussion = discussions.get(questionIndex);
    if (!discussion?.thread) continue;
    const resolution = discussion.resolution;
    const bounded = boundDiscussionTranscript(resolution?.transcript ?? []);
    contexts.push({
      questionIndex,
      question: questions[questionIndex]!.question,
      thread: discussion.thread,
      ...(resolution
        ? {
            outcome: resolution.outcome,
            classification: resolution.classification,
            ...(resolution.suggestion ? { suggestion: resolution.suggestion } : {}),
          }
        : {}),
      messages: bounded.messages,
      ...(bounded.truncated || resolution?.truncated ? { truncated: true } : {}),
      usage: discussion.usage,
    });
  }
  return contexts;
}

export function aggregateDiscussionUsage(
  discussions: ReadonlyMap<number, QuestionDiscussionState>,
): DiscussionUsage {
  let usage = emptyDiscussionUsage();
  for (const discussion of discussions.values()) usage = mergeDiscussionUsage(usage, discussion.usage);
  return usage;
}
