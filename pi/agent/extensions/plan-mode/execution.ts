import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	EXECUTION_BOUNDARY_MESSAGE,
	EXECUTION_ENTRY,
	buildExecutionBoundaryMessage,
	buildExecutionKickoff,
	buildStageInstruction,
	getExecutionToolNames,
	hashExecutionBoundary,
	isolateExecutionMessages,
	restoreExecutionContract,
} from "./execution-helpers.js";
import { synchronizeLedgerMarkdown } from "./ledger.js";
import { atomicReplaceFile } from "./plan-store.js";
import {
	completeWorkflow,
	recordStageCheckpoint,
	recordTaskProgress,
} from "./state.js";
import type { PlanModeState, TransitionResult } from "./state.ts";

export {
	EXECUTION_BOUNDARY_MESSAGE,
	EXECUTION_ENTRY,
	buildExecutionBoundaryMessage,
	buildExecutionKickoff,
	buildStageInstruction,
	getExecutionToolNames,
	hashExecutionBoundary,
	isolateExecutionMessages,
	restoreExecutionContract,
};

export interface ExecutionContract {
	version: 2;
	handoff: "in_place";
	runId: string;
	approvedMarkdown: string;
	planPath: string;
	planHash: string;
	executionMode: "all" | "staged";
	executionStrategy?: "standard" | "parallel";
	workerModel?: string;
	workerThinkingLevel?: "high";
	originalActiveTools: string[];
	sessionPath: string | null;
	boundaryHash: string;
}

export type InPlaceExecutionContract = ExecutionContract;

interface ExecutionRuntime {
	getState(): PlanModeState;
	getContract(): ExecutionContract | null;
	commit(result: TransitionResult): void;
	commitState(state: PlanModeState): void;
	refreshUI(ctx: ExtensionContext): void;
}

export function registerExecutionTools(pi: ExtensionAPI, runtime: ExecutionRuntime): void {
	pi.registerTool({
		name: "plan_progress",
		label: "Plan Progress",
		description: "Update exactly one approved plan item through a legal status transition and atomically persist its ledger evidence.",
		promptSnippet: "Update one approved plan-item status and evidence",
		parameters: Type.Object({
			itemId: Type.String({ description: "Stable Part ID, such as A or AA" }),
			status: StringEnum(["in_progress", "completed", "blocked"] as const),
			note: Type.Optional(Type.String()),
			evidence: Type.Optional(Type.String()),
			reopenReason: Type.Optional(Type.String({ description: "Required to reopen a completed plan item after user feedback" })),
		}),
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = args as { itemId?: string; taskId?: string };
			return input.itemId === undefined && typeof input.taskId === "string"
				? { ...input, itemId: input.taskId }
				: args;
		},
		async execute(_id, params, _signal, _update, ctx) {
			const contract = runtime.getContract();
			if (!contract) throw new Error("Execution contract is missing");
			const itemId = params.itemId ?? (params as { taskId?: string }).taskId;
			return withFileMutationQueue(contract.planPath, async () => {
				const transition = recordTaskProgress(runtime.getState(), { ...params, itemId }) as TransitionResult;
				if (!transition.ok) throw new Error(transition.error.message);
				let current: string;
				try {
					current = await readFile(contract.planPath, "utf8");
				} catch (error) {
					if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
					current = contract.approvedMarkdown;
				}
				const next = synchronizeLedgerMarkdown(current, contract.approvedMarkdown, transition.state.ledger);
				await atomicReplaceFile(contract.planPath, next);
				const accepted = structuredClone(transition.state);
				accepted.counters.recoveryAttempts = 0;
				runtime.commitState(accepted);
				runtime.refreshUI(ctx);
				return {
					content: [{ type: "text", text: `Plan item ${itemId} is now ${params.status}.` }],
					details: { itemId, ledger: accepted.ledger[itemId] },
				};
			});
		},
	});

	pi.registerTool({
		name: "complete_plan",
		label: "Complete Plan",
		description: "Validate terminal ledger state and finish approved-plan execution with summaries and test evidence.",
		parameters: Type.Object({
			summary: Type.String({ minLength: 1 }),
			tests: Type.Array(Type.String(), { description: "Verification evidence; may be empty only when the approved plan has no meaningful Verification" }),
			allowBlockedStoppingCriterion: Type.Optional(Type.Boolean()),
			blockedReason: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const state = runtime.getState();
			if (params.allowBlockedStoppingCriterion && !params.blockedReason?.trim()) throw new Error("A stopping-criterion reason is required for blocked completion");
			const result = completeWorkflow(state, { allowBlocked: params.allowBlockedStoppingCriterion === true }) as TransitionResult;
			if (!result.ok) throw new Error(result.error.message);
			const next = structuredClone(result.state);
			next.testEvidence = params.tests.map((command) => ({ command, result: "passed", summary: params.summary }));
			next.blockedReason = params.blockedReason?.trim() || null;
			runtime.commitState(next);
			runtime.refreshUI(ctx);
			return {
				content: [{ type: "text", text: `Plan completed: ${params.summary}` }],
				details: { summary: params.summary, tests: params.tests },
				terminate: true,
			};
		},
	});

	pi.registerTool({
		name: "complete_stage",
		label: "Complete Stage",
		description: "Validate the current staged-execution boundary, persist its summary, and open the mandatory user checkpoint after the agent settles.",
		parameters: Type.Object({
			stageId: Type.String(),
			summary: Type.String({ minLength: 1 }),
			changedFiles: Type.Array(Type.String()),
			tests: Type.Array(Type.String(), { description: "Stage verification evidence; may be empty only when no meaningful check applies" }),
			blockers: Type.Array(Type.String()),
			parallelWorkers: Type.Optional(Type.Array(Type.Object({
				workerId: Type.String(),
				runId: Type.Optional(Type.String()),
				sessionId: Type.Optional(Type.String()),
				stageIds: Type.Array(Type.String()),
				summary: Type.Optional(Type.String()),
			}))),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const nonce = randomBytes(18).toString("base64url");
			const result = recordStageCheckpoint(runtime.getState(), { ...params, nonce }) as TransitionResult;
			if (!result.ok) throw new Error(result.error.message);
			runtime.commit(result);
			runtime.refreshUI(ctx);
			return {
				content: [{ type: "text", text: `Stage ${params.stageId} complete. Mandatory checkpoint will open when the agent settles.` }],
				details: { stageId: params.stageId, nonce, summary: params.summary },
				terminate: true,
			};
		},
	});
}
