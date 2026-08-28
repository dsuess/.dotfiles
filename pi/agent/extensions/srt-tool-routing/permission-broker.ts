import path from "node:path";

export type FilesystemAccess = "read" | "write";
export type GrantLifetime = "once" | "session" | "persistent";
export type PermissionSource = "tool-preflight" | "worker-violation";

/**
 * Data that crosses the trusted controller/UI boundary. `canonicalPath` must
 * already be resolved by trusted code; this broker rejects lexical aliases.
 */
export interface FilesystemPermissionRequest {
  source: PermissionSource;
  operation: string;
  canonicalPath: string;
  toolName: string;
  toolCallId: string;
  commandLabel?: string;
  requestedAccess: FilesystemAccess;
  grantLifetimes: readonly GrantLifetime[];
  consequences: string;
}

export type FilesystemPermissionDecision =
  | { allowed: true; lifetime: GrantLifetime }
  | { allowed: false; reason: "denied" | "no-ui" | "cancelled" | "timeout" | "shutdown" | "invalid-request" };

export interface PermissionDialog {
  hasUI: boolean;
  select(title: string, options: string[], options?: { timeout?: number; signal?: AbortSignal }): Promise<string | undefined>;
}

export interface PermissionBrokerOptions {
  timeoutMs?: number;
}

const LIFETIME_CHOICES: Record<GrantLifetime, string> = {
  once: "Allow once",
  session: "Allow for this session",
  persistent: "Always allow",
};

function deny(reason: Extract<FilesystemPermissionDecision, { allowed: false }> ["reason"]): FilesystemPermissionDecision {
  return { allowed: false, reason };
}

function validateRequest(request: FilesystemPermissionRequest): void {
  if (!request.operation || !request.toolName || !request.toolCallId || !request.consequences) {
    throw new Error("permission request is missing required context");
  }
  if (!path.isAbsolute(request.canonicalPath) || request.canonicalPath.includes("\0") ||
      path.resolve(request.canonicalPath) !== request.canonicalPath) {
    throw new Error("permission request path must be canonical and absolute");
  }
  if (request.requestedAccess !== "read" && request.requestedAccess !== "write") {
    throw new Error("permission request has invalid access");
  }
  if (request.grantLifetimes.length === 0 || new Set(request.grantLifetimes).size !== request.grantLifetimes.length ||
      request.grantLifetimes.some((lifetime) => !(lifetime in LIFETIME_CHOICES))) {
    throw new Error("permission request has invalid grant lifetimes");
  }
}

function keyFor(request: FilesystemPermissionRequest): string {
  // Deliberately omit toolCallId: equivalent simultaneous tool calls share one prompt.
  return JSON.stringify({
    source: request.source,
    operation: request.operation,
    canonicalPath: request.canonicalPath,
    toolName: request.toolName,
    commandLabel: request.commandLabel ?? "",
    requestedAccess: request.requestedAccess,
    grantLifetimes: [...request.grantLifetimes],
    consequences: request.consequences,
  });
}

/**
 * Single-controller broker. It serializes dialogs, coalesces identical pending
 * requests, and treats every unavailable or interrupted UI path as a denial.
 * It only decides; Part G owns applying/restarting grants.
 */
export class FilesystemPermissionBroker {
  readonly #timeoutMs: number;
  #tail: Promise<void> = Promise.resolve();
  #pending = new Map<string, Promise<FilesystemPermissionDecision>>();
  #activeDialogs = new Set<AbortController>();
  #shuttingDown = false;

  constructor(options: PermissionBrokerOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  shutdown(): void {
    this.#shuttingDown = true;
    for (const controller of this.#activeDialogs) controller.abort();
  }

  request(request: FilesystemPermissionRequest, dialog: PermissionDialog, signal?: AbortSignal): Promise<FilesystemPermissionDecision> {
    try {
      validateRequest(request);
    } catch {
      return Promise.resolve(deny("invalid-request"));
    }
    if (this.#shuttingDown) return Promise.resolve(deny("shutdown"));
    if (!dialog.hasUI) return Promise.resolve(deny("no-ui"));
    if (signal?.aborted) return Promise.resolve(deny("cancelled"));

    const key = keyFor(request);
    const existing = this.#pending.get(key);
    if (existing) return existing;

    let resolveResult!: (decision: FilesystemPermissionDecision) => void;
    const result = new Promise<FilesystemPermissionDecision>((resolve) => { resolveResult = resolve; });
    this.#pending.set(key, result);
    const run = async (): Promise<void> => {
      if (this.#shuttingDown) return resolveResult(deny("shutdown"));
      if (signal?.aborted) return resolveResult(deny("cancelled"));
      const controller = new AbortController();
      this.#activeDialogs.add(controller);
      const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const title = `Filesystem permission: ${request.requestedAccess} ${request.canonicalPath}`;
        const context = [
          `${request.operation} via ${request.toolName}${request.commandLabel ? ` (${request.commandLabel})` : ""}.`,
          request.consequences,
        ].join("\n\n");
        const options = [...request.grantLifetimes.map((lifetime) => LIFETIME_CHOICES[lifetime]), "Deny"];
        const selected = await dialog.select(`${title}\n\n${context}`, options, { timeout: this.#timeoutMs, signal: controller.signal });
        if (this.#shuttingDown) resolveResult(deny("shutdown"));
        else if (signal?.aborted) resolveResult(deny("cancelled"));
        else if (controller.signal.aborted) resolveResult(deny("timeout"));
        else {
          const lifetime = request.grantLifetimes.find((candidate) => LIFETIME_CHOICES[candidate] === selected);
          resolveResult(lifetime ? { allowed: true, lifetime } : deny("denied"));
        }
      } catch {
        resolveResult(controller.signal.aborted ? deny(signal?.aborted ? "cancelled" : "timeout") : deny("cancelled"));
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        this.#activeDialogs.delete(controller);
        this.#pending.delete(key);
      }
    };
    this.#tail = this.#tail.then(run, run);
    return result;
  }
}
