import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
	CONFIG_DIR_NAME,
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { showPlanActionDialog } from "./action-dialog.ts";
import { analyzeBashMutation } from "./bash-policy.js";
import { PLAN_MODE_DIRECT_TOGGLE_EVENT, PLAN_MODE_WORKFLOW_STATE_EVENT } from "./events.ts";
import {
	EXECUTION_ENTRY,
	buildExecutionBoundaryMessage,
	buildExecutionKickoff,
	buildStageInstruction,
	getExecutionToolNames,
	hashExecutionBoundary,
	isolateExecutionMessages,
	registerExecutionTools,
	restoreExecutionContract,
	type ExecutionContract,
	type InPlaceExecutionContract,
} from "./execution.ts";
import {
	evaluatePlanningToolCall,
	getPlanningToolNames,
	getRestorableTools,
	snapshotActiveTools,
	WORKFLOW_TOOLS,
} from "./planning-gate.js";
import { synchronizeLedgerMarkdown } from "./ledger.js";
import {
	PLAN_MODE_MODEL_ROUTING_ENTRY,
	captureModelProfile,
	createModelRoutingState,
	restoreLatestModelRouting,
	type ModelProfile,
	type ModelRoutingState,
} from "./model-routing.ts";
import { createSettingsModelDefaults, type ModelDefaultsBoundary } from "./settings-defaults.ts";
import { parsePlanDocument, validateFastPlanRevision } from "./plan-document.js";
import { atomicReplaceFile, persistPlan, PlanStoreError, restorePlanFile } from "./plan-store.js";
import { PLAN_DISPLAY_ENTRY, STAGE_SUMMARY_ENTRY, registerPlanRenderer } from "./plan-renderer.ts";
import { buildProgressRows, getDocumentProgressTasks } from "./progress-widget.js";
import { buildFastOptimizationPrompt, buildPlanningPrompt, PLAN_MODE_CONTEXT_TYPE } from "./prompts.ts";
import { showStageDialog } from "./stage-dialog.ts";
import {
	PLAN_MODE_STATE_ENTRY,
	acceptFastOptimization,
	approveExecution,
	beginFastOptimization,
	completeWorkflow,
	createInitialState,
	enterPlanning,
	exitPlanning,
	getStageTaskIds,
	hasDurableFeedbackPending,
	recordInvalidSubmission,
	requestRevision,
	resetInvalidSubmissions,
	resolveStageCheckpoint,
	resumeExecution,
	restoreFastOptimization,
	restoreLatestState,
	submitPlan,
} from "./state.js";
import type { PlanModeState, TransitionResult } from "./state.ts";
import { runTuicrPlanReview, type TuicrPlanReviewResult } from "./tuicr-plan-review.ts";

const GATED_MODES = new Set(["planning", "approval"]);
const MAX_INVALID_SUBMISSIONS = 3;
const MAX_VALIDATION_DETAIL_ROWS = 12;
const SRT_ROUTING_VERIFY_TOOLS_EVENT = "srt-tool-routing:verify-tools";
const SRT_ROUTING_BEFORE_USER_BASH_EVENT = "srt-tool-routing:before-user-bash";
const SRT_ROUTING_BUILTINS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

function isGated(state: PlanModeState): boolean {
	return GATED_MODES.has(state.mode);
}

interface ValidationDetailRow {
	code: string;
	line?: number;
	message: string;
}

function validationDetailRows(error: unknown): ValidationDetailRow[] | undefined {
	if (!(error instanceof PlanStoreError) || !Array.isArray(error.details)) return undefined;
	const rows = error.details
		.filter((item): item is { code?: unknown; line?: unknown; message?: unknown } => typeof item === "object" && item !== null && typeof item.message === "string")
		.slice(0, MAX_VALIDATION_DETAIL_ROWS)
		.map((item) => ({
			code: typeof item.code === "string" && item.code ? item.code : error.code,
			...(typeof item.line === "number" ? { line: item.line } : {}),
			message: item.message,
		}));
	return rows.length > 0 ? rows : undefined;
}

function formatStoreError(error: unknown): string {
	if (!(error instanceof PlanStoreError)) {
		return error instanceof Error ? error.message : String(error);
	}
	const details = validationDetailRows(error);
	if (details) {
		const lines = details.map((item) =>
			`- [${item.code}] ${item.line !== undefined ? `Line ${item.line}: ` : ""}${item.message}`,
		);
		const remainder = error.details.length - details.length;
		if (remainder > 0) lines.push(`- …and ${remainder} more validation error(s)`);
		return `${error.message}:\n${lines.join("\n")}`;
	}
	return `${error.code}: ${error.message}`;
}

interface PlanModeDependencies {
	runPlanReview?: (ctx: ExtensionContext, canonicalPlanPath: string, validatedPlan: string) => Promise<TuicrPlanReviewResult>;
	modelDefaults?: ModelDefaultsBoundary;
}

function hasExplicitCliModel(): boolean {
	return process.argv.some((argument) => argument === "--model" || argument.startsWith("--model="));
}

export default function planModeExtension(pi: ExtensionAPI, dependencies: PlanModeDependencies = {}): void {
	let state = createInitialState() as PlanModeState;
	let executionContract: ExecutionContract | null = null;
	let modelRouting: ModelRoutingState | null = null;
	let applyingModelProfile = false;
	const modelDefaults = dependencies.modelDefaults ?? createSettingsModelDefaults();
	const explicitCliModel = hasExplicitCliModel();
	let lastContext: ExtensionContext | undefined;
	let approvedPlanMarkdown: string | null = null;
	let rejectedExecutionRestore = false;
	let presentingApproval = false;
	let presentingCheckpoint = false;
	registerPlanRenderer(pi);

	pi.registerFlag("plan", {
		description: "Start in planning mode",
		type: "boolean",
		default: false,
	});

	function persistState(): void {
		pi.appendEntry(PLAN_MODE_STATE_ENTRY, state);
	}

	function commitState(next: PlanModeState): void {
		state = next;
		persistState();
	}

	function commitTransition(result: TransitionResult): boolean {
		if (!result.ok) return false;
		commitState(result.state);
		return true;
	}

	function persistModelRouting(): void {
		if (modelRouting) pi.appendEntry(PLAN_MODE_MODEL_ROUTING_ENTRY, modelRouting);
	}

	function notifyRoutingFallback(ctx: ExtensionContext, fallback?: string): void {
		if (fallback && ctx.hasUI) ctx.ui.notify(`Plan mode: ${fallback}.`, "warning");
	}

	function initializeModelRouting(ctx: ExtensionContext): void {
		if (modelRouting) return;
		const thinkingLevel = typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : ctx.thinkingLevel;
		const current = captureModelProfile(ctx.model, thinkingLevel);
		if (!current) return;
		if (explicitCliModel) {
			modelRouting = { version: 1, planning: current, inference: current };
			persistModelRouting();
			return;
		}
		const configured = modelDefaults.load(thinkingLevel);
		if (configured.profiles) {
			const planning = configured.profiles.planning;
			const inference = configured.profiles.inference;
			const missing = [planning, inference].find((profile) => !ctx.modelRegistry.find(profile.provider, profile.modelId));
			if (!missing) {
				modelRouting = createModelRoutingState(planning, ctx.modelRegistry, inference).state;
				persistModelRouting();
				return;
			}
			if (ctx.hasUI) ctx.ui.notify(`Plan mode: configured ${missing === planning ? "planning" : "implementation"} model ${missing.provider}/${missing.modelId} is unavailable; keeping the current model.`, "warning");
		} else if (configured.warning && ctx.hasUI) {
			ctx.ui.notify(`Plan mode: ${configured.warning}`, "warning");
		}
		const resolved = createModelRoutingState(current, ctx.modelRegistry);
		modelRouting = resolved.state;
		persistModelRouting();
		notifyRoutingFallback(ctx, resolved.fallback);
	}

	async function persistDurableDefaults(ctx: ExtensionContext): Promise<boolean> {
		if (!modelRouting) return false;
		try {
			await modelDefaults.persist({ planning: modelRouting.planning, inference: modelRouting.inference });
			return true;
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Plan mode: model defaults could not be saved; the active model changed but its durable default did not: ${error instanceof Error ? error.message : String(error)}`, "warning");
			return false;
		}
	}

	async function applyModelProfile(ctx: ExtensionContext, profile: ModelProfile | undefined, label: string): Promise<void> {
		if (!profile) return;
		const model = ctx.modelRegistry.find(profile.provider, profile.modelId);
		if (!model) {
			if (ctx.hasUI) ctx.ui.notify(`Plan mode: ${label} model ${profile.provider}/${profile.modelId} is unavailable; keeping the current model.`, "warning");
			return;
		}
		applyingModelProfile = true;
		try {
			if (ctx.model?.provider !== model.provider || ctx.model.id !== model.id) {
				const changed = await pi.setModel(model);
				if (!changed) {
					if (ctx.hasUI) ctx.ui.notify(`Plan mode: no credentials for ${profile.provider}/${profile.modelId}; keeping the current model.`, "warning");
					return;
				}
				await persistDurableDefaults(ctx);
			}
			pi.setThinkingLevel(profile.thinkingLevel);
		} finally {
			applyingModelProfile = false;
		}
	}

	function allToolNames(): string[] {
		return pi.getAllTools().map((tool) => tool.name);
	}

	function snapshotOriginalTools(): string[] {
		return snapshotActiveTools(pi.getActiveTools());
	}

	function planningToolNames(): string[] {
		const names = getPlanningToolNames(allToolNames(), { fastOptimization: state.optimization !== null });
		return state.mode === "planning" && state.counters.invalidSubmissions >= MAX_INVALID_SUBMISSIONS
			? names.filter((name) => name !== "submit_plan")
			: names;
	}

	function verifySandboxToolComposition(stage: string): void {
		const payload: { stage: string; error?: string } = { stage };
		pi.events.emit(SRT_ROUTING_VERIFY_TOOLS_EVENT, payload);
		if (!payload.error) return;
		pi.setActiveTools(pi.getActiveTools().filter((name) => !SRT_ROUTING_BUILTINS.has(name)));
		throw new Error(`Plan mode SRT tool routing tool verification failed after ${stage}: ${payload.error}`);
	}

	function applyPlanningGate(): void {
		pi.setActiveTools(planningToolNames());
		verifySandboxToolComposition("planning gate");
	}

	function hideWorkflowTools(): void {
		pi.setActiveTools(pi.getActiveTools().filter((name) => !WORKFLOW_TOOLS.has(name)));
		verifySandboxToolComposition("workflow-tool hide");
	}

	function restoreOriginalTools(ctx: ExtensionContext): void {
		const { restored, missing } = getRestorableTools(state.originalActiveTools, allToolNames());
		pi.setActiveTools(restored);
		verifySandboxToolComposition("original-tool restore");
		if (missing.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`Plan mode: tools no longer registered and not restored: ${missing.join(", ")}`, "warning");
		}
	}

	function updateStatus(ctx: ExtensionContext): void {
		lastContext = ctx;
		pi.events.emit(PLAN_MODE_WORKFLOW_STATE_EVENT, {
			mode: state.mode,
			feedbackPending: hasDurableFeedbackPending(state),
		});
		if (!ctx.hasUI) return;
		if (state.mode === "planning") {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "plan:planning"));
		} else if (state.mode === "approval") {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", "plan:approval"));
		} else if (state.mode === "executing_all" || state.mode === "executing_staged") {
			const completed = Object.values(state.ledger).filter((item) => item.status === "completed").length;
			const total = Object.keys(state.ledger).length;
			const paused = state.execution?.paused ? ":paused" : "";
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `plan:${completed}/${total}${paused}`));
			ctx.ui.setWidget("plan-mode-ledger", buildProgressRows(state));
			return;
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}
		ctx.ui.setWidget("plan-mode-ledger", undefined);
	}

	function applyExecutionTools(ctx?: ExtensionContext): void {
		const { active, missing } = getExecutionToolNames(state, allToolNames());
		pi.setActiveTools(active);
		verifySandboxToolComposition("execution-tool transition");
		if (missing.length > 0 && ctx?.hasUI) ctx.ui.notify(`Plan execution skipped missing tools: ${missing.join(", ")}`, "warning");
	}

	function refreshWorkflowUI(ctx: ExtensionContext): void {
		if (state.mode === "executing_all" || state.mode === "executing_staged") applyExecutionTools(ctx);
		else if (state.mode === "completed" || state.mode === "blocked") restoreOriginalTools(ctx);
		updateStatus(ctx);
	}

	registerExecutionTools(pi, {
		getState: () => state,
		getContract: () => executionContract,
		commit: (result) => { commitTransition(result); },
		commitState,
		refreshUI: refreshWorkflowUI,
	});

	async function startPlanning(ctx: ExtensionContext, goal: string): Promise<void> {
		initializeModelRouting(ctx);
		if (state.mode === "planning") {
			applyPlanningGate();
			await applyModelProfile(ctx, modelRouting?.planning, "planning");
			if (goal) pi.sendUserMessage(`Planning goal: ${goal}`);
			else if (ctx.hasUI) ctx.ui.notify("Planning mode is already active.", "info");
			return;
		}
		const result = enterPlanning(state, snapshotOriginalTools()) as TransitionResult;
		if (!result.ok) {
			if (ctx.hasUI) ctx.ui.notify(result.error.message, "warning");
			return;
		}
		commitTransition(result);
		applyPlanningGate();
		updateStatus(ctx);
		await applyModelProfile(ctx, modelRouting?.planning, "planning");
		if (ctx.hasUI) ctx.ui.notify("Planning mode enabled. Mutation tools are gated.", "info");
		if (goal) pi.sendUserMessage(`Planning goal: ${goal}`);
	}

	async function stopPlanning(ctx: ExtensionContext): Promise<void> {
		if (state.optimization) {
			const restored = restoreFastOptimization(state) as TransitionResult;
			if (restored.ok) {
				commitTransition(restored);
				applyPlanningGate();
				updateStatus(ctx);
				if (ctx.hasUI) ctx.ui.notify("Fast optimization stopped. The original approval is available again.", "info");
				return;
			}
		}
		const result = exitPlanning(state) as TransitionResult;
		if (!result.ok) {
			if (ctx.hasUI) ctx.ui.notify(result.error.message, "warning");
			return;
		}
		// Restore against the pre-transition snapshot before replacing state.
		restoreOriginalTools(ctx);
		commitTransition(result);
		updateStatus(ctx);
		await applyModelProfile(ctx, modelRouting?.inference, "inference");
		if (ctx.hasUI) ctx.ui.notify("Planning mode disabled. Original tools restored.", "info");
	}

	async function togglePlanning(ctx: ExtensionContext): Promise<void> {
		if (isGated(state)) await stopPlanning(ctx);
		else await startPlanning(ctx, "");
	}

	pi.events.on(PLAN_MODE_DIRECT_TOGGLE_EVENT, () => {
		if (lastContext) void togglePlanning(lastContext);
	});

	pi.registerCommand("plan", {
		description: "Enter planning mode with an optional goal; use /plan off to exit",
		handler: async (args, ctx) => {
			const value = args?.trim() ?? "";
			if (value.toLowerCase() === "off") {
				await stopPlanning(ctx);
				return;
			}
			if (state.mode === "approval") {
				if (ctx.hasUI) ctx.ui.notify(
					state.approval?.consumed
						? "This plan was already handed off for implementation in this session. Use /plan off to start a new planning run."
						: "A plan is awaiting approval. Use /plan-actions to reopen its actions or /plan off.",
					"info",
				);
				return;
			}
			await startPlanning(ctx, value);
		},
	});

	async function readApprovedPlan(ctx: ExtensionContext): Promise<string> {
		if (!state.plan) throw new Error("No approved plan is active");
		try {
			const markdown = await readFile(state.plan.path, "utf8");
			const hash = createHash("sha256").update(markdown, "utf8").digest("hex");
			if (hash !== state.plan.hash) throw new PlanStoreError("revision_drift", "The saved plan changed since its validated revision");
			return markdown;
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" || !approvedPlanMarkdown) throw error;
			const restored = await restorePlanFile({
				cwd: ctx.cwd,
				configDirName: CONFIG_DIR_NAME,
				path: state.plan.path,
				markdown: approvedPlanMarkdown,
				expectedHash: state.plan.hash,
				title: state.plan.title,
			});
			if (restored.restored && ctx.hasUI) ctx.ui.notify("Recovered the missing plan file from the validated transcript copy.", "warning");
			return approvedPlanMarkdown;
		}
	}

	async function queueInPlaceExecution(
		ctx: ExtensionContext,
		next: PlanModeState,
		approvedMarkdown: string,
		mode: "all" | "staged",
	): Promise<void> {
		if (!next.plan) return;
		const runId = randomBytes(18).toString("base64url");
		if (next.execution) {
			next.execution.startedAt = new Date().toISOString();
			next.execution.parentSessionPath = null;
			next.execution.runId = runId;
		}
		const workerProfile = modelRouting?.inference ?? captureModelProfile(ctx.model, pi.getThinkingLevel());
		const contract: InPlaceExecutionContract = {
			version: 2,
			handoff: "in_place",
			runId,
			approvedMarkdown,
			planPath: next.plan.path,
			planHash: next.plan.hash,
			executionMode: mode,
			executionStrategy: next.execution?.strategy ?? "standard",
			...(workerProfile ? { workerModel: `${workerProfile.provider}/${workerProfile.modelId}`, workerThinkingLevel: "high" as const } : {}),
			originalActiveTools: [...next.originalActiveTools],
			sessionPath: ctx.sessionManager.getSessionFile() ?? null,
			boundaryHash: "",
		};
		contract.boundaryHash = hashExecutionBoundary(buildExecutionKickoff(contract, next));
		pi.appendEntry(EXECUTION_ENTRY, contract);
		executionContract = contract;
		commitState(next);
		applyExecutionTools(ctx);
		updateStatus(ctx);
		await applyModelProfile(ctx, modelRouting?.inference, "inference");
		const boundary = buildExecutionBoundaryMessage(contract, next);
		try {
			pi.sendMessage({
				customType: boundary.customType,
				content: boundary.content,
				display: boundary.display,
				details: boundary.details,
			}, { triggerTurn: true, deliverAs: "followUp" });
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Execution boundary delivery was interrupted; the persisted approved contract will be restored on the next turn: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}

	async function handoffExecution(ctx: ExtensionContext, nonce: string, mode: "all" | "staged"): Promise<void> {
		if (!state.plan) return;
		let approvedMarkdown: string;
		try {
			approvedMarkdown = await readApprovedPlan(ctx);
		} catch (error) {
			ctx.ui.notify(`The approved plan is unavailable: ${formatStoreError(error)}`, "error");
			return;
		}
		const transition = approveExecution(state, nonce, mode) as TransitionResult;
		if (!transition.ok) { ctx.ui.notify(transition.error.message, "warning"); return; }
		await queueInPlaceExecution(ctx, structuredClone(transition.state), approvedMarkdown, mode);
	}

	async function startFastOptimization(ctx: ExtensionContext, nonce: string): Promise<void> {
		if (!state.plan) return;
		if (!state.originalActiveTools.includes("subagent")) {
			if (ctx.hasUI) ctx.ui.notify("Implement (fast) requires subagent in the original active-tool snapshot. The approval remains pending.", "error");
			return;
		}
		if (!modelRouting?.inference && !ctx.model) {
			if (ctx.hasUI) ctx.ui.notify("Implement (fast) requires a concrete inference model for worker routing. The approval remains pending.", "error");
			return;
		}
		let sourceMarkdown: string;
		try {
			sourceMarkdown = await readApprovedPlan(ctx);
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`The approved plan is unavailable: ${formatStoreError(error)}`, "error");
			return;
		}
		const parsed = parsePlanDocument(sourceMarkdown);
		if (!parsed.ok) {
			if (ctx.hasUI) ctx.ui.notify("Implement (fast) requires a valid canonical plan. The approval remains pending.", "error");
			return;
		}
		const transition = beginFastOptimization(state, nonce, parsed.document.parts.map((part) => part.id)) as TransitionResult;
		if (!transition.ok) {
			if (ctx.hasUI) ctx.ui.notify(transition.error.message, "warning");
			return;
		}
		commitTransition(transition);
		applyPlanningGate();
		updateStatus(ctx);
		await applyModelProfile(ctx, modelRouting?.planning, "planning");
		pi.sendUserMessage(buildFastOptimizationPrompt(state, sourceMarkdown));
	}

	async function requestPlanChange(ctx: ExtensionContext, nonce: string, text: string): Promise<void> {
		try {
			await readApprovedPlan(ctx);
		} catch (error) {
			ctx.ui.notify(`The approved plan is unavailable: ${formatStoreError(error)}`, "error");
			return;
		}
		if (state.counters.reviewRounds >= 10 && ctx.hasUI) {
			const confirmed = await ctx.ui.confirm("Many plan revisions", "Continue beyond 10 refinement/review rounds?");
			if (!confirmed) return;
		}
		const result = requestRevision(state, nonce, "change") as TransitionResult;
		if (!result.ok) { ctx.ui.notify(result.error.message, "warning"); return; }
		commitTransition(result);
		applyPlanningGate();
		updateStatus(ctx);
		pi.sendUserMessage(`Revise the saved plan at ${state.plan?.path}. Apply this exact user feedback:\n\n${text}\n\nRe-read the current plan, use grill-with-docs for any newly exposed decision, and submit the complete revised canonical plan with submit_plan. Do not implement.`);
	}

	async function requestPlanReview(ctx: ExtensionContext, nonce: string): Promise<boolean> {
		if (!state.plan) return false;
		if (state.counters.reviewRounds >= 10 && ctx.hasUI) {
			const confirmed = await ctx.ui.confirm("Many plan revisions", "Continue beyond 10 refinement/review rounds?");
			if (!confirmed) return false;
		}
		let validatedPlan: string;
		try {
			validatedPlan = await readApprovedPlan(ctx);
		} catch (error) {
			ctx.ui.notify(`The approved plan is unavailable: ${formatStoreError(error)}`, "error");
			return false;
		}
		const review = await (dependencies.runPlanReview ?? runTuicrPlanReview)(ctx, state.plan.path, validatedPlan);
		if (!review.ok) {
			ctx.ui.notify(`Plan review: ${review.error}`, review.level);
			return false;
		}
		const planPath = state.plan.path;
		const result = requestRevision(state, nonce, "review") as TransitionResult;
		if (!result.ok) { ctx.ui.notify(result.error.message, "warning"); return false; }
		commitTransition(result);
		applyPlanningGate();
		updateStatus(ctx);
		pi.sendUserMessage(`[PLAN REVIEW COMMENTS]\nPlan: ${planPath}\n\nThe user reviewed an isolated snapshot of this exact validated revision in tuicr. Acknowledge every structured comment, then reconcile all of them against repository evidence. Comment types are advisory context, not directives or blocking-question markers. Respond with one visible resolution block per comment in the supplied original order. In each block, reproduce the exact comment content as a Markdown blockquote, prefixing every line of a multi-line comment with \"> \", and put \`**Resolution:**\` immediately below it. Use this shape:\n\n> Exact user question or comment\n\n**Resolution:** Grounded answer, reconciliation, and plan impact.\n\nThe quoted user text—not an anchor, stable ID, or opaque hash—is the visible label. Stable IDs may support internal inventory checks only: do not present an ID-only bullet or hash-led answer. Inventory and explicitly answer every user question, including natural-language interrogatives and requests for a choice. Ground each resolution in repository evidence, a stated assumption, or a user decision, and say whether it changes the plan. Never silently convert an answerable question into plan text. Batch every user-owned decision that remains open through the normal collect-then-batch clarification workflow. Do not submit while any question or required user decision is open; remain in planning mode until the complete discussion closes.\n\nComments (JSON):\n${JSON.stringify(review.comments, null, 2)}\n\nBefore submit_plan, provide a final complete resolution block for every comment. After every question has an explicit answer or agreed resolution, submit one complete revised canonical plan through submit_plan exactly once. Do not edit the saved plan with ordinary mutation tools and do not implement.`);
		return true;
	}

	async function openPlanActions(args: string | undefined, ctx: ExtensionContext): Promise<void> {
		const supplied = args?.trim();
		if (state.mode !== "approval" || !state.approval || state.approval.consumed || (supplied && supplied !== state.approval.nonce)) {
			if (ctx.hasUI) ctx.ui.notify("No matching plan approval is pending.", "warning");
			return;
		}
		if (!ctx.hasUI) return;
		const nonce = state.approval.nonce;
		if (!state.approval.presented) {
			const next = structuredClone(state);
			next.approval!.presented = true;
			commitState(next);
		}
		for (;;) {
			const choice = await showPlanActionDialog(ctx);
			if (choice.action === "cancel") return;
			if (choice.action === "run" || choice.action === "staged") {
				await handoffExecution(ctx, nonce, choice.action === "run" ? "all" : "staged");
				return;
			}
			if (choice.action === "fast") {
				await startFastOptimization(ctx, nonce);
				return;
			}
			if (choice.action === "change") { await requestPlanChange(ctx, nonce, choice.text); return; }
			if (choice.action === "review" && await requestPlanReview(ctx, nonce)) return;
		}
	}

	pi.registerCommand("plan-actions", {
		description: "Open actions for the currently submitted plan",
		handler: async (args, ctx) => {
			await openPlanActions(args, ctx);
		},
	});

	async function openStageActions(args: string | undefined, ctx: ExtensionContext): Promise<void> {
			const supplied = args?.trim();
			if (state.mode !== "executing_staged" || !state.checkpoint || (supplied && supplied !== state.checkpoint.nonce)) {
				if (ctx.hasUI) ctx.ui.notify("No matching stage checkpoint is pending.", "warning");
				return;
			}
			if (!ctx.hasUI) return;
			if (!state.checkpoint.presented) {
				const next = structuredClone(state);
				next.checkpoint!.presented = true;
				commitState(next);
			}
			const nonce = state.checkpoint.nonce;
			for (;;) {
				const stageId = state.checkpoint?.stageId;
				if (!stageId) return;
				const finalStage = state.plan?.stageIds.at(-1) === stageId;
				const choice = await showStageDialog(ctx, finalStage);
				if (choice.action === "cancel") return;
				if (choice.action === "review") {
					const summary = state.completedStages.find((item) => item.stageId === stageId);
					const stageTaskIds = new Set(getStageTaskIds(state, stageId));
					const ledger = Object.entries(state.ledger).filter(([id]) => stageTaskIds.has(id));
					pi.appendEntry(STAGE_SUMMARY_ENTRY, {
						markdown: `# Stage ${stageId} checkpoint\n\n${summary?.summary ?? "No summary"}\n\n## Changed files\n${summary?.changedFiles.map((file) => `- ${file}`).join("\n") || "- None"}\n\n## Tests\n${summary?.tests.map((test) => `- ${test}`).join("\n") || "- None"}\n\n## Ledger\n${ledger.map(([id, item]) => `- **${id}** — ${item.status}: ${item.note ?? item.evidence ?? ""}`).join("\n")}`,
					});
					continue;
				}
				if (choice.action === "stop") {
					const result = resolveStageCheckpoint(state, nonce, "stop") as TransitionResult;
					if (!result.ok) { ctx.ui.notify(result.error.message, "warning"); return; }
					commitTransition(result); applyExecutionTools(ctx); updateStatus(ctx);
					ctx.ui.notify("Plan execution paused. Use /plan-resume to continue in this session.", "info");
					return;
				}
				if (choice.action === "feedback") {
					const result = resolveStageCheckpoint(state, nonce, "feedback") as TransitionResult;
					if (!result.ok) { ctx.ui.notify(result.error.message, "warning"); return; }
					commitTransition(result); applyExecutionTools(ctx); updateStatus(ctx);
					pi.sendUserMessage(`User feedback for Stage ${stageId}:\n\n${choice.text}\n\nApply these fixes before advancing. Reopen each affected completed task with plan_progress and an explicit reopenReason tied to this feedback, then complete the stage and call complete_stage again.`);
					return;
				}
				if (finalStage) {
					const hasBlocked = Object.values(state.ledger).some((item) => item.status === "blocked");
					let blockedReason: string | undefined;
					if (hasBlocked) {
						blockedReason = await ctx.ui.input("Blocked stopping criterion", "Explain why the plan may terminate with blocked tasks");
						if (!blockedReason?.trim()) { ctx.ui.notify("Blocked completion requires an explicit stopping-criterion reason.", "warning"); continue; }
					}
					const result = completeWorkflow(state, { allowBlocked: hasBlocked }) as TransitionResult;
					if (!result.ok) { ctx.ui.notify(result.error.message, "warning"); return; }
					const next = structuredClone(result.state);
					next.blockedReason = blockedReason?.trim() || null;
					next.testEvidence = state.completedStages.flatMap((stage) => stage.tests.map((command) => ({ command, result: "passed" as const, summary: stage.summary })));
					commitState(next); restoreOriginalTools(ctx); updateStatus(ctx);
					ctx.ui.notify("Approved plan execution completed.", "info");
					return;
				}
				const result = resolveStageCheckpoint(state, nonce, "continue") as TransitionResult;
				if (!result.ok) { ctx.ui.notify(result.error.message, "warning"); return; }
				commitTransition(result); applyExecutionTools(ctx); updateStatus(ctx);
				pi.sendUserMessage(buildStageInstruction(state));
				return;
			}
	}

	pi.registerCommand("plan-stage-actions", {
		description: "Open the mandatory staged-execution checkpoint",
		handler: async (args, ctx) => {
			await openStageActions(args, ctx);
		},
	});

	pi.registerCommand("plan-resume", {
		description: "Resume a paused approved-plan execution",
		handler: async (_args, ctx) => {
			if ((state.mode !== "executing_all" && state.mode !== "executing_staged") || !state.execution?.paused) {
				if (ctx.hasUI) ctx.ui.notify("No paused plan execution is available in this session.", "warning");
				return;
			}
			const result = resumeExecution(state) as TransitionResult;
			if (!result.ok) return;
			commitTransition(result); applyExecutionTools(ctx); updateStatus(ctx);
			pi.sendUserMessage(state.mode === "executing_staged" ? buildStageInstruction(state) : "Resume the approved plan from the current ledger. Continue until complete_plan or a declared stopping criterion.");
		},
	});

	pi.registerShortcut("shift+tab", {
		description: "Toggle planning mode",
		handler: async (ctx) => {
			await togglePlanning(ctx);
		},
	});

	pi.registerTool({
		name: "submit_plan",
		label: "Submit Plan",
		description:
			"Validate and atomically save a complete canonical planning-mode Markdown document under the current project's .pi/plans directory, then request user approval.",
		promptSnippet: "Submit the complete validated planning document for approval",
		promptGuidelines: [
			"Use submit_plan only as the final action in Pi planning mode, and include the entire canonical Markdown document.",
		],
		parameters: Type.Object({
			intent: Type.String({ description: "Short intent used to derive the safe plan filename", minLength: 1, maxLength: 16_384 }),
			title: Type.String({ description: "Exact H1 title from the Markdown plan", minLength: 1, maxLength: 512 }),
			markdown: Type.String({ description: "Complete canonical Markdown plan", minLength: 1, maxLength: 262_144 }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (state.mode !== "planning") {
				return {
					content: [{ type: "text", text: `submit_plan is unavailable while workflow mode is ${state.mode}.` }],
					details: { accepted: false, mode: state.mode },
				};
			}
			if (state.counters.invalidSubmissions >= MAX_INVALID_SUBMISSIONS) {
				return {
					content: [{ type: "text", text: "Three submissions failed. Wait for new user input before retrying submit_plan." }],
					details: { accepted: false, retryLimitReached: true },
				};
			}

			try {
				const optimizing = state.optimization !== null;
				let sourceMarkdown: string;
				if (optimizing) {
					try {
						sourceMarkdown = await readApprovedPlan(ctx);
					} catch (error) {
						const restored = restoreFastOptimization(state) as TransitionResult;
						if (restored.ok) commitTransition(restored);
						applyPlanningGate();
						return {
							content: [{ type: "text", text: `Fast optimization lost its approved source: ${formatStoreError(error)}. The original approval was restored without execution.` }],
							details: { accepted: false, fast: true, restoredApproval: restored.ok },
						};
					}
					const equivalent = validateFastPlanRevision(sourceMarkdown, params.markdown);
					if (!equivalent.ok) {
						throw new PlanStoreError("fast_revision_invalid", "Fast revision changed approved scope or has an invalid parallel schedule", equivalent.errors);
					}
				}
				const stored = await persistPlan({
					cwd: ctx.cwd,
					configDirName: CONFIG_DIR_NAME,
					intent: params.intent,
					title: params.title,
					markdown: params.markdown,
					existingPlan: state.plan ? { path: state.plan.path, hash: state.plan.hash } : null,
				});
				const nonce = randomBytes(18).toString("base64url");
				const stages = stored.document.stages.map((stage) => ({
					id: stage.id,
					description: stage.description,
					taskIds: stage.stepIds,
					...(stage.parallelExecution ? {
						parallelExecution: {
							wave: stage.parallelExecution.wave,
							workerId: stage.parallelExecution.worker,
							sourcePartId: stage.parallelExecution.sourcePartId,
							dependencies: stage.parallelExecution.dependencies,
							ownership: stage.parallelExecution.ownership,
						},
					} : {}),
				}));
				const tasks = getDocumentProgressTasks(stored.document)
					.map((task) => ({ id: task.id, title: task.title, status: task.status }));
				const submission = {
					path: stored.path,
					slug: stored.slug,
					hash: stored.hash,
					title: stored.document.title,
					intent: params.intent.trim(),
					approvalNonce: nonce,
					executionStrategy: optimizing ? "parallel" : "standard",
					stages,
					tasks,
				};
				const result = (optimizing
					? acceptFastOptimization(state, submission)
					: submitPlan(state, submission)) as TransitionResult;
				if (!result.ok) throw new PlanStoreError(result.error.code, result.error.message);

				approvedPlanMarkdown = stored.markdown;
				pi.appendEntry(PLAN_DISPLAY_ENTRY, {
					markdown: stored.markdown,
					path: stored.path,
					revision: result.state.plan?.revision ?? 1,
					hash: stored.hash,
				});
				if (optimizing) {
					await queueInPlaceExecution(ctx, structuredClone(result.state), stored.markdown, "all");
					return {
						content: [{ type: "text", text: `Validated fast revision and saved it to ${stored.path}. Parallel execution has started without another approval dialog.` }],
						details: { accepted: true, fast: true, path: stored.path, hash: stored.hash, revision: result.state.plan?.revision },
						terminate: true,
					};
				}
				commitTransition(result);
				applyPlanningGate();
				updateStatus(ctx);
				return {
					content: [{
						type: "text",
						text: `Validated and saved plan to ${stored.path}. ${ctx.hasUI ? "Approval actions will open automatically." : "This mode does not prompt or execute plans."}`,
					}],
					details: {
						accepted: true,
						path: stored.path,
						hash: stored.hash,
						revision: result.state.plan?.revision,
						stageIds: result.state.plan?.stageIds,
						taskIds: result.state.plan?.taskIds,
					},
					terminate: true,
				};
			} catch (error) {
				const optimizing = state.optimization !== null;
				const validationErrors = validationDetailRows(error);
				const transition = recordInvalidSubmission(state) as TransitionResult;
				if (transition.ok) commitTransition(transition);
				const attempts = state.counters.invalidSubmissions;
				const retryLimitReached = attempts >= MAX_INVALID_SUBMISSIONS;
				if (optimizing && retryLimitReached) {
					const restored = restoreFastOptimization(state) as TransitionResult;
					if (restored.ok) commitTransition(restored);
					applyPlanningGate();
					return {
						content: [{ type: "text", text: `${formatStoreError(error)}\nFast optimization reached its invalid-submission limit. The original approval was restored without execution.` }],
						details: { accepted: false, fast: true, attempts, retryLimitReached: true, restoredApproval: restored.ok, ...(validationErrors ? { validationErrors } : {}) },
					};
				}
				applyPlanningGate();
				return {
					content: [{
						type: "text",
						text: `${formatStoreError(error)}\nSubmission rejected; planning mode remains active. Attempt ${attempts}/${MAX_INVALID_SUBMISSIONS}.${retryLimitReached ? " Wait for user input before retrying." : " Correct the errors and resubmit the complete plan."}`,
					}],
					details: { accepted: false, attempts, retryLimitReached, fast: optimizing, ...(validationErrors ? { validationErrors } : {}) },
				};
			}
		},
	});

	pi.on("model_select", async (event, ctx) => {
		if (applyingModelProfile || !modelRouting || (event.source !== "set" && event.source !== "cycle")) return;
		const selected = captureModelProfile(event.model, pi.getThinkingLevel());
		if (!selected) return;
		const key = isGated(state) ? "planning" : "inference";
		modelRouting = { ...modelRouting, [key]: selected };
		persistModelRouting();
		await persistDurableDefaults(ctx);
	});

	pi.on("thinking_level_select", async (event) => {
		if (applyingModelProfile || !modelRouting) return;
		const key = isGated(state) ? "planning" : "inference";
		modelRouting = {
			...modelRouting,
			[key]: { ...modelRouting[key], thinkingLevel: event.level },
		};
		persistModelRouting();
	});

	pi.on("tool_call", async (event) => {
		if (!isGated(state)) return;
		const reason = evaluatePlanningToolCall(event.toolName, event.input, allToolNames(), { fastOptimization: state.optimization !== null });
		if (reason) return { block: true, reason };
	});

	function evaluatePlanningUserBash(command: string) {
		if (!isGated(state)) return;
		const analysis = analyzeBashMutation(command);
		if (!analysis.blocked) return;
		return {
			result: {
				output: `Planning mode blocked a known-mutating shell command (${analysis.reason}: ${analysis.detail}).`,
				exitCode: 126,
				cancelled: false,
				truncated: false,
			},
		};
	}

	// The SRT tool routing user_bash router may load before plan mode. This synchronous
	// preflight runs the same known-mutator policy before that router can issue an
	// execution RPC; the ordinary user_bash hook remains fallback coverage.
	pi.events.on(SRT_ROUTING_BEFORE_USER_BASH_EVENT, (payload: { command?: string; result?: unknown }) => {
		if (typeof payload.command !== "string") return;
		payload.result = evaluatePlanningUserBash(payload.command);
	});

	pi.on("user_bash", async (event) => evaluatePlanningUserBash(event.command));

	pi.on("input", async (event) => {
		if (event.source === "extension" || state.mode !== "planning" || state.counters.invalidSubmissions === 0) return;
		const result = resetInvalidSubmissions(state) as TransitionResult;
		if (result.ok && result.state !== state) {
			commitTransition(result);
			applyPlanningGate();
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (isGated(state)) {
			applyPlanningGate();
			if (state.mode === "planning") return { systemPrompt: `${event.systemPrompt}\n\n${state.optimization ? "Fast optimization is active. Follow its dedicated source-preserving prompt." : buildPlanningPrompt(state)}` };
			return;
		}
		if (state.mode === "executing_all" || state.mode === "executing_staged") applyExecutionTools();
	});

	async function presentPendingWorkflowDecision(ctx: ExtensionContext): Promise<boolean> {
		if (ctx.hasUI && !presentingApproval && state.mode === "approval" && state.approval && !state.approval.consumed && !state.approval.presented) {
			const nonce = state.approval.nonce;
			const next = structuredClone(state);
			next.approval!.presented = true;
			commitState(next);
			presentingApproval = true;
			try {
				await openPlanActions(nonce, ctx);
			} finally {
				presentingApproval = false;
			}
			return true;
		}
		if (ctx.hasUI && !presentingCheckpoint && state.mode === "executing_staged" && state.checkpoint && !state.checkpoint.consumed && !state.checkpoint.presented) {
			const nonce = state.checkpoint.nonce;
			const next = structuredClone(state);
			next.checkpoint!.presented = true;
			commitState(next);
			presentingCheckpoint = true;
			try {
				await openStageActions(nonce, ctx);
			} finally {
				presentingCheckpoint = false;
			}
			return true;
		}
		return false;
	}

	let handlingEarlyIdle = false;
	pi.on("agent_settled", async (_event, ctx) => {
		if (await presentPendingWorkflowDecision(ctx)) return;
		if (state.mode === "planning" && state.optimization && !ctx.hasPendingMessages()) {
			const restored = restoreFastOptimization(state) as TransitionResult;
			if (restored.ok) {
				commitTransition(restored);
				applyPlanningGate();
				updateStatus(ctx);
				if (ctx.hasUI) ctx.ui.notify("Fast optimization ended without an equivalent schedule. The original approval was restored.", "warning");
			}
			return;
		}
		if (handlingEarlyIdle || (state.mode !== "executing_all" && state.mode !== "executing_staged") || state.execution?.paused || state.checkpoint || ctx.hasPendingMessages()) return;
		const relevant = state.mode === "executing_staged"
			? Object.entries(state.ledger).filter(([id]) => getStageTaskIds(state, state.currentStageId).includes(id))
			: Object.entries(state.ledger);
		if (relevant.length > 0 && relevant.every(([, item]) => item.status === "completed" || item.status === "blocked")) {
			// Terminal tasks still require complete_stage/complete_plan; treat idle as early.
		}
		handlingEarlyIdle = true;
		try {
			if (state.counters.recoveryAttempts >= 3 || !ctx.hasUI) {
				const next = structuredClone(state);
				if (next.execution) next.execution.paused = true;
				next.lastAction = "early_idle_paused";
				commitState(next); updateStatus(ctx);
				if (ctx.hasUI) ctx.ui.notify("Plan execution paused after repeated early idle. Use /plan-resume after reviewing the ledger.", "warning");
				return;
			}
			const retry = await ctx.ui.confirm("Plan execution stopped early", "Retry from the current ledger? Cancel pauses the run.");
			const next = structuredClone(state);
			next.counters.recoveryAttempts += 1;
			if (!retry && next.execution) next.execution.paused = true;
			next.lastAction = retry ? "early_idle_retry" : "early_idle_paused";
			commitState(next); updateStatus(ctx);
			if (retry) pi.sendUserMessage(state.mode === "executing_staged" ? buildStageInstruction(state) : "Reconcile the approved plan ledger and continue execution. Call complete_plan only after all tasks and tests are terminal.");
		} finally {
			handlingEarlyIdle = false;
		}
	});

	pi.on("context", async (event) => {
		if (state.mode === "planning") return;
		const messages = event.messages.filter((message) =>
			!(message.role === "custom" && "customType" in message && message.customType === PLAN_MODE_CONTEXT_TYPE));
		if (executionContract && state.execution?.runId === executionContract.runId) {
			return { messages: isolateExecutionMessages(messages, executionContract, state) };
		}
		if (rejectedExecutionRestore) return { messages: [] };
		return { messages };
	});

	async function restoreTaskMetadata(ctx: ExtensionContext): Promise<void> {
		if (!state.plan || state.plan.tasks.length === state.plan.taskIds.length) return;
		let durableMarkdown = executionContract?.approvedMarkdown ?? approvedPlanMarkdown;
		if (!durableMarkdown) {
			try {
				durableMarkdown = await readFile(state.plan.path, "utf8");
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`Plan progress titles could not be restored: ${formatStoreError(error)}`, "error");
				return;
			}
		}
		const parsed = parsePlanDocument(durableMarkdown);
		if (!parsed.ok) {
			if (ctx.hasUI) ctx.ui.notify("Plan progress titles could not be restored from the durable approved plan.", "error");
			return;
		}
		const tasks = getDocumentProgressTasks(parsed.document).map(({ id, title }) => ({ id, title }));
		if (tasks.map((task) => task.id).join("\0") !== state.plan.taskIds.join("\0")) {
			if (ctx.hasUI) ctx.ui.notify("Plan progress titles do not match the durable execution ledger.", "error");
			return;
		}
		const next = structuredClone(state);
		next.plan!.tasks = tasks;
		commitState(next);
	}

	async function backfillExecutionProgressReport(ctx: ExtensionContext): Promise<void> {
		if (!state.plan || (state.mode !== "executing_all" && state.mode !== "executing_staged")) return;
		const approvedMarkdown = executionContract?.approvedMarkdown ?? approvedPlanMarkdown;
		if (!approvedMarkdown) return;
		try {
			await withFileMutationQueue(state.plan.path, async () => {
				let current: string;
				let missing = false;
				try {
					current = await readFile(state.plan!.path, "utf8");
				} catch (error) {
					if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
					current = approvedMarkdown;
					missing = true;
				}
				if (!missing) {
					const parsed = parsePlanDocument(current);
					if (parsed.ok && parsed.document.managedProgressReport) return;
				}
				const next = synchronizeLedgerMarkdown(current, approvedMarkdown, state.ledger);
				await atomicReplaceFile(state.plan!.path, next);
			});
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Plan progress report could not be restored: ${formatStoreError(error)}`, "error");
		}
	}

	async function restoreForContext(ctx: ExtensionContext, honorFlag: boolean): Promise<void> {
		const branch = ctx.sessionManager.getBranch();
		const hasPersistedWorkflow = branch.some(
			(entry) => entry.type === "custom" && entry.customType === PLAN_MODE_STATE_ENTRY,
		);
		state = restoreLatestState(branch) as PlanModeState;
		executionContract = restoreExecutionContract(branch, state);
		rejectedExecutionRestore = (state.mode === "executing_all" || state.mode === "executing_staged") && executionContract === null;
		if (rejectedExecutionRestore) {
			const next = structuredClone(state);
			next.mode = "blocked";
			next.execution = null;
			next.blockedReason = "Execution restoration stopped: the active run has no matching canonical in-place execution contract.";
			next.lastAction = "unsupported_execution_contract";
			state = next;
			commitState(next);
			if (ctx.hasUI) ctx.ui.notify(next.blockedReason, "error");
		}
		modelRouting = restoreLatestModelRouting(branch);
		approvedPlanMarkdown = null;
		if (state.plan) {
			for (let index = branch.length - 1; index >= 0; index -= 1) {
				const entry = branch[index];
				if (entry.type !== "custom" || entry.customType !== PLAN_DISPLAY_ENTRY) continue;
				const data = entry.data as { markdown?: string; path?: string; hash?: string };
				if (data.path === state.plan.path && data.hash === state.plan.hash && typeof data.markdown === "string") {
					approvedPlanMarkdown = data.markdown;
					break;
				}
			}
		}
		await restoreTaskMetadata(ctx);
		await backfillExecutionProgressReport(ctx);
		const inheritedChildPlanning = process.env.PI_SUBAGENT_PLANNING === "1";
		if (honorFlag && !hasPersistedWorkflow && (pi.getFlag("plan") === true || inheritedChildPlanning) && state.mode === "off") {
			const result = enterPlanning(state, snapshotOriginalTools()) as TransitionResult;
			if (result.ok) commitTransition(result);
		}
		if (isGated(state)) applyPlanningGate();
		else if (state.mode === "executing_all" || state.mode === "executing_staged") applyExecutionTools(ctx);
		else if (state.originalActiveTools.length > 0 && ["completed", "blocked"].includes(state.mode)) restoreOriginalTools(ctx);
		else if (state.mode === "off" && state.lastAction === "exit_planning" && state.originalActiveTools.length > 0) restoreOriginalTools(ctx);
		else hideWorkflowTools();
		initializeModelRouting(ctx);
		if (isGated(state)) {
			await applyModelProfile(ctx, modelRouting?.planning, "planning");
		} else if (modelRouting) {
			await applyModelProfile(ctx, modelRouting.inference, "inference");
		}
		updateStatus(ctx);
		const pendingApproval = ctx.hasUI && state.mode === "approval" && state.approval && !state.approval.consumed && !state.approval.presented;
		const pendingCheckpoint = ctx.hasUI && state.mode === "executing_staged" && state.checkpoint && !state.checkpoint.consumed && !state.checkpoint.presented;
		if (pendingApproval || pendingCheckpoint) {
			queueMicrotask(() => {
				presentPendingWorkflowDecision(ctx).catch((error) => {
					ctx.ui.notify(`Plan workflow dialog failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				});
			});
		}
	}

	pi.on("session_start", async (_event, ctx) => restoreForContext(ctx, true));
	pi.on("session_tree", async (_event, ctx) => restoreForContext(ctx, false));
	pi.on("session_shutdown", () => {
		if (lastContext?.hasUI) {
			lastContext.ui.setStatus("plan-mode", undefined);
			lastContext.ui.setWidget("plan-mode-ledger", undefined);
		}
	});
}
