/**
 * Plan Mode Extension — Phased planning workflow for pi-coding-agent.
 *
 * Phases: off → explore → draft → review → approved
 *
 * Features:
 * - /plan command cycles phases, Ctrl+Alt+P toggles, --plan flag starts in explore
 * - Read-only mutation gate during explore/draft/review
 * - submit_plan tool: agent submits plan markdown, extension writes it (keeps gate absolute)
 * - Editor review loop: $EDITOR on the plan, diff for comments, iterate
 * - /plan-review, /plan-approve, /plan-reject commands
 * - On approval: write final plan, release gate, dispatch worker subagent
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	PHASE_ORDER,
	isSafeCommand,
	nextPhase,
	isGatedPhase,
	phaseLabel,
	phaseBadge,
	phaseColor,
	titlePrefix,
	extractReviewFeedback,
	defaultPlanState,
	type Phase,
	type PlanState,
} from "./utils.ts";
import {
	createModeEditorFactory,
	type PhaseRef,
} from "./mode-indicator.ts";

// ─── Tool allowlists ────────────────────────────────────────────────────────

const GATED_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire", "subagent"];
const FULL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "questionnaire", "subagent"];

// ─── Extension ──────────────────────────────────────────────────────────────

export default function planModeExtension(pi: ExtensionAPI): void {
	let state: PlanState = defaultPlanState("init");

	// Mutable phase reference shared with the custom editor for live badge updates
	const phaseRef: PhaseRef = { phase: "off" };

	// ─── Persistence ──────────────────────────────────────────────────────

	function persistState(): void {
		pi.appendEntry("plan-mode-v2", { ...state });
	}

	function restoreState(ctx: ExtensionContext): void {
		const entries = ctx.sessionManager.getEntries();
		const entry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode-v2")
			.pop() as { data?: PlanState } | undefined;

		if (entry?.data) {
			// Restore persisted state
			state = { ...entry.data };
		} else {
			// Fresh session — use actual session ID for temp path
			const sessionId = ctx.sessionManager.getLeafId?.() || "session";
			state = defaultPlanState(sessionId);
		}

		// --plan flag overrides to explore if currently off
		if (pi.getFlag("plan") === true && state.phase === "off") {
			state.phase = "explore";
		}

		// Re-apply tool restrictions for current phase
		if (isGatedPhase(state.phase)) {
			pi.setActiveTools(GATED_TOOLS);
		}
	}

	// ─── Status UI ───────────────────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext): void {
		// Sync the shared phase ref so the custom editor re-renders the badge
		phaseRef.phase = state.phase;

		if (state.phase !== "off") {
			const round = state.reviewRound > 0 ? ` (round ${state.reviewRound})` : "";
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg(phaseColor(state.phase), `${phaseLabel(state.phase)}${round}`));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}
		ctx.ui.setWidget("plan-mode", undefined);

		// Update terminal title with mode prefix
		const baseTitle = pi.getSessionName()
			? `π - ${pi.getSessionName()} - ${path.basename(ctx.cwd)}`
			: `π - ${path.basename(ctx.cwd)}`;
		ctx.ui.setTitle(titlePrefix(state.phase) + baseTitle);
	}

	// ─── Phase transitions ──────────────────────────────────────────────

	function setPhase(phase: Phase, ctx: ExtensionContext): void {
		const prev = state.phase;
		state.phase = phase;

		if (isGatedPhase(phase)) {
			pi.setActiveTools(GATED_TOOLS);
		} else if (phase === "approved" || phase === "off") {
			pi.setActiveTools(FULL_TOOLS);
		}

		updateStatus(ctx);
		persistState();

		const label = phaseLabel(phase);
		if (label) {
			ctx.ui.notify(`Plan mode: ${label}${prev !== "off" ? ` (was ${phaseLabel(prev)})` : ""}`);
		} else {
			ctx.ui.notify("Plan mode: off — full access restored");
		}
	}

	// ─── /plan command: cycle through phases ─────────────────────────────

	pi.registerCommand("plan", {
		description: "Cycle plan mode phases: off → explore → draft → review → approved → off",
		handler: async (args, ctx) => {
			// If args specify a phase, jump directly
			if (args && PHASE_ORDER.includes(args.trim() as Phase)) {
				setPhase(args.trim() as Phase, ctx);
				return;
			}
			// Otherwise cycle
			const next = nextPhase(state.phase);
			setPhase(next, ctx);
		},
	});

	// ─── Shortcut ────────────────────────────────────────────────────────

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode (off ↔ explore)",
		handler: async (ctx) => {
			if (state.phase === "off") {
				setPhase("explore", ctx);
			} else {
				setPhase("off", ctx);
			}
		},
	});

	// ─── Flag ────────────────────────────────────────────────────────────

	pi.registerFlag("plan", {
		description: "Start in plan mode (explore phase)",
		type: "boolean",
		default: false,
	});

	// ─── /plan-review command ────────────────────────────────────────────

	pi.registerCommand("plan-review", {
		description: "Open the plan file in $EDITOR for review",
		handler: async (_args, ctx) => {
			if (state.phase !== "review") {
				ctx.ui.notify("Not in review phase. Use /plan to enter review first.", "warning");
				return;
			}
			await openEditorReview(ctx);
		},
	});

	// ─── /plan-approve command ──────────────────────────────────────────

	pi.registerCommand("plan-approve", {
		description: "Approve the plan and dispatch implementation",
		handler: async (_args, ctx) => {
			if (state.phase !== "review" && state.phase !== "approved") {
				ctx.ui.notify("Not in review phase. Submit a plan first.", "warning");
				return;
			}
			await approvePlan(ctx);
		},
	});

	// ─── /plan-reject command ──────────────────────────────────────────

	pi.registerCommand("plan-reject", {
		description: "Reject the plan and return to explore phase",
		handler: async (_args, ctx) => {
			if (state.phase === "off") {
				ctx.ui.notify("Not in plan mode.", "warning");
				return;
			}
			// Clean up temp file
			try {
				if (fs.existsSync(state.planPath)) fs.unlinkSync(state.planPath);
			} catch { /* ignore */ }
			state.preReviewContent = "";
			state.reviewRound = 0;
			setPhase("explore", ctx);
			ctx.ui.notify("Plan rejected. Returned to explore phase.");
		},
	});

	// ─── submit_plan tool ───────────────────────────────────────────────

	pi.registerTool({
		name: "submit_plan",
		label: "Submit Plan",
		description:
			"Submit the plan markdown. This is the ONLY way to save a plan during plan mode. " +
			"Call this when you have a complete structured plan ready for review. " +
			"The plan will be saved to a temp file and the phase will advance to review.",
		parameters: Type.Object({
			markdown: Type.String({
				description: "The full plan content in markdown format",
			}),
		}),
		promptSnippet: "Submit the plan for review",
		promptGuidelines:
			"Call submit_plan when you have a complete, structured plan. " +
			"Include numbered steps, file paths, and acceptance criteria. " +
			"The user will review it in their editor and may leave comments.",
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			if (state.phase !== "explore" && state.phase !== "draft" && state.phase !== "review") {
				return {
					type: "text" as const,
					text: "Error: Cannot submit plan outside of explore/draft/review phase.",
				};
			}

			// Write plan to temp file
			const dir = path.dirname(state.planPath);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(state.planPath, params.markdown, "utf-8");

			// Transition to review — don't reset reviewRound (tracks cumulative cycles)
			state.preReviewContent = params.markdown;
			setPhase("review", ctx);

			// Auto-open editor for review (only in TTY mode)
			if (ctx.hasUI) {
				// Kick off editor asynchronously — don't block the tool result
				openEditorReview(ctx).catch(() => {
					/* ignore */
				});
			}

			return {
				type: "text" as const,
				text: `Plan saved to ${state.planPath}. Phase is now review.${ctx.hasUI ? " Opening in editor..." : " Use /plan-review to open in editor."}`,
			};
		},
	});

	// ─── Editor review logic ─────────────────────────────────────────────

	async function openEditorReview(ctx: ExtensionContext): Promise<void> {
		if (!fs.existsSync(state.planPath)) {
			ctx.ui.notify("No plan file found. Submit a plan first.", "warning");
			return;
		}

		// Snapshot before editing
		const beforeContent = fs.readFileSync(state.planPath, "utf-8");
		state.preReviewContent = beforeContent;

		if (ctx.hasUI) {
			// Try spawning $EDITOR
			const editor = process.env.EDITOR || process.env.VISUAL || "vi";
			try {
				await spawnEditor(editor, state.planPath);
			} catch {
				// Fallback to ctx.ui.editor if spawn fails
				ctx.ui.notify(`Failed to spawn ${editor}, using built-in editor.`, "warning");
				await openBuiltinEditor(ctx, beforeContent);
			}
		} else {
			// No TTY — use the built-in multi-line editor dialog
			await openBuiltinEditor(ctx, beforeContent);
		}

		// Re-read after editing
		const afterContent = fs.readFileSync(state.planPath, "utf-8");
		const feedback = extractReviewFeedback(beforeContent, afterContent);

		if (feedback.length > 0) {
			state.reviewRound++;
			persistState();
			updateStatus(ctx);

			// Inject feedback as a follow-up message so the agent revises
			const feedbackText = feedback.map((f, i) => `${i + 1}. ${f}`).join("\n");
			pi.sendMessage(
				{
					customType: "plan-review-feedback",
					content: `[PLAN REVIEW FEEDBACK — Round ${state.reviewRound}]\nThe user reviewed the plan and left these comments/edits:\n\n${feedbackText}\n\nRevise the plan to address this feedback and call submit_plan again with the updated plan.`,
					display: true,
				},
				{ triggerTurn: true },
			);
		} else {
			// No feedback — plan is unchanged, ask what to do
			const choice = await ctx.ui.select("Plan review — no changes detected. What next?", [
				"Approve the plan",
				"Keep reviewing (I'll add comments)",
				"Revise the plan",
			]);

			if (choice === "Approve the plan") {
				await approvePlan(ctx);
			} else if (choice === "Revise the plan") {
				const revision = await ctx.ui.editor("Describe what to revise:", "");
				if (revision?.trim()) {
					pi.sendUserMessage(
						`Please revise the plan based on this feedback: ${revision.trim()}`,
					);
				}
			}
			// "Keep reviewing" — do nothing, user will edit and call /plan-review again
		}
	}

	function spawnEditor(editor: string, filePath: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const proc = spawn(editor, [filePath], {
				stdio: "inherit",
				env: { ...process.env },
			});
			proc.on("close", (code) => {
				if (code === 0) resolve();
				else reject(new Error(`Editor exited with code ${code}`));
			});
			proc.on("error", reject);
		});
	}

	async function openBuiltinEditor(ctx: ExtensionContext, currentContent: string): Promise<void> {
		const result = await ctx.ui.editor("Review and edit the plan. Add <!-- comments --> for feedback:", currentContent);
		if (result !== undefined && result !== null) {
			fs.writeFileSync(state.planPath, result, "utf-8");
		}
	}

	// ─── Approve and handoff ─────────────────────────────────────────────

	async function approvePlan(ctx: ExtensionContext): Promise<void> {
		if (!fs.existsSync(state.planPath)) {
			ctx.ui.notify("No plan file found. Submit a plan first.", "warning");
			return;
		}

		// Ask user for final path
		const defaultPath = path.join(ctx.cwd, "PLAN.md");
		const finalPath = await ctx.ui.input("Save plan to:", defaultPath);
		if (!finalPath?.trim()) {
			ctx.ui.notify("Plan approval cancelled.", "warning");
			return;
		}

		// Write final plan
		const planContent = fs.readFileSync(state.planPath, "utf-8");
		const resolvedPath = path.resolve(ctx.cwd, finalPath.trim());
		fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
		fs.writeFileSync(resolvedPath, planContent, "utf-8");

		// Clean up temp file
		try {
			fs.unlinkSync(state.planPath);
		} catch { /* ignore */ }

		state.finalPath = resolvedPath;

		// Release the gate
		setPhase("approved", ctx);

		// Ask execution mode
		const execMode = await ctx.ui.select("How should implementation be dispatched?", [
			"Parallel (one worker per plan section)",
			"Sequential (single worker for entire plan)",
			"Just save the plan (I'll implement manually)",
		]);

		if (execMode?.startsWith("Parallel")) {
			await dispatchParallel(resolvedPath, ctx);
		} else if (execMode?.startsWith("Sequential")) {
			await dispatchSequential(resolvedPath, ctx);
		} else {
			ctx.ui.notify(`Plan saved to ${resolvedPath}. Gate released — full access restored.`);
		}
	}

	async function dispatchSequential(planPath: string, ctx: ExtensionContext): Promise<void> {
		ctx.ui.notify(`Dispatching worker agent with plan: ${planPath}`);

		pi.sendUserMessage(
			`Execute the plan at ${planPath}. Read the plan first, then implement all steps. ` +
				`Report what was implemented, what was left undone, and any decisions needing approval.`,
			{ deliverAs: "steer" },
		);
	}

	async function dispatchParallel(planPath: string, ctx: ExtensionContext): Promise<void> {
		ctx.ui.notify(`Dispatching parallel workers for plan: ${planPath}`);

		pi.sendMessage(
			{
				customType: "plan-parallel-dispatch",
				content: `The plan at ${planPath} has been approved for parallel execution.\n\n` +
					`Read the plan file and identify independent sections. ` +
					`For each section, dispatch a worker subagent using the subagent tool with worktree isolation:\n\n` +
					`\`\`\`\nsubagent({\n  tasks: [\n    { agent: "worker", task: "Implement section N of the plan at ${planPath}. Read the plan first. Report what was done and any issues.", worktree: true },\n    ...\n  ]\n})\n\`\`\`\n\n` +
					`Use worktree: true to isolate each worker in its own git worktree. ` +
					`After all workers complete, summarize the results.`,
				display: true,
			},
			{ triggerTurn: true },
		);
	}

	// ─── Mutation gate: tool_call handler ─────────────────────────────────

	pi.on("tool_call", async (event) => {
		if (!isGatedPhase(state.phase)) return;

		// Block write and edit tools
		if (event.toolName === "write" || event.toolName === "edit") {
			return {
				block: true,
				reason: `Plan mode (${state.phase}): file modification blocked. Use submit_plan to save the plan, or /plan to exit plan mode.`,
			};
		}

		// Block mutating bash commands
		if (isToolCallEventType("bash", event)) {
			const command = event.input.command as string;
			if (!isSafeCommand(command)) {
				return {
					block: true,
					reason: `Plan mode (${state.phase}): bash command blocked (not allowlisted). Use /plan to exit plan mode first.\nCommand: ${command}`,
				};
			}
		}

		// Allow everything else (read, grep, find, ls, questionnaire, subagent, submit_plan)
	});

	// ─── Phase-specific instructions ─────────────────────────────────────

	pi.on("before_agent_start", async () => {
		if (state.phase === "off") return;

		if (isGatedPhase(state.phase)) {
			const instructionsByPhase: Record<string, string> = {
				explore: `Gather information by reading files, searching the codebase, and researching online.
Ask clarifying questions using the questionnaire tool.
Do NOT attempt to make any changes — just explore and understand.
When you have enough context to produce a structured plan, call submit_plan with the full plan markdown.`,

				draft: `You are drafting a plan based on the exploration so far.
Continue gathering any missing information, then produce a structured plan.
The plan should include numbered steps, file paths, and acceptance criteria.
Call submit_plan with the complete plan markdown when ready.`,

				review: `The plan is under review. The user may have left feedback as HTML comments or inline edits.
Address any feedback by revising the plan and calling submit_plan again with the updated version.
If the user approves (via /plan-approve), the gate will be released and implementation will begin.`,
			};

			const phaseInstructions = instructionsByPhase[state.phase] || "";

			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE — ${state.phase.toUpperCase()}]
You are in plan mode, phase: ${state.phase}.

Restrictions:
- You can only use: ${GATED_TOOLS.join(", ")}
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to read-only commands
- submit_plan is the ONLY way to save the plan

${phaseInstructions}`,
					display: false,
				},
			};
		}

		if (state.phase === "approved") {
			return {
				message: {
					customType: "plan-approved-context",
					content: `[PLAN APPROVED — Full tool access enabled]
The plan has been approved and saved to ${state.finalPath}.
Implement the plan as described. Read the plan file first if needed.`,
					display: false,
				},
			};
		}
	});

	// ─── Context filtering: remove plan-mode messages when off ────────────

	pi.on("context", async (event) => {
		if (state.phase !== "off") return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as { customType?: string; content?: unknown };
				// Filter out our custom plan-mode messages when not in plan mode
				if (msg.customType?.startsWith("plan-")) return false;
				return true;
			}),
		};
	});

	// ─── Session lifecycle ───────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		restoreState(ctx);

		// Install the mode-indicator editor (badge in the border)
		if (ctx.hasUI) {
			ctx.ui.setEditorComponent(
				createModeEditorFactory(phaseRef, () => ctx.ui.theme),
			);
		}

		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Restore default editor
		if (ctx.hasUI) {
			ctx.ui.setEditorComponent(undefined);
			ctx.ui.setTitle(""); // clear mode prefix from title
		}

		// Clean up temp plan file
		try {
			if (fs.existsSync(state.planPath)) fs.unlinkSync(state.planPath);
		} catch { /* ignore */ }
	});
}
