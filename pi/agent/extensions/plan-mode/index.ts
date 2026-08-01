import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { showPlanActionDialog } from "./action-dialog.ts";
import { analyzeBashMutation } from "./bash-policy.js";
import { PLAN_MODE_DIRECT_TOGGLE_EVENT, PLAN_MODE_WORKFLOW_STATE_EVENT } from "./events.ts";
import { editPlanForReview } from "./external-editor.ts";
import {
	EXECUTION_ENTRY,
	buildExecutionKickoff,
	buildStageInstruction,
	getExecutionToolNames,
	registerExecutionTools,
	restoreExecutionContract,
	type ExecutionContract,
} from "./execution.ts";
import {
	evaluatePlanningToolCall,
	getPlanningToolNames,
	getRestorableTools,
	snapshotActiveTools,
	WORKFLOW_TOOLS,
} from "./planning-gate.js";
import { atomicReplaceFile, persistPlan, PlanStoreError, restorePlanFile } from "./plan-store.js";
import { PLAN_DISPLAY_ENTRY, STAGE_SUMMARY_ENTRY, registerPlanRenderer } from "./plan-renderer.ts";
import { buildStageProgressRows } from "./progress-widget.js";
import { buildPlanningPrompt, PLAN_MODE_CONTEXT_TYPE } from "./prompts.ts";
import { parseReviewAnnotations } from "./review-annotations.js";
import { showStageDialog } from "./stage-dialog.ts";
import {
	PLAN_MODE_STATE_ENTRY,
	approveExecution,
	completeWorkflow,
	createInitialState,
	enterPlanning,
	exitPlanning,
	getStageTaskIds,
	recordInvalidSubmission,
	requestRevision,
	resetInvalidSubmissions,
	resolveStageCheckpoint,
	resumeExecution,
	restoreLatestState,
	submitPlan,
} from "./state.js";
import type { PlanModeState, TransitionResult } from "./state.ts";

const GATED_MODES = new Set(["planning", "approval"]);
const MAX_INVALID_SUBMISSIONS = 3;

function isGated(state: PlanModeState): boolean {
	return GATED_MODES.has(state.mode);
}

function formatStoreError(error: unknown): string {
	if (!(error instanceof PlanStoreError)) {
		return error instanceof Error ? error.message : String(error);
	}
	if (error.code === "validation_failed" && Array.isArray(error.details)) {
		const lines = error.details.slice(0, 12).map((item: { line?: number; message?: string }) =>
			`- ${item.line ? `Line ${item.line}: ` : ""}${item.message ?? "Invalid plan"}`,
		);
		const remainder = error.details.length - lines.length;
		if (remainder > 0) lines.push(`- …and ${remainder} more validation error(s)`);
		return `${error.message}:\n${lines.join("\n")}`;
	}
	return `${error.code}: ${error.message}`;
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let state = createInitialState() as PlanModeState;
	let executionContract: ExecutionContract | null = null;
	let lastContext: ExtensionContext | undefined;
	let approvalCommandContext: ExtensionCommandContext | undefined;
	let pendingApprovalNonce: string | null = null;
	let approvedPlanMarkdown: string | null = null;
	let presentingApproval = false;
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

	function allToolNames(): string[] {
		return pi.getAllTools().map((tool) => tool.name);
	}

	function snapshotOriginalTools(): string[] {
		return snapshotActiveTools(pi.getActiveTools());
	}

	function planningToolNames(): string[] {
		const names = getPlanningToolNames(allToolNames());
		return state.mode === "planning" && state.counters.invalidSubmissions >= MAX_INVALID_SUBMISSIONS
			? names.filter((name) => name !== "submit_plan")
			: names;
	}

	function applyPlanningGate(): void {
		pi.setActiveTools(planningToolNames());
	}

	function hideWorkflowTools(): void {
		pi.setActiveTools(pi.getActiveTools().filter((name) => !WORKFLOW_TOOLS.has(name)));
	}

	function restoreOriginalTools(ctx: ExtensionContext): void {
		const { restored, missing } = getRestorableTools(state.originalActiveTools, allToolNames());
		pi.setActiveTools(restored);
		if (missing.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`Plan mode: tools no longer registered and not restored: ${missing.join(", ")}`, "warning");
		}
	}

	function updateStatus(ctx: ExtensionContext): void {
		lastContext = ctx;
		pi.events.emit(PLAN_MODE_WORKFLOW_STATE_EVENT, { mode: state.mode });
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
			ctx.ui.setWidget("plan-mode-ledger", buildStageProgressRows(state));
			return;
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}
		ctx.ui.setWidget("plan-mode-ledger", undefined);
	}

	function applyExecutionTools(ctx?: ExtensionContext): void {
		const { active, missing } = getExecutionToolNames(state, allToolNames());
		pi.setActiveTools(active);
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

	function startPlanning(ctx: ExtensionContext, goal: string): void {
		if (state.mode === "planning") {
			applyPlanningGate();
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
		if (ctx.hasUI) ctx.ui.notify("Planning mode enabled. Mutation tools are gated.", "info");
		if (goal) pi.sendUserMessage(`Planning goal: ${goal}`);
	}

	function stopPlanning(ctx: ExtensionContext): void {
		const result = exitPlanning(state) as TransitionResult;
		if (!result.ok) {
			if (ctx.hasUI) ctx.ui.notify(result.error.message, "warning");
			return;
		}
		// Restore against the pre-transition snapshot before replacing state.
		restoreOriginalTools(ctx);
		commitTransition(result);
		updateStatus(ctx);
		if (ctx.hasUI) ctx.ui.notify("Planning mode disabled. Original tools restored.", "info");
	}

	function togglePlanning(ctx: ExtensionContext): void {
		if (isGated(state)) stopPlanning(ctx);
		else startPlanning(ctx, "");
	}

	pi.events.on(PLAN_MODE_DIRECT_TOGGLE_EVENT, () => {
		if (lastContext) togglePlanning(lastContext);
	});

	pi.registerCommand("plan", {
		description: "Enter planning mode with an optional goal; use /plan off to exit",
		handler: async (args, ctx) => {
			approvalCommandContext = ctx;
			const value = args?.trim() ?? "";
			if (value.toLowerCase() === "off") {
				stopPlanning(ctx);
				return;
			}
			if (state.mode === "approval") {
				if (ctx.hasUI) ctx.ui.notify(
					state.approval?.consumed
						? "This plan was already handed off to a fresh implementation session. Use /plan off to start a new planning run."
						: "A plan is awaiting approval. Use /plan-actions to reopen its actions or /plan off.",
					"info",
				);
				return;
			}
			startPlanning(ctx, value);
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

	async function handoffExecution(ctx: ExtensionCommandContext, nonce: string, mode: "all" | "staged"): Promise<void> {
		if (!state.plan) return;
		let approvedMarkdown: string;
		try {
			approvedMarkdown = await readApprovedPlan(ctx);
		} catch (error) {
			ctx.ui.notify(`The approved plan is unavailable: ${formatStoreError(error)}`, "error");
			return;
		}
		const approvalState = structuredClone(state);
		const transition = approveExecution(state, nonce, mode) as TransitionResult;
		if (!transition.ok) { ctx.ui.notify(transition.error.message, "warning"); return; }
		const next = structuredClone(transition.state);
		const parentSessionPath = ctx.sessionManager.getSessionFile() ?? null;
		if (next.execution) {
			next.execution.startedAt = new Date().toISOString();
			next.execution.parentSessionPath = parentSessionPath;
		}
		const contract: ExecutionContract = {
			version: 1,
			approvedMarkdown,
			planPath: state.plan.path,
			planHash: state.plan.hash,
			executionMode: mode,
			originalActiveTools: [...state.originalActiveTools],
			parentSessionPath,
		};
		const consumedParent = structuredClone(approvalState);
		if (consumedParent.approval) consumedParent.approval.consumed = true;
		consumedParent.lastAction = `handoff_${mode}`;
		commitState(consumedParent);
		try {
			const result = await ctx.newSession({
				parentSession: parentSessionPath ?? undefined,
				setup: async (sessionManager) => {
					sessionManager.appendCustomEntry(EXECUTION_ENTRY, contract);
					sessionManager.appendCustomEntry(PLAN_MODE_STATE_ENTRY, next);
					sessionManager.appendCustomEntry(PLAN_DISPLAY_ENTRY, {
						markdown: approvedMarkdown, path: contract.planPath, revision: next.plan?.revision ?? 1, hash: contract.planHash,
					});
				},
				withSession: async (replacementCtx) => {
					await replacementCtx.sendUserMessage(buildExecutionKickoff(contract, next));
				},
			});
			if (!result.cancelled) return;
		} catch (error) {
			ctx.ui.notify(`Fresh-session handoff failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
		commitState(approvalState);
		applyPlanningGate();
		updateStatus(ctx);
		ctx.ui.notify("The plan remains pending approval.", "warning");
	}

	async function requestPlanChange(ctx: ExtensionCommandContext, nonce: string, text: string): Promise<void> {
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

	async function requestPlanReview(ctx: ExtensionCommandContext, nonce: string): Promise<boolean> {
		if (!state.plan) return false;
		if (state.counters.reviewRounds >= 10 && ctx.hasUI) {
			const confirmed = await ctx.ui.confirm("Many plan revisions", "Continue beyond 10 refinement/review rounds?");
			if (!confirmed) return false;
		}
		let original: string;
		try {
			original = await readApprovedPlan(ctx);
		} catch (error) {
			ctx.ui.notify(`The approved plan is unavailable: ${formatStoreError(error)}`, "error");
			return false;
		}
		const edited = await editPlanForReview(ctx, state.plan.path, original);
		if (!edited.ok || !edited.changed) {
			ctx.ui.notify(edited.error ? `Review editor failed: ${edited.error}` : "No saved review edits or annotations were found.", edited.error ? "warning" : "info");
			return false;
		}
		const feedback = parseReviewAnnotations(original, edited.content);
		await atomicReplaceFile(state.plan.path, original);
		if (!feedback.hasAnnotations && !feedback.hasDirectEdits) {
			ctx.ui.notify("No review annotations or direct edits were found.", "info");
			return false;
		}
		const result = requestRevision(state, nonce, "review") as TransitionResult;
		if (!result.ok) { ctx.ui.notify(result.error.message, "warning"); return false; }
		commitTransition(result);
		applyPlanningGate();
		updateStatus(ctx);
		const directives = feedback.directives.map((item) => `- [${item.context}] ${item.text}`).join("\n") || "- None";
		const questions = feedback.questions.map((item) => `- [${item.context}] ${item.text || "Ambiguous marker: ask what was intended"}`).join("\n") || "- None";
		const conflicts = feedback.conflicts.map((item) => `- Potential directive/question conflict in ${item.context}: ${item.question}`).join("\n") || "- None";
		pi.sendUserMessage(`[PLAN REVIEW FEEDBACK]\nPlan: ${state.plan?.path}\n\nDirectives:\n${directives}\n\nQuestions that must all be resolved before resubmission:\n${questions}\n\nPotential conflicts:\n${conflicts}\n\nDirect edits present: ${feedback.hasDirectEdits ? "yes" : "no"}\nCleaned edited draft:\n\n${feedback.cleanedMarkdown}\n\nFirst acknowledge what you parsed. Resolve every ? interactively without guessing, reconcile conflicts, strip all annotations, then call submit_plan exactly once with the revised canonical plan. Stay in planning mode.`);
		return true;
	}

	async function openPlanActions(args: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
		const supplied = args?.trim();
		if (state.mode !== "approval" || !state.approval || state.approval.consumed || (supplied && supplied !== state.approval.nonce)) {
			if (ctx.hasUI) ctx.ui.notify("No matching plan approval is pending.", "warning");
			return;
		}
		if (!ctx.hasUI) return;
		const nonce = state.approval.nonce;
		if (pendingApprovalNonce === nonce) pendingApprovalNonce = null;
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
			if (choice.action === "change") { await requestPlanChange(ctx, nonce, choice.text); return; }
			if (choice.action === "review" && await requestPlanReview(ctx, nonce)) return;
		}
	}

	pi.registerCommand("plan-actions", {
		description: "Open actions for the currently submitted plan",
		handler: async (args, ctx) => {
			approvalCommandContext = ctx;
			await openPlanActions(args, ctx);
		},
	});

	pi.registerCommand("plan-stage-actions", {
		description: "Open the mandatory staged-execution checkpoint",
		handler: async (args, ctx) => {
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
			togglePlanning(ctx);
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
				}));
				const tasks = (stored.document.steps ?? stored.document.stages.flatMap((stage) => stage.tasks))
					.map((task) => ({ id: task.id, status: task.status }));
				const result = submitPlan(state, {
					path: stored.path,
					slug: stored.slug,
					hash: stored.hash,
					title: stored.document.title,
					intent: params.intent.trim(),
					approvalNonce: nonce,
					stages,
					tasks,
				}) as TransitionResult;
				if (!result.ok) throw new PlanStoreError(result.error.code, result.error.message);

				commitTransition(result);
				approvedPlanMarkdown = params.markdown;
				applyPlanningGate();
				updateStatus(ctx);
				pi.appendEntry(PLAN_DISPLAY_ENTRY, {
					markdown: params.markdown,
					path: stored.path,
					revision: result.state.plan?.revision ?? 1,
					hash: stored.hash,
				});
				const autoOpenApproval = ctx.hasUI && approvalCommandContext !== undefined;
				if (autoOpenApproval) pendingApprovalNonce = nonce;
				return {
					content: [{
						type: "text",
						text: `Validated and saved plan to ${stored.path}. ${autoOpenApproval ? "Approval actions will open automatically." : "Use /plan-actions to continue."}`,
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
				const transition = recordInvalidSubmission(state) as TransitionResult;
				if (transition.ok) commitTransition(transition);
				applyPlanningGate();
				const attempts = state.counters.invalidSubmissions;
				const retryLimitReached = attempts >= MAX_INVALID_SUBMISSIONS;
				return {
					content: [{
						type: "text",
						text: `${formatStoreError(error)}\nSubmission rejected; planning mode remains active. Attempt ${attempts}/${MAX_INVALID_SUBMISSIONS}.${retryLimitReached ? " Wait for user input before retrying." : " Correct the errors and resubmit the complete plan."}`,
					}],
					details: { accepted: false, attempts, retryLimitReached },
				};
			}
		},
	});

	pi.on("tool_call", async (event) => {
		if (!isGated(state)) return;
		const reason = evaluatePlanningToolCall(event.toolName, event.input, allToolNames());
		if (reason) return { block: true, reason };
	});

	pi.on("user_bash", async (event) => {
		if (!isGated(state)) return;
		const analysis = analyzeBashMutation(event.command);
		if (!analysis.blocked) return;
		return {
			result: {
				output: `Planning mode blocked a known-mutating shell command (${analysis.reason}: ${analysis.detail}).`,
				exitCode: 126,
				cancelled: false,
				truncated: false,
			},
		};
	});

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
			if (state.mode === "planning") return { systemPrompt: `${event.systemPrompt}\n\n${buildPlanningPrompt(state)}` };
			return;
		}
		if (state.mode === "executing_all" || state.mode === "executing_staged") applyExecutionTools();
	});

	let handlingEarlyIdle = false;
	pi.on("agent_settled", async (_event, ctx) => {
		const commandCtx = approvalCommandContext;
		if (pendingApprovalNonce && commandCtx && !presentingApproval && state.mode === "approval" && state.approval && !state.approval.consumed) {
			const nonce = pendingApprovalNonce;
			presentingApproval = true;
			try {
				await openPlanActions(nonce, commandCtx);
			} finally {
				presentingApproval = false;
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
		return {
			messages: event.messages.filter((message) =>
				!(message.role === "custom" && "customType" in message && message.customType === PLAN_MODE_CONTEXT_TYPE)),
		};
	});

	function restoreForContext(ctx: ExtensionContext, honorFlag: boolean): void {
		const branch = ctx.sessionManager.getBranch();
		const hasPersistedWorkflow = branch.some(
			(entry) => entry.type === "custom" && entry.customType === PLAN_MODE_STATE_ENTRY,
		);
		state = restoreLatestState(branch) as PlanModeState;
		executionContract = restoreExecutionContract(branch);
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
		if (honorFlag && !hasPersistedWorkflow && pi.getFlag("plan") === true && state.mode === "off") {
			const result = enterPlanning(state, snapshotOriginalTools()) as TransitionResult;
			if (result.ok) commitTransition(result);
		}
		if (isGated(state)) applyPlanningGate();
		else if (state.mode === "executing_all" || state.mode === "executing_staged") applyExecutionTools(ctx);
		else if (state.originalActiveTools.length > 0 && ["completed", "blocked"].includes(state.mode)) restoreOriginalTools(ctx);
		else if (state.mode === "off" && state.lastAction === "exit_planning" && state.originalActiveTools.length > 0) restoreOriginalTools(ctx);
		else hideWorkflowTools();
		updateStatus(ctx);
		if (ctx.hasUI && state.mode === "approval" && state.approval && !state.approval.consumed && !state.approval.presented) {
			ctx.ui.notify("A validated plan is awaiting approval. Use /plan-actions to reopen its actions.", "info");
		} else if (ctx.hasUI && state.mode === "executing_staged" && state.checkpoint && !state.checkpoint.presented) {
			const next = structuredClone(state);
			next.checkpoint!.presented = true;
			commitState(next);
			queueMicrotask(() => pi.sendUserMessage(`/plan-stage-actions ${next.checkpoint!.nonce}`));
		}
	}

	pi.on("session_start", (_event, ctx) => restoreForContext(ctx, true));
	pi.on("session_tree", (_event, ctx) => restoreForContext(ctx, false));
	pi.on("session_shutdown", () => {
		if (lastContext?.hasUI) {
			lastContext.ui.setStatus("plan-mode", undefined);
			lastContext.ui.setWidget("plan-mode-ledger", undefined);
		}
	});
}
