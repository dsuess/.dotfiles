import type { SandboxLifecycleEvent } from "./events.ts";

export const SANDBOX_OFF_LABEL = "OFF — host access";
export const SANDBOX_OFF_WARNING = "Sandbox OFF — host access. Tools can access host-user files, credentials, and Docker with your OS permissions. Other clients remain sandboxed. Sandbox ON affects future operations only. It cannot undo host effects or stop escaped background processes.";

function text(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && value ? value : fallback;
}

function generation(value: unknown): string {
  return typeof value === "string" && value ? value.slice(0, 12) : "unknown";
}

function filesystemGrants(label: string, value: unknown): string[] {
  const grants = Array.isArray(value) ? value
    .filter((grant): grant is { path: string; access: string } => Boolean(grant && typeof grant.path === "string" && ["ro", "rw"].includes(grant.access)))
    .map((grant) => `  ${grant.access === "rw" ? "read-write" : "read-only"}: ${grant.path}`) : [];
  return grants.length ? [`${label}:`, ...grants] : [`${label}: none`];
}

export function formatSandboxGrants(status: any): string {
  return [
    `Config: ${text(status?.configPath)}`,
    `Saved revision: ${text(status?.savedRevision)}`,
    `Effective revision: ${text(status?.effectiveRevision)}`,
    `Refresh needed: ${status?.refreshNeeded ? "yes — use /sandbox reload" : "no"}`,
    ...(status?.savedError ? [`Saved configuration error: ${status.savedError}`] : []),
    ...(status?.blockedReason ? [`Sandbox execution blocked: ${status.blockedReason}`] : []),
    ...filesystemGrants("Configured grants", status?.configuredGrants),
    ...filesystemGrants("Effective grants (sandbox policy snapshot)", status?.filesystemGrants),
    "Derived access (not editable grants): workspace and tool/runtime policy. Removing a configured grant does not revoke derived access.",
  ].join("\n");
}

export function formatSandboxStatus(status: any): string {
  const off = status?.mode === "off";
  const hasSidecar = typeof status?.sidecarId === "string" && status.sidecarId.length > 0;
  const docker = hasSidecar || status?.dockerHealthy === true ? (status?.dockerHealthy === true ? "healthy" : "unhealthy") : "not created";
  return [
    `Execution: ${off ? SANDBOX_OFF_LABEL : "ON — sandboxed"}`,
    ...(off ? ["Sandbox grants are not enforced while off."] : []),
    `Health: ${text(status?.health)}`,
    ...(status?.failure ? [`Controller failure: ${status.failure}`] : []),
    `Workspace: ${text(status?.workspaceRoot)}`,
    `Attached clients: ${Number.isInteger(status?.attachedRoots) ? status.attachedRoots : 0}`,
    `Policy generation: ${generation(status?.policyGeneration)}`,
    `Runtime generation: ${generation(status?.runtimeGeneration)}`,
    formatSandboxGrants(status),
    `Broker: ${status?.brokerHealthy === true ? "healthy" : "unavailable"}`,
    `Sidecar: ${hasSidecar ? status.sidecarId.slice(0, 12) : "not created"}`,
    `Docker selection: ${off ? "host Docker (ordinary host context; health not checked)" : "private sandbox broker"}`,
    `Private Docker health: ${docker}${off ? " (not selected)" : ""}`,
    "Manage persistent Docker state with pi-sbx.",
  ].join("\n");
}

/** Compact presentation only: execution authority takes precedence over health. */
export function compactSandboxStatus(status: Pick<SandboxLifecycleEvent, "mode" | "health" | "blockedReason">): {
  label: string;
  color: "success" | "error" | "warning";
} {
  if (status.mode === "off") return { label: "● sandbox: off — host access", color: "error" };
  if (status.blockedReason) return { label: "◌ sandbox: on — blocked", color: "error" };
  if (status.health === "failed") return { label: "◌ sandbox: on — failed", color: "error" };
  if (status.health === "healthy") return { label: "● sandbox: on", color: "success" };
  return { label: `◌ sandbox: on — ${status.health}`, color: "warning" };
}
