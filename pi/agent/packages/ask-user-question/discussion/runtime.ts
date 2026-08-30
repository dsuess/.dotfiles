import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  childToolCliArgs,
  splitChildCapabilities,
} from "../../../extensions/srt-tool-routing/child-capabilities.js";
import type {
  DiscussionMessage,
  DiscussionResolution,
  DiscussionThread,
  DiscussionUsage,
  QuestionDiscussionState,
} from "./types.js";
import {
  boundDiscussionTranscript,
  emptyDiscussionUsage,
  MAX_DISCUSSION_MESSAGE_CHARS,
  MAX_DISCUSSION_OUTCOME_CHARS,
  mergeDiscussionUsage,
} from "./types.js";

export const DISCUSSION_CHILD_MARKER = "PI_ASK_USER_QUESTION_DISCUSSION_CHILD";
export const DISCUSSION_SYSTEM_PROMPT_PATH = "PI_ASK_USER_QUESTION_DISCUSSION_SYSTEM_PROMPT";
export const DISCUSSION_THREAD_ENTRY = "rpiv:ask-user-question:discussion-thread";
export const DISCUSSION_KICKOFF_ENTRY = "rpiv:ask-user-question:discussion-kickoff";
export const DISCUSSION_RESOLUTION_ENTRY = "rpiv:ask-user-question:discussion-resolution";

export const CHILD_TOOL_EXCLUSIONS = new Set([
  "ask_user_question",
  "subagent",
  "submit_plan",
  "plan_progress",
  "complete_plan",
  "complete_stage",
]);

export interface DiscussionThreadMetadata {
  questionIndex: number;
  question: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
  parentSessionFile: string;
  parentToolCallId: string;
  forkAnchorId: string;
}

export interface DiscussionForkRequest {
  questionIndex: number;
  question: string;
  options: ReadonlyArray<{ label: string; description: string }>;
  multiSelect: boolean;
  parentSessionFile: string | undefined;
  parentToolCallId: string;
  systemPrompt: string;
  cwd: string;
  model: { provider: string; id: string };
  thinkingLevel: string;
  activeTools: readonly string[];
  projectTrusted: boolean;
  tui: Pick<TUI, "start" | "stop" | "renderNow">;
  thread?: DiscussionThread;
  lastConsumedResolutionId?: string;
  signal?: AbortSignal;
}

export interface DiscussionForkResult {
  thread?: DiscussionThread;
  resolution?: DiscussionResolution;
  /** Total usage for this child thread, not a delta. */
  usage: DiscussionUsage;
  error?: string;
}

interface SpawnedProcess {
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface DiscussionRuntimeDependencies {
  spawnProcess: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => SpawnedProcess;
  getInvocation: (args: string[]) => { command: string; args: string[] };
  openSession: (path: string) => SessionManager;
}

interface SecurePromptFiles {
  dir: string;
  systemPath: string;
  cleanup: () => Promise<void>;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(execName) ? { command: "pi", args } : { command: process.execPath, args };
}

export function filterChildTools(activeTools: readonly string[]): string[] {
  const capabilities = splitChildCapabilities(activeTools, { excluded: CHILD_TOOL_EXCLUSIONS });
  return [...capabilities.builtins, ...capabilities.hostAdapters];
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

function isDiscussionThread(value: unknown): value is DiscussionThreadMetadata {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    typeof data.questionIndex === "number" &&
    typeof data.question === "string" &&
    typeof data.parentSessionFile === "string" &&
    typeof data.parentToolCallId === "string" &&
    typeof data.forkAnchorId === "string" &&
    Array.isArray(data.options)
  );
}

function isResolution(value: unknown): value is DiscussionResolution {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    typeof data.id === "string" &&
    typeof data.outcome === "string" &&
    typeof data.classification === "string" &&
    Array.isArray(data.transcript) &&
    typeof data.createdAt === "number"
  );
}

function entryMessages(entries: readonly SessionEntry[], afterId: string): { messages: DiscussionMessage[]; usage: DiscussionUsage } {
  const start = entries.findIndex((entry) => entry.id === afterId);
  const messages: DiscussionMessage[] = [];
  let usage = emptyDiscussionUsage();
  for (const entry of entries.slice(start < 0 ? 0 : start + 1)) {
    if (entry.type !== "message") continue;
    const message = entry.message as unknown as Record<string, unknown>;
    if (message.role === "user") {
      const text = textFromContent(message.content);
      if (text) messages.push({ role: "user", text });
      continue;
    }
    if (message.role === "assistant") {
      usage = mergeDiscussionUsage(usage, usageFrom(message.usage));
      const text = textFromContent(message.content);
      if (text) messages.push({ role: "assistant", text });
      continue;
    }
    if (message.role === "toolResult") {
      usage = mergeDiscussionUsage(usage, usageFrom(message.usage));
      const text = textFromContent(message.content);
      if (text) messages.push({ role: "assistant", text: `[tool: ${String(message.toolName ?? "tool")}]\n${text}` });
    }
  }
  return { messages, usage };
}

/** Read the child-only observable state that the parent is allowed to project. */
export function readDiscussionThread(sessionFile: string, openSession: (path: string) => SessionManager = SessionManager.open): {
  thread?: DiscussionThread;
  resolution?: DiscussionResolution;
  usage: DiscussionUsage;
} {
  const session = openSession(sessionFile);
  const entries = session.getEntries();
  const metadataEntry = entries.find(
    (entry) => entry.type === "custom" && entry.customType === DISCUSSION_THREAD_ENTRY && isDiscussionThread(entry.data),
  );
  if (!metadataEntry || metadataEntry.type !== "custom" || !isDiscussionThread(metadataEntry.data)) {
    return { usage: emptyDiscussionUsage() };
  }
  const metadata = metadataEntry.data;
  const transcript = entryMessages(entries, metadataEntry.id);
  const resolutions = entries
    .filter((entry) => entry.type === "custom" && entry.customType === DISCUSSION_RESOLUTION_ENTRY)
    .flatMap((entry) => {
      if (entry.type !== "custom" || !entry.data || typeof entry.data !== "object") return [];
      const record = entry.data as Record<string, unknown>;
      return isResolution(record.resolution) ? [{ entry, resolution: record.resolution }] : [];
    });
  let classifierUsage = emptyDiscussionUsage();
  for (const candidate of resolutions) classifierUsage = mergeDiscussionUsage(classifierUsage, candidate.resolution.classifierUsage);
  const newest = resolutions.at(-1)?.resolution;
  const bounded = boundDiscussionTranscript(transcript.messages);
  const resolution = newest
    ? {
        ...newest,
        transcript: bounded.messages,
        ...(bounded.truncated || newest.truncated ? { truncated: true } : {}),
      }
    : undefined;
  return {
    thread: {
      sessionFile,
      sessionId: session.getSessionId(),
      parentSessionFile: metadata.parentSessionFile,
      forkAnchorId: metadata.forkAnchorId,
      parentToolCallId: metadata.parentToolCallId,
      metadataEntryId: metadataEntry.id,
    },
    resolution,
    usage: mergeDiscussionUsage(transcript.usage, classifierUsage),
  };
}

function findForkAnchor(entries: readonly SessionEntry[], toolCallId: string): string | undefined {
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as unknown as Record<string, unknown>;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const called = message.content.some(
      (part) =>
        part &&
        typeof part === "object" &&
        (part as Record<string, unknown>).type === "toolCall" &&
        (part as Record<string, unknown>).id === toolCallId,
    );
    if (called && entry.parentId) return entry.parentId;
  }
  return undefined;
}

function buildKickoff(metadata: DiscussionThreadMetadata): string {
  const choices = metadata.options
    .map((option, index) => `${index + 1}. ${option.label.slice(0, 60)} — ${option.description.slice(0, 2_000)}`)
    .join("\n");
  return [
    "You are in a persisted child discussion for an active structured questionnaire.",
    "Help the user investigate the question. Do not call ask_user_question, delegation, or parent workflow-completion tools.",
    "When the user is ready to return, they can run /resolve [optional concise outcome]. Ctrl+D leaves this child unresolved and returns to the unchanged questionnaire.",
    "The parent will require normal confirmation for any classified answer suggestion.",
    "",
    `Original question: ${metadata.question.slice(0, MAX_DISCUSSION_MESSAGE_CHARS)}`,
    "Authored choices:",
    choices,
  ].join("\n").slice(0, 24_000);
}

export function createDiscussionThread(
  request: Pick<
    DiscussionForkRequest,
    "questionIndex" | "question" | "options" | "multiSelect" | "parentSessionFile" | "parentToolCallId"
  >,
  openSession: (path: string) => SessionManager = SessionManager.open,
): DiscussionThread {
  if (!request.parentSessionFile) throw new Error("Cannot start a discussion because the parent session is not persisted.");
  const parent = openSession(request.parentSessionFile);
  const anchor = findForkAnchor(parent.getEntries(), request.parentToolCallId);
  if (!anchor) {
    throw new Error("Cannot start a discussion because the questionnaire tool-call fork anchor is unavailable.");
  }
  const childFile = parent.createBranchedSession(anchor);
  if (!childFile) throw new Error("Cannot create a persisted discussion child session.");
  const metadata: DiscussionThreadMetadata = {
    questionIndex: request.questionIndex,
    question: request.question,
    options: request.options.map(({ label, description }) => ({ label, description })),
    multiSelect: request.multiSelect,
    parentSessionFile: request.parentSessionFile,
    parentToolCallId: request.parentToolCallId,
    forkAnchorId: anchor,
  };
  // createBranchedSession changes this temporary manager to the new child. Do
  // not reopen its deferred file before appending metadata: an anchor before the
  // current tool call can legitimately contain no assistant entry yet, so Pi
  // writes the child file only on this first append.
  const metadataEntryId = parent.appendCustomEntry(DISCUSSION_THREAD_ENTRY, metadata);
  parent.appendCustomMessageEntry(DISCUSSION_KICKOFF_ENTRY, buildKickoff(metadata), false);
  // Pi intentionally defers a newly branched file that contains no assistant
  // entry. A questionnaire can be the first assistant action, so force the
  // manager's own serializer here rather than inventing a fake assistant turn.
  const deferredManager = parent as unknown as { _rewriteFile?: () => void };
  if (typeof deferredManager._rewriteFile !== "function") {
    throw new Error("Cannot persist the discussion child session with this Pi runtime.");
  }
  deferredManager._rewriteFile();
  return {
    sessionFile: childFile,
    sessionId: parent.getSessionId(),
    parentSessionFile: request.parentSessionFile,
    forkAnchorId: anchor,
    parentToolCallId: request.parentToolCallId,
    metadataEntryId,
  };
}

async function makeSecurePromptFile(cwd: string, systemPrompt: string): Promise<SecurePromptFiles> {
  const dir = await mkdtemp(join(cwd, ".pi-ask-user-question-"));
  await chmod(dir, 0o700);
  const systemPath = join(dir, "system.md");
  await writeFile(systemPath, systemPrompt, { encoding: "utf8", mode: 0o600 });
  return { dir, systemPath, cleanup: async () => rm(dir, { recursive: true, force: true }) };
}

function childEnvironment(
  systemPath: string,
  builtinTools: readonly string[],
  hostTools: readonly string[],
  planningMode: boolean,
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key === "PI_SESSION_ID" ||
      key === "PI_SESSION_FILE" ||
      key === "PI_PROVIDER" ||
      key === "PI_MODEL" ||
      key === "PI_REASONING_LEVEL" ||
      key === "PI_SRT_ROUTING_STARTUP_DESCRIPTOR" ||
      key === "NODE_TEST_CONTEXT" ||
      key.startsWith("HERDR_") ||
      key.startsWith("PI_HERDR_")
    ) {
      delete env[key];
    }
  }
  env[DISCUSSION_CHILD_MARKER] = "1";
  env[DISCUSSION_SYSTEM_PROMPT_PATH] = systemPath;
  env.PI_SRT_ROUTING_BUILTIN_TOOLS = builtinTools.join(",");
  env.PI_SRT_ROUTING_HOST_TOOLS = hostTools.join(",");
  if (planningMode) env.PI_SUBAGENT_PLANNING = "1";
  else delete env.PI_SUBAGENT_PLANNING;
  return env;
}

function waitForChild(child: SpawnedProcess, signal: AbortSignal | undefined): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      fn();
    };
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.once("close", (code, closeSignal) => finish(() => resolve({ code, signal: closeSignal })));
    child.once("error", (error) => finish(() => reject(error)));
  });
}

/**
 * Suspend the parent TUI while a real interactive Pi process owns the terminal.
 * The child records a resolution in its own persisted session; ordinary exits add
 * nothing, so returning to this result cannot fabricate a questionnaire answer.
 */
export async function runDiscussionFork(
  request: DiscussionForkRequest,
  dependencies: Partial<DiscussionRuntimeDependencies> = {},
): Promise<DiscussionForkResult> {
  const openSession = dependencies.openSession ?? SessionManager.open;
  let thread = request.thread;
  try {
    if (!thread) thread = createDiscussionThread(request, openSession);
  } catch (error) {
    return { usage: emptyDiscussionUsage(), error: error instanceof Error ? error.message : String(error) };
  }

  let files: SecurePromptFiles | undefined;
  let stopped = false;
  try {
    files = await makeSecurePromptFile(request.cwd, request.systemPrompt);
    const capabilities = splitChildCapabilities(request.activeTools, { excluded: CHILD_TOOL_EXCLUSIONS });
    const planningMode =
      request.activeTools.includes("submit_plan") &&
      /\[PI PLANNING MODE ACTIVE\]/.test(request.systemPrompt);
    const args = [
      "--session",
      thread.sessionFile,
      "--model",
      `${request.model.provider}/${request.model.id}`,
      "--thinking",
      request.thinkingLevel,
      request.projectTrusted ? "--approve" : "--no-approve",
    ];
    args.push(...childToolCliArgs(capabilities));

    const getInvocation = dependencies.getInvocation ?? getPiInvocation;
    const spawnProcess = dependencies.spawnProcess ?? ((command, childArgs, options) => spawn(command, childArgs, options) as ChildProcess);
    const invocation = getInvocation(args);
    request.tui.stop({ preserveScreen: true });
    stopped = true;
    const child = spawnProcess(invocation.command, invocation.args, {
      cwd: request.cwd,
      shell: false,
      stdio: "inherit",
      env: childEnvironment(
        files.systemPath,
        capabilities.builtins,
        capabilities.hostAdapters,
        planningMode,
      ),
    });
    const exit = await waitForChild(child, request.signal);
    const state = readDiscussionThread(thread.sessionFile, openSession);
    const resolution = state.resolution?.id !== request.lastConsumedResolutionId ? state.resolution : undefined;
    if (exit.code !== 0 && !resolution) {
      return { thread: state.thread ?? thread, usage: state.usage, error: `Discussion child exited with code ${exit.code ?? "unknown"}.` };
    }
    return { thread: state.thread ?? thread, resolution, usage: state.usage };
  } catch (error) {
    let usage = emptyDiscussionUsage();
    try {
      usage = readDiscussionThread(thread.sessionFile, openSession).usage;
    } catch {
      // A failed spawn or corrupt child file must leave the parent questionnaire usable.
    }
    return { thread, usage, error: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      await files?.cleanup();
    } finally {
      if (stopped) {
        request.tui.start();
        request.tui.renderNow(true);
      }
    }
  }
}

/** Test helper: assert prompt-file permissions while a fake child is running. */
export async function readSecureTurnFile(path: string): Promise<{ content: string; mode: number }> {
  const [content, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
  return { content, mode: metadata.mode & 0o777 };
}

/** Converts child-state fields into a compact failure-safe outcome. */
export function contextOnlyResolution(
  id: string,
  outcome: string,
  transcript: readonly DiscussionMessage[],
  classifierUsage: DiscussionUsage = emptyDiscussionUsage(),
): DiscussionResolution {
  const bounded = boundDiscussionTranscript(transcript);
  return {
    id,
    outcome: outcome.slice(0, MAX_DISCUSSION_OUTCOME_CHARS),
    classification: "context_only",
    transcript: bounded.messages,
    ...(bounded.truncated ? { truncated: true } : {}),
    classifierUsage,
    createdAt: Date.now(),
  };
}
