import { join } from "node:path";

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	buildUsageSummary,
	renderUsage,
	scanUsage,
	skippedRecordCount,
} from "./usage.ts";

export default function usageExtension(pi: ExtensionAPI) {
	pi.registerCommand("usage", {
		description: "Show token activity across the last 30 days",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /usage", "warning");
				return;
			}
			if (!ctx.hasUI) return;

			ctx.ui.notify("Scanning 30-day token activity…", "info");

			const result = await scanUsage(join(getAgentDir(), "sessions"));
			const summary = buildUsageSummary(result.events);
			const lines = renderUsage(summary, ctx.ui.theme);
			const skipped = skippedRecordCount(result.diagnostics);

			if (skipped > 0) {
				lines.push(
					"",
					ctx.ui.theme.fg(
						"warning",
						`Skipped ${skipped.toLocaleString("en-US")} malformed or unreadable session record${skipped === 1 ? "" : "s"}.`,
					),
				);
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
