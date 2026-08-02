import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DiscussionMessage, DiscussionUsage } from "./types.js";
import {
  boundDiscussionTranscript,
  emptyDiscussionUsage,
  MAX_DISCUSSION_MESSAGE_CHARS,
  mergeDiscussionUsage,
} from "./types.js";

export const MAX_PARENT_CONTEXT_CHARS = 32_000;
export const MAX_DISCUSSION_OUTPUT_CHARS = 12_000;
export const MAX_CHILD_STDERR_CHARS = 4_000;
export const MAX_CHILD_PROMPT_CHARS = 72_000;

export const CHILD_TOOL_EXCLUSIONS = new Set([
  "ask_user_question",
  "subagent",
  "submit_plan",
  "plan_progress",
  "complete_plan",
  "complete_stage",
]);

export interface DiscussionTurnRequest {
  question: string;
  options: ReadonlyArray<{ label: string; description: string }>;
  userPrompt: string;
  transcript: readonly DiscussionMessage[];
  parentContext: string;
  systemPrompt: string;
  cwd: string;
  model: { provider: string; id: string };
  thinkingLevel: string;
  activeTools: readonly string[];
  projectTrusted: boolean;
  signal?: AbortSignal;
  onActivity?: (message: string) => void;
}

export interface DiscussionTurnResult {
  response: string;
  usage: DiscussionUsage;
  truncated: boolean;
  tools: string[];
}

interface SpawnedProcess {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(event: "close", listener: (code: number | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
  killed: boolean;
}

export interface DiscussionRuntimeDependencies {
  spawnProcess: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => SpawnedProcess;
  getInvocation: (args: string[]) => { command: string; args: string[] };
}

export class DiscussionTurnCancelledError extends Error {
  constructor() {
    super("Discussion turn cancelled");
    this.name = "DiscussionTurnCancelledError";
  }
}

export function filterChildTools(activeTools: readonly string[]): string[] {
  return activeTools.filter((name) => !CHILD_TOOL_EXCLUSIONS.has(name));
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const value = part as Record<string, unknown>;
      if (value.type === "text" && typeof value.text === "string") return [value.text];
      if (value.type === "toolCall" && typeof value.name === "string") return [`[tool call: ${value.name}]`];
      return [];
    })
    .join("\n");
}

/** Format compaction-aware parent messages without exposing private thinking blocks or image data. */
export function formatParentContext(
  messages: ReadonlyArray<{ role: string; content?: unknown; summary?: string }>,
): string {
  const sections: string[] = [];
  for (const message of messages) {
    const role = message.role;
    if (role === "assistant" || role === "user" || role === "toolResult" || role === "custom") {
      const text = contentText(message.content);
      if (text) sections.push(`${role}: ${text}`);
    } else if (role === "compactionSummary" || role === "branchSummary") {
      sections.push(`${role}: ${message.summary ?? ""}`);
    }
  }
  const full = sections.join("\n\n");
  if (full.length <= MAX_PARENT_CONTEXT_CHARS) return full;
  return `[Earlier parent context omitted]\n${full.slice(-MAX_PARENT_CONTEXT_CHARS)}`;
}

export function formatParentEntries(entries: ReadonlyArray<Record<string, unknown>>): string {
  const messages: Array<{ role: string; content?: unknown; summary?: string }> = [];
  for (const entry of entries) {
    if (entry.type === "message" && entry.message && typeof entry.message === "object") {
      messages.push(entry.message as { role: string; content?: unknown; summary?: string });
    } else if (entry.type === "custom_message") {
      messages.push({ role: "custom", content: entry.content });
    } else if (entry.type === "compaction") {
      messages.push({ role: "compactionSummary", summary: typeof entry.summary === "string" ? entry.summary : "" });
      if (Array.isArray(entry.retainedTail)) {
        messages.push(...(entry.retainedTail as Array<{ role: string; content?: unknown; summary?: string }>));
      }
    } else if (entry.type === "branch_summary") {
      messages.push({ role: "branchSummary", summary: typeof entry.summary === "string" ? entry.summary : "" });
    }
  }
  return formatParentContext(messages);
}

export function buildDiscussionPrompt(request: DiscussionTurnRequest): string {
  const choices = request.options
    .map(
      (option, index) =>
        `${index + 1}. ${option.label.slice(0, 60)} — ${option.description.slice(0, 2_000)}`,
    )
    .join("\n");
  const boundedTranscript = boundDiscussionTranscript(request.transcript);
  const transcript = boundedTranscript.messages.length
    ? boundedTranscript.messages
        .map((message) => `${message.role === "user" ? "User" : "Discussion agent"}: ${message.text}`)
        .join("\n")
    : "(no prior discussion)";
  const parentContext =
    request.parentContext.length <= MAX_PARENT_CONTEXT_CHARS
      ? request.parentContext
      : `[Earlier parent context omitted]\n${request.parentContext.slice(-MAX_PARENT_CONTEXT_CHARS)}`;
  const prompt = [
    "You are handling one clarification turn inside an active structured questionnaire.",
    "Answer the user's clarification directly. You may inspect or change the workspace only through the inherited active capabilities when doing so is genuinely required.",
    "Do not answer the structured question for the user, rewrite its choices, dismiss the questionnaire, or expose private reasoning. Recommendations are allowed; the user remains in control.",
    "Keep the final response concise and useful.",
    "",
    `Original question: ${request.question.slice(0, MAX_DISCUSSION_MESSAGE_CHARS)}`,
    "Authored choices:",
    choices,
    "",
    "Relevant parent conversation context:",
    parentContext || "(none)",
    "",
    "Prior discussion for this question:",
    transcript,
    "",
    "Current clarification request:",
    request.userPrompt.slice(0, MAX_DISCUSSION_MESSAGE_CHARS),
  ].join("\n");
  if (prompt.length <= MAX_CHILD_PROMPT_CHARS) return prompt;
  const headLength = 16_000;
  return `${prompt.slice(0, headLength)}\n[Middle context omitted]\n${prompt.slice(-(MAX_CHILD_PROMPT_CHARS - headLength))}`;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  return isGenericRuntime ? { command: "pi", args } : { command: process.execPath, args };
}

function usageFromMessage(message: Record<string, unknown>): DiscussionUsage {
  const value = (message.usage ?? {}) as Record<string, unknown>;
  const cost = (value.cost ?? {}) as Record<string, unknown>;
  const number = (input: unknown) => (typeof input === "number" && Number.isFinite(input) ? input : 0);
  return {
    input: number(value.input),
    output: number(value.output),
    cacheRead: number(value.cacheRead),
    cacheWrite: number(value.cacheWrite),
    totalTokens: number(value.totalTokens),
    cost: {
      input: number(cost.input),
      output: number(cost.output),
      cacheRead: number(cost.cacheRead),
      cacheWrite: number(cost.cacheWrite),
      total: number(cost.total),
    },
  };
}

function finalAssistantText(message: Record<string, unknown>): string {
  if (message.role !== "assistant") return "";
  return contentText(message.content);
}

async function makeSecureTurnFiles(cwd: string, systemPrompt: string, prompt: string) {
  // mkdtemp creates a collision-resistant directory in the sandboxed workspace;
  // chmod pins permissions even under an unexpectedly permissive umask.
  const dir = await mkdtemp(join(cwd, ".pi-ask-user-question-"));
  await chmod(dir, 0o700);
  const systemPath = join(dir, "system.md");
  const promptPath = join(dir, "prompt.md");
  await writeFile(systemPath, systemPrompt, { encoding: "utf8", mode: 0o600 });
  await writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600 });
  return {
    dir,
    systemPath,
    promptPath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function runDiscussionTurn(
  request: DiscussionTurnRequest,
  dependencies: Partial<DiscussionRuntimeDependencies> = {},
): Promise<DiscussionTurnResult> {
  if (request.signal?.aborted) throw new DiscussionTurnCancelledError();
  const tools = filterChildTools(request.activeTools);
  const childSystemPrompt = `${request.systemPrompt}\n\n# Embedded questionnaire discussion\nDo not invoke questionnaire, delegation, or parent-workflow completion tools. Return only observable final guidance; never expose private reasoning.`;
  const files = await makeSecureTurnFiles(request.cwd, childSystemPrompt, buildDiscussionPrompt(request));
  const args = [
    "--mode",
    "json",
    "--print",
    "--no-session",
    "--system-prompt",
    files.systemPath,
    "--model",
    `${request.model.provider}/${request.model.id}`,
    "--thinking",
    request.thinkingLevel,
    request.projectTrusted ? "--approve" : "--no-approve",
  ];
  if (tools.length > 0) args.push("--tools", tools.join(","));
  else args.push("--no-tools");
  args.push(`@${files.promptPath}`);

  const getInvocationImpl = dependencies.getInvocation ?? getPiInvocation;
  const spawnImpl = dependencies.spawnProcess ?? ((command, childArgs, options) => spawn(command, childArgs, options) as ChildProcessWithoutNullStreams);
  const invocation = getInvocationImpl(args);
  let usage = emptyDiscussionUsage();
  let response = "";
  let stderr = "";
  let buffer = "";
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  let aborted = false;
  let lastActivity: string | undefined;
  const emitActivity = (message: string) => {
    if (message === lastActivity) return;
    lastActivity = message;
    request.onActivity?.(message);
  };

  try {
    emitActivity("Starting discussion agent");
    const child = spawnImpl(invocation.command, invocation.args, {
      cwd: request.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PI_DISCUSSION_CHILD: "1" },
    });

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (event.type === "tool_execution_start") {
        const toolName = typeof event.toolName === "string" ? event.toolName : "capability";
        emitActivity(`Using ${toolName}`);
      }
      if (event.type === "message_update") emitActivity("Writing response");
      if (event.type === "message_end" && event.message && typeof event.message === "object") {
        const message = event.message as Record<string, unknown>;
        if (message.role === "assistant") {
          usage = mergeDiscussionUsage(usage, usageFromMessage(message));
          response = finalAssistantText(message) || response;
          stopReason = typeof message.stopReason === "string" ? message.stopReason : stopReason;
          errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : errorMessage;
        }
      }
    };

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-MAX_CHILD_STDERR_CHARS);
    });

    let forceKill: ReturnType<typeof setTimeout> | undefined;
    let childClosed = false;
    const abortChild = () => {
      aborted = true;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => {
        if (!childClosed) child.kill("SIGKILL");
      }, 2_000);
      forceKill.unref?.();
    };
    if (request.signal?.aborted) abortChild();
    else request.signal?.addEventListener("abort", abortChild, { once: true });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("close", (code) => {
        childClosed = true;
        resolve(code ?? 0);
      });
      child.on("error", reject);
    });
    request.signal?.removeEventListener("abort", abortChild);
    if (forceKill) clearTimeout(forceKill);
    if (buffer.trim()) processLine(buffer);

    if (aborted || request.signal?.aborted) throw new DiscussionTurnCancelledError();
    if (exitCode !== 0 || stopReason === "error") {
      throw new Error(errorMessage || stderr || `Discussion agent exited with code ${exitCode}`);
    }
    if (!response.trim()) throw new Error(errorMessage || stderr || "Discussion agent returned no final response");
    const truncated = response.length > MAX_DISCUSSION_OUTPUT_CHARS || stopReason === "length";
    if (response.length > MAX_DISCUSSION_OUTPUT_CHARS) {
      response = `${response.slice(0, MAX_DISCUSSION_OUTPUT_CHARS)}\n[response truncated]`;
    } else if (stopReason === "length") {
      response = `${response}\n[response truncated by provider]`;
    }
    emitActivity("Discussion response ready");
    return { response, usage, truncated, tools };
  } finally {
    await files.cleanup();
  }
}

/** Test helper: assert secure on-disk modes while a fake child is running. */
export async function readSecureTurnFile(path: string): Promise<{ content: string; mode: number }> {
  const [content, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
  return { content, mode: metadata.mode & 0o777 };
}
