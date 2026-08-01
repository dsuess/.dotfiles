import { DynamicBorder, getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";

export const PLAN_DISPLAY_ENTRY = "plan-mode-plan-display";
export const STAGE_SUMMARY_ENTRY = "plan-mode-stage-summary";

export interface PlanDisplayEntry {
	markdown: string;
	path: string;
	revision: number;
	hash: string;
}

export function registerPlanRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<PlanDisplayEntry>(PLAN_DISPLAY_ENTRY, (entry, _options, theme) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Text(
			theme.fg("accent", theme.bold(`Approved plan candidate — revision ${entry.data.revision}`)) +
			`\n${theme.fg("dim", entry.data.path)}`,
			1,
			0,
		));
		container.addChild(new Markdown(entry.data.markdown, 1, 0, getMarkdownTheme()));
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
