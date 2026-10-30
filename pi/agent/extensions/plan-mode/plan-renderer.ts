import { DynamicBorder, getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	computePlanComparison,
	type AffectedSection,
	type MarkedBlock,
	type PlanComparison,
} from "./plan-comparison.ts";

export const PLAN_DISPLAY_ENTRY = "plan-mode-plan-display";
export const STAGE_SUMMARY_ENTRY = "plan-mode-stage-summary";

export interface PlanComparisonBaseline {
	revision: number;
	path: string;
	hash: string;
	authoredHash: string;
	markdown: string;
}

export interface PlanDisplayEntry {
	markdown: string;
	path: string;
	revision: number;
	hash: string;
	authoredHash?: string;
	baseline?: PlanComparisonBaseline | null;
}

function lineUnit(count: number): string {
	return count === 1 ? "1 line" : `${count} lines`;
}

function formatChangeMapSummary(
	sec: AffectedSection,
	theme: { fg: (color: string, text: string) => string },
): string {
	if (sec.added > 0 && sec.removed > 0) {
		return `${theme.fg("success", `+${lineUnit(sec.added)}`)}, ${theme.fg("warning", `-${lineUnit(sec.removed)}`)}`;
	}
	if (sec.added > 0) {
		return theme.fg("success", `+${lineUnit(sec.added)}`);
	}
	if (sec.removed > 0) {
		return theme.fg("warning", `-${lineUnit(sec.removed)}`);
	}
	return "unchanged";
}

export class MarkedPlanComponent {
	private readonly cache = new Map<number, string[]>();

	constructor(
		private readonly blocks: readonly MarkedBlock[],
		private readonly theme: {
			fg: (color: string, text: string) => string;
		},
		private readonly markdownTheme: unknown,
	) {}

	invalidate(): void {
		this.cache.clear();
	}

	render(width: number): string[] {
		if (this.cache.has(width)) return this.cache.get(width)!;

		const gutterWidth = 2;
		const contentWidth = Math.max(1, width - gutterWidth);
		const lines: string[] = [];

		for (let i = 0; i < this.blocks.length; i += 1) {
			const block = this.blocks[i];
			if (i > 0) lines.push("");

			let gutter = "  ";
			if (block.status === "added") {
				gutter = `${this.theme.fg("success", "+")} `;
			} else if (block.status === "modified") {
				gutter = `${this.theme.fg("warning", "~")} `;
			}

			// Render the markdown block content
			const md = new Markdown(block.text, 0, 0, this.markdownTheme as any);
			const mdLines = md.render(contentWidth);

			for (const line of mdLines) {
				const combined = gutter + line;
				if (visibleWidth(combined) > width) {
					lines.push(truncateToWidth(combined, width));
				} else {
					lines.push(combined);
				}
			}
		}

		this.cache.set(width, lines);
		return lines;
	}
}

export function registerPlanRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<PlanDisplayEntry>(PLAN_DISPLAY_ENTRY, (entry, _options, theme) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

		const revision = entry.data.revision;
		const baseline = entry.data.baseline;

		let comparison: PlanComparison | null = null;
		if (baseline !== undefined) {
			comparison = computePlanComparison(baseline?.markdown, entry.data.markdown, baseline?.revision, revision);
		}

		let headerText = `Plan candidate — revision ${revision}`;
		if (comparison) {
			if (comparison.status === "compared" && baseline) {
				headerText = `Plan candidate — revision ${revision} (compared with revision ${baseline.revision})`;
			} else if (comparison.status === "identical" && baseline) {
				headerText = `Plan candidate — revision ${revision} (no authored changes since revision ${baseline.revision})`;
			} else if (comparison.status === "unavailable") {
				headerText = `Plan candidate — revision ${revision} (comparison unavailable)`;
			}
		}

		container.addChild(new Text(
			theme.fg("accent", theme.bold(headerText)) +
			`\n${theme.fg("dim", entry.data.path)}`,
			1,
			0,
		));

		if (comparison && comparison.status === "compared" && comparison.affectedSections && comparison.affectedSections.length > 0) {
			const changeMapHeader = theme.fg("accent", theme.bold(`Change map (vs rev ${baseline!.revision}):`));
			const sectionLines = comparison.affectedSections.map((sec) => {
				const summaryFormatted = formatChangeMapSummary(sec, theme);
				return `  ${sec.label}: ${summaryFormatted}`;
			});
			container.addChild(new Text(`${changeMapHeader}\n${sectionLines.join("\n")}`, 1, 0));
		}

		if (comparison && comparison.status === "compared" && comparison.currentBlocks && comparison.currentBlocks.length > 0) {
			container.addChild(new MarkedPlanComponent(comparison.currentBlocks, theme, getMarkdownTheme()));
		} else {
			container.addChild(new Markdown(entry.data.markdown, 1, 0, getMarkdownTheme()));
		}

		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		return container;
	});

	pi.registerEntryRenderer<{ markdown: string }>(STAGE_SUMMARY_ENTRY, (entry, _options, theme) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Markdown(entry.data.markdown, 1, 0, getMarkdownTheme()));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		return container;
	});
}
