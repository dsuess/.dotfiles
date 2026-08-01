import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlySessionManager,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	CHECKPOINT_VERSION,
	captureCheckpoint,
	createPiRunner,
	findGitRepository,
	restoreCheckpoint,
} from "./git-checkpoints.js";

export const CHECKPOINT_ENTRY_TYPE = "git-tree-checkpoint";

interface CheckpointData {
	version: number;
	representedLeafId: string | null;
	[key: string]: unknown;
}

type CheckpointEntry = Extract<SessionEntry, { type: "custom" }> & {
	customType: string;
	data?: CheckpointData;
};

interface CheckpointMatch {
	entry: CheckpointEntry;
	checkpoint: CheckpointData;
	match: "exact" | "ancestor";
}

interface GitRepository {
	root: string;
	gitDir: string;
	commonDir: string;
	bare: false;
}

interface Dependencies {
	findGitRepository: typeof findGitRepository;
	captureCheckpoint: typeof captureCheckpoint;
	restoreCheckpoint: typeof restoreCheckpoint;
}

export function effectiveDestinationId(entry: SessionEntry): string | null {
	if (entry.type === "message" && entry.message.role === "user") return entry.parentId;
	if (entry.type === "custom_message") return entry.parentId;
	return entry.id;
}

function checkpointFromEntry(entry: SessionEntry | undefined): CheckpointData | null {
	if (!entry || entry.type !== "custom" || entry.customType !== CHECKPOINT_ENTRY_TYPE) return null;
	if (!entry.data || typeof entry.data !== "object") return null;
	const data = entry.data as CheckpointData;
	if (data.version !== CHECKPOINT_VERSION) return null;
	if (data.representedLeafId !== null && typeof data.representedLeafId !== "string") return null;
	return data;
}

/** Resolve newest explicit association first, then the closest checkpoint entry on the path. */
export function resolveCheckpointForLeaf(
	sessionManager: Pick<ReadonlySessionManager, "getEntry" | "getEntries">,
	leafId: string | null,
): CheckpointMatch | null {
	const entries = sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		const checkpoint = checkpointFromEntry(entry);
		if (checkpoint && checkpoint.representedLeafId === leafId) {
			return { entry: entry as CheckpointEntry, checkpoint, match: "exact" };
		}
	}

	let currentId = leafId;
	const visited = new Set<string>();
	while (currentId !== null && !visited.has(currentId)) {
		visited.add(currentId);
		const entry = sessionManager.getEntry(currentId);
		const checkpoint = checkpointFromEntry(entry);
		if (checkpoint) return { entry: entry as CheckpointEntry, checkpoint, match: "ancestor" };
		if (!entry) break;
		currentId = entry.parentId;
	}
	return null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function createQueue() {
	let tail = Promise.resolve();
	return function enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = tail.then(operation, operation);
		tail = result.then(() => undefined, () => undefined);
		return result;
	};
}

export function createGitTreeCheckpointsExtension(overrides: Partial<Dependencies> = {}) {
	const dependencies: Dependencies = {
		findGitRepository: overrides.findGitRepository ?? findGitRepository,
		captureCheckpoint: overrides.captureCheckpoint ?? captureCheckpoint,
		restoreCheckpoint: overrides.restoreCheckpoint ?? restoreCheckpoint,
	};

	return function gitTreeCheckpointsExtension(pi: ExtensionAPI) {
		const runner = createPiRunner(pi);
		let repository: GitRepository | null = null;
		let sessionId: string | null = null;
		let enqueue = createQueue();
		let sessionGeneration = 0;
		let nonGitNoticeShown = false;

		pi.on("session_start", async (_event, ctx) => {
			const generation = ++sessionGeneration;
			repository = null;
			sessionId = null;
			enqueue = createQueue();
			try {
				const detected = await dependencies.findGitRepository(ctx.cwd, { runner });
				if (generation !== sessionGeneration) return;
				if (!detected) {
					if (ctx.hasUI && !nonGitNoticeShown) {
						nonGitNoticeShown = true;
						ctx.ui.notify("Code checkpoints disabled outside a Git worktree", "info");
					}
					return;
				}
				repository = detected as GitRepository;
				sessionId = ctx.sessionManager.getSessionId();
			} catch (error) {
				if (generation !== sessionGeneration) return;
				if (ctx.hasUI) {
					ctx.ui.notify(`Code checkpoints disabled: ${errorMessage(error)}`, "warning");
				}
			}
		});

		async function captureAndPersist(ctx: ExtensionContext, reason: string, representedLeafId: string | null) {
			const activeRepository = repository;
			const activeSessionId = sessionId;
			const generation = sessionGeneration;
			if (!activeRepository || !activeSessionId) return null;
			return enqueue(async () => {
				if (generation !== sessionGeneration || repository !== activeRepository) {
					throw new Error("checkpoint session changed during operation");
				}
				const checkpoint = await dependencies.captureCheckpoint(activeRepository, {
					sessionId: activeSessionId,
					reason,
					representedLeafId,
				}, { runner });
				if (generation !== sessionGeneration || repository !== activeRepository) {
					throw new Error("checkpoint session changed during operation");
				}
				pi.appendEntry(CHECKPOINT_ENTRY_TYPE, checkpoint);
				return checkpoint;
			});
		}

		pi.on("before_agent_start", async (_event, ctx) => {
			if (!repository || !sessionId) return;
			try {
				await captureAndPersist(ctx, "before-prompt", ctx.sessionManager.getLeafId());
			} catch (error) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Code checkpoint failed: ${errorMessage(error)}`, "warning");
				}
			}
		});

		pi.on("session_before_tree", async (event, ctx) => {
			const activeRepository = repository;
			if (!activeRepository || !sessionId) return;

			try {
				const targetEntry = ctx.sessionManager.getEntry(event.preparation.targetId);
				if (!targetEntry) {
					if (ctx.hasUI) ctx.ui.notify("Navigation cancelled: tree destination no longer exists", "error");
					return { cancel: true };
				}
				const destinationLeafId = effectiveDestinationId(targetEntry);
				const destination = resolveCheckpointForLeaf(ctx.sessionManager, destinationLeafId);

				let shouldRestore = false;
				if (ctx.hasUI) {
					if (destination) {
						const choice = await ctx.ui.select("Restore code state?", [
							"Restore checkpointed code",
							"Keep current code",
							"Cancel navigation",
						], { signal: event.signal });
						if (choice === undefined || choice === "Cancel navigation") return { cancel: true };
						if (choice !== "Restore checkpointed code" && choice !== "Keep current code") return { cancel: true };
						shouldRestore = choice === "Restore checkpointed code";
					} else {
						const choice = await ctx.ui.select("No code checkpoint for this point", [
							"Keep current code and navigate",
							"Cancel navigation",
						], { signal: event.signal });
						if (choice !== "Keep current code and navigate") return { cancel: true };
					}
				}

				let safetyCheckpoint;
				try {
					safetyCheckpoint = await captureAndPersist(
						ctx,
						"before-tree-navigation",
						event.preparation.oldLeafId,
					);
					if (!safetyCheckpoint) throw new Error("Git checkpointing is no longer active");
				} catch (error) {
					if (ctx.hasUI) {
						ctx.ui.notify(`Navigation cancelled: could not capture safety checkpoint: ${errorMessage(error)}`, "error");
					}
					return { cancel: true };
				}

				if (!shouldRestore || !destination) return;
				try {
					await enqueue(() => dependencies.restoreCheckpoint(activeRepository, destination.checkpoint, { runner }));
					if (ctx.hasUI) ctx.ui.notify("Code restored to checkpoint", "info");
					return;
				} catch (targetError) {
					try {
						await enqueue(() => dependencies.restoreCheckpoint(activeRepository, safetyCheckpoint, { runner }));
						if (ctx.hasUI) {
							ctx.ui.notify(
								`Code restore failed: ${errorMessage(targetError)}. Safety checkpoint restored; navigation cancelled.`,
								"error",
							);
						}
					} catch (safetyError) {
						if (ctx.hasUI) {
							ctx.ui.notify(
								`URGENT: code restore failed (${errorMessage(targetError)}); safety recovery also failed (${errorMessage(safetyError)}). Manual recovery ref: ${safetyCheckpoint.sessionRef ?? "refs/pi/checkpoints/"}.`,
								"error",
							);
						}
					}
					return { cancel: true };
				}
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`Navigation cancelled: ${errorMessage(error)}`, "error");
				return { cancel: true };
			}
		});
	};
}

export default createGitTreeCheckpointsExtension();
