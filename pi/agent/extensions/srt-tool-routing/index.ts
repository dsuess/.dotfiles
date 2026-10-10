import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createMcpExtension, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installReviewedMcp } from "./routed-mcp.mjs";
import { SERENA_INSPECTION_TOOLS } from "./serena-profile.mjs";

import { acquireControllerLease, ControllerClient, stopStartedController } from "../../../sandbox/client.mjs";
import { createFilesystemConfigurationService } from "../../../sandbox/filesystem-configuration.mjs";
import { createClientPolicyService, takeReloadPolicy, retainReloadPolicy } from "./policy-service.mjs";
import {
  createHostAdapterManifest,
  isSrtToolRoutingReplacement,
  isRoutingExtensionSource,
  isTrustedHostAdapter,
  verifyToolInventory,
  type ConfiguredToolInfo,
} from "./host-adapters.ts";
import {
  lifecycleFromStatus,
  SANDBOX_LIFECYCLE_EVENT,
  type SandboxLifecycleEvent,
} from "./events.ts";
import { compactSandboxStatus, formatSandboxStatus, formatSandboxGrants, SANDBOX_OFF_LABEL, SANDBOX_OFF_WARNING } from "./status-view.ts";
import { createSandboxCommand, type SandboxCommandMessage } from "./command-ui.ts";
import {
  createModeBashOperations,
  SRT_ROUTING_BUILTIN_NAMES,
  registerSandboxTools,
  type SandboxClient,
} from "./tools.ts";
import {
  ConversationMode,
  startConversationMode,
  retireConversationMode,
  type SandboxExecutionMode,
} from "./mode-state.ts";

/** Trusted command/policy integration only; never publish this service as a model tool. */
export interface RoutingControl {
  getMode(): { mode: SandboxExecutionMode; blockedReason: string | null };
  assertIdle(ctx: ExtensionContext): void;
  atIdle<T>(ctx: ExtensionContext, action: () => Promise<T>): Promise<T>;
  setMode(mode: SandboxExecutionMode, ctx: ExtensionContext): Promise<void>;
  setPolicyVerifier(verify: () => Promise<void>): void;
  blockSandbox(reason: string): void;
  getPolicyService(): RoutingPolicyService;
}

export interface RoutingPolicyService {
  status(): Promise<any>;
  listGrants(): Promise<any>;
  addGrant(access: "ro" | "rw", path: string, ctx: ExtensionContext): Promise<any>;
  removeGrant(path: string, ctx: ExtensionContext): Promise<any>;
  reloadGrants(ctx: ExtensionContext): Promise<any>;
}

export const SANDBOX_VERIFY_TOOLS_EVENT = "srt-tool-routing:verify-tools";
export const SANDBOX_BEFORE_USER_BASH_EVENT = "srt-tool-routing:before-user-bash";
export const SANDBOX_PLANNING_TOOLS_EVENT = "srt-tool-routing:planning-tools";
export const PLANNING_GUARD_QUERY_EVENT = "plan-mode:query-mutation-guard";

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
    effectiveSnapshot?: any;
  }) => Promise<{ client: SandboxClient & { destroy?: () => void; release?: () => Promise<void> }; status: any }>;
  acquire?: (options: { startup: any; clientId: string; signal: AbortSignal }) => Promise<{
    client: SandboxClient & { destroy?: () => void; release?: () => Promise<void>; onTerminal?: (listener: (error: Error) => void) => () => void; };
    status: any;
    leaseToken: string;
    scope: { workspaceKey: string; canonicalWorkspaceRoot: string };
    manifest: { socketPath: string };
  }>;
  auditOptions?: { extensionPath?: string; agentDir?: string };
  statusIntervalMs?: number;
  onControl?: (control: RoutingControl) => void;
  mcpApproval?: any;
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
    let client: (SandboxClient & { destroy?: () => void; release?: () => Promise<void>; onTerminal?: (listener: (error: Error) => void) => () => void; }) | null = null;
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
    let mode = new ConversationMode();
    let sessionManager: object | undefined;
    let startupReady = false;
    let verifyEffectivePolicy: () => Promise<void> = async () => {};
    let policyService: ReturnType<typeof createClientPolicyService> | null = null;
    let retainedPolicy: any = undefined;
    let routedMcp: ReturnType<typeof installReviewedMcp> | null = null;
    const inspectionNames = new Set(SERENA_INSPECTION_TOOLS.map((name: string) => `mcp__serena__${name}`));
    const planningGuardActive = (): boolean => {
      const query = { active: false };
      pi.events.emit(PLANNING_GUARD_QUERY_EVENT, query);
      return query.active;
    };
    const isRoutedMcp = (tool: ConfiguredToolInfo): boolean => Boolean(
      routedMcp?.isAdmitted(tool) && isRoutingExtensionSource(tool.sourceInfo, dependencies.auditOptions),
    );
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

    const verifyInventory = () => {
      routedMcp?.validateCurrent();
      return verifyToolInventory(configuredTools(pi), {
        manifest, isRoutedMcp,
        extensionPath: dependencies.auditOptions?.extensionPath,
        agentDir: dependencies.auditOptions?.agentDir,
      });
    };
    const refreshMcpPermission = (): void => {
      for (const tool of configuredTools(pi)) {
        if (isRoutedMcp(tool) && startupReady && !fatalError && !retired) permittedNames.add(tool.name);
        else if (tool.name.startsWith("mcp__")) permittedNames.delete(tool.name);
      }
    };
    const prepareLoadout = (loadout: any) => {
      const inventory = verifyInventory();
      return { hiddenDeclarations: loadout.declared.map((tool: any) => tool.name)
        .filter((name: string) => !inventory.allowedNames.has(name) || !permittedNames.has(name)) };
    };
    const coreFacade = Object.create(pi);
    coreFacade.registerTool = (definition: any) => pi.registerTool({ ...definition, prepareLoadout });
    registerSandboxTools(coreFacade, { cwd, getClient, execution: { run: (operation) => mode.run(operation) } });

    const emitLifecycle = (event: SandboxLifecycleEvent, ctx = lastContext): void => {
      const execution = mode.snapshot();
      event = { ...event, mode: execution.mode, blockedReason: execution.blockedReason };
      pi.events.emit(SANDBOX_LIFECYCLE_EVENT, event);
      if (!ctx?.hasUI) return;
      const compact = compactSandboxStatus(event);
      ctx.ui.setStatus("srt-tool-routing", ctx.ui.theme.fg(compact.color, compact.label));
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

    const failClosed = (ctx: ExtensionContext | undefined, reason: string, controllerFailure = false): void => {
      if (retired || (fatalError && controllerFailure)) return;
      fatalError = reason;
      const deliberatelyOff = controllerFailure && mode.snapshot().mode === "off";
      const activeClient = client;
      client = null;
      if (!deliberatelyOff) pi.setActiveTools([]);
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
      if (!deliberatelyOff) ctx?.shutdown();
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
      routedMcp?.syncDeclarations();
      refreshMcpPermission();
      const result = verifyInventory();
      pi.setActiveTools(
        pi
          .getActiveTools()
          .filter((name) => result.allowedNames.has(name) && permittedNames.has(name)),
      );
      if (result.replacementErrors.length > 0) payload.error = result.replacementErrors.join("; ");
    });

    pi.events.on(SANDBOX_PLANNING_TOOLS_EVENT, (payload: any) => {
      const inventory = verifyInventory();
      payload.names = [...inspectionNames].filter((name) => routedMcp?.isInspection(name) && inventory.allowedNames.has(name) && permittedNames.has(name));
    });

    const startReadiness = (ctx: ExtensionContext): Promise<void> => {
      if (readiness) return readiness;
      lastContext = ctx;
      permittedNames = new Set();
      pi.setActiveTools([]);
      const requested = parseRequestedBuiltins(env.PI_SRT_ROUTING_BUILTIN_TOOLS);
      const requestedHostTools = parseRequestedHostTools(env.PI_SRT_ROUTING_HOST_TOOLS, manifest.keys());
      if (mode.snapshot().mode === "off") {
        // A retained explicit choice remains usable if the controller died during
        // reload. Audit replacements first; this is never a health-based fallback.
        const inventory = verifyInventory();
        const missing = requestedHostTools.filter((name) => !inventory.allowedNames.has(name));
        if (inventory.replacementErrors.length > 0 || missing.length > 0) {
          const reason = [...inventory.replacementErrors, ...missing.map((name) => `Untrusted host adapter: ${name}`)].join("; ");
          failClosed(ctx, reason);
          return Promise.reject(new Error(reason));
        }
        permittedNames = new Set([...requested, ...requestedHostTools]);
        pi.setActiveTools([...permittedNames]);
        enforceInventory(ctx, inventory);
      }
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
              ...(retainedPolicy ? { effectiveSnapshot: retainedPolicy.effective } : {}),
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
          const activeClient = client;
          activeClient.onTerminal?.((error) => {
            if (!retired && !fatalError && client === activeClient) {
              failClosed(lastContext ?? undefined, error.message, true);
            }
          });
          let status = connected.status;
          // Production clients always provide this API; dependency-injected tool
          // spies may intentionally implement only the execution interface.
          if (typeof (activeClient as any).preparePolicy === "function") {
            policyService = createClientPolicyService({ client: activeClient,
              configuration: createFilesystemConfigurationService({ home: os.homedir(), workspaceRoot,
                controllerRoot: path.dirname(requiredString(env.PI_SRT_ROUTING_SOCKET ?? connected.manifest?.socketPath, "controller socket")) }),
              control, publish: (next: any) => publishStatus(next),
            });
            await policyService.restore(retainedPolicy);
            verifyEffectivePolicy = policyService.verify;
            status = await policyService.status();
          }
          if (status.workspaceKey !== workspaceKey || status.workspaceRoot !== workspaceRoot ||
              status.health !== "healthy" ||
              !((status.sidecarId === null && status.dockerHealthy === false) || (typeof status.sidecarId === "string" && status.dockerHealthy === true)) ||
              !/^[0-9a-f]{64}$/.test(status.policyGeneration) || !/^[0-9a-f]{64}$/.test(status.runtimeGeneration)) {
            throw new Error("SRT tool routing controller status does not match the requested workspace");
          }
          const result = verifyInventory();
          if (result.replacementErrors.length > 0) {
            const reason = result.replacementErrors.join("; ");
            failClosed(ctx, reason);
            throw new Error(reason);
          }
          const missingHostTools = requestedHostTools.filter((name) => !result.allowedNames.has(name));
          if (missingHostTools.length > 0) {
            const reason = `Requested host adapters are missing or have untrusted provenance: ${missingHostTools.join(", ")}`;
            failClosed(ctx, reason);
            throw new Error(reason);
          }
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
          startupReady = true;
          publishStatus(status, ctx);
          traceStartup("routing_connection_audit_complete");
          if (statusTimer) clearInterval(statusTimer);
          statusTimer = setInterval(() => {
            const activeClient = client as any;
            if (!activeClient || fatalError || retired) return;
            void (policyService ? policyService.status() : activeClient.status()).then((next: any) => {
              if (!retired && client === activeClient) publishStatus(next);
            }).catch((error: unknown) => {
              if (!retired && client === activeClient) {
                failClosed(lastContext ?? undefined, error instanceof Error ? error.message : String(error), true);
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
          failClosed(ctx, reason, true);
          throw error;
        }
      })();
      return readiness;
    };

    const control: RoutingControl = {
      getMode: () => mode.snapshot(),
      getPolicyService: () => {
        if (!policyService || fatalError) throw new Error(fatalError ?? "Sandbox policy is not ready");
        return policyService;
      },
      assertIdle: (ctx) => mode.assertIdle(() => ctx.isIdle?.() ?? true),
      atIdle: (ctx, action) => mode.atIdle(() => ctx.isIdle?.() ?? true, action),
      setPolicyVerifier: (verify) => { verifyEffectivePolicy = verify; },
      blockSandbox: (reason) => mode.blockSandbox(reason),
      async setMode(next, ctx) {
        mode.assertIdle(() => ctx.isIdle?.() ?? true);
        // An explicit off choice cannot bypass the normal launch handshake.
        if (next === "off" && !startupReady && mode.snapshot().mode !== "off") {
          await readiness;
          if (!startupReady) throw new Error(fatalError ?? "Sandbox startup is not ready");
        }
        await mode.switchMode(next, () => ctx.isIdle?.() ?? true, async () => {
          await readiness;
          const activeClient = getClient() as SandboxClient & { status(): Promise<any> };
          const status = await activeClient.status();
          if (status.health !== "healthy" ||
              !((status.sidecarId === null && status.dockerHealthy === false) ||
                (typeof status.sidecarId === "string" && status.dockerHealthy === true)) ||
              !/^[0-9a-f]{64}$/.test(status.policyGeneration) || !/^[0-9a-f]{64}$/.test(status.runtimeGeneration) ||
              status.workspaceKey !== connectedStatus?.workspaceKey ||
              status.workspaceRoot !== connectedStatus?.workspaceRoot ||
              status.policyGeneration !== activeClient.policyGeneration ||
              status.runtimeGeneration !== connectedStatus?.runtimeGeneration) {
            throw new Error("SRT tool routing readiness or effective policy does not match this client");
          }
          await verifyEffectivePolicy();
          enforceInventory(ctx);
          publishStatus(policyService ? await policyService.status() : status, ctx);
        });
      },
    };
    dependencies.onControl?.(control);

    pi.on("session_start", async (event, ctx) => {
      sessionManager = ctx.sessionManager;
      mode = await startConversationMode(sessionManager, event.reason);
      retainedPolicy = takeReloadPolicy(sessionManager, event.reason);
      // A retained off choice was already authorized after a successful normal
      // launch; a failed re-enable must not prevent an explicit return to off.
      startupReady = mode.snapshot().mode === "off";
      traceStartup("pi_initialize_complete");
      if (ctx.hasUI) traceStartup("host_ui_ready");
      const pending = startReadiness(ctx);
      if (!ctx.hasUI) return pending;
      void pending.catch(() => {});
    });

    routedMcp = installReviewedMcp(pi, {
      factory: createMcpExtension,
      approval: dependencies.mcpApproval,
      prepareLoadout,
      canDeclare: (_name: string, reviewedInspection: boolean) => !planningGuardActive() || reviewedInspection,
      onToolsChanged: () => {
        refreshMcpPermission();
        if (startupReady && !retired) {
          enforceInventory(lastContext ?? undefined);
          pi.setActiveTools(pi.getActiveTools()); // Refresh declaration projection, never restore a broader loadout.
        }
      },
      connect: async () => {
        await readiness;
        if (!startupReady || retired) throw new Error("Routed MCP requires a ready current-client sandbox policy");
        return getClient();
      },
    });

    pi.on("input", async () => {
      try {
        mode.assertExecutable();
        if (mode.snapshot().mode === "on") { await readiness; getClient(); }
        enforceInventory(lastContext ?? undefined);
        return { action: "continue" };
      } catch {
        // Pi catches input-event errors and would continue the submission. A
        // handled result is the fail-closed boundary for queued prompts.
        return { action: "handled" };
      }
    });

    pi.on("before_agent_start", async () => {
      mode.assertExecutable();
      if (mode.snapshot().mode === "on") { await readiness; getClient(); }
      await routedMcp?.ensureConnected(lastContext);
      enforceInventory(lastContext ?? undefined);
    });

    pi.on("turn_start", () => { enforceInventory(lastContext ?? undefined); });
    pi.on("agent_start", () => { mode.agentStarted(); });
    pi.on("agent_end", () => { mode.agentEnded(); });
    pi.on("tool_execution_start", (event) => { mode.toolStarted(event.toolCallId); });
    pi.on("tool_execution_end", (event) => { mode.toolEnded(event.toolCallId); });

    pi.on("tool_call", async (event) => {
      try { mode.assertExecutable(); }
      catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
      routedMcp?.validateCurrent();
      refreshMcpPermission();
      const tool = configuredTools(pi).find((candidate) => candidate.name === event.toolName);
      const allowed = Boolean(
        tool &&
          permittedNames.has(event.toolName) &&
          (isSrtToolRoutingReplacement(tool, dependencies.auditOptions) ||
            isTrustedHostAdapter(tool, manifest) || isRoutedMcp(tool)),
      );
      if (!allowed) {
        return {
          block: true,
          terminate: true,
          reason: `Tool '${event.toolName}' is not a trusted SRT tool-routing replacement, host adapter, or live routed MCP tool.`,
        };
      }
    });

    pi.on("user_bash", async (event) => {
      const gate = { command: event.command, result: undefined as any };
      pi.events.emit(SANDBOX_BEFORE_USER_BASH_EVENT, gate);
      if (gate.result) return gate.result;
      try {
        mode.assertExecutable();
        if (mode.snapshot().mode === "on") { await readiness; getClient(); }
      } catch (error) {
        return {
          result: {
            output: error instanceof Error ? error.message : (fatalError ?? "SRT tool routing controller startup failed."), exitCode: 126,
            cancelled: false, truncated: false,
          },
        };
      }
      return { operations: createModeBashOperations(getClient, mode.reserve()) };
    });

    pi.on("session_shutdown", async (event, ctx) => {
      await routedMcp?.close();
      retainReloadPolicy(sessionManager, event.reason, policyService?.retention());
      retireConversationMode(mode, sessionManager, event.reason);
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

    const report = (result: SandboxCommandMessage, ctx: ExtensionContext): void => {
      if (result.level === "error") emitLifecycle(lifecycleFromStatus(connectedStatus), ctx);
      if (ctx.hasUI) ctx.ui.notify(result.message, result.level ?? "info");
      else pi.sendMessage({ customType: "sandbox-status", content: result.message, display: true }, { triggerTurn: false });
    };
    const readStatus = async (ctx: ExtensionContext, grantsOnly = false): Promise<any> => {
      let status = connectedStatus ?? { health: "starting", workspaceRoot: ctx.cwd };
      if (client && !fatalError) {
        try {
          status = policyService
            ? await control.getPolicyService()[grantsOnly ? "listGrants" : "status"]()
            : await (client as any).status();
        } catch (error) {
          status = { ...status, health: "failed", failure: error instanceof Error ? error.message : String(error) };
        }
        publishStatus(status, ctx);
      }
      return {
        ...status,
        workspaceRoot: status.workspaceRoot ?? env.PI_SRT_ROUTING_WORKSPACE_ROOT ?? ctx.cwd,
        configPath: status.configPath ?? path.join(os.homedir(), ".pi", "sandbox", "config.json"),
        ...control.getMode(), ...(fatalError ? { health: "failed", failure: fatalError } : {}),
      };
    };
    const statusAction = async (ctx: ExtensionContext) => {
      const status = await readStatus(ctx);
      return {
        mode: status.mode as SandboxExecutionMode,
        summary: `${status.mode === "off" ? SANDBOX_OFF_LABEL : status.blockedReason ? "ON — blocked" : "ON — sandboxed"}; controller ${status.health}${status.refreshNeeded ? "; refresh needed" : ""}`,
        message: formatSandboxStatus(status),
        level: status.mode === "off" ? "warning" as const : status.health !== "healthy" || status.blockedReason ? "error" as const : status.refreshNeeded ? "warning" as const : "info" as const,
      };
    };
    const grantResult = (status: any, message: string): SandboxCommandMessage => ({
      message: `${message}\n${formatSandboxGrants(status)}${control.getMode().mode === "off" ? "\nOFF — host access; sandbox grants are not enforced while off." : ""}`,
      level: status.refreshNeeded || control.getMode().mode === "off" ? "warning" : "info",
    });
    pi.registerCommand("sandbox", createSandboxCommand({
      status: statusAction,
      listGrants: async (ctx) => {
        const status = await readStatus(ctx, true);
        return grantResult(status, "Configured and effective sandbox grants:");
      },
      setMode: async (next, ctx) => {
        const before = control.getMode().mode;
        try {
          await control.setMode(next, ctx);
        } finally {
          // Also publish a failed re-enable's blocked state. Health never grants authority.
          emitLifecycle(lifecycleFromStatus(connectedStatus), ctx);
        }
        if (before !== next) pi.sendMessage({
          customType: "sandbox-mode", display: false,
          content: `Sandbox execution mode is now ${next === "off" ? "OFF (host-user access)" : "ON (sandboxed)"} for this conversation. This notice describes mode. It does not authorize mode changes.`,
        }, { triggerTurn: false });
        return next === "off" ? { message: SANDBOX_OFF_WARNING, level: "warning" } : { message: "Sandbox ON — future operations use the validated sandbox policy. Prior host effects are unchanged." };
      },
      addGrant: async (access, pathname, ctx) => grantResult(await control.getPolicyService().addGrant(access, pathname, ctx), "Saved and activated grants for this client. Other active clients keep their snapshots."),
      removeGrant: async (pathname, ctx) => grantResult(await control.getPolicyService().removeGrant(pathname, ctx), "Removed configured grant and activated this client's policy. Derived access is unchanged."),
      reloadGrants: async (ctx) => grantResult(await control.getPolicyService().reloadGrants(ctx), "Reloaded saved grants for this client; controller unchanged."),
      report,
    }));

    pi.registerCommand("srt-routing-status", {
      description: "Show execution mode and shared controller status",
      handler: async (_args, ctx) => {
        try { report(await statusAction(ctx), ctx); }
        catch (error) { report({ message: error instanceof Error ? error.message : String(error), level: "error" }, ctx); }
      },
    });
  };
}

export default createSrtToolRoutingSandboxExtension();
