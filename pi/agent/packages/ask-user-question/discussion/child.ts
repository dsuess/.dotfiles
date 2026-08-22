import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  CHILD_TOOL_EXCLUSIONS,
  DISCUSSION_CHILD_MARKER,
  DISCUSSION_RESOLUTION_ENTRY,
  DISCUSSION_SYSTEM_PROMPT_PATH,
  DISCUSSION_THREAD_ENTRY,
  type DiscussionThreadMetadata,
} from "./runtime.js";
import type {
  DiscussionAnswerSuggestion,
  DiscussionClassification,
  DiscussionMessage,
  DiscussionResolution,
  DiscussionUsage,
} from "./types.js";
import { boundDiscussionTranscript, emptyDiscussionUsage, MAX_DISCUSSION_OUTCOME_CHARS } from "./types.js";

const RESOLVER_TOOL_NAME = "classify_questionnaire_resolution";
const CHILD_SYSTEM_SUFFIX = `

# Questionnaire discussion child
You are a child discussion thread for an active structured questionnaire. Help the user investigate the stated question. Do not call ask_user_question, delegate work to subagents, or execute parent planning/workflow completion actions. The user can run /resolve [optional outcome] to return to the unchanged questionnaire; Ctrl+D leaves it unresolved.`;

const resolutionTool = {
  name: RESOLVER_TOOL_NAME,
  description: "Classify whether the discussion outcome completely answers the original questionnaire question.",
  parameters: Type.Object({
    outcome: Type.String({ description: "Concise, user-visible discussion outcome." }),
    fullyAnswers: Type.Boolean({ description: "True only when the outcome completely answers the original question." }),
    classification: Type.Union([
      Type.Literal("context_only"),
      Type.Literal("single_option"),
      Type.Literal("multi_options"),
      Type.Literal("custom_answer"),
    ]),
    optionLabels: Type.Optional(Type.Array(Type.String())),
    customAnswer: Type.Optional(Type.String()),
  }),
};

export type ResolutionToolInput = {
  outcome: string;
  fullyAnswers: boolean;
  classification: DiscussionClassification;
  optionLabels?: string[];
  customAnswer?: string;
};

export function isDiscussionChild(): boolean {
  return process.env[DISCUSSION_CHILD_MARKER] === "1";
}

function usageFrom(value: unknown): DiscussionUsage {
  const usage = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const cost = (usage.cost && typeof usage.cost === "object" ? usage.cost : {}) as Record<string, unknown>;
  const number = (input: unknown) => (typeof input === "number" && Number.isFinite(input) ? input : 0);
  return {
    input: number(usage.input),
    output: number(usage.output),
    cacheRead: number(usage.cacheRead),
    cacheWrite: number(usage.cacheWrite),
    totalTokens: number(usage.totalTokens),
    cost: {
      input: number(cost.input),
      output: number(cost.output),
      cacheRead: number(cost.cacheRead),
      cacheWrite: number(cost.cacheWrite),
      total: number(cost.total),
    },
  };
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const value = part as Record<string, unknown>;
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join("\n");
}

function metadataFor(ctx: ExtensionCommandContext): DiscussionThreadMetadata | undefined {
  const entry = ctx.sessionManager
    .getEntries()
    .find((candidate) => candidate.type === "custom" && candidate.customType === DISCUSSION_THREAD_ENTRY);
  if (!entry || entry.type !== "custom" || !entry.data || typeof entry.data !== "object") return undefined;
  const data = entry.data as Partial<DiscussionThreadMetadata>;
  return typeof data.question === "string" && Array.isArray(data.options) && typeof data.multiSelect === "boolean"
    ? (data as DiscussionThreadMetadata)
    : undefined;
}

function observableTranscript(ctx: ExtensionCommandContext): DiscussionMessage[] {
  const entries = ctx.sessionManager.getEntries();
  const start = entries.findIndex((entry) => entry.type === "custom" && entry.customType === DISCUSSION_THREAD_ENTRY);
  const messages: DiscussionMessage[] = [];
  for (const entry of entries.slice(start < 0 ? 0 : start + 1)) {
    if (entry.type !== "message") continue;
    const message = entry.message as unknown as Record<string, unknown>;
    if (message.role === "user") {
      const text = textFromContent(message.content);
      if (text) messages.push({ role: "user", text });
    } else if (message.role === "assistant") {
      const text = textFromContent(message.content);
      if (text) messages.push({ role: "assistant", text });
    } else if (message.role === "toolResult") {
      const text = textFromContent(message.content);
      if (text) messages.push({ role: "assistant", text: `[tool: ${String(message.toolName ?? "tool")}]\n${text}` });
    }
  }
  return boundDiscussionTranscript(messages).messages;
}

function latestAssistantText(transcript: readonly DiscussionMessage[]): string | undefined {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const message = transcript[i]!;
    if (message.role === "assistant" && message.text.trim()) return message.text;
  }
  return undefined;
}

function resolutionCallArguments(message: unknown): ResolutionToolInput | undefined {
  if (!message || typeof message !== "object") return undefined;
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return undefined;
  const call = content.find(
    (part) => part && typeof part === "object" && (part as Record<string, unknown>).type === "toolCall" && (part as Record<string, unknown>).name === RESOLVER_TOOL_NAME,
  ) as Record<string, unknown> | undefined;
  const args = call?.arguments;
  if (!args || typeof args !== "object") return undefined;
  const value = args as Record<string, unknown>;
  if (
    typeof value.outcome !== "string" ||
    typeof value.fullyAnswers !== "boolean" ||
    typeof value.classification !== "string" ||
    !["context_only", "single_option", "multi_options", "custom_answer"].includes(value.classification)
  ) {
    return undefined;
  }
  return {
    outcome: value.outcome,
    fullyAnswers: value.fullyAnswers,
    classification: value.classification as DiscussionClassification,
    ...(Array.isArray(value.optionLabels) && value.optionLabels.every((label) => typeof label === "string")
      ? { optionLabels: value.optionLabels as string[] }
      : {}),
    ...(typeof value.customAnswer === "string" ? { customAnswer: value.customAnswer } : {}),
  };
}

export function validateResolutionSuggestion(
  metadata: DiscussionThreadMetadata,
  result: ResolutionToolInput,
): DiscussionAnswerSuggestion | undefined {
  if (!result.fullyAnswers || result.classification === "context_only") return undefined;
  const validLabel = (label: string) => metadata.options.some((option) => option.label === label);
  if (!metadata.multiSelect && result.classification === "single_option") {
    const labels = result.optionLabels ?? [];
    return labels.length === 1 && validLabel(labels[0]!) ? { kind: "option", optionLabels: labels } : undefined;
  }
  if (metadata.multiSelect && result.classification === "multi_options") {
    const labels = result.optionLabels ?? [];
    const unique = [...new Set(labels)];
    return unique.length > 0 && unique.length === labels.length && unique.every(validLabel)
      ? { kind: "multi", optionLabels: labels }
      : undefined;
  }
  if (result.classification === "custom_answer" && result.customAnswer?.trim()) {
    return { kind: "custom", customAnswer: result.customAnswer.trim() };
  }
  return undefined;
}

async function classify(
  ctx: ExtensionCommandContext,
  metadata: DiscussionThreadMetadata,
  candidate: string,
  transcript: readonly DiscussionMessage[],
): Promise<{ outcome: string; classification: DiscussionClassification; suggestion?: DiscussionAnswerSuggestion; usage: DiscussionUsage; failed?: boolean }> {
  const fallbackOutcome = candidate.trim().slice(0, MAX_DISCUSSION_OUTCOME_CHARS) || "Discussion resolved without a written outcome.";
  if (!ctx.model) return { outcome: fallbackOutcome, classification: "context_only", usage: emptyDiscussionUsage(), failed: true };
  const choices = metadata.options.map((option) => option.label).join(", ");
  const transcriptText = transcript
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`)
    .join("\n")
    .slice(-16_000);
  try {
    const completion = await ctx.modelRegistry.complete(ctx.model, {
      systemPrompt: [
        "You classify a completed structured-question discussion. Return exactly one tool call.",
        "Use context_only unless the outcome unambiguously and completely answers the original question.",
        "Only use authored labels exactly as supplied. Never invent labels. Use custom_answer only for meaningful non-empty user answer text.",
      ].join("\n"),
      messages: [
        {
          role: "user",
          timestamp: Date.now(),
          content: [
            {
              type: "text",
              text: [
                `Original question: ${metadata.question}`,
                `Question mode: ${metadata.multiSelect ? "multi-select" : "single-select"}`,
                `Authored option labels: ${choices}`,
                `Candidate outcome: ${fallbackOutcome}`,
                "Observable discussion transcript:",
                transcriptText || "(none)",
              ].join("\n"),
            },
          ],
        },
      ],
      tools: [resolutionTool],
    }, { signal: ctx.signal });
    const parsed = resolutionCallArguments(completion);
    const suggestion = parsed ? validateResolutionSuggestion(metadata, parsed) : undefined;
    return {
      outcome: (parsed?.outcome.trim() || fallbackOutcome).slice(0, MAX_DISCUSSION_OUTCOME_CHARS),
      classification: suggestion ? parsed!.classification : "context_only",
      ...(suggestion ? { suggestion } : {}),
      usage: usageFrom(completion.usage),
      ...(!parsed || (!suggestion && parsed.classification !== "context_only") ? { failed: true } : {}),
    };
  } catch {
    return { outcome: fallbackOutcome, classification: "context_only", usage: emptyDiscussionUsage(), failed: true };
  }
}

async function resolveDiscussion(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const metadata = metadataFor(ctx);
  if (!metadata) {
    ctx.ui.notify("This /resolve command is only available in a questionnaire discussion child.", "error");
    return;
  }
  const transcript = observableTranscript(ctx);
  const candidate = args.trim() || latestAssistantText(transcript) || "Discussion resolved without a written outcome.";
  const classified = await classify(ctx, metadata, candidate, transcript);
  const bounded = boundDiscussionTranscript(transcript);
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const resolution: DiscussionResolution = {
    id,
    outcome: classified.outcome,
    classification: classified.classification,
    ...(classified.suggestion ? { suggestion: classified.suggestion } : {}),
    transcript: bounded.messages,
    ...(bounded.truncated ? { truncated: true } : {}),
    classifierUsage: classified.usage,
    ...(classified.failed ? { classifierFailed: true } : {}),
    createdAt: Date.now(),
  };
  pi.appendEntry(DISCUSSION_RESOLUTION_ENTRY, { resolution, transcriptBoundary: bounded.messages.length });
  ctx.ui.notify("Discussion resolution saved. Returning to the questionnaire…", "info");
  ctx.shutdown();
}

async function childSystemPrompt(current: string): Promise<string> {
  const path = process.env[DISCUSSION_SYSTEM_PROMPT_PATH];
  if (!path) return `${current}${CHILD_SYSTEM_SUFFIX}`;
  try {
    return `${await readFile(path, "utf8")}${CHILD_SYSTEM_SUFFIX}`;
  } catch {
    return `${current}${CHILD_SYSTEM_SUFFIX}`;
  }
}

/** Register child-only controls. Parent sessions never expose /resolve. */
export function registerDiscussionChildRuntime(pi: ExtensionAPI): void {
  if (!isDiscussionChild()) return;
  const stripExcluded = () => pi.setActiveTools(pi.getActiveTools().filter((name) => !CHILD_TOOL_EXCLUSIONS.has(name)));
  stripExcluded();
  // Registration completes before session_start; run again then so this package's
  // own ask_user_question registration cannot become active in the child.
  pi.on("session_start", stripExcluded);
  pi.on("before_agent_start", async (event) => {
    stripExcluded();
    return { systemPrompt: await childSystemPrompt(event.systemPrompt) };
  });
  pi.on("tool_call", (event) => {
    if (CHILD_TOOL_EXCLUSIONS.has(event.toolName)) {
      return { block: true, terminate: true, reason: "This tool is unavailable inside a questionnaire discussion child." };
    }
  });
  pi.registerCommand("resolve", {
    description: "Return a classified discussion outcome to the suspended questionnaire",
    handler: async (args, ctx) => resolveDiscussion(args, ctx, pi),
  });
}
