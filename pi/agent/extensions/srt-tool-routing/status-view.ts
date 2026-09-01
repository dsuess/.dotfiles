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

export function formatSandboxStatus(status: any): string {
  const hasSidecar = typeof status?.sidecarId === "string" && status.sidecarId.length > 0;
  return [
    `Health: ${text(status?.health)}`,
    `Workspace: ${text(status?.workspaceRoot)}`,
    `Attached clients: ${Number.isInteger(status?.attachedRoots) ? status.attachedRoots : 0}`,
    `Policy generation: ${generation(status?.policyGeneration)}`,
    `Runtime generation: ${generation(status?.runtimeGeneration)}`,
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
