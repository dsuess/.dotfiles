import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { ControllerClient } from "../../../sandbox/client.mjs";
import {
  auditToolInventory,
  createHostAdapterManifest,
  isAuditedHostAdapter,
  isGondolinReplacement,
  type ConfiguredToolInfo,
} from "./host-adapters.ts";
import {
  lifecycleFromStatus,
  SANDBOX_LIFECYCLE_EVENT,
  type SandboxLifecycleEvent,
} from "./events.ts";
import { SandboxSettingsStore } from "./settings-store.ts";
import { showSandboxSettings } from "./settings-view.ts";
import {
  createSandboxBashOperations,
  GONDOLIN_BUILTIN_NAMES,
  registerSandboxTools,
  type SandboxClient,
} from "./tools.ts";

export const SANDBOX_VERIFY_TOOLS_EVENT = "gondolin-sandbox:verify-tools";
export const SANDBOX_BEFORE_USER_BASH_EVENT = "gondolin-sandbox:before-user-bash";

interface SandboxEnvironment {
  PI_GONDOLIN_SANDBOX?: string;
  PI_GONDOLIN_SOCKET?: string;
  PI_GONDOLIN_LEASE?: string;
  PI_GONDOLIN_WORKSPACE_KEY?: string;
  PI_GONDOLIN_WORKSPACE_ROOT?: string;
  PI_GONDOLIN_POLICY_GENERATION?: string;
  PI_GONDOLIN_IMAGE_GENERATION?: string;
  PI_GONDOLIN_VM_ID?: string;
  PI_GONDOLIN_BUILTIN_TOOLS?: string;
  PI_GONDOLIN_HOST_TOOLS?: string;
  PI_GONDOLIN_HANDSHAKE_FILE?: string;
  PI_CODING_AGENT_DIR?: string;
}

interface ExtensionDependencies {
  env?: SandboxEnvironment;
  connect?: (options: {
    socketPath: string;
    leaseToken: string;
    workspaceKey: string;
    workspaceRoot: string;
    policyGeneration: string;
    imageGeneration: string;
    vmId: string;
  }) => Promise<{ client: SandboxClient & { destroy?: () => void }; status: any }>;
  auditOptions?: { extensionPath?: string; agentDir?: string };
}

function requiredHex(value: string | undefined, name: string): string {
  if (!value || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} is missing or invalid`);
  return value;
}

function requiredString(value: string | undefined, name: string): string {
  if (!value || value.includes("\0")) throw new Error(`${name} is missing or invalid`);
  return value;
}

export function parseRequestedBuiltins(value: string | undefined): string[] {
  if (value === undefined) return [...GONDOLIN_BUILTIN_NAMES];
  if (value === "") return [];
  const requested = value.split(",").filter(Boolean);
  const unknown = requested.filter(
    (name) => !GONDOLIN_BUILTIN_NAMES.includes(name as (typeof GONDOLIN_BUILTIN_NAMES)[number]),
  );
  if (unknown.length > 0) throw new Error(`Unknown requested Gondolin built-ins: ${unknown.join(", ")}`);
  return [...new Set(requested)];
}

export function parseRequestedHostTools(
  value: string | undefined,
  allowedNames: Iterable<string>,
): string[] {
  const allowed = new Set(allowedNames);
  const requested = value === undefined ? [...allowed] : value.split(",").filter(Boolean);
  const unknown = requested.filter((name) => !allowed.has(name));
  if (unknown.length > 0) throw new Error(`Unknown requested host adapters: ${unknown.join(", ")}`);
  return [...new Set(requested)];
}

function writeHandshake(filePath: string | undefined, value: Record<string, unknown>): void {
  if (!filePath) return;
  const absolute = path.resolve(filePath);
  const directory = path.dirname(absolute);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(absolute)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, absolute);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function configuredTools(pi: ExtensionAPI): ConfiguredToolInfo[] {
  return pi.getAllTools() as ConfiguredToolInfo[];
}

function traceStartup(phase: string): void {
  const filePath = process.env.PI_GONDOLIN_STARTUP_TRACE_FILE;
  if (!filePath || !path.isAbsolute(filePath) || /[\t\r\n\0]/.test(filePath)) return;
  try {
    fs.appendFileSync(filePath, `${JSON.stringify({ phase, at: Date.now() })}\n`, { mode: 0o600 });
  } catch {
    // Benchmark diagnostics must not affect routing readiness.
  }
}

export function createGondolinSandboxExtension(dependencies: ExtensionDependencies = {}) {
  const env = dependencies.env ?? (process.env as SandboxEnvironment);
  const connect =
    dependencies.connect ??
    ((options) => ControllerClient.connectInherited(options) as Promise<{ client: SandboxClient; status: any }>);

  return function gondolinSandboxExtension(pi: ExtensionAPI): void {
    if (env.PI_GONDOLIN_SANDBOX !== "1") return;

    const cwd = process.cwd();
    let client: (SandboxClient & { destroy?: () => void }) | null = null;
    let connectedStatus: any = null;
    let fatalError: string | null = null;
    let permittedNames = new Set<string>();
    let statusTimer: NodeJS.Timeout | null = null;
    let lastContext: ExtensionContext | null = null;
    const settingsStore = new SandboxSettingsStore();
    const manifest = createHostAdapterManifest({ agentDir: dependencies.auditOptions?.agentDir });
    const getClient = (): SandboxClient => {
      if (!client || fatalError) {
        throw new Error(fatalError ?? "Gondolin controller handshake has not completed");
      }
      return client;
    };

    registerSandboxTools(pi, { cwd, getClient });

    const audit = () =>
      auditToolInventory(configuredTools(pi), {
        manifest,
        extensionPath: dependencies.auditOptions?.extensionPath,
        agentDir: dependencies.auditOptions?.agentDir,
      });

    const emitLifecycle = (event: SandboxLifecycleEvent, ctx = lastContext): void => {
      pi.events.emit(SANDBOX_LIFECYCLE_EVENT, event);
      if (!ctx?.hasUI) return;
      const marker =
        event.health === "healthy"
          ? ctx.ui.theme.fg("success", `sandbox:${event.vmId?.slice(0, 8) ?? "ready"}`)
          : event.health === "failed"
            ? ctx.ui.theme.fg("error", "sandbox:failed")
            : ctx.ui.theme.fg("warning", `sandbox:${event.health}`);
      ctx.ui.setStatus("gondolin-sandbox", marker);
    };

    const publishStatus = (status: any, ctx = lastContext): void => {
      connectedStatus = status;
      emitLifecycle(lifecycleFromStatus(status), ctx);
    };

    const failClosed = (ctx: ExtensionContext | undefined, reason: string): void => {
      fatalError = reason;
      client?.destroy?.();
      client = null;
      const currentAudit = audit();
      pi.setActiveTools(
        pi
          .getActiveTools()
          .filter((name) => !GONDOLIN_BUILTIN_NAMES.includes(name as any))
          .filter((name) => currentAudit.allowedNames.has(name)),
      );
      emitLifecycle({
        health: "failed",
        vmId: connectedStatus?.vmId ?? null,
        dockerHealthy: false,
        attachedRoots: connectedStatus?.attachedRoots ?? 0,
        policyGeneration: connectedStatus?.policyGeneration ?? null,
        imageGeneration: connectedStatus?.imageGeneration ?? null,
        pendingRestart: false,
        failure: reason,
      }, ctx);
      if (ctx?.hasUI) ctx.ui.notify(`Gondolin tool routing failed closed: ${reason}`, "error");
      writeHandshake(env.PI_GONDOLIN_HANDSHAKE_FILE, { ok: false, error: reason });
      ctx?.shutdown();
    };

    const enforceInventory = (ctx?: ExtensionContext, result = audit()): void => {
      const safeActive = pi
        .getActiveTools()
        .filter((name) => result.allowedNames.has(name) && permittedNames.has(name));
      if (safeActive.length !== pi.getActiveTools().length) pi.setActiveTools(safeActive);
      if (result.replacementErrors.length > 0) {
        const reason = result.replacementErrors.join("; ");
        failClosed(ctx, reason);
        throw new Error(reason);
      }
    };

    pi.events.on(SANDBOX_VERIFY_TOOLS_EVENT, (payload: any) => {
      const result = audit();
      pi.setActiveTools(
        pi
          .getActiveTools()
          .filter((name) => result.allowedNames.has(name) && permittedNames.has(name)),
      );
      if (result.replacementErrors.length > 0) payload.error = result.replacementErrors.join("; ");
    });

    pi.on("session_start", async (_event, ctx) => {
      lastContext = ctx;
      try {
        traceStartup("pi_initialize_complete");
        traceStartup("routing_connection_audit_start");
        const socketPath = requiredString(env.PI_GONDOLIN_SOCKET, "PI_GONDOLIN_SOCKET");
        const leaseToken = requiredHex(env.PI_GONDOLIN_LEASE, "PI_GONDOLIN_LEASE");
        const workspaceKey = requiredHex(env.PI_GONDOLIN_WORKSPACE_KEY, "PI_GONDOLIN_WORKSPACE_KEY");
        const workspaceRoot = requiredString(
          env.PI_GONDOLIN_WORKSPACE_ROOT,
          "PI_GONDOLIN_WORKSPACE_ROOT",
        );
        const policyGeneration = requiredHex(
          env.PI_GONDOLIN_POLICY_GENERATION,
          "PI_GONDOLIN_POLICY_GENERATION",
        );
        const imageGeneration = requiredHex(
          env.PI_GONDOLIN_IMAGE_GENERATION,
          "PI_GONDOLIN_IMAGE_GENERATION",
        );
        const vmId = requiredString(env.PI_GONDOLIN_VM_ID, "PI_GONDOLIN_VM_ID");
        const requested = parseRequestedBuiltins(env.PI_GONDOLIN_BUILTIN_TOOLS);
        const requestedHostTools = parseRequestedHostTools(
          env.PI_GONDOLIN_HOST_TOOLS,
          manifest.keys(),
        );
        const connected = await connect({
          socketPath,
          leaseToken,
          workspaceKey,
          workspaceRoot,
          policyGeneration,
          imageGeneration,
          vmId,
        });
        client = connected.client;
        publishStatus(connected.status, ctx);
        const result = audit();
        if (result.replacementErrors.length > 0) throw new Error(result.replacementErrors.join("; "));
        const missingHostTools = requestedHostTools.filter((name) => !result.allowedNames.has(name));
        if (missingHostTools.length > 0) {
          throw new Error(`Requested host adapters are missing or unaudited: ${missingHostTools.join(", ")}`);
        }
        permittedNames = new Set([...requested, ...requestedHostTools]);
        pi.setActiveTools([...permittedNames]);
        enforceInventory(ctx, result);
        traceStartup("routing_connection_audit_complete");
        if (statusTimer) clearInterval(statusTimer);
        statusTimer = setInterval(() => {
          const activeClient = client as any;
          if (!activeClient || fatalError) return;
          void activeClient
            .status()
            .then((status: any) => publishStatus(status))
            .catch((error: unknown) =>
              failClosed(lastContext ?? undefined, error instanceof Error ? error.message : String(error)),
            );
        }, 2000);
        statusTimer.unref?.();
        writeHandshake(env.PI_GONDOLIN_HANDSHAKE_FILE, {
          ok: true,
          workspaceKey,
          workspaceRoot,
          policyGeneration,
          imageGeneration,
          vmId: connected.status.vmId,
          dockerHealthy: connected.status.dockerHealthy,
          tools: [...GONDOLIN_BUILTIN_NAMES],
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failClosed(ctx, reason);
        throw error;
      }
    });

    pi.on("before_agent_start", async () => {
      enforceInventory();
    });

    pi.on("tool_call", async (event) => {
      const tool = configuredTools(pi).find((candidate) => candidate.name === event.toolName);
      const allowed = Boolean(
        tool &&
          permittedNames.has(event.toolName) &&
          (isGondolinReplacement(tool, dependencies.auditOptions) ||
            isAuditedHostAdapter(tool, manifest)),
      );
      if (!allowed) {
        return {
          block: true,
          terminate: true,
          reason: `Tool '${event.toolName}' is not an audited Gondolin replacement or host adapter.`,
        };
      }
    });

    pi.on("user_bash", async (event) => {
      const gate = { command: event.command, result: undefined as any };
      pi.events.emit(SANDBOX_BEFORE_USER_BASH_EVENT, gate);
      if (gate.result) return gate.result;
      if (!client || fatalError) {
        return {
          result: {
            output: fatalError ?? "Gondolin controller handshake has not completed.",
            exitCode: 126,
            cancelled: false,
            truncated: false,
          },
        };
      }
      return { operations: createSandboxBashOperations(getClient) };
    });

    pi.on("session_shutdown", (_event, ctx) => {
      if (statusTimer) clearInterval(statusTimer);
      statusTimer = null;
      client?.destroy?.();
      client = null;
      emitLifecycle({
        health: "stopped",
        vmId: connectedStatus?.vmId ?? null,
        dockerHealthy: false,
        attachedRoots: 0,
        policyGeneration: connectedStatus?.policyGeneration ?? null,
        imageGeneration: connectedStatus?.imageGeneration ?? null,
        pendingRestart: false,
      }, ctx);
      connectedStatus = null;
      lastContext = null;
      if (ctx.hasUI) ctx.ui.setStatus("gondolin-sandbox", undefined);
    });

    pi.registerCommand("sandbox", {
      description: "Inspect or change the shared Gondolin sandbox",
      handler: async (_args, ctx) => {
        if (!client || fatalError) {
          ctx.ui.notify(fatalError ?? "Gondolin is not connected.", "error");
          return;
        }
        await showSandboxSettings(
          ctx,
          client as any,
          settingsStore,
          (event) => emitLifecycle(event, ctx),
        );
      },
    });

    pi.registerCommand("gondolin-status", {
      description: "Show the active shared Gondolin controller status",
      handler: async (_args, ctx) => {
        if (!connectedStatus) {
          ctx.ui.notify(fatalError ?? "Gondolin is not connected.", "error");
          return;
        }
        ctx.ui.notify(
          [
            `VM: ${connectedStatus.vmId}`,
            `Docker: ${connectedStatus.dockerHealthy ? "healthy" : "failed"}`,
            `Policy: ${connectedStatus.policyGeneration}`,
            `Attached roots: ${connectedStatus.attachedRoots}`,
          ].join("\n"),
          "info",
        );
      },
    });
  };
}

export default createGondolinSandboxExtension();
