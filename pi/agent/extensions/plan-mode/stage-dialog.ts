import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";

export type StageAction =
	| { action: "continue" }
	| { action: "feedback"; text: string }
	| { action: "review" }
	| { action: "stop" }
	| { action: "cancel" };

export async function showStageDialog(ctx: ExtensionContext, finalStage: boolean): Promise<StageAction> {
	const items: SelectItem[] = [
		{ value: "continue", label: finalStage ? "Complete plan" : "Continue", description: finalStage ? "Validate the whole ledger and finish" : "Start the next stage in this session" },
		{ value: "feedback", label: "Give feedback", description: "Request fixes before advancing" },
		{ value: "review", label: "Review summary", description: "Inspect the current summary and ledger" },
		{ value: "stop", label: "Stop here", description: "Pause this resumable execution" },
	];
	for (;;) {
		let selected: string | undefined;
		if (ctx.mode === "tui") {
			selected = await ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Stage checkpoint")), 1, 0));
				const list = new SelectList(items, items.length, {
					selectedPrefix: (text) => theme.fg("accent", text), selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text), scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				});
				list.onSelect = (item) => done(item.value);
				list.onCancel = () => done(undefined);
				container.addChild(list);
				container.addChild(new Text(theme.fg("dim", "No stage advances automatically"), 1, 0));
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				return { render: (width: number) => container.render(width), invalidate: () => container.invalidate(), handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); } };
			});
		} else if (ctx.hasUI) {
			const labels = items.map((item) => `${item.label} — ${item.description ?? ""}`);
			const choice = await ctx.ui.select("Stage checkpoint", labels);
			selected = items[labels.indexOf(choice ?? "")]?.value;
		}
		if (!selected) return { action: "cancel" };
		if (selected !== "feedback") return { action: selected } as StageAction;
		const text = await ctx.ui.editor("Stage feedback / requested fixes", "");
		if (text?.trim()) return { action: "feedback", text: text.trim() };
		if (text === undefined) return { action: "cancel" };
	}
}
