import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isInheritedPlanningMode, runSubagent } from "./runtime.js";
import {
	createRunUiManager,
	inferRole,
	normalizeTaskSummary,
	renderSubagentCall,
	renderSubagentResult,
	type SubagentActivity,
} from "./ui.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const MAX_PARTIAL_ACTIVITY = 50;

const SubagentParameters = Type.Object({
	prompt: Type.String({
		description: "The sole user task for the isolated child Pi run",
		minLength: 1,
	}),
	model: Type.Optional(Type.String({
		description: "Optional child model override as provider/model; defaults to the parent model",
		minLength: 1,
	})),
	thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS, {
		description: "Optional child thinking-level override; defaults to the parent level",
	})),
}, { additionalProperties: false });

interface ChildResult {
	output: string;
	details?: Record<string, any>;
	usage?: Record<string, any>;
}

interface ChildOptions {
	prompt: string;
	model: string;
	thinkingLevel?: string;
	systemPrompt: string;
	activeTools: string[];
	cwd: string;
	planningMode: boolean;
	signal: AbortSignal;
	onActivity: (activity: SubagentActivity) => void;
}

interface ExtensionDependencies {
	runChild?: (options: ChildOptions) => Promise<ChildResult>;
	env?: Record<string, string | undefined>;
}

function parentModel(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function runningDetails(
	model: string,
	prompt: string,
	role: ReturnType<typeof inferRole>,
	taskSummary: string,
	activity: SubagentActivity[],
) {
	return {
		status: "running",
		model,
		requestedModel: model,
		prompt,
		role,
		taskSummary,
		activity: [...activity],
	};
}

export function createSubagentExtension(dependencies: ExtensionDependencies = {}) {
	const runChild = dependencies.runChild ?? runSubagent;
	const env = dependencies.env ?? process.env;

	return function subagentExtension(pi: ExtensionAPI): void {
		const controllers = new Map<string, AbortController>();
		let runUi: ReturnType<typeof createRunUiManager> | undefined;
		let nextOrdinal = 1;

		const getRunUi = (ctx: ExtensionContext) => {
			if (ctx.mode !== "tui") return undefined;
			runUi ??= createRunUiManager(ctx.ui);
			return runUi;
		};

		pi.registerTool({
			name: "subagent",
			label: "Subagent",
			description: [
				"Run one isolated, ephemeral child Pi task and return its final report.",
				"The child inherits the parent model, thinking level, effective system instructions, working directory, and active tool allowlist unless model or thinkingLevel is overridden.",
				"Nested delegation and parent workflow tools are unavailable. Live activity is coalesced; icons appear only in result status headers and the below-editor active-run row. Output is bounded; complete oversized output is retained in a secure temporary file.",
			].join(" "),
			promptSnippet: "Delegate one independent task to an isolated child Pi run",
			promptGuidelines: [
				"Use subagent for an independent delegated task; provide one complete nonblank prompt and do not expect nested delegation.",
			],
			parameters: SubagentParameters,

			async execute(toolCallId, params, signal, onUpdate, ctx) {
				if (env.PI_SUBAGENT_CHILD === "1") {
					throw new Error("Nested delegation is disabled: a child Pi run cannot invoke subagent");
				}
				if (typeof params.prompt !== "string" || !params.prompt.trim()) {
					throw new Error("Subagent requires a nonblank prompt");
				}
				if (params.model !== undefined && !params.model.trim()) {
					throw new Error("Subagent model override must be nonblank");
				}

				const model = params.model?.trim() || parentModel(ctx);
				if (!model) {
					throw new Error("Subagent requires either a parent model or an explicit model override");
				}
				const thinkingLevel = params.thinkingLevel ?? ctx.thinkingLevel;
				const systemPrompt = ctx.getSystemPrompt();
				const activeTools = pi.getActiveTools();
				const planningMode = isInheritedPlanningMode(activeTools, systemPrompt);
				const role = inferRole(params.prompt);
				const taskSummary = normalizeTaskSummary(params.prompt);
				const ordinal = nextOrdinal++;
				const controller = new AbortController();
				const abortFromParent = () => controller.abort(signal?.reason);
				if (signal?.aborted) abortFromParent();
				else signal?.addEventListener("abort", abortFromParent, { once: true });
				controllers.set(toolCallId, controller);

				const ui = getRunUi(ctx);
				ui?.start(toolCallId, { ordinal, model, prompt: params.prompt, role, taskSummary });
				const activity: SubagentActivity[] = [];
				const emitRunningUpdate = () => onUpdate?.({
					content: [{ type: "text", text: activity.length > 0
						? activity.at(-1)?.label ?? activity.at(-1)?.kind ?? "running"
						: "Subagent running…" }],
					details: runningDetails(model, params.prompt, role, taskSummary, activity),
				});
				emitRunningUpdate();

				try {
					const result = await runChild({
						prompt: params.prompt,
						model,
						thinkingLevel,
						systemPrompt,
						activeTools,
						cwd: ctx.cwd,
						planningMode,
						signal: controller.signal,
						onActivity(item) {
							activity.push(item);
							if (activity.length > MAX_PARTIAL_ACTIVITY) {
								activity.splice(0, activity.length - MAX_PARTIAL_ACTIVITY);
							}
							ui?.update(toolCallId, item);
							emitRunningUpdate();
						},
					});
					return {
						content: [{ type: "text", text: result.output }],
						details: {
							...result.details,
							prompt: params.prompt,
							role,
							taskSummary,
							requestedModel: model,
						},
						usage: result.usage,
					};
				} finally {
					signal?.removeEventListener("abort", abortFromParent);
					controllers.delete(toolCallId);
					ui?.remove(toolCallId);
				}
			},

			renderCall(args, theme) {
				return renderSubagentCall(args, theme);
			},

			renderResult(result, options, theme) {
				return renderSubagentResult(result, options, theme, getMarkdownTheme());
			},
		});

		pi.on("session_shutdown", () => {
			for (const controller of controllers.values()) controller.abort(new Error("Pi session shutdown"));
			controllers.clear();
			runUi?.clear();
		});
	};
}

export default createSubagentExtension();
