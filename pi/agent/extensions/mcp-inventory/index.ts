import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { collectInventory } from "./inventory.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "mcp_list",
    label: "MCP configuration inventory",
    description: "List bounded MCP configuration metadata using current session trust. Does not connect to servers, test health, or make MCP tools callable.",
    parameters: Type.Object({}, { additionalProperties: false }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: Type.Object({
      inventoryOnly: Type.Literal(true),
      establishes: Type.String(),
      projectConfiguration: Type.Union([Type.Literal("included"), Type.Literal("skipped-untrusted")]),
      servers: Type.Array(Type.Object({
        name: Type.String(),
        source: Type.Object({ scope: Type.String(), path: Type.String() }),
        enabled: Type.Boolean(),
        transport: Type.Union([Type.Literal("stdio"), Type.Literal("http")]),
      })),
      diagnostics: Type.Array(Type.Object({ scope: Type.String(), code: Type.String() })),
    }),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const inventory = collectInventory({ agentDir: getAgentDir(), ctx, getMcpServers: () => pi.getMcpServers() });
      return { content: [{ type: "text", text: JSON.stringify(inventory) }], details: inventory, structuredContent: inventory };
    },
  });
}
