export const SANDBOX_LIFECYCLE_EVENT = "srt-tool-routing:lifecycle";

export type SandboxHealth = "starting" | "healthy" | "restarting" | "failed" | "stopped";

export interface SandboxLifecycleEvent {
  health: SandboxHealth;
  // Execution authority is separate from controller/sidecar health.
  mode?: "on" | "off";
  blockedReason?: string | null;
  sidecarId: string | null;
  dockerHealthy: boolean;
  attachedRoots: number;
  policyGeneration: string | null;
  runtimeGeneration: string | null;
  pendingRestart: boolean;
  failure?: string | null;
}

export function lifecycleFromStatus(status: any): SandboxLifecycleEvent {
  return {
    health: status?.health ?? "failed",
    mode: status?.mode === "off" ? "off" : "on",
    blockedReason: typeof status?.blockedReason === "string" ? status.blockedReason : null,
    sidecarId: typeof status?.sidecarId === "string" ? status.sidecarId : null,
    dockerHealthy: status?.dockerHealthy === true,
    attachedRoots: Number.isInteger(status?.attachedRoots) ? status.attachedRoots : 0,
    policyGeneration: typeof status?.policyGeneration === "string" ? status.policyGeneration : null,
    runtimeGeneration: typeof status?.runtimeGeneration === "string" ? status.runtimeGeneration : null,
    pendingRestart: status?.pendingRestart === true,
    failure: typeof status?.failure === "string" ? status.failure : null,
  };
}
