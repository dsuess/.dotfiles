import { readReviewedSerena, validateReviewedEntry, SERENA_TOOLS } from "./serena-profile.mjs";
import { RoutedMcpTransport } from "./mcp-transport.mjs";

const names = new Set(SERENA_TOOLS.map((name) => `mcp__serena__${name}`));

/** Narrow facade: only reviewed config, transport and actual direct offerings. */
export function installReviewedMcp(pi, { factory, connect, prepareLoadout, canDeclare = () => true, onToolsChanged = () => {} }) {
  let context;
  let transport;
  let managerCommand;
  let reconnecting;
  const records = new Map();
  const validate = (entry, cwd) => {
    const current = readReviewedSerena({ cwd, projectTrusted: context?.isProjectTrusted?.() === true });
    validateReviewedEntry(entry, cwd);
    return { current, launch: validateReviewedEntry(current, cwd) };
  };
  const live = (record) => Boolean(record && record.desiredDirect && !record.transport.closed && record.transport.channel && record.transport.channel.policyGeneration === record.transport.client.policyGeneration);
  const register = (record) => {
    const exposure = live(record) && canDeclare(record.definition.name) ? "direct" : "hidden";
    pi.registerTool({ ...record.definition, exposure, prepareLoadout, execute: async (...args) => {
      if (records.get(record.definition.name) !== record || !live(record)) throw new Error("Routed Serena tool authority is retired");
      let current;
      try { ({ current } = validate(record.entry, record.cwd)); }
      catch (error) { void record.transport.close().catch(() => {}); throw error; }
      if (current.config.toolExposure[record.definition.name.slice("mcp__serena__".length)] !== "direct") throw new Error("Routed Serena tool exposure is not admitted");
      return record.definition.execute(...args);
    } });
  };
  const retire = (retiredTransport) => {
    for (const record of records.values()) if (record.transport === retiredTransport) register(record);
    onToolsChanged();
  };
  const facade = Object.create(pi);
  facade.registerCommand = (name, command) => {
    if (name === "mcp") managerCommand = command;
    pi.registerCommand(name, command);
  };
  facade.getMcpServers = () => []; // Never consume file-independent registrations.
  facade.setActiveTools = (requested) => {
    // The reused manager cannot enable discovery/resource tools or reset the
    // host/core loadout. It may only withdraw its own existing declarations.
    const requestedNames = new Set(requested);
    pi.setActiveTools(pi.getActiveTools().filter((name) => !names.has(name) || requestedNames.has(name)));
  };
  facade.registerTool = (definition) => {
    if (!names.has(definition.name) || !["direct", "hidden"].includes(definition.exposure) || !transport || transport.closed) return;
    const tool = definition.name.slice("mcp__serena__".length);
    if (transport.entry.config.toolExposure[tool] !== "direct") return;
    const record = { definition, desiredDirect: definition.exposure === "direct", transport, entry: transport.entry, cwd: transport.cwd };
    records.set(definition.name, record);
    register(record);
    onToolsChanged();
  };
  factory({
    loadConfig: (ctx) => {
      context = ctx;
      try {
        const entry = readReviewedSerena({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted?.() === true });
        return { servers: [entry], errors: [], autoEnableCodemode: false };
      } catch (error) {
        return { servers: [], errors: [error.message], autoEnableCodemode: false };
      }
    },
    createTransport: (entry, cwd, authProvider) => {
      if (authProvider) throw new Error("Routed Serena does not admit authentication transports");
      validate(entry, cwd);
      const next = new RoutedMcpTransport({
        connect,
        validate: () => validate(entry, cwd).launch,
        onRetire: () => retire(next),
      });
      next.entry = entry;
      next.cwd = cwd;
      transport = next;
      return next;
    },
    updateConfig: () => { throw new Error("Reviewed Serena configuration is read-only here; review profile changes before updating admission"); },
    openUrl: () => { throw new Error("Routed Serena does not admit OAuth or browser actions"); },
  })(facade);
  return {
    isAdmitted: (tool) => {
      const record = records.get(tool.name);
      return Boolean(live(record) && tool.parameters === record.definition.parameters && tool.exposure === "direct");
    },
    validateCurrent: () => {
      if (!transport || transport.closed) return false;
      try { validate(transport.entry, transport.cwd); return true; }
      catch { void transport.close().catch(() => {}); return false; }
    },
    ensureConnected: async (ctx) => {
      if (!transport?.closed || !managerCommand || !context) return;
      if (!reconnecting) reconnecting = managerCommand.handler("reconnect serena", ctx).finally(() => { reconnecting = null; });
      await reconnecting;
    },
    syncDeclarations: () => { for (const record of records.values()) register(record); onToolsChanged(); },
    close: async () => { await transport?.close(); },
  };
}
