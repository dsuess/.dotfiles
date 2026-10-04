export type SandboxExecutionMode = "on" | "off";

export interface ExecutionGate {
  run<T>(operation: (mode: SandboxExecutionMode) => Promise<T>): Promise<T>;
}

/** Trusted process memory only: never reconstruct authority from a transcript or environment. */
export class ConversationMode implements ExecutionGate {
  private mode: SandboxExecutionMode = "on";
  private blockedReason: string | null = null;
  private operations = 0;
  private toolCalls = new Set<string>();
  private agentActive = false;
  private transitioning = false;
  private retired = false;

  snapshot(): { mode: SandboxExecutionMode; blockedReason: string | null } {
    return { mode: this.mode, blockedReason: this.blockedReason };
  }

  assertIdle(isIdle: () => boolean = () => true): void {
    if (this.retired) throw new Error("SRT tool routing runtime is retired");
    if (this.transitioning || this.operations > 0 || this.toolCalls.size > 0 || this.agentActive || !isIdle()) {
      throw new Error("Sandbox controls require an idle conversation. Retry after the tool batch or user Bash finishes.");
    }
  }

  assertExecutable(): void {
    if (this.retired) throw new Error("SRT tool routing runtime is retired");
    if (this.transitioning) throw new Error("Sandbox controls are changing; retry after the transition finishes.");
    if (this.mode === "on" && this.blockedReason) throw new Error(this.blockedReason);
  }

  reserve(): ExecutionGate {
    this.assertExecutable();
    const mode = this.mode;
    this.operations += 1;
    let used = false;
    return {
      run: async <T>(operation: (mode: SandboxExecutionMode) => Promise<T>): Promise<T> => {
        if (used) throw new Error("Sandbox operation reservation was already used");
        used = true;
        try {
          this.assertExecutable();
          return await operation(mode);
        } finally { this.operations -= 1; }
      },
    };
  }

  async run<T>(operation: (mode: SandboxExecutionMode) => Promise<T>): Promise<T> {
    return this.reserve().run(operation);
  }

  async atIdle<T>(isIdle: () => boolean, action: () => Promise<T>): Promise<T> {
    this.assertIdle(isIdle);
    this.transitioning = true;
    try { return await action(); }
    finally { this.transitioning = false; }
  }

  async switchMode(mode: SandboxExecutionMode, isIdle: () => boolean, verifySandbox: () => Promise<void>): Promise<void> {
    await this.atIdle(isIdle, async () => {
      if (mode === "off") {
        this.mode = "off";
        return;
      }
      // Re-enabling must never leave host authority selected on verification failure.
      this.mode = "on";
      this.blockedReason = "Sandbox readiness and effective policy are being verified";
      try {
        await verifySandbox();
        this.blockedReason = null;
      } catch (error) {
        this.blockedReason = `Sandbox execution blocked: ${error instanceof Error ? error.message : String(error)}`;
        throw new Error(this.blockedReason);
      }
    });
  }

  blockSandbox(reason: string): void { this.blockedReason = reason; }
  toolStarted(id: string): void { this.toolCalls.add(id); }
  toolEnded(id: string): void { this.toolCalls.delete(id); }
  agentStarted(): void { this.agentActive = true; }
  agentEnded(): void { this.agentActive = false; }
  retire(): void { this.retired = true; }
}

// Reload re-evaluates extension modules. The actual SessionManager object is stable
// across reload, unlike branch/history IDs, and is not shared with child processes.
const STORE_KEY = Symbol.for("dotfiles.pi.srt-tool-routing.conversation-mode.v1");
const processMemory = globalThis as typeof globalThis & { [STORE_KEY]?: WeakMap<object, SandboxExecutionMode> };
const reloadModes = processMemory[STORE_KEY] ??= new WeakMap<object, SandboxExecutionMode>();

export async function startConversationMode(sessionManager: object | undefined, reason: string): Promise<ConversationMode> {
  const mode = new ConversationMode();
  const retained = sessionManager && reason === "reload" ? reloadModes.get(sessionManager) : undefined;
  if (sessionManager) reloadModes.delete(sessionManager);
  if (retained === "off") await mode.switchMode("off", () => true, async () => {});
  return mode;
}

export function retireConversationMode(mode: ConversationMode, sessionManager: object | undefined, reason: string): void {
  if (sessionManager) {
    if (reason === "reload") reloadModes.set(sessionManager, mode.snapshot().mode);
    else reloadModes.delete(sessionManager);
  }
  mode.retire();
}
