import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";

export type PlanAction =
	| { action: "run" }
	| { action: "fast" }
	| { action: "staged" }
	| { action: "discuss"; text: string }
	| { action: "review" }
	| { action: "review-changes" }
	| { action: "cancel" };

export interface ActionDialogOptions {
	allowReviewChanges?: boolean;
}

const BASE_ITEMS: SelectItem[] = [
	{ value: "run", label: "Implement plan", description: "Execute every stage in the current session" },
	{ value: "fast", label: "Implement (fast)", description: "Optimize safe Parts for parallel execution, then start automatically" },
	{ value: "staged", label: "Implement in stages", description: "Pause for review after every stage" },
	{ value: "discuss", label: "Discuss", description: "Continue an open planning conversation" },
];

function actionItems(ctx: ExtensionContext, options: ActionDialogOptions = {}): SelectItem[] {
	if (ctx.mode !== "tui") {
		return BASE_ITEMS.map((item) => item.value === "discuss"
			? { ...item, description: "Continue planning (tuicr Review requires interactive TUI mode)" }
			: item);
	}
	const reviewItems: SelectItem[] = [];
	if (options.allowReviewChanges) {
		reviewItems.push({
			value: "review-changes",
			label: "Review changes",
			description: "Inspect revision diff with tuicr",
		});
	}
	reviewItems.push({
		value: "review",
		label: "Review full plan",
		description: "Comment on an isolated full plan snapshot with tuicr",
	});
	return [
		...BASE_ITEMS,
		...reviewItems,
	];
}

async function selectAction(ctx: ExtensionContext, options: ActionDialogOptions = {}): Promise<string | undefined> {
	const items = actionItems(ctx, options);
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

export async function showPlanActionDialog(ctx: ExtensionContext, options: ActionDialogOptions = {}): Promise<PlanAction> {
	for (;;) {
		const action = await selectAction(ctx, options);
		if (!action) return { action: "cancel" };
		if (action !== "discuss") return { action } as PlanAction;
		const text = await ctx.ui.editor("Discuss the candidate plan", "");
		if (text?.trim()) return { action: "discuss", text: text.trim() };
		if (text === undefined) return { action: "cancel" };
		// Empty Discuss returns to the action list.
	}
}
