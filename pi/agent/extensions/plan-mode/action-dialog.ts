import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";

export type PlanAction =
	| { action: "run" }
	| { action: "fast" }
	| { action: "staged" }
	| { action: "change"; text: string }
	| { action: "review" }
	| { action: "cancel" };

const BASE_ITEMS: SelectItem[] = [
	{ value: "run", label: "Implement plan", description: "Execute every stage in the current session" },
	{ value: "fast", label: "Implement (fast)", description: "Optimize safe Parts for parallel execution, then start automatically" },
	{ value: "staged", label: "Implement in stages", description: "Pause for review after every stage" },
	{ value: "change", label: "Change", description: "Send revision instructions to the planner" },
];

function actionItems(ctx: ExtensionContext): SelectItem[] {
	if (ctx.mode !== "tui") {
		return BASE_ITEMS.map((item) => item.value === "change"
			? { ...item, description: "Send revision instructions (tuicr Review requires interactive TUI mode)" }
			: item);
	}
	return [
		...BASE_ITEMS,
		{ value: "review", label: "Review", description: "Comment on an isolated plan snapshot with tuicr" },
	];
}

async function selectAction(ctx: ExtensionContext): Promise<string | undefined> {
	const items = actionItems(ctx);
	if (ctx.mode !== "tui") {
		if (!ctx.hasUI) return undefined;
		const labels = items.map((item) => `${item.label} — ${item.description ?? ""}`);
		return ctx.ui.select("Plan ready — what should happen next?", labels)
			.then((choice) => items[labels.indexOf(choice ?? "")]?.value);
	}
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Plan ready — what should happen next?")), 1, 0));
		const list = new SelectList(items, items.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(undefined);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc keep pending"), 1, 0));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
		};
	});
}

export async function showPlanActionDialog(ctx: ExtensionContext): Promise<PlanAction> {
	for (;;) {
		const action = await selectAction(ctx);
		if (!action) return { action: "cancel" };
		if (action !== "change") return { action } as PlanAction;
		const text = await ctx.ui.editor("Change the approved plan", "");
		if (text?.trim()) return { action: "change", text: text.trim() };
		if (text === undefined) return { action: "cancel" };
		// Empty Change returns to the action list.
	}
}
