import { readReviewedSerena, validateReviewedEntry, SERENA_INSPECTION_TOOLS } from "./serena-profile.mjs";
import { RoutedMcpTransport } from "./mcp-transport.mjs";
import { createWorkspaceApproval, stable } from "./workspace-approval.mjs";

const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const prefix = (name) => `mcp__${name.replaceAll("-", "_")}__`;
const inspectionNames = new Set(SERENA_INSPECTION_TOOLS.map((name) => `mcp__serena__${name}`));

/** Only approved project entries reach the upstream manager's routed transport. */
export function installReviewedMcp(pi, { factory, connect, prepareLoadout, canDeclare = () => true, onToolsChanged = () => {}, approval = createWorkspaceApproval() }) {
  let context;
  let managerCommand;
  let startManager;
  let stopManager;
  let reconnecting;
  const transports = new Map();
  const records = new Map();
  const live = (record) => Boolean(record && record.desiredDirect && transports.get(record.server.entry.name) === record.transport && !record.transport.closed && record.transport.channel && record.transport.channel.policyGeneration === record.transport.client.policyGeneration);
  const isInspection = (record) => {
    if (!live(record) || !inspectionNames.has(record.definition.name)) return false;
    try {
      approval.validate(record.server);
      const reviewed = readReviewedSerena({ cwd: record.cwd, projectTrusted: context?.isProjectTrusted?.() === true });
      return reviewed.config.toolExposure[record.definition.name.slice(prefix("serena").length)] === "direct" && same(validateReviewedEntry(reviewed, record.cwd), record.server.launch);
    } catch { return false; }
  };
  const register = (record) => {
    const exposure = live(record) && canDeclare(record.definition.name, isInspection(record)) ? "direct" : "hidden";
    pi.registerTool({ ...record.definition, exposure, prepareLoadout, execute: async (...args) => {
      if (records.get(record.definition.name) !== record || !live(record)) throw new Error("Routed MCP tool authority is retired");
      try { approval.validate(record.server); }
      catch (error) { void record.transport.close().catch(() => {}); throw error; }
      if (!canDeclare(record.definition.name, isInspection(record))) throw new Error("Planning mode blocks unreviewed routed MCP tools");
      return record.definition.execute(...args);
    } });
  };
  const retire = (transport) => {
    for (const record of records.values()) if (record.transport === transport) register(record);
    onToolsChanged();
  };
  const close = async () => { await Promise.all([...transports.values()].map((transport) => transport.close())); };
  const restart = async (ctx) => {
    await close();
    await stopManager?.({ reason: "reload" }, ctx);
    await startManager?.({ reason: "reload" }, ctx);
  };
  const facade = Object.create(pi);
  facade.on = (name, handler) => {
    if (name === "session_start") {
      startManager = handler;
      return pi.on(name, async (event, ctx) => {
        context = ctx;
        await approval.initialize(ctx);
        return handler(event, ctx);
      });
    }
    if (name === "session_shutdown") stopManager = handler;
    return pi.on(name, handler);
  };
  facade.registerCommand = (name, command) => {
    if (name !== "mcp") return pi.registerCommand(name, command);
    managerCommand = command;
    pi.registerCommand(name, { ...command, description: "Routed project MCP: status, approve, revoke, reconnect",
      handler: async (args, ctx) => {
        const action = args.trim();
        if (action === "approval" || action === "status") { ctx.ui.notify(approval.status(), "info"); return; }
        if (action === "approve") {
          if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("Routed MCP approval requires an interactive terminal session");
          await ctx.waitForIdle?.();
          await approval.initialize(ctx, true);
          await restart(ctx);
          ctx.ui.notify(approval.status(), "info");
          return;
        }
        if (action === "revoke") {
          if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("Routed MCP revocation requires an interactive terminal session");
          await ctx.waitForIdle?.();
          await approval.revoke();
          await close();
          ctx.ui.notify(approval.status(), "info");
          return;
        }
        ctx.ui.notify(approval.status(), "info");
        return command.handler(args, ctx);
      } });
  };
  facade.getMcpServers = () => []; // No global or extension-registered authority.
  facade.setActiveTools = (requested) => {
    // Manager refreshes may withdraw only their own declarations, never reset
    // core tools, host adapters, or another server's independently live tools.
    const wanted = new Set(requested);
    pi.setActiveTools(pi.getActiveTools().filter((name) => !records.has(name) || wanted.has(name) || live(records.get(name))));
  };
  facade.registerTool = (definition) => {
    const transport = [...transports.values()].find((candidate) => definition.name.startsWith(prefix(candidate.server.entry.name)));
    if (!transport) return; // No resources or discovery plumbing.
    const previous = records.get(definition.name);
    if (definition.exposure === "hidden") {
      // Upstream uses hideTools on reconnect; never bind a withdrawal to a new
      // channel or resurrect a withdrawn offering on planning exit.
      if (previous) { previous.desiredDirect = false; register(previous); onToolsChanged(); }
      return;
    }
    if (transport.closed || definition.exposure !== "direct") return;
    const record = { definition, desiredDirect: true, transport, server: transport.server, cwd: transport.cwd };
    records.set(definition.name, record);
    register(record);
    onToolsChanged();
  };
  factory({
    loadConfig: (ctx) => {
      context = ctx;
      const loaded = approval.load(ctx);
      return { servers: loaded.servers.map((server) => server.entry), errors: loaded.errors ?? [], autoEnableCodemode: false };
    },
    createTransport: (entry, cwd, authProvider) => {
      if (authProvider) throw new Error("Routed MCP does not admit authentication transports");
      const server = approval.load().servers.find((candidate) => candidate.entry.name === entry.name);
      if (!server || !same(entry, server.entry) || cwd !== context.cwd) throw new Error("Routed MCP server configuration provenance does not match approval");
      approval.validate(server);
      const previous = transports.get(entry.name);
      if (previous && !previous.closed) throw new Error("Routed MCP previous process must retire before reconnect");
      const next = new RoutedMcpTransport({ connect, validate: () => approval.validate(server), onRetire: () => retire(next) });
      next.server = server;
      next.cwd = cwd;
      transports.set(entry.name, next);
      return next;
    },
    updateConfig: () => { throw new Error("Routed MCP configuration is read-only here; edit .pi/mcp.json and use /mcp approve or /reload"); },
    openUrl: () => { throw new Error("Routed MCP does not admit HTTP/OAuth or browser actions"); },
  })(facade);
  return {
    isAdmitted: (tool) => {
      const record = records.get(tool.name);
      return Boolean(live(record) && tool.parameters === record.definition.parameters && tool.exposure === "direct" && canDeclare(tool.name, isInspection(record)));
    },
    isInspection: (name) => isInspection(records.get(name)),
    validateCurrent: () => {
      let valid = false;
      for (const transport of transports.values()) {
        if (transport.closed) continue;
        try {
          approval.validate(transport.server);
          if (transport.channel && transport.channel.policyGeneration !== transport.client.policyGeneration) throw new Error("Routed MCP policy generation retired");
          valid = true;
        } catch { void transport.close().catch(() => {}); }
      }
      return valid;
    },
    ensureConnected: async (ctx) => {
      if (!managerCommand || !context) return;
      if (!reconnecting) reconnecting = (async () => {
        // No automatic retry after revocation/config changes. Only a still
        // matching approval can authorize a fresh connection; calls never replay.
        for (const transport of transports.values()) if (transport.closed) {
          try { approval.validate(transport.server); } catch { continue; }
          await managerCommand.handler(`reconnect ${transport.server.entry.name}`, ctx);
        }
      })().finally(() => { reconnecting = null; });
      await reconnecting;
    },
    syncDeclarations: () => { for (const record of records.values()) register(record); onToolsChanged(); },
    close,
  };
}
