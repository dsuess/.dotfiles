import type { ExtensionContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";

export type SandboxCommand =
  | { kind: "menu" | "status" | "on" | "off" | "list" | "reload" | "help" }
  | { kind: "add"; access: "ro" | "rw"; path: string }
  | { kind: "remove"; path: string };

export interface SandboxCommandMessage {
  message: string;
  level?: "info" | "warning" | "error";
}

export interface SandboxCommandStatus extends SandboxCommandMessage {
  mode: "on" | "off";
  summary: string;
}

/** Trusted services own validation, idle gates, activation, and status formatting. */
export interface SandboxCommandActions {
  status(ctx: ExtensionContext): Promise<SandboxCommandStatus>;
  listGrants(ctx: ExtensionContext): Promise<SandboxCommandMessage>;
  setMode(mode: "on" | "off", ctx: ExtensionContext): Promise<SandboxCommandMessage>;
  addGrant(access: "ro" | "rw", path: string, ctx: ExtensionContext): Promise<SandboxCommandMessage>;
  removeGrant(path: string, ctx: ExtensionContext): Promise<SandboxCommandMessage>;
  reloadGrants(ctx: ExtensionContext): Promise<SandboxCommandMessage>;
  // Pi's no-UI notify is a no-op. The caller must also supply non-interactive output.
  report(result: SandboxCommandMessage, ctx: ExtensionContext): void;
}

export const SANDBOX_HELP = [
  "/sandbox — show the status and actions menu",
  "/sandbox status — show execution mode, saved/effective grants, and health",
  "/sandbox on — enable sandboxed execution for this conversation",
  "/sandbox off — use host access for this conversation",
  "/sandbox grants list — list saved and effective grants",
  "/sandbox grants add ro <path> — save a read-only directory grant",
  "/sandbox grants add rw <path> — save a read-write directory grant",
  "/sandbox grants remove <path> — remove a saved grant, not derived workspace access",
  "/sandbox reload — reload saved grants for this client, not extensions or the controller",
  "/sandbox help — show this help",
  "Paths must be existing absolute or home-relative directories. The remainder is the literal path, including spaces. Do not add shell quotes.",
  "Without interactive or RPC UI, only status, grants list, and help are available. An empty command shows status.",
].join("\n");

function invalidSyntax(): never {
  throw new Error("Invalid /sandbox syntax. Use /sandbox help for supported commands.");
}

export function parseSandboxCommand(args: string): SandboxCommand {
  if (/[\r\n\0]/.test(args)) invalidSyntax();
  const text = args.trim();
  if (!text) return { kind: "menu" };
  if (text === "status" || text === "on" || text === "off" || text === "reload" || text === "help") {
    return { kind: text };
  }
  if (/^grants[ \t]+list$/.test(text)) return { kind: "list" };
  const add = /^grants[ \t]+add[ \t]+(ro|rw)[ \t]+(.+)$/.exec(text);
  if (add) return { kind: "add", access: add[1] as "ro" | "rw", path: add[2] };
  const remove = /^grants[ \t]+remove[ \t]+(.+)$/.exec(text);
  if (remove) return { kind: "remove", path: remove[1] };
  return invalidSyntax();
}

const COMPLETIONS = [
  "status", "on", "off", "grants list", "grants add ro", "grants add rw", "grants remove", "reload", "help",
];

export function sandboxArgumentCompletions(prefix: string): { value: string; label: string }[] | null {
  const normalized = prefix.trimStart().replace(/[ \t]+/g, " ");
  const matches = COMPLETIONS.filter((value) => value.startsWith(normalized));
  return matches.length ? matches.map((value) => ({ value, label: value })) : null;
}

const menuOptions = (mode: "on" | "off") => [
  "Show status",
  mode === "on" ? "Turn sandbox off — host access" : "Turn sandbox on",
  "List saved and effective grants",
  "Add or change a saved grant",
  "Remove a saved grant",
  "Reload saved grants for this client",
  "Help",
];

async function inputPath(ctx: ExtensionContext): Promise<string | undefined> {
  const value = await ctx.ui.input("Existing directory path (absolute or ~/)", "/path with spaces or ~/directory");
  if (value === undefined) return undefined;
  const path = value.trim();
  if (!path || /[\r\n\0]/.test(path)) throw new Error("Enter a directory path. Use an absolute path or ~/path.");
  return path;
}

/** Returns a command definition only; this module registers no tools or commands. */
export function createSandboxCommand(actions: SandboxCommandActions): Pick<RegisteredCommand, "description" | "getArgumentCompletions" | "handler"> {
  const run = async (command: SandboxCommand, ctx: ExtensionContext): Promise<void> => {
    let result: SandboxCommandMessage;
    switch (command.kind) {
      case "status": result = await actions.status(ctx); break;
      case "list": result = await actions.listGrants(ctx); break;
      case "help": result = { message: SANDBOX_HELP }; break;
      case "on": case "off": result = await actions.setMode(command.kind, ctx); break;
      case "add": result = await actions.addGrant(command.access, command.path, ctx); break;
      case "remove": result = await actions.removeGrant(command.path, ctx); break;
      case "reload": result = await actions.reloadGrants(ctx); break;
      case "menu": return;
    }
    actions.report(result, ctx);
  };

  const menu = async (ctx: ExtensionContext): Promise<void> => {
    const status = await actions.status(ctx);
    const choice = await ctx.ui.select(`Sandbox — ${status.summary}`, menuOptions(status.mode));
    switch (choice) {
      case undefined: return;
      case "Show status": actions.report(status, ctx); return;
      case "Turn sandbox on": return run({ kind: "on" }, ctx);
      case "Turn sandbox off — host access": return run({ kind: "off" }, ctx);
      case "List saved and effective grants": return run({ kind: "list" }, ctx);
      case "Reload saved grants for this client": return run({ kind: "reload" }, ctx);
      case "Help": return run({ kind: "help" }, ctx);
      case "Add or change a saved grant": {
        const access = await ctx.ui.select("Grant access", ["Read-only (ro)", "Read-write (rw)"]);
        if (access === undefined) return;
        if (access !== "Read-only (ro)" && access !== "Read-write (rw)") invalidSyntax();
        const path = await inputPath(ctx);
        if (path === undefined) return;
        return run({ kind: "add", access: access === "Read-only (ro)" ? "ro" : "rw", path }, ctx);
      }
      case "Remove a saved grant": {
        const path = await inputPath(ctx);
        if (path === undefined) return;
        return run({ kind: "remove", path }, ctx);
      }
      default: invalidSyntax();
    }
  };

  return {
    description: "Show sandbox status, control this conversation, and edit saved directory grants",
    getArgumentCompletions: sandboxArgumentCompletions,
    handler: async (args, ctx) => {
      try {
        const command = parseSandboxCommand(args);
        if (command.kind === "menu") {
          if (ctx.hasUI) await menu(ctx);
          else await run({ kind: "status" }, ctx);
          return;
        }
        if (!ctx.hasUI && command.kind !== "status" && command.kind !== "list" && command.kind !== "help") {
          throw new Error("This /sandbox action requires interactive or RPC UI. No change was applied.");
        }
        await run(command, ctx);
      } catch (error) {
        actions.report({ message: error instanceof Error ? error.message : String(error), level: "error" }, ctx);
      }
    },
  };
}
