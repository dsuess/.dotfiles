import {
  getSettingsListTheme,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SettingItem,
  SettingsList,
  Text,
} from "@earendil-works/pi-tui";

import {
  lifecycleFromStatus,
  type SandboxLifecycleEvent,
} from "./events.ts";
import {
  type SandboxSettings,
  SandboxSettingsStore,
  type TcpMappingSetting,
} from "./settings-store.ts";

interface SettingsClient {
  status(): Promise<any>;
  reload(expectedPolicyGeneration?: string): Promise<any>;
  restart(): Promise<any>;
  resetDocker(): Promise<any>;
}

interface SettingsAction {
  id: string;
  value: string;
}

function formatTcp(mapping: TcpMappingSetting): string {
  return `${mapping.guestHost}:${mapping.guestPort}=${mapping.connectHost}:${mapping.connectPort}`;
}

function parseTcpMappings(value: string): TcpMappingSetting[] {
  if (!value.trim()) return [];
  return value.split(",").map((raw, index) => {
    const entry = raw.trim();
    const [guest, connect, extra] = entry.split("=");
    if (!guest || !connect || extra !== undefined) {
      throw new Error(`TCP mapping ${index + 1} must be guest:port=host:port`);
    }
    const guestColon = guest.lastIndexOf(":");
    const connectColon = connect.lastIndexOf(":");
    if (guestColon < 1 || connectColon < 1) {
      throw new Error(`TCP mapping ${index + 1} must include both ports`);
    }
    return {
      guestHost: guest.slice(0, guestColon),
      guestPort: Number(guest.slice(guestColon + 1)),
      connectHost: connect.slice(0, connectColon),
      connectPort: Number(connect.slice(connectColon + 1)),
    };
  });
}

function buildItems(settings: SandboxSettings, status: any): SettingItem[] {
  const workspaceAccess = status.mounts?.find((mount: any) => mount.kind === "workspace")?.access ?? "unknown";
  const bareCommonAccess = status.mounts?.find((mount: any) => mount.kind === "bare-common")?.access;
  const items: SettingItem[] = [
    {
      id: "status",
      label: "Controller / VM / Docker",
      currentValue: `${status.health} · ${status.vmId?.slice(0, 8) ?? "no-vm"} · docker ${status.dockerHealthy ? "ok" : "failed"} · ${status.attachedRoots} root(s)`,
      values: [`${status.health} · ${status.vmId?.slice(0, 8) ?? "no-vm"} · docker ${status.dockerHealthy ? "ok" : "failed"} · ${status.attachedRoots} root(s)`],
    },
    {
      id: "workspace",
      label: "Workspace",
      currentValue: `${status.workspaceRoot} · ${workspaceAccess}`,
      values: [`${status.workspaceRoot} · ${workspaceAccess}`],
    },
    ...(bareCommonAccess ? [{
      id: "bare-common",
      label: "Bare common",
      currentValue: `${status.bareCommonDirectory} · ${bareCommonAccess}`,
      values: [`${status.bareCommonDirectory} · ${bareCommonAccess}`],
    }] : []),
    {
      id: "generations",
      label: "Policy / image",
      currentValue: `${status.policyGeneration.slice(0, 12)} / ${status.imageGeneration.slice(0, 12)}${status.pendingRestart ? " · restart pending" : ""}`,
      values: [`${status.policyGeneration.slice(0, 12)} / ${status.imageGeneration.slice(0, 12)}${status.pendingRestart ? " · restart pending" : ""}`],
    },
    {
      id: "network-mode",
      label: "Network mode",
      currentValue: settings.network.mode,
      values: ["public-http", "public-tcp", "allowlist", "offline"],
    },
    {
      id: "allowed-hosts",
      label: "Allowed hosts",
      currentValue: settings.network.allowedHosts.join(", ") || "(none)",
      values: [settings.network.allowedHosts.join(", ") || "(none)", "edit…"],
    },
    {
      id: "websockets",
      label: "WebSockets",
      currentValue: settings.network.allowWebSockets ? "on" : "off",
      values: ["off", "on"],
    },
    {
      id: "tcp",
      label: "TCP mappings",
      currentValue: settings.network.tcpMappings.map(formatTcp).join(", ") || "(none)",
      values: [settings.network.tcpMappings.map(formatTcp).join(", ") || "(none)", "edit…"],
    },
  ];

  for (const [index, mount] of settings.filesystem.externalMounts.entries()) {
    items.push({
      id: `mount:${index}`,
      label: `External ${mount.path}`,
      currentValue: mount.access,
      values: ["ro", "rw", "remove"],
    });
  }
  items.push(
    { id: "mount-add", label: "Add external mount", currentValue: "none", values: ["none", "add…"] },
    { id: "restart", label: "Restart VM", currentValue: "ready", values: ["ready", "restart"] },
    { id: "docker-reset", label: "Replace VM and clear Docker", currentValue: "keep", values: ["keep", "replace…"] },
  );
  return items;
}

async function chooseAction(
  ctx: ExtensionCommandContext,
  settings: SandboxSettings,
  status: any,
): Promise<SettingsAction | null> {
  return ctx.ui.custom<SettingsAction | null>((_tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold("Gondolin sandbox")), 1, 1));
    const items = buildItems(settings, status);
    const list = new SettingsList(
      items,
      Math.min(items.length + 2, 22),
      getSettingsListTheme(),
      (id, value) => done({ id, value }),
      () => done(null),
      { enableSearch: true },
    );
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "Enter changes · Esc closes"), 1, 1));
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => list.handleInput?.(data),
    };
  });
}

export async function showSandboxSettings(
  ctx: ExtensionCommandContext,
  client: SettingsClient,
  store: SandboxSettingsStore,
  emitLifecycle: (event: SandboxLifecycleEvent) => void,
): Promise<void> {
  if (ctx.mode !== "tui") {
    const status = await client.status();
    ctx.ui.notify(
      `Gondolin ${status.health}; VM ${status.vmId ?? "none"}; Docker ${status.dockerHealthy ? "healthy" : "failed"}; policy ${status.policyGeneration}`,
      status.health === "healthy" ? "info" : "error",
    );
    return;
  }

  for (;;) {
    const status = await client.status();
    const settings = store.load();
    const action = await chooseAction(ctx, settings, status);
    if (!action) return;
    if (["status", "workspace", "bare-common", "generations"].includes(action.id)) continue;

    try {
      if (action.id === "restart" && action.value === "restart") {
        emitLifecycle({ ...lifecycleFromStatus(status), health: "restarting", pendingRestart: true });
        emitLifecycle(lifecycleFromStatus(await client.restart()));
        continue;
      }
      if (action.id === "docker-reset" && action.value === "replace…") {
        const confirmed = await ctx.ui.confirm(
          "Replace shared VM?",
          "This stops the shared VM. Its guest-native Docker images, containers, volumes, and build cache are ephemeral and will be deleted.",
        );
        if (!confirmed) continue;
        emitLifecycle({ ...lifecycleFromStatus(status), health: "restarting", pendingRestart: true });
        emitLifecycle(lifecycleFromStatus(await client.resetDocker()));
        continue;
      }

      const next = structuredClone(settings);
      if (action.id === "network-mode") {
        next.network.mode = action.value as SandboxSettings["network"]["mode"];
        if (next.network.mode === "public-http" || next.network.mode === "public-tcp") next.network.allowedHosts = [];
        if (next.network.mode === "offline") {
          next.network.allowedHosts = [];
          next.network.allowWebSockets = false;
          next.network.tcpMappings = [];
        }
        if (next.network.mode === "allowlist" && next.network.allowedHosts.length === 0) {
          const hosts = await ctx.ui.input("Allowed hosts", "example.com, *.example.org");
          if (!hosts?.trim()) continue;
          next.network.allowedHosts = hosts.split(",").map((host) => host.trim()).filter(Boolean);
        }
      } else if (action.id === "allowed-hosts" && action.value === "edit…") {
        const hosts = await ctx.ui.input("Allowed hosts", next.network.allowedHosts.join(", "));
        if (hosts === undefined) continue;
        next.network.allowedHosts = hosts.split(",").map((host) => host.trim()).filter(Boolean);
        if (next.network.allowedHosts.length > 0) next.network.mode = "allowlist";
        else if (next.network.mode === "allowlist") next.network.mode = "public-http";
      } else if (action.id === "websockets") {
        next.network.allowWebSockets = action.value === "on";
      } else if (action.id === "tcp" && action.value === "edit…") {
        const mappings = await ctx.ui.input(
          "TCP mappings",
          next.network.tcpMappings.map(formatTcp).join(", "),
        );
        if (mappings === undefined) continue;
        next.network.tcpMappings = parseTcpMappings(mappings);
      } else if (action.id === "mount-add" && action.value === "add…") {
        const mountPath = await ctx.ui.input("External path", "~/src/shared");
        if (!mountPath?.trim()) continue;
        const access = await ctx.ui.select("Mount access", ["ro", "rw"]);
        if (access !== "ro" && access !== "rw") continue;
        next.filesystem.externalMounts.push({ path: mountPath.trim(), access });
      } else if (action.id.startsWith("mount:")) {
        const index = Number(action.id.slice("mount:".length));
        if (!Number.isInteger(index) || !next.filesystem.externalMounts[index]) continue;
        if (action.value === "remove") next.filesystem.externalMounts.splice(index, 1);
        else next.filesystem.externalMounts[index].access = action.value as "ro" | "rw";
      } else {
        continue;
      }

      await store.save(next, status);
      emitLifecycle({ ...lifecycleFromStatus(status), health: "restarting", pendingRestart: true });
      emitLifecycle(lifecycleFromStatus(await client.reload()));
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }
}
