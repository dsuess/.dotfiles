import type { QuestionAnswer, QuestionData } from "../tool/types.js";

export const MAX_DISCUSSION_MESSAGES = 12;
export const MAX_DISCUSSION_MESSAGE_CHARS = 4_000;
export const MAX_DISCUSSION_CONTEXT_CHARS = 16_000;
export const MAX_DISCUSSION_ACTIVITY_ITEMS = 8;

export interface DiscussionCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface DiscussionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: DiscussionCost;
}

export interface DiscussionMessage {
  role: "user" | "assistant";
  text: string;
  truncated?: boolean;
}

export interface QuestionDiscussionState {
  draft: string;
  transcript: readonly DiscussionMessage[];
  running: boolean;
  activity: readonly string[];
  error?: string;
  usage: DiscussionUsage;
}

export interface QuestionDiscussionContext {
  questionIndex: number;
  question: string;
  messages: DiscussionMessage[];
  truncated?: boolean;
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
  return {
    draft: "",
    transcript: [],
    running: false,
    activity: [],
    usage: emptyDiscussionUsage(),
  };
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
    if (!discussion || discussion.transcript.length === 0) continue;
    const bounded = boundDiscussionTranscript(discussion.transcript);
    contexts.push({
      questionIndex,
      question: questions[questionIndex]!.question,
      messages: bounded.messages,
      ...(bounded.truncated ? { truncated: true } : {}),
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
