import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";

export interface SubagentRole {
	name: "reviewer" | "planner" | "worker" | "scout" | "general";
	emoji: string;
}

export interface SubagentActivity {
	kind: string;
	emoji?: string;
	label?: string;
	action?: string;
}

interface RunPresentation {
	ordinal: number;
	model: string;
	prompt: string;
	role?: SubagentRole;
	taskSummary?: string;
}

interface WidgetUi {
	setWidget(
		key: string,
		value: undefined | ((tui: unknown, theme: Theme) => { render(width: number): string[]; invalidate(): void }),
		options?: { placement: "belowEditor" },
	): void;
}

const ROLE_RULES: ReadonlyArray<{ role: SubagentRole; terms: readonly string[] }> = [
	{
		role: { name: "reviewer", emoji: "🧪" },
		terms: ["review", "audit", "critique", "assess", "verify", "validate"],
	},
	{
		role: { name: "planner", emoji: "🗺️" },
		terms: ["plan", "design", "architect", "roadmap", "strategy"],
	},
	{
		role: { name: "worker", emoji: "🔨" },
		terms: ["implement", "fix", "build", "edit", "write", "refactor", "change", "create"],
	},
	{
		role: { name: "scout", emoji: "🔎" },
		terms: ["inspect", "investigate", "explore", "search", "find", "research", "analyze", "locate"],
	},
];

const GENERAL_ROLE: SubagentRole = { name: "general", emoji: "🤖" };
const EXPLICIT_ROLE_DIRECTIVE = /^[ \t]*\[PI SUBAGENT ROLE: (reviewer|planner|worker|scout|general)\][ \t]*(?:\r?\n|$)/i;
const PARALLEL_PLAN_WORKER_DIRECTIVE = /^[ \t]*\[PARALLEL PLAN WORKER\][ \t]*(?:\r?\n|$)/i;
const COLLAPSED_ACTIVITY_LIMIT = 5;
const EXPANDED_ACTIVITY_LIMIT = 50;

export function inferRole(prompt: string): SubagentRole {
	const text = typeof prompt === "string" ? prompt : "";
	const explicitRole = EXPLICIT_ROLE_DIRECTIVE.exec(text)?.[1]?.toLowerCase();
	if (explicitRole) {
		const matchingRole = ROLE_RULES.find(({ role }) => role.name === explicitRole)?.role
			?? (GENERAL_ROLE.name === explicitRole ? GENERAL_ROLE : undefined);
		if (matchingRole) return { ...matchingRole };
	}
	for (const rule of ROLE_RULES) {
		const pattern = new RegExp(`\\b(?:${rule.terms.join("|")})\\b`, "i");
		if (pattern.test(text)) return { ...rule.role };
	}
	return { ...GENERAL_ROLE };
}

export function normalizeTaskSummary(prompt: string): string {
	if (typeof prompt !== "string") return "";
	let summary = prompt;
	while (true) {
		const directive = EXPLICIT_ROLE_DIRECTIVE.exec(summary)?.[0] ?? PARALLEL_PLAN_WORKER_DIRECTIVE.exec(summary)?.[0];
		if (!directive) break;
		summary = summary.slice(directive.length);
	}
	return summary.replace(/\s+/g, " ").trim();
}

function boundedLines(lines: string[], width: number): string[] {
	const safeWidth = Math.max(0, width);
	return lines.map((line) => truncateToWidth(line, safeWidth));
}

class RenderComponent {
	private readonly renderInner: (width: number) => string[];

	constructor(renderInner: (width: number) => string[]) {
		this.renderInner = renderInner;
	}

	render(width: number): string[] {
		return boundedLines(this.renderInner(Math.max(0, width)), width);
	}

	invalidate(): void {
		// Content and theme styling are rebuilt on every render.
	}
}

function activeRow(run: Required<Pick<RunPresentation, "ordinal" | "model" | "prompt">> & {
	role: SubagentRole;
	taskSummary: string;
}, theme: Theme, width: number): string {
	const role = theme.fg("accent", `${run.role.emoji} ${run.role.name}`);
	const ordinal = theme.fg("muted", `subagent #${run.ordinal}`);
	const task = theme.fg("text", run.taskSummary || "(no task)");
	const model = theme.fg("dim", run.model);
	const identity = `${role} ${theme.fg("dim", "·")} ${ordinal} ${theme.fg("dim", "·")} ${model}`;
	const row = `${identity} ${theme.fg("dim", "·")} ${task}`;
	return truncateToWidth(row, Math.max(0, width));
}

export function createRunUiManager(ui: WidgetUi, widgetKey = "subagent-active") {
	const runs = new Map<string, Required<Pick<RunPresentation, "ordinal" | "model" | "prompt">> & {
		role: SubagentRole;
		taskSummary: string;
	}>();

	const renderWidget = () => {
		if (runs.size === 0) {
			ui.setWidget(widgetKey, undefined);
			return;
		}
		const snapshot = Array.from(runs.values());
		ui.setWidget(
			widgetKey,
			(_tui, theme) => new RenderComponent((width) => [
				...snapshot.map((run) => activeRow(run, theme, width)),
				"",
			]),
			{ placement: "belowEditor" },
		);
	};

	return {
		start(toolCallId: string, presentation: RunPresentation): void {
			const prompt = presentation.prompt ?? "";
			runs.set(toolCallId, {
				ordinal: presentation.ordinal,
				model: presentation.model,
				prompt,
				role: presentation.role ? { ...presentation.role } : inferRole(prompt),
				taskSummary: presentation.taskSummary ?? normalizeTaskSummary(prompt),
			});
			renderWidget();
		},
		update(_toolCallId: string, _activity: SubagentActivity): void {
			// Active rows intentionally remain fixed for the life of each run.
		},
		remove(toolCallId: string): void {
			if (!runs.delete(toolCallId)) return;
			renderWidget();
		},
		clear(): void {
			runs.clear();
			ui.setWidget(widgetKey, undefined);
		},
	};
}

function formatTokens(value: number): string {
	if (value < 1000) return String(value);
	if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
	return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function formatUsage(usage: Record<string, any> | undefined, turns?: number): string {
	if (!usage && !turns) return "";
	const parts: string[] = [];
	if (turns) parts.push(`${turns} turn${turns === 1 ? "" : "s"}`);
	if (typeof usage?.input === "number") parts.push(`↑${formatTokens(usage.input)}`);
	if (typeof usage?.output === "number") parts.push(`↓${formatTokens(usage.output)}`);
	if (typeof usage?.cacheRead === "number" && usage.cacheRead > 0) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (typeof usage?.cacheWrite === "number" && usage.cacheWrite > 0) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (typeof usage?.reasoning === "number" && usage.reasoning > 0) parts.push(`reasoning ${formatTokens(usage.reasoning)}`);
	if (typeof usage?.cost?.total === "number" && usage.cost.total > 0) parts.push(`$${usage.cost.total.toFixed(4)}`);
	return parts.join(" ");
}

function textContent(result: Record<string, any>): string {
	if (!Array.isArray(result?.content)) return "";
	return result.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n");
}

function observableActivity(details: Record<string, any> | undefined, expanded: boolean): SubagentActivity[] {
	if (!Array.isArray(details?.activity)) return [];
	const safe = details.activity.filter((item: any) =>
		item && typeof item === "object" && item.kind !== "thinking",
	);
	return safe.slice(-(expanded ? EXPANDED_ACTIVITY_LIMIT : COLLAPSED_ACTIVITY_LIMIT));
}

function activityText(item: SubagentActivity, theme: Theme): string {
	const label = normalizeTaskSummary(item.label || item.kind || "activity");
	const action = normalizeTaskSummary(item.action || "");
	return `${theme.fg("muted", label)}${action ? ` ${theme.fg("dim", action)}` : ""}`;
}

function statusPresentation(status: string, theme: Theme): string {
	switch (status) {
		case "completed": return theme.fg("success", "✓ completed");
		case "failed": return theme.fg("error", "✗ failed");
		case "cancelled": return theme.fg("warning", "⛔ cancelled");
		default: return theme.fg("warning", "⏳ running");
	}
}

export function renderSubagentCall(args: Record<string, any>, theme: Theme) {
	const rawPrompt = args?.prompt ?? "";
	const prompt = normalizeTaskSummary(rawPrompt);
	const role = inferRole(rawPrompt);
	const model = typeof args?.model === "string" && args.model ? args.model : "inherited model";
	const thinking = typeof args?.thinkingLevel === "string" ? ` · ${args.thinkingLevel}` : "";
	return new RenderComponent((width) => {
		const line = [
			theme.fg("toolTitle", theme.bold("subagent")),
			theme.fg("accent", role.name),
			theme.fg("muted", `${model}${thinking}`),
			prompt ? theme.fg("dim", prompt) : theme.fg("error", "(missing task)"),
		].join(" · ");
		return [truncateToWidth(line, width)];
	});
}

export function renderSubagentResult(
	result: Record<string, any>,
	options: { expanded?: boolean; isPartial?: boolean; isError?: boolean },
	theme: Theme,
	markdownTheme: any,
) {
	return new RenderComponent((width) => {
		const details = result?.details && typeof result.details === "object" ? result.details : {};
		const expanded = options?.expanded === true;
		const status = options?.isPartial
			? "running"
			: typeof details.status === "string"
				? details.status
				: options?.isError
					? "failed"
					: "completed";
		const header = statusPresentation(status, theme);
		const container = new Container();
		container.addChild(new Text(header, 0, 0));

		const activity = observableActivity(details, expanded);
		if (activity.length > 0) {
			container.addChild(new Text(activity.map((item) => activityText(item, theme)).join("\n"), 0, 0));
		}

		const usage = formatUsage(result?.usage ?? details.usage, details.turns);
		if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));

		const finalOutput = typeof details.finalText === "string" ? details.finalText : textContent(result);
		if (!options?.isPartial && finalOutput) {
			if (expanded) {
				container.addChild(new Markdown(finalOutput, 0, 0, markdownTheme));
			} else {
				const preview = finalOutput.split("\n").slice(0, 3).join("\n");
				container.addChild(new Text(theme.fg("toolOutput", preview), 0, 0));
			}
		}

		return boundedLines(container.render(width), width);
	});
}
