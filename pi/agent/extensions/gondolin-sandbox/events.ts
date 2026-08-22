export const SANDBOX_LIFECYCLE_EVENT = "gondolin-sandbox:lifecycle";

export type SandboxHealth = "starting" | "healthy" | "restarting" | "failed" | "stopped";

export interface SandboxLifecycleEvent {
  health: SandboxHealth;
  vmId: string | null;
  dockerHealthy: boolean;
  attachedRoots: number;
  policyGeneration: string | null;
  imageGeneration: string | null;
  pendingRestart: boolean;
  failure?: string | null;
}

export function lifecycleFromStatus(status: any): SandboxLifecycleEvent {
  return {
    health: status?.health ?? "failed",
    vmId: typeof status?.vmId === "string" ? status.vmId : null,
    dockerHealthy: status?.dockerHealthy === true,
    attachedRoots: Number.isInteger(status?.attachedRoots) ? status.attachedRoots : 0,
    policyGeneration: typeof status?.policyGeneration === "string" ? status.policyGeneration : null,
    imageGeneration: typeof status?.imageGeneration === "string" ? status.imageGeneration : null,
    pendingRestart: status?.pendingRestart === true,
    failure: typeof status?.failure === "string" ? status.failure : null,
  };
}
