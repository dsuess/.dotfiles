import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { acquireControllerLease, ControllerClient, stopStartedController } from "../../../sandbox/client.mjs";
import {
  createHostAdapterManifest,
  isSrtToolRoutingReplacement,
  isTrustedHostAdapter,
  verifyToolInventory,
  type ConfiguredToolInfo,
} from "./host-adapters.ts";
import {
  lifecycleFromStatus,
  SANDBOX_LIFECYCLE_EVENT,
  type SandboxLifecycleEvent,
} from "./events.ts";
import { showSandboxStatus } from "./status-view.ts";
import {
  createSandboxBashOperations,
  SRT_ROUTING_BUILTIN_NAMES,
  registerSandboxTools,
  type SandboxClient,
} from "./tools.ts";

export const SANDBOX_VERIFY_TOOLS_EVENT = "srt-tool-routing:verify-tools";
export const SANDBOX_BEFORE_USER_BASH_EVENT = "srt-tool-routing:before-user-bash";

interface SandboxEnvironment {
  PI_SRT_ROUTING?: string;
  // Compatibility only for already-running extension tests; the launcher sets
  // PI_SRT_ROUTING and never this legacy activation bit.
  PI_SRT_ROUTING_SANDBOX?: string;
  PI_SRT_ROUTING_STARTUP_DESCRIPTOR?: string;
  PI_SRT_ROUTING_SOCKET?: string;
  PI_SRT_ROUTING_LEASE?: string;
  // Non-secret PID of the host Pi process that may release this lease.
  PI_SRT_ROUTING_ROOT_OWNER_PID?: string;
  PI_SRT_ROUTING_WORKSPACE_KEY?: string;
  PI_SRT_ROUTING_WORKSPACE_ROOT?: string;
  PI_SRT_ROUTING_POLICY_GENERATION?: string;
  PI_SRT_ROUTING_IMAGE_GENERATION?: string;
  PI_SRT_ROUTING_VM_ID?: string;
  PI_SRT_ROUTING_BUILTIN_TOOLS?: string;
  PI_SRT_ROUTING_HOST_TOOLS?: string;
  PI_SRT_ROUTING_HANDSHAKE_FILE?: string;
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
    runtimeGeneration: string;
    adoptLease: boolean;
    renewalStartup?: any;
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
  if (!value || !/^[A-Za-z0-9+/=]+$/.test(value)) throw new Error("PI_SRT_ROUTING_STARTUP_DESCRIPTOR is missing or invalid");
  let descriptor: any;
  try { descriptor = JSON.parse(Buffer.from(value, "base64").toString("utf8")); } catch {
    throw new Error("PI_SRT_ROUTING_STARTUP_DESCRIPTOR is invalid JSON");
  }
  if (descriptor?.version !== 2 || !/^[0-9a-f]{64}$/.test(descriptor.workspaceKey) || !/^[0-9a-f]{64}$/.test(descriptor.token) || !/^[0-9a-f]{64}$/.test(descriptor.sourceDigest) ||
      typeof descriptor.workspaceRoot !== "string" || !path.isAbsolute(descriptor.workspaceRoot) ||
      typeof descriptor.runtimeRoot !== "string" || !path.isAbsolute(descriptor.runtimeRoot) ||
      typeof descriptor.socketPath !== "string" || !path.isAbsolute(descriptor.socketPath) ||
      typeof descriptor.manifestPath !== "string" || !path.isAbsolute(descriptor.manifestPath) ||
      typeof descriptor.capabilityPath !== "string" || !path.isAbsolute(descriptor.capabilityPath) ||
      (descriptor.startupPid !== undefined && descriptor.startupPid !== null &&
        (!Number.isSafeInteger(descriptor.startupPid) || descriptor.startupPid < 1))) {
    throw new Error("PI_SRT_ROUTING_STARTUP_DESCRIPTOR has an invalid shape");
  }
  return descriptor;
}

export function parseRequestedBuiltins(value: string | undefined): string[] {
  if (value === undefined) return [...SRT_ROUTING_BUILTIN_NAMES];
  if (value === "") return [];
  const requested = value.split(",").filter(Boolean);
  const unknown = requested.filter(
    (name) => !SRT_ROUTING_BUILTIN_NAMES.includes(name as (typeof SRT_ROUTING_BUILTIN_NAMES)[number]),
  );
  if (unknown.length > 0) throw new Error(`Unknown requested SRT tool routing built-ins: ${unknown.join(", ")}`);
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
  "PI_SRT_ROUTING_SOCKET", "PI_SRT_ROUTING_LEASE", "PI_SRT_ROUTING_ROOT_OWNER_PID",
  "PI_SRT_ROUTING_WORKSPACE_KEY", "PI_SRT_ROUTING_WORKSPACE_ROOT", "PI_SRT_ROUTING_POLICY_GENERATION",
  "PI_SRT_ROUTING_IMAGE_GENERATION", "PI_SRT_ROUTING_VM_ID",
] as const;

function traceStartup(phase: string): void {
  const filePath = process.env.PI_SRT_ROUTING_STARTUP_TRACE_FILE;
  if (!filePath || !path.isAbsolute(filePath) || /[\t\r\n\0]/.test(filePath)) return;
  try {
    fs.appendFileSync(filePath, `${JSON.stringify({ phase, at: Date.now() })}\n`, { mode: 0o600 });
  } catch {
    // Benchmark diagnostics must not affect routing readiness.
  }
}

export function createSrtToolRoutingSandboxExtension(dependencies: ExtensionDependencies = {}) {
  const env = dependencies.env ?? (process.env as SandboxEnvironment);
  const connect =
    dependencies.connect ??
    ((options) => ControllerClient.connectInherited(options) as Promise<{ client: SandboxClient; status: any }>);
  const acquire = dependencies.acquire ?? ((options) => acquireControllerLease(options) as Promise<any>);

  return function srtRoutingSandboxExtension(pi: ExtensionAPI): void {
    if (env.PI_SRT_ROUTING !== "1" && env.PI_SRT_ROUTING_SANDBOX !== "1") return;

    const cwd = process.cwd();
    let client: (SandboxClient & { destroy?: () => void; release?: () => Promise<void> }) | null = null;
    let connectedStatus: any = null;
    let fatalError: string | null = null;
    let permittedNames = new Set<string>();
    let statusTimer: NodeJS.Timeout | null = null;
    let lastContext: ExtensionContext | null = null;
    let readiness: Promise<void> | null = null;
    let acquisitionAbort: AbortController | null = null;
    let fallbackNoticeVmId: string | null = null;
    let rootStartup: any = null;
    let ownsRootLease = false;
    let released = false;
    let retired = false;
    const clearCapabilityEnvironment = (): void => {
      for (const name of CAPABILITY_ENV_FIELDS) delete env[name];
    };
    const manifest = createHostAdapterManifest({ agentDir: dependencies.auditOptions?.agentDir });
    const getClient = (): SandboxClient => {
      if (!client || fatalError) {
        throw new Error(fatalError ?? "SRT tool routing controller handshake has not completed");
      }
      return client;
    };

    registerSandboxTools(pi, { cwd, getClient });

    const verifyInventory = () =>
      verifyToolInventory(configuredTools(pi), {
        manifest,
        extensionPath: dependencies.auditOptions?.extensionPath,
        agentDir: dependencies.auditOptions?.agentDir,
      });

    const emitLifecycle = (event: SandboxLifecycleEvent, ctx = lastContext): void => {
      pi.events.emit(SANDBOX_LIFECYCLE_EVENT, event);
      if (!ctx?.hasUI) return;
      const marker =
        event.health === "healthy"
          ? ctx.ui.theme.fg("success", `sandbox:${event.sidecarId?.slice(0, 8) ?? "ready"}`)
          : event.health === "failed"
            ? ctx.ui.theme.fg("error", "sandbox:failed")
            : ctx.ui.theme.fg("warning", `sandbox:${event.health}`);
      ctx.ui.setStatus("srt-tool-routing", marker);
    };

    const publishStatus = (status: any, ctx = lastContext): void => {
      connectedStatus = status;
      emitLifecycle(lifecycleFromStatus(status), ctx);
      if (ctx?.hasUI && typeof status?.sidecarId === "string" && status.sidecarId !== fallbackNoticeVmId) {
        fallbackNoticeVmId = status.sidecarId;
        const fallbacks = (status?.ingress?.listeners ?? []).filter((listener: any) => listener?.fallback === true);
        if (fallbacks.length > 0) {
          ctx.ui.notify(
            `Ingress port fallback: ${fallbacks.map((listener: any) => `${listener.name} → ${listener.url} (preferred ${listener.preferredPort})`).join(", ")}`,
            "warning",
          );
        }
      }
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
        sidecarId: connectedStatus?.sidecarId ?? null,
        dockerHealthy: false,
        attachedRoots: connectedStatus?.attachedRoots ?? 0,
        policyGeneration: connectedStatus?.policyGeneration ?? null,
        runtimeGeneration: connectedStatus?.runtimeGeneration ?? null,
        pendingRestart: false,
        failure: reason,
      }, ctx);
      if (ctx?.hasUI) ctx.ui.notify(`SRT tool routing failed closed: ${reason}`, "error");
      writeHandshake(env.PI_SRT_ROUTING_HANDSHAKE_FILE, { ok: false, error: reason });
      ctx?.shutdown();
    };

    const enforceInventory = (ctx?: ExtensionContext, result = verifyInventory()): void => {
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
      const result = verifyInventory();
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
      const requested = parseRequestedBuiltins(env.PI_SRT_ROUTING_BUILTIN_TOOLS);
      const requestedHostTools = parseRequestedHostTools(env.PI_SRT_ROUTING_HOST_TOOLS, manifest.keys());
      const inherited = env.PI_SRT_ROUTING_LEASE !== undefined;
      // Only a replacement runtime in this same host process can adopt the
      // release duty. Child Pi processes inherit the marker but have another PID.
      const adoptRootLease = inherited && env.PI_SRT_ROUTING_ROOT_OWNER_PID === String(process.pid);
      acquisitionAbort = new AbortController();
      connectedStatus = {
        health: "starting", sidecarId: null, dockerHealthy: false, attachedRoots: 0,
        policyGeneration: null, runtimeGeneration: null, pendingRestart: false,
      };
      emitLifecycle(lifecycleFromStatus(connectedStatus), ctx);
      readiness = (async () => {
        try {
          traceStartup("routing_connection_audit_start");
          let connected: any;
          let workspaceKey: string;
          let workspaceRoot: string;
          if (inherited) {
            const socketPath = requiredString(env.PI_SRT_ROUTING_SOCKET, "PI_SRT_ROUTING_SOCKET");
            const leaseToken = requiredHex(env.PI_SRT_ROUTING_LEASE, "PI_SRT_ROUTING_LEASE");
            workspaceKey = requiredHex(env.PI_SRT_ROUTING_WORKSPACE_KEY, "PI_SRT_ROUTING_WORKSPACE_KEY");
            workspaceRoot = requiredString(env.PI_SRT_ROUTING_WORKSPACE_ROOT, "PI_SRT_ROUTING_WORKSPACE_ROOT");
            const renewalStartup = adoptRootLease
              ? parseStartupDescriptor(env.PI_SRT_ROUTING_STARTUP_DESCRIPTOR)
              : undefined;
            connected = await connect({
              socketPath, leaseToken, workspaceKey, workspaceRoot,
              policyGeneration: requiredHex(env.PI_SRT_ROUTING_POLICY_GENERATION, "PI_SRT_ROUTING_POLICY_GENERATION"),
              runtimeGeneration: requiredHex(env.PI_SRT_ROUTING_IMAGE_GENERATION, "PI_SRT_ROUTING_IMAGE_GENERATION"),
              adoptLease: adoptRootLease,
              renewalStartup,
            });
          } else {
            const startup = parseStartupDescriptor(env.PI_SRT_ROUTING_STARTUP_DESCRIPTOR);
            rootStartup = startup;
            workspaceKey = startup.workspaceKey;
            workspaceRoot = startup.workspaceRoot;
            connected = await acquire({ startup, clientId: `pi-${process.pid}`, signal: acquisitionAbort!.signal });
            ownsRootLease = true;
          }
          if (retired) {
            connected.client.destroy?.();
            throw new Error("SRT tool routing runtime retired during startup");
          }
          client = connected.client;
          ownsRootLease = !inherited || adoptRootLease;
          const status = connected.status;
          if (status.workspaceKey !== workspaceKey || status.workspaceRoot !== workspaceRoot ||
              status.health !== "healthy" ||
              !((status.sidecarId === null && status.dockerHealthy === false) || (typeof status.sidecarId === "string" && status.dockerHealthy === true)) ||
              !/^[0-9a-f]{64}$/.test(status.policyGeneration) || !/^[0-9a-f]{64}$/.test(status.runtimeGeneration)) {
            throw new Error("SRT tool routing controller status does not match the requested workspace");
          }
          const result = verifyInventory();
          if (result.replacementErrors.length > 0) throw new Error(result.replacementErrors.join("; "));
          const missingHostTools = requestedHostTools.filter((name) => !result.allowedNames.has(name));
          if (missingHostTools.length > 0) throw new Error(`Requested host adapters are missing or have untrusted provenance: ${missingHostTools.join(", ")}`);
          permittedNames = new Set([...requested, ...requestedHostTools]);
          pi.setActiveTools([...permittedNames]);
          enforceInventory(ctx, result);
          if (!inherited) {
            env.PI_SRT_ROUTING_SOCKET = connected.manifest.socketPath;
            env.PI_SRT_ROUTING_LEASE = connected.leaseToken;
            env.PI_SRT_ROUTING_ROOT_OWNER_PID = String(process.pid);
            env.PI_SRT_ROUTING_WORKSPACE_KEY = workspaceKey;
            env.PI_SRT_ROUTING_WORKSPACE_ROOT = workspaceRoot;
            env.PI_SRT_ROUTING_POLICY_GENERATION = status.policyGeneration;
            env.PI_SRT_ROUTING_IMAGE_GENERATION = status.runtimeGeneration;
            // A sidecar is intentionally lazy and therefore has no capability
            // field before the first Docker connection.
            delete env.PI_SRT_ROUTING_VM_ID;
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
          writeHandshake(env.PI_SRT_ROUTING_HANDSHAKE_FILE, {
            ok: true, workspaceKey, workspaceRoot, policyGeneration: status.policyGeneration,
            runtimeGeneration: status.runtimeGeneration, sidecarId: status.sidecarId, dockerHealthy: status.dockerHealthy,
            tools: [...SRT_ROUTING_BUILTIN_NAMES],
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
          (isSrtToolRoutingReplacement(tool, dependencies.auditOptions) ||
            isTrustedHostAdapter(tool, manifest)),
      );
      if (!allowed) {
        return {
          block: true,
          terminate: true,
          reason: `Tool '${event.toolName}' is not a trusted SRT tool-routing replacement or host adapter.`,
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
            output: fatalError ?? "SRT tool routing controller startup failed.", exitCode: 126,
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
        sidecarId: connectedStatus?.sidecarId ?? null,
        dockerHealthy: false,
        attachedRoots: 0,
        policyGeneration: connectedStatus?.policyGeneration ?? null,
        runtimeGeneration: connectedStatus?.runtimeGeneration ?? null,
        pendingRestart: false,
      }, ctx);
      connectedStatus = null;
      lastContext = null;
      if (ctx.hasUI) ctx.ui.setStatus("srt-tool-routing", undefined);
    });

    pi.registerCommand("sandbox", {
      description: "Show shared SRT tool routing sandbox status",
      handler: async (_args, ctx) => {
        if (!client || fatalError) {
          ctx.ui.notify(fatalError ?? "SRT tool routing is starting; status is available after readiness.", fatalError ? "error" : "info");
          return;
        }
        try {
          publishStatus(await showSandboxStatus(ctx, client), ctx);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      },
    });

    pi.registerCommand("srt-routing-status", {
      description: "Show the active shared SRT tool routing controller status",
      handler: async (_args, ctx) => {
        if (!connectedStatus) {
          ctx.ui.notify(fatalError ?? "SRT tool routing is not connected.", "error");
          return;
        }
        ctx.ui.notify(
          [
            `Health: ${connectedStatus.health ?? "healthy"}`,
            `Sidecar: ${connectedStatus.sidecarId ?? "not created"}`,
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

export default createSrtToolRoutingSandboxExtension();
