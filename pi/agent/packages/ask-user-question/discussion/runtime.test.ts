import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  CHILD_TOOL_EXCLUSIONS,
  createDiscussionThread,
  DISCUSSION_RESOLUTION_ENTRY,
  filterChildTools,
  readDiscussionThread,
  readSecureTurnFile,
  runDiscussionFork,
} from "./runtime.js";
import { emptyDiscussionUsage } from "./types.js";

afterEach(() => vi.unstubAllEnvs());

class FakeChild extends EventEmitter {
  kill = vi.fn(() => true);
  close(code = 0): void {
    this.emit("close", code, null);
  }
}

function parentWithQuestionnaireTool() {
  const root = join(tmpdir(), "ask-user-question-runtime");
  const parent = SessionManager.create(process.cwd(), root);
  const userId = parent.appendMessage({ role: "user", content: "Ask me a question", timestamp: Date.now() });
  parent.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "tool-1", name: "ask_user_question", arguments: {} }],
    api: "test",
    provider: "test",
    model: "test",
    usage: emptyDiscussionUsage(),
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  return { parent, userId };
}

describe("discussion fork runtime", () => {
  it("preserves trusted tool order while excluding recursion, workflow, duplicates, and unknown tools", () => {
    expect(filterChildTools(["write", "read", "ask_user_question", "edit", "plan_progress", "bash", "read", "unknown_tool"])).toEqual([
      "write",
      "read",
      "edit",
      "bash",
    ]);
    expect(CHILD_TOOL_EXCLUSIONS).toContain("ask_user_question");
    expect(CHILD_TOOL_EXCLUSIONS).toContain("subagent");
    expect(CHILD_TOOL_EXCLUSIONS).toContain("show_plan");
    expect(CHILD_TOOL_EXCLUSIONS).toContain("complete_plan");
  });

  it("creates a persisted child fork before the parent assistant tool-call and records provenance", () => {
    const { parent, userId } = parentWithQuestionnaireTool();
    const thread = createDiscussionThread({
      questionIndex: 0,
      question: "Which implementation?",
      options: [
        { label: "A", description: "Simple" },
        { label: "B", description: "Flexible" },
      ],
      multiSelect: false,
      parentSessionFile: parent.getSessionFile(),
      parentToolCallId: "tool-1",
    });
    expect(thread.forkAnchorId).toBe(userId);
    const child = SessionManager.open(thread.sessionFile);
    expect(child.getHeader()?.parentSession).toBe(parent.getSessionFile());
    expect(child.getEntries().some((entry) => entry.type === "custom" && entry.customType === "rpiv:ask-user-question:discussion-thread")).toBe(true);
    expect(child.getEntries().some((entry) => entry.type === "message" && entry.message.role === "assistant" && (entry.message.content as object[]).some((part) => (part as { id?: string }).id === "tool-1"))).toBe(false);
  });

  it("stops and restarts the parent TUI, cleans the secure prompt, and leaves ordinary exits unresolved", async () => {
    vi.stubEnv("HERDR_ENV", "1");
    vi.stubEnv("HERDR_SOCKET_PATH", "/tmp/parent-herdr.sock");
    vi.stubEnv("HERDR_PANE_ID", "parent-pane");
    vi.stubEnv("HERDR_FUTURE_CAPABILITY", "future");
    vi.stubEnv("PI_HERDR_STATUS_PORT", "12345");
    vi.stubEnv("NON_HERDR_CHILD_CAPABILITY", "preserved");
    vi.stubEnv("PI_SRT_ROUTING_SOCKET", "/tmp/controller.sock");
    vi.stubEnv("PI_SRT_ROUTING_LEASE", "a".repeat(64));
    vi.stubEnv("PI_SRT_ROUTING_WORKSPACE_KEY", "b".repeat(64));
    vi.stubEnv("PI_SRT_ROUTING_WORKSPACE_ROOT", "/workspace/project");
    vi.stubEnv("PI_SRT_ROUTING_POLICY_GENERATION", "c".repeat(64));
    vi.stubEnv("PI_SRT_ROUTING_IMAGE_GENERATION", "d".repeat(64));
    vi.stubEnv("PI_SRT_ROUTING_STARTUP_DESCRIPTOR", "private-root-startup");
    const { parent } = parentWithQuestionnaireTool();
    const thread = createDiscussionThread({
      questionIndex: 0,
      question: "Which implementation?",
      options: [{ label: "A", description: "Simple" }, { label: "B", description: "Flexible" }],
      multiSelect: false,
      parentSessionFile: parent.getSessionFile(),
      parentToolCallId: "tool-1",
    });
    const child = new FakeChild();
    const tui = { stop: vi.fn(), start: vi.fn(), renderNow: vi.fn() };
    let systemPath = "";
    const result = await runDiscussionFork(
      {
        questionIndex: 0,
        question: "Which implementation?",
        options: [{ label: "A", description: "Simple" }, { label: "B", description: "Flexible" }],
        multiSelect: false,
        parentSessionFile: parent.getSessionFile(),
        parentToolCallId: "tool-1",
        systemPrompt: "Parent instructions\n[PI PLANNING MODE ACTIVE]",
        cwd: process.cwd(),
        model: { provider: "provider", id: "model" },
        thinkingLevel: "high",
        activeTools: ["read", "edit", "ask_user_question", "subagent", "show_plan"],
        projectTrusted: true,
        tui,
        thread,
      },
      {
        spawnProcess: vi.fn((_command, args, options) => {
          systemPath = (options?.env as Record<string, string>)["PI_ASK_USER_QUESTION_DISCUSSION_SYSTEM_PROMPT"]!;
          expect(args).toEqual(expect.arrayContaining(["--session", thread.sessionFile, "--no-builtin-tools"]));
          expect(args).not.toContain("--tools");
          expect(args).not.toContain("--no-tools");
          expect((options?.env as Record<string, string>)["PI_ASK_USER_QUESTION_DISCUSSION_CHILD"]).toBe("1");
          expect((options?.env as Record<string, string>)["PI_SRT_ROUTING_BUILTIN_TOOLS"]).toBe("read,edit");
          expect((options?.env as Record<string, string>)["PI_SRT_ROUTING_HOST_TOOLS"]).toBe("");
          expect((options?.env as Record<string, string>)["PI_SRT_ROUTING_SOCKET"]).toBe("/tmp/controller.sock");
          expect((options?.env as Record<string, string>)["PI_SRT_ROUTING_LEASE"]).toBe("a".repeat(64));
          expect((options?.env as Record<string, string>)["PI_SRT_ROUTING_WORKSPACE_KEY"]).toBe("b".repeat(64));
          expect((options?.env as Record<string, string>)["PI_SRT_ROUTING_WORKSPACE_ROOT"]).toBe("/workspace/project");
          expect((options?.env as Record<string, string>)["PI_SRT_ROUTING_POLICY_GENERATION"]).toBe("c".repeat(64));
          expect((options?.env as Record<string, string>)["PI_SRT_ROUTING_IMAGE_GENERATION"]).toBe("d".repeat(64));
          expect((options?.env as Record<string, string>)["PI_SRT_ROUTING_STARTUP_DESCRIPTOR"]).toBeUndefined();
          expect((process.env as Record<string, string>)["PI_SRT_ROUTING_STARTUP_DESCRIPTOR"]).toBe("private-root-startup");
          expect((options?.env as Record<string, string>)["PI_SUBAGENT_PLANNING"]).toBe("1");
          expect((options?.env as Record<string, string>)["HERDR_ENV"]).toBeUndefined();
          expect((options?.env as Record<string, string>)["HERDR_SOCKET_PATH"]).toBeUndefined();
          expect((options?.env as Record<string, string>)["HERDR_PANE_ID"]).toBeUndefined();
          expect((options?.env as Record<string, string>)["HERDR_FUTURE_CAPABILITY"]).toBeUndefined();
          expect((options?.env as Record<string, string>)["PI_HERDR_STATUS_PORT"]).toBeUndefined();
          expect((options?.env as Record<string, string>)["NON_HERDR_CHILD_CAPABILITY"]).toBe("preserved");
          void readSecureTurnFile(systemPath).then((file) => {
            expect(file.mode).toBe(0o600);
            expect(file.content).toContain("Parent instructions");
            child.close(0);
          });
          return child;
        }),
        getInvocation: (args) => ({ command: "fake-pi", args }),
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.thread?.sessionFile).toBe(thread.sessionFile);
    expect(result.resolution).toBeUndefined();
    expect(tui.stop).toHaveBeenCalledWith({ preserveScreen: true });
    expect(tui.start).toHaveBeenCalledOnce();
    expect(tui.renderNow).toHaveBeenCalledWith(true);
    expect(existsSync(systemPath)).toBe(false);
  });

  it("does not replay a resolution that the parent already consumed", async () => {
    const { parent } = parentWithQuestionnaireTool();
    const thread = createDiscussionThread({
      questionIndex: 0,
      question: "Which implementation?",
      options: [{ label: "A", description: "Simple" }, { label: "B", description: "Flexible" }],
      multiSelect: false,
      parentSessionFile: parent.getSessionFile(),
      parentToolCallId: "tool-1",
    });
    const childSession = SessionManager.open(thread.sessionFile);
    childSession.appendCustomEntry(DISCUSSION_RESOLUTION_ENTRY, {
      resolution: {
        id: "already-consumed",
        outcome: "A is smaller.",
        classification: "context_only",
        transcript: [],
        classifierUsage: emptyDiscussionUsage(),
        createdAt: Date.now(),
      },
    });
    const child = new FakeChild();
    const result = await runDiscussionFork({
      questionIndex: 0,
      question: "Which implementation?",
      options: [{ label: "A", description: "Simple" }, { label: "B", description: "Flexible" }],
      multiSelect: false,
      parentSessionFile: parent.getSessionFile(),
      parentToolCallId: "tool-1",
      systemPrompt: "Parent instructions",
      cwd: process.cwd(),
      model: { provider: "provider", id: "model" },
      thinkingLevel: "off",
      activeTools: [],
      projectTrusted: true,
      tui: { stop: vi.fn(), start: vi.fn(), renderNow: vi.fn() },
      thread,
      lastConsumedResolutionId: "already-consumed",
    }, {
      spawnProcess: vi.fn(() => {
        queueMicrotask(() => child.close(0));
        return child;
      }),
      getInvocation: (args) => ({ command: "fake-pi", args }),
    });
    expect(result.resolution).toBeUndefined();
  });

  it("returns only one unconsumed durable resolution and includes classifier usage", () => {
    const { parent } = parentWithQuestionnaireTool();
    const thread = createDiscussionThread({
      questionIndex: 0,
      question: "Which implementation?",
      options: [{ label: "A", description: "Simple" }, { label: "B", description: "Flexible" }],
      multiSelect: false,
      parentSessionFile: parent.getSessionFile(),
      parentToolCallId: "tool-1",
    });
    const child = SessionManager.open(thread.sessionFile);
    child.appendCustomEntry(DISCUSSION_RESOLUTION_ENTRY, {
      resolution: {
        id: "resolution-1",
        outcome: "A is smaller.",
        classification: "single_option",
        suggestion: { kind: "option", optionLabels: ["A"] },
        transcript: [{ role: "assistant", text: "A is smaller." }],
        classifierUsage: { ...emptyDiscussionUsage(), input: 2, output: 1, totalTokens: 3 },
        createdAt: Date.now(),
      },
    });
    const state = readDiscussionThread(thread.sessionFile);
    expect(state.resolution).toMatchObject({ id: "resolution-1", classification: "single_option" });
    expect(state.usage.totalTokens).toBe(3);
  });
});
