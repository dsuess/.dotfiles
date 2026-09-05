import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

interface StatusClient {
  status(): Promise<any>;
}

function text(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && value ? value : fallback;
}

function generation(value: unknown): string {
  return typeof value === "string" && value ? value.slice(0, 12) : "unknown";
}

function filesystemGrants(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return ["Filesystem grants: none"];
  const grants = value
    .filter((grant): grant is { path: string; access: string } => Boolean(grant && typeof grant.path === "string" && ["ro", "rw"].includes(grant.access)))
    .map((grant) => `  ${grant.access === "rw" ? "read-write" : "read-only"}: ${grant.path}`);
  return grants.length ? ["Filesystem grants:", ...grants] : ["Filesystem grants: none"];
}

export function formatSandboxStatus(status: any): string {
  const hasSidecar = typeof status?.sidecarId === "string" && status.sidecarId.length > 0;
  return [
    `Health: ${text(status?.health)}`,
    `Workspace: ${text(status?.workspaceRoot)}`,
    `Attached clients: ${Number.isInteger(status?.attachedRoots) ? status.attachedRoots : 0}`,
    `Policy generation: ${generation(status?.policyGeneration)}`,
    `Runtime generation: ${generation(status?.runtimeGeneration)}`,
    ...filesystemGrants(status?.filesystemGrants),
    `Broker: ${status?.brokerHealthy === true ? "healthy" : "unavailable"}`,
    `Sidecar: ${hasSidecar ? status.sidecarId.slice(0, 12) : "not created"}`,
    `Docker: ${hasSidecar || status?.dockerHealthy === true ? (status?.dockerHealthy === true ? "healthy" : "unhealthy") : "not created"}`,
    "Manage persistent Docker state with pi-sbx.",
  ].join("\n");
}

export async function showSandboxStatus(
  ctx: ExtensionCommandContext,
  client: StatusClient,
): Promise<any> {
  const status = await client.status();
  ctx.ui.notify(
    formatSandboxStatus(status),
    status?.health === "healthy" ? "info" : "error",
  );
  return status;
}
