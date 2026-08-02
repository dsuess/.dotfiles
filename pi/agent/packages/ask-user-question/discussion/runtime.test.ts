import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  CHILD_TOOL_EXCLUSIONS,
  DiscussionTurnCancelledError,
  filterChildTools,
  formatParentContext,
  MAX_DISCUSSION_OUTPUT_CHARS,
  readSecureTurnFile,
  runDiscussionTurn,
  type DiscussionTurnRequest,
} from "./runtime.js";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = true;
    this.signals.push(signal);
    return true;
  }

  close(code = 0): void {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code);
  }
}

function request(overrides: Partial<DiscussionTurnRequest> = {}): DiscussionTurnRequest {
  return {
    question: "Which implementation?",
    options: [
      { label: "A", description: "Simple" },
      { label: "B", description: "Flexible" },
    ],
    userPrompt: "What is the maintenance trade-off?",
    transcript: [{ role: "assistant", text: "We established A is smaller." }],
    parentContext: "user: Build the feature",
    systemPrompt: "Parent system instructions",
    cwd: process.cwd(),
    model: { provider: "provider", id: "model" },
    thinkingLevel: "high",
    activeTools: ["read", "edit", "ask_user_question", "ketch_search", "subagent", "complete_plan"],
    projectTrusted: true,
    ...overrides,
  };
}

function assistantEvent(text: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text },
      ],
      stopReason: "stop",
      usage: {
        input: 8,
        output: 3,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 14,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
      },
      ...overrides,
    },
  });
}

function fakeRuntime(run: (child: FakeChild, args: string[]) => void | Promise<void>) {
  const captured: { args?: string[]; child?: FakeChild } = {};
  const spawnProcess = vi.fn((_command: string, args: string[]) => {
    const child = new FakeChild();
    captured.args = args;
    captured.child = child;
    queueMicrotask(() => void run(child, args));
    return child;
  });
  return { captured, spawnProcess };
}

function argAfter(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0) throw new Error(`missing ${name}`);
  return args[index + 1]!;
}

describe("discussion child runtime", () => {
  it("preserves active capability order while excluding only recursive/workflow tools", () => {
    expect(filterChildTools(["write", "read", "ask_user_question", "edit", "plan_progress", "bash"])).toEqual([
      "write",
      "read",
      "edit",
      "bash",
    ]);
    expect(CHILD_TOOL_EXCLUSIONS).toContain("subagent");
    expect(CHILD_TOOL_EXCLUSIONS).toContain("complete_stage");
  });

  it("inherits model, thinking, cwd, system/context, trust, and mutation-capable tools through secure files", async () => {
    const inspected: Array<{ mode: number; content: string }> = [];
    const activity: string[] = [];
    const fake = fakeRuntime(async (child, args) => {
      const systemPath = argAfter(args, "--system-prompt");
      const promptPath = args.at(-1)!.slice(1);
      inspected.push(await readSecureTurnFile(systemPath), await readSecureTurnFile(promptPath));
      child.stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolName: "edit" })}\n`);
      child.stdout.write(`${assistantEvent("Choose A unless extensibility is expected.")}\n`);
      child.close(0);
    });

    const result = await runDiscussionTurn(request({ onActivity: (message) => activity.push(message) }), {
      spawnProcess: fake.spawnProcess,
      getInvocation: (args) => ({ command: "fake-pi", args }),
    });

    const args = fake.captured.args!;
    expect(argAfter(args, "--model")).toBe("provider/model");
    expect(argAfter(args, "--thinking")).toBe("high");
    expect(argAfter(args, "--tools")).toBe("read,edit,ketch_search");
    expect(args).toContain("--approve");
    expect(result.tools).toEqual(["read", "edit", "ketch_search"]);
    expect(result.response).toBe("Choose A unless extensibility is expected.");
    expect(result.usage).toMatchObject({ input: 8, output: 3, totalTokens: 14, cost: { total: 0.33 } });
    expect(activity).toContain("Using edit");
    expect(inspected.map((entry) => entry.mode)).toEqual([0o600, 0o600]);
    expect(inspected[0]!.content).toContain("Parent system instructions");
    expect(inspected[1]!.content).toContain("user: Build the feature");
    expect(inspected[1]!.content).toContain("What is the maintenance trade-off?");
    expect(existsSync(argAfter(args, "--system-prompt"))).toBe(false);
  });

  it("does not expose private thinking when formatting parent context", () => {
    const context = formatParentContext([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret chain" },
          { type: "text", text: "observable answer" },
        ],
      },
      { role: "compactionSummary", summary: "compacted facts" },
    ]);
    expect(context).toContain("observable answer");
    expect(context).toContain("compacted facts");
    expect(context).not.toContain("secret chain");
  });

  it("marks provider-length and local output truncation", async () => {
    const fake = fakeRuntime((child) => {
      child.stdout.write(`${assistantEvent("x".repeat(MAX_DISCUSSION_OUTPUT_CHARS + 100), { stopReason: "length" })}\n`);
      child.close(0);
    });
    const result = await runDiscussionTurn(request(), {
      spawnProcess: fake.spawnProcess,
      getInvocation: (args) => ({ command: "fake", args }),
    });
    expect(result.truncated).toBe(true);
    expect(result.response.length).toBeLessThan(MAX_DISCUSSION_OUTPUT_CHARS + 100);
    expect(result.response).toContain("[response truncated]");
  });

  it("aborts the child cleanly and removes temporary state", async () => {
    const controller = new AbortController();
    const fake = fakeRuntime((child) => {
      controller.abort();
      child.close(143);
    });
    const promise = runDiscussionTurn(request({ signal: controller.signal }), {
      spawnProcess: fake.spawnProcess,
      getInvocation: (args) => ({ command: "fake", args }),
    });
    await expect(promise).rejects.toBeInstanceOf(DiscussionTurnCancelledError);
    expect(fake.captured.child?.signals).toContain("SIGTERM");
    const systemPath = argAfter(fake.captured.args!, "--system-prompt");
    expect(existsSync(systemPath)).toBe(false);
  });

  it("reports child/provider failures without returning partial text", async () => {
    const fake = fakeRuntime((child) => {
      child.stderr.write("provider unavailable");
      child.stdout.write(`${assistantEvent("partial", { stopReason: "error", errorMessage: "auth failed" })}\n`);
      child.close(1);
    });
    await expect(
      runDiscussionTurn(request(), {
        spawnProcess: fake.spawnProcess,
        getInvocation: (args) => ({ command: "fake", args }),
      }),
    ).rejects.toThrow("auth failed");
  });

  it("does not broaden an empty parent capability set", async () => {
    const fake = fakeRuntime((child) => {
      child.stdout.write(`${assistantEvent("No tools were needed.")}\n`);
      child.close(0);
    });
    await runDiscussionTurn(request({ activeTools: [] }), {
      spawnProcess: fake.spawnProcess,
      getInvocation: (args) => ({ command: "fake", args }),
    });
    expect(fake.captured.args).toContain("--no-tools");
    expect(fake.captured.args).not.toContain("--tools");
  });
});
