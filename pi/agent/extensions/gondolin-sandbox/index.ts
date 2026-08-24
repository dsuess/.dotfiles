import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { acquireControllerLease, ControllerClient, stopStartedController } from "../../../sandbox/client.mjs";
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
  PI_GONDOLIN_STARTUP_DESCRIPTOR?: string;
  PI_GONDOLIN_SOCKET?: string;
  PI_GONDOLIN_LEASE?: string;
  // Non-secret PID of the host Pi process that may release this lease.
  PI_GONDOLIN_ROOT_OWNER_PID?: string;
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
    adoptLease: boolean;
  }) => Promise<{ client: SandboxClient & { destroy?: () => void; release?: () => Promise<void> }; status: any }>;
  acquire?: (options: { startup: any; clientId: string; signal: AbortSignal }) => Promise<{
    client: SandboxClient & { destroy?: () => void; release?: () => Promise<void> };
    status: any;
    leaseToken: string;
    scope: { workspaceKey: string; canonicalWorkspaceRoot: string };
    manifest: { socketPath: string };
  }>;
  auditOptions?: { extensionPath?: string; agentDir?: string };
  statusIntervalMs?: number;
}

function requiredHex(value: string | undefined, name: string): string {
  if (!value || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} is missing or invalid`);
  return value;
}

function requiredString(value: string | undefined, name: string): string {
  if (!value || value.includes("\0")) throw new Error(`${name} is missing or invalid`);
  return value;
}

function parseStartupDescriptor(value: string | undefined): any {
  if (!value || !/^[A-Za-z0-9+/=]+$/.test(value)) throw new Error("PI_GONDOLIN_STARTUP_DESCRIPTOR is missing or invalid");
  let descriptor: any;
  try { descriptor = JSON.parse(Buffer.from(value, "base64").toString("utf8")); } catch {
    throw new Error("PI_GONDOLIN_STARTUP_DESCRIPTOR is invalid JSON");
  }
  if (descriptor?.version !== 1 || !/^[0-9a-f]{64}$/.test(descriptor.workspaceKey) ||
      typeof descriptor.workspaceRoot !== "string" || !path.isAbsolute(descriptor.workspaceRoot) ||
      typeof descriptor.runtimeRoot !== "string" || !path.isAbsolute(descriptor.runtimeRoot) ||
      typeof descriptor.socketPath !== "string" || !path.isAbsolute(descriptor.socketPath) ||
      typeof descriptor.manifestPath !== "string" || !path.isAbsolute(descriptor.manifestPath) ||
      (descriptor.startupPid !== undefined && descriptor.startupPid !== null &&
        (!Number.isSafeInteger(descriptor.startupPid) || descriptor.startupPid < 1))) {
    throw new Error("PI_GONDOLIN_STARTUP_DESCRIPTOR has an invalid shape");
  }
  return descriptor;
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

const CAPABILITY_ENV_FIELDS = [
  "PI_GONDOLIN_SOCKET", "PI_GONDOLIN_LEASE", "PI_GONDOLIN_ROOT_OWNER_PID",
  "PI_GONDOLIN_WORKSPACE_KEY", "PI_GONDOLIN_WORKSPACE_ROOT", "PI_GONDOLIN_POLICY_GENERATION",
  "PI_GONDOLIN_IMAGE_GENERATION", "PI_GONDOLIN_VM_ID",
] as const;

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
  const acquire = dependencies.acquire ?? ((options) => acquireControllerLease(options) as Promise<any>);

  return function gondolinSandboxExtension(pi: ExtensionAPI): void {
    if (env.PI_GONDOLIN_SANDBOX !== "1") return;

    const cwd = process.cwd();
    let client: (SandboxClient & { destroy?: () => void; release?: () => Promise<void> }) | null = null;
    let connectedStatus: any = null;
    let fatalError: string | null = null;
    let permittedNames = new Set<string>();
    let statusTimer: NodeJS.Timeout | null = null;
    let lastContext: ExtensionContext | null = null;
    let readiness: Promise<void> | null = null;
    let acquisitionAbort: AbortController | null = null;
    let rootStartup: any = null;
    let ownsRootLease = false;
    let released = false;
    let retired = false;
    const clearCapabilityEnvironment = (): void => {
      for (const name of CAPABILITY_ENV_FIELDS) delete env[name];
    };
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
      if (retired) return;
      fatalError = reason;
      const activeClient = client;
      client = null;
      pi.setActiveTools([]);
      if (ownsRootLease && !released) {
        released = true;
        void activeClient?.release?.().catch(() => {});
      } else activeClient?.destroy?.();
      clearCapabilityEnvironment();
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

    const startReadiness = (ctx: ExtensionContext): Promise<void> => {
      if (readiness) return readiness;
      lastContext = ctx;
      permittedNames = new Set();
      pi.setActiveTools([]);
      const requested = parseRequestedBuiltins(env.PI_GONDOLIN_BUILTIN_TOOLS);
      const requestedHostTools = parseRequestedHostTools(env.PI_GONDOLIN_HOST_TOOLS, manifest.keys());
      const inherited = env.PI_GONDOLIN_LEASE !== undefined;
      // Only a replacement runtime in this same host process can adopt the
      // release duty. Child Pi processes inherit the marker but have another PID.
      const adoptRootLease = inherited && env.PI_GONDOLIN_ROOT_OWNER_PID === String(process.pid);
      acquisitionAbort = new AbortController();
      connectedStatus = {
        health: "starting", vmId: null, dockerHealthy: false, attachedRoots: 0,
        policyGeneration: null, imageGeneration: null, pendingRestart: false,
      };
      emitLifecycle(lifecycleFromStatus(connectedStatus), ctx);
      readiness = (async () => {
        try {
          traceStartup("routing_connection_audit_start");
          let connected: any;
          let workspaceKey: string;
          let workspaceRoot: string;
          if (inherited) {
            const socketPath = requiredString(env.PI_GONDOLIN_SOCKET, "PI_GONDOLIN_SOCKET");
            const leaseToken = requiredHex(env.PI_GONDOLIN_LEASE, "PI_GONDOLIN_LEASE");
            workspaceKey = requiredHex(env.PI_GONDOLIN_WORKSPACE_KEY, "PI_GONDOLIN_WORKSPACE_KEY");
            workspaceRoot = requiredString(env.PI_GONDOLIN_WORKSPACE_ROOT, "PI_GONDOLIN_WORKSPACE_ROOT");
            connected = await connect({
              socketPath, leaseToken, workspaceKey, workspaceRoot,
              policyGeneration: requiredHex(env.PI_GONDOLIN_POLICY_GENERATION, "PI_GONDOLIN_POLICY_GENERATION"),
              imageGeneration: requiredHex(env.PI_GONDOLIN_IMAGE_GENERATION, "PI_GONDOLIN_IMAGE_GENERATION"),
              vmId: requiredString(env.PI_GONDOLIN_VM_ID, "PI_GONDOLIN_VM_ID"),
              adoptLease: adoptRootLease,
            });
          } else {
            const startup = parseStartupDescriptor(env.PI_GONDOLIN_STARTUP_DESCRIPTOR);
            rootStartup = startup;
            workspaceKey = startup.workspaceKey;
            workspaceRoot = startup.workspaceRoot;
            connected = await acquire({ startup, clientId: `pi-${process.pid}`, signal: acquisitionAbort!.signal });
            ownsRootLease = true;
          }
          if (retired) {
            connected.client.destroy?.();
            throw new Error("Gondolin runtime retired during startup");
          }
          client = connected.client;
          ownsRootLease = !inherited || adoptRootLease;
          const status = connected.status;
          if (status.workspaceKey !== workspaceKey || status.workspaceRoot !== workspaceRoot ||
              status.health !== "healthy" || status.dockerHealthy !== true || !status.vmId ||
              !/^[0-9a-f]{64}$/.test(status.policyGeneration) || !/^[0-9a-f]{64}$/.test(status.imageGeneration)) {
            throw new Error("Gondolin controller status does not match the requested workspace");
          }
          const result = audit();
          if (result.replacementErrors.length > 0) throw new Error(result.replacementErrors.join("; "));
          const missingHostTools = requestedHostTools.filter((name) => !result.allowedNames.has(name));
          if (missingHostTools.length > 0) throw new Error(`Requested host adapters are missing or unaudited: ${missingHostTools.join(", ")}`);
          permittedNames = new Set([...requested, ...requestedHostTools]);
          pi.setActiveTools([...permittedNames]);
          enforceInventory(ctx, result);
          if (!inherited) {
            env.PI_GONDOLIN_SOCKET = connected.manifest.socketPath;
            env.PI_GONDOLIN_LEASE = connected.leaseToken;
            env.PI_GONDOLIN_ROOT_OWNER_PID = String(process.pid);
            env.PI_GONDOLIN_WORKSPACE_KEY = workspaceKey;
            env.PI_GONDOLIN_WORKSPACE_ROOT = workspaceRoot;
            env.PI_GONDOLIN_POLICY_GENERATION = status.policyGeneration;
            env.PI_GONDOLIN_IMAGE_GENERATION = status.imageGeneration;
            env.PI_GONDOLIN_VM_ID = status.vmId;
          }
          publishStatus(status, ctx);
          traceStartup("routing_connection_audit_complete");
          if (statusTimer) clearInterval(statusTimer);
          statusTimer = setInterval(() => {
            const activeClient = client as any;
            if (!activeClient || fatalError || retired) return;
            void activeClient.status().then((next: any) => {
              if (!retired && client === activeClient) publishStatus(next);
            }).catch((error: unknown) => {
              if (!retired && client === activeClient) {
                failClosed(lastContext ?? undefined, error instanceof Error ? error.message : String(error));
              }
            });
          }, dependencies.statusIntervalMs ?? 2000);
          statusTimer.unref?.();
          writeHandshake(env.PI_GONDOLIN_HANDSHAKE_FILE, {
            ok: true, workspaceKey, workspaceRoot, policyGeneration: status.policyGeneration,
            imageGeneration: status.imageGeneration, vmId: status.vmId, dockerHealthy: true,
            tools: [...GONDOLIN_BUILTIN_NAMES],
          });
        } catch (error) {
          if (retired) throw error;
          const reason = error instanceof Error ? error.message : String(error);
          failClosed(ctx, reason);
          throw error;
        }
      })();
      return readiness;
    };

    pi.on("session_start", (_event, ctx) => {
      traceStartup("pi_initialize_complete");
      if (ctx.hasUI) traceStartup("host_ui_ready");
      const pending = startReadiness(ctx);
      if (!ctx.hasUI) return pending;
      void pending.catch(() => {});
    });

    pi.on("input", async () => {
      try {
        await readiness;
        enforceInventory();
        return { action: "continue" };
      } catch {
        // Pi catches input-event errors and would continue the submission. A
        // handled result is the fail-closed boundary for queued prompts.
        return { action: "handled" };
      }
    });

    pi.on("before_agent_start", async () => {
      await readiness;
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
      try {
        await readiness;
      } catch {
        return {
          result: {
            output: fatalError ?? "Gondolin controller startup failed.", exitCode: 126,
            cancelled: false, truncated: false,
          },
        };
      }
      return { operations: createSandboxBashOperations(getClient) };
    });

    pi.on("session_shutdown", async (event, ctx) => {
      retired = true;
      if (statusTimer) clearInterval(statusTimer);
      statusTimer = null;
      const pendingAbort = acquisitionAbort;
      pendingAbort?.abort();
      acquisitionAbort = null;
      const activeClient = client;
      client = null;

      if (event.reason === "quit") {
        // A cold root owns the detached controller only until final quit. A
        // conversation replacement must leave it running for the next runtime.
        if (!activeClient && rootStartup && pendingAbort) stopStartedController(rootStartup);
        if (ownsRootLease && !released) {
          released = true;
          await activeClient?.release?.().catch(() => {});
        } else activeClient?.destroy?.();
        clearCapabilityEnvironment();
      } else {
        // /new, /resume, /fork, and /reload reload extensions in this same
        // process. Retire this connection without releasing its root lease.
        activeClient?.destroy?.();
      }

      pi.setActiveTools([]);
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
          ctx.ui.notify(fatalError ?? "Gondolin is starting; settings are available after readiness.", fatalError ? "error" : "info");
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
            `Health: ${connectedStatus.health ?? "healthy"}`,
            `VM: ${connectedStatus.vmId ?? "starting"}`,
            `Docker: ${connectedStatus.dockerHealthy ? "healthy" : "starting"}`, 
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
