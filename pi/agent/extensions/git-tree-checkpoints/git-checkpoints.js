import { execFile } from "node:child_process";
import { randomUUID as nodeRandomUUID } from "node:crypto";
import { lstat, open, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const CHECKPOINT_VERSION = 2;
const LEGACY_CHECKPOINT_VERSION = 1;
const REF_PREFIX = "refs/pi/checkpoints";
const CHECKPOINT_IDENTITY = {
	name: "Pi Code Checkpoints",
	email: "pi-checkpoints@localhost.invalid",
};

export class GitCheckpointError extends Error {
	constructor(code, message, details = {}, options = {}) {
		super(message, options);
		this.name = "GitCheckpointError";
		this.code = code;
		this.details = details;
	}
}

async function defaultRunner(command, args, options = {}) {
	try {
		const result = await execFileAsync(command, args, {
			cwd: options.cwd,
			encoding: "utf8",
			env: options.env ? { ...process.env, ...options.env } : process.env,
			maxBuffer: 10 * 1024 * 1024,
			signal: options.signal,
			timeout: options.timeout,
		});
		return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
	} catch (error) {
		return {
			stdout: error.stdout ?? "",
			stderr: error.stderr ?? error.message,
			code: typeof error.code === "number" ? error.code : 1,
			killed: Boolean(error.killed || options.signal?.aborted),
			error,
		};
	}
}

/** Adapt Pi's exec API, which has no env option, without invoking a shell. */
export function createPiRunner(pi) {
	return async (command, args, options = {}) => {
		const execOptions = {
			cwd: options.cwd,
			signal: options.signal,
			timeout: options.timeout,
		};
		if (!options.env || Object.keys(options.env).length === 0) {
			return pi.exec(command, args, execOptions);
		}
		const assignments = Object.entries(options.env).map(([key, value]) => `${key}=${value}`);
		return pi.exec("env", [...assignments, command, ...args], execOptions);
	};
}

function dependencyRunner(dependencies) {
	return dependencies?.runner ?? defaultRunner;
}

async function runGit(cwd, args, options = {}) {
	const runner = options.runner ?? defaultRunner;
	const result = await runner("git", args, {
		cwd,
		env: options.env,
		signal: options.signal,
		timeout: options.timeout,
	});
	if (result.code !== 0 && !options.allowFailure) {
		const code = options.signal?.aborted ? "ABORTED" : "GIT_COMMAND_FAILED";
		throw new GitCheckpointError(
			code,
			options.signal?.aborted
				? "Git checkpoint operation was cancelled"
				: `git ${args[0] ?? "command"} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`,
			{ args, cwd, exitCode: result.code, stderr: result.stderr, killed: result.killed },
			result.error ? { cause: result.error } : undefined,
		);
	}
	return result;
}

async function canonicalGitPath(cwd, value) {
	const absolute = path.isAbsolute(value) ? value : path.resolve(cwd, value);
	return realpath(absolute);
}

/** Return canonical repository identity, or null when cwd is not inside a worktree. */
export async function findGitRepository(cwd, dependencies = {}) {
	const runner = dependencyRunner(dependencies);
	const signal = dependencies.signal;
	const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], {
		runner, signal, allowFailure: true,
	});
	if (inside.code !== 0 || inside.stdout.trim() !== "true") return null;

	const [topLevel, gitDir, commonDir, bare] = await Promise.all([
		runGit(cwd, ["rev-parse", "--show-toplevel"], { runner, signal }),
		runGit(cwd, ["rev-parse", "--absolute-git-dir"], { runner, signal }),
		runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { runner, signal }),
		runGit(cwd, ["rev-parse", "--is-bare-repository"], { runner, signal }),
	]);
	if (bare.stdout.trim() === "true") return null;
	return {
		root: await canonicalGitPath(cwd, topLevel.stdout.trim()),
		gitDir: await canonicalGitPath(cwd, gitDir.stdout.trim()),
		commonDir: await canonicalGitPath(cwd, commonDir.stdout.trim()),
		bare: false,
	};
}

function sessionRef(sessionId) {
	if (typeof sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) {
		throw new GitCheckpointError(
			"INVALID_SESSION_ID",
			"Pi session ID cannot be represented safely as a checkpoint ref",
			{ sessionId },
		);
	}
	return `${REF_PREFIX}/${sessionId}`;
}

async function rejectUnsupportedIndex(repository, runner, signal) {
	const unmerged = await runGit(repository.root, ["ls-files", "--unmerged"], { runner, signal });
	if (unmerged.stdout.trim()) {
		throw new GitCheckpointError(
			"UNMERGED_INDEX",
			"Cannot checkpoint an unmerged Git index",
			{ repositoryRoot: repository.root },
		);
	}
	const indexDebug = await runGit(repository.root, ["ls-files", "--debug"], { runner, signal });
	const hasIntentToAdd = [...indexDebug.stdout.matchAll(/flags:\s*([0-9a-f]+)/gi)]
		.some((match) => (BigInt(`0x${match[1]}`) & 0x20000000n) !== 0n);
	if (hasIntentToAdd) {
		throw new GitCheckpointError(
			"INTENT_TO_ADD",
			"Cannot checkpoint intent-to-add index entries without losing their special state",
			{ repositoryRoot: repository.root },
		);
	}
	const sparse = await runGit(repository.root, ["config", "--bool", "core.sparseCheckout"], {
		runner, signal, allowFailure: true,
	});
	if (sparse.code === 0 && sparse.stdout.trim() === "true") {
		throw new GitCheckpointError(
			"SPARSE_CHECKOUT",
			"Sparse checkouts are not supported by Git tree checkpoints",
			{ repositoryRoot: repository.root },
		);
	}
}

async function readHead(repository, runner, signal) {
	const [oid, ref] = await Promise.all([
		runGit(repository.root, ["rev-parse", "--verify", "HEAD^{commit}"], { runner, signal, allowFailure: true }),
		runGit(repository.root, ["symbolic-ref", "--quiet", "HEAD"], { runner, signal, allowFailure: true }),
	]);
	return {
		oid: oid.code === 0 ? oid.stdout.trim() : null,
		ref: ref.code === 0 ? ref.stdout.trim() : null,
	};
}

async function readCurrentAnchor(repository, ref, runner, signal) {
	const result = await runGit(repository.root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
		runner, signal, allowFailure: true,
	});
	if (result.code === 1) return null;
	if (result.code !== 0) {
		throw new GitCheckpointError(
			"REF_READ_FAILED",
			`Cannot read checkpoint ref ${ref}: ${(result.stderr || result.stdout).trim()}`,
			{ ref, exitCode: result.code },
		);
	}
	return result.stdout.trim();
}

async function commitTree(repository, tree, parents, message, runner, signal) {
	const args = [
		"-c", `user.name=${CHECKPOINT_IDENTITY.name}`,
		"-c", `user.email=${CHECKPOINT_IDENTITY.email}`,
		"commit-tree", tree,
	];
	for (const parent of parents) args.push("-p", parent);
	args.push("-m", message);
	return (await runGit(repository.root, args, { runner, signal })).stdout.trim();
}

function captureTime(now) {
	const value = typeof now === "function" ? now() : now;
	const date = value === undefined ? new Date() : value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.valueOf())) {
		throw new GitCheckpointError("INVALID_CAPTURE_TIME", "Checkpoint capture time is invalid", { value });
	}
	return date.toISOString();
}

function nulPaths(output) {
	return output.split("\0").filter(Boolean);
}

async function gitPaths(repository, args, runner, signal) {
	return nulPaths((await runGit(repository.root, args, { runner, signal })).stdout);
}

async function isTextPath(root, relativePath) {
	let handle;
	try {
		const stat = await lstat(path.join(root, relativePath));
		if (stat.isSymbolicLink()) return true;
		if (!stat.isFile()) return false;
		handle = await open(path.join(root, relativePath), "r");
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let position = 0;
		while (true) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
			if (bytesRead === 0) break;
			const chunk = buffer.subarray(0, bytesRead);
			if (chunk.includes(0)) return false;
			decoder.decode(chunk, { stream: true });
			position += bytesRead;
		}
		decoder.decode();
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	} finally {
		await handle?.close();
	}
}

function batches(items, size = 256) {
	const out = [];
	for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
	return out;
}

async function removeIndexPaths(repository, paths, runner, signal, env) {
	for (const batch of batches(paths)) {
		if (batch.length) await runGit(repository.root, ["rm", "--cached", "--ignore-unmatch", "--", ...batch], { runner, signal, env });
	}
}

async function addWorktreePaths(repository, paths, runner, signal, env) {
	for (const batch of batches(paths)) {
		if (batch.length) await runGit(repository.root, ["add", "-A", "--", ...batch], { runner, signal, env });
	}
}

async function treePaths(repository, tree, runner, signal) {
	return gitPaths(repository, ["ls-tree", "-r", "-z", "--name-only", tree], runner, signal);
}

function parseAttributeOutput(output) {
	const fields = output.split("\0");
	const attributes = new Map();
	for (let index = 0; index + 2 < fields.length; index += 3) {
		if (fields[index]) attributes.set(fields[index], fields[index + 2]);
	}
	return attributes;
}

async function textAttributes(repository, paths, runner, signal) {
	const attributes = new Map();
	for (const batch of batches(paths)) {
		if (!batch.length) continue;
		const result = await runGit(repository.root, ["check-attr", "-z", "text", "--", ...batch], { runner, signal });
		for (const [filePath, value] of parseAttributeOutput(result.stdout)) attributes.set(filePath, value);
	}
	return attributes;
}

async function checkpointTextPaths(repository, runner, signal) {
	const [tracked, untracked] = await Promise.all([
		gitPaths(repository, ["ls-files", "-z", "--cached"], runner, signal),
		gitPaths(repository, ["ls-files", "-z", "--others", "--exclude-standard"], runner, signal),
	]);
	const trackedPaths = new Set(tracked);
	const candidates = [...new Set([...tracked, ...untracked])];
	const attributes = await textAttributes(repository, candidates, runner, signal);
	const textPaths = [];
	for (const filePath of candidates) {
		const attribute = attributes.get(filePath);
		if (attribute === "unset") continue;
		if (attribute === "set" || await isTextPath(repository.root, filePath)) textPaths.push(filePath);
	}
	return {
		textPaths,
		trackedTextPaths: textPaths.filter((filePath) => trackedPaths.has(filePath)),
	};
}

function requireTextPathList(value, field) {
	if (!Array.isArray(value) || value.some((filePath) => typeof filePath !== "string"
		|| !filePath || filePath.includes("\0") || path.isAbsolute(filePath)
		|| filePath.split(/[\\/]/).includes(".."))) {
		throw new GitCheckpointError("INVALID_CHECKPOINT", `Checkpoint ${field} must be a safe path list`, { field });
	}
	return [...new Set(value)];
}

async function indexEntries(repository, indexPath, runner, signal) {
	const output = (await runGit(repository.root, ["ls-files", "-s", "-z"], {
		runner, signal, env: { GIT_INDEX_FILE: indexPath },
	})).stdout;
	return output.split("\0").filter(Boolean).map((record) => {
		const match = record.match(/^(\d+) ([0-9a-f]{40,64}) (\d)\t(.+)$/s);
		if (!match || match[3] !== "0") {
			throw new GitCheckpointError("INVALID_CHECKPOINT", "Checkpoint index contains an unsupported entry");
		}
		return { mode: match[1], oid: match[2], path: match[4] };
	});
}

/**
 * Capture selected text paths from the index and worktree into Git objects.
 * The user's index, worktree, branch, HEAD, and refs outside the Pi namespace are untouched.
 */
export async function captureCheckpoint(repository, options, dependencies = {}) {
	if (!repository?.root || !repository?.commonDir || repository.bare) {
		throw new GitCheckpointError("INVALID_REPOSITORY", "A non-bare Git worktree is required");
	}
	const runner = dependencyRunner(dependencies);
	const signal = dependencies.signal;
	const ref = sessionRef(options?.sessionId);
	const randomUUID = dependencies.randomUUID ?? nodeRandomUUID;
	const tempBase = dependencies.tempDir ?? os.tmpdir();
	const tempIndex = path.join(tempBase, `pi-git-checkpoint-index-${randomUUID()}`);
	const tempWorktreeIndex = path.join(tempBase, `pi-git-checkpoint-worktree-index-${randomUUID()}`);
	const temporaryIndexes = [tempIndex, tempWorktreeIndex];

	try {
		await rejectUnsupportedIndex(repository, runner, signal);
		const [head, realIndexTree, previousAnchor, selection] = await Promise.all([
			readHead(repository, runner, signal),
			runGit(repository.root, ["write-tree"], { runner, signal }).then((result) => result.stdout.trim()),
			readCurrentAnchor(repository, ref, runner, signal),
			checkpointTextPaths(repository, runner, signal),
		]);

		const alternateIndexEnv = { GIT_INDEX_FILE: tempIndex };
		await runGit(repository.root, ["read-tree", realIndexTree], { runner, signal, env: alternateIndexEnv });
		const excludedTrackedPaths = (await gitPaths(repository, ["ls-files", "-z", "--cached"], runner, signal))
			.filter((filePath) => !selection.trackedTextPaths.includes(filePath));
		await removeIndexPaths(repository, excludedTrackedPaths, runner, signal, alternateIndexEnv);
		const indexTree = (await runGit(repository.root, ["write-tree"], {
			runner, signal, env: alternateIndexEnv,
		})).stdout.trim();

		const alternateWorktreeIndexEnv = { GIT_INDEX_FILE: tempWorktreeIndex };
		await runGit(repository.root, ["read-tree", indexTree], { runner, signal, env: alternateWorktreeIndexEnv });
		await addWorktreePaths(repository, selection.textPaths, runner, signal, alternateWorktreeIndexEnv);
		const worktreeTree = (await runGit(repository.root, ["write-tree"], {
			runner, signal, env: alternateWorktreeIndexEnv,
		})).stdout.trim();

		const capturedAt = captureTime(dependencies.now);
		const indexCommit = await commitTree(
			repository,
			indexTree,
			[],
			`Pi checkpoint index\n\nsession: ${options.sessionId}\ncaptured: ${capturedAt}`,
			runner,
			signal,
		);
		const anchorParents = previousAnchor ? [previousAnchor, indexCommit] : [indexCommit];
		const anchorCommit = await commitTree(
			repository,
			worktreeTree,
			anchorParents,
			`Pi code checkpoint\n\nsession: ${options.sessionId}\nreason: ${options.reason}\ncaptured: ${capturedAt}`,
			runner,
			signal,
		);
		const expectedOld = previousAnchor ?? "0".repeat(anchorCommit.length);
		const update = await runGit(repository.root, [
			"update-ref", "-m", "Pi code checkpoint", ref, anchorCommit, expectedOld,
		], { runner, signal, allowFailure: true });
		if (update.code !== 0) {
			throw new GitCheckpointError(
				"REF_UPDATE_FAILED",
				`Cannot anchor checkpoint at ${ref}: ${(update.stderr || update.stdout).trim() || `exit ${update.code}`}`,
				{ ref, anchorCommit, previousAnchor, exitCode: update.code },
			);
		}

		return {
			version: CHECKPOINT_VERSION,
			repositoryRoot: repository.root,
			repositoryCommonDir: repository.commonDir,
			capturedAt,
			reason: options.reason,
			representedLeafId: options.representedLeafId ?? null,
			head,
			sessionRef: ref,
			anchorCommit,
			indexCommit,
			worktreeTree,
			indexTree,
			textPaths: selection.textPaths,
			trackedTextPaths: selection.trackedTextPaths,
		};
	} finally {
		await Promise.all(temporaryIndexes.flatMap((index) => [rm(index, { force: true }), rm(`${index}.lock`, { force: true })]));
	}
}

function requireObjectId(value, field) {
	if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
		throw new GitCheckpointError("INVALID_CHECKPOINT", `Checkpoint ${field} is not a valid Git object ID`, { field });
	}
	return value;
}

async function requireObject(repository, oid, expectedType, runner, signal) {
	const result = await runGit(repository.root, ["cat-file", "-e", `${oid}^{${expectedType}}`], {
		runner, signal, allowFailure: true,
	});
	if (result.code !== 0) {
		throw new GitCheckpointError(
			"MISSING_CHECKPOINT_OBJECT",
			`Checkpoint ${expectedType} object ${oid} is missing or invalid`,
			{ oid, expectedType, exitCode: result.code },
		);
	}
}

function parseCommit(raw) {
	const header = raw.split("\n\n", 1)[0];
	const tree = header.match(/^tree ([0-9a-f]{40,64})$/m)?.[1];
	const parents = [...header.matchAll(/^parent ([0-9a-f]{40,64})$/gm)].map((match) => match[1]);
	return { tree, parents };
}

/** Validate repository identity, object types, commit links, and ref reachability before mutation. */
export async function validateCheckpoint(repository, checkpoint, dependencies = {}) {
	const runner = dependencyRunner(dependencies);
	const signal = dependencies.signal;
	if (!checkpoint || (checkpoint.version !== CHECKPOINT_VERSION && checkpoint.version !== LEGACY_CHECKPOINT_VERSION)) {
		throw new GitCheckpointError(
			"UNSUPPORTED_CHECKPOINT_VERSION",
			`Unsupported Git checkpoint version ${checkpoint?.version ?? "missing"}`,
			{ expected: [LEGACY_CHECKPOINT_VERSION, CHECKPOINT_VERSION], actual: checkpoint?.version },
		);
	}
	if (checkpoint.version === CHECKPOINT_VERSION) {
		const textPaths = requireTextPathList(checkpoint.textPaths, "textPaths");
		const trackedTextPaths = requireTextPathList(checkpoint.trackedTextPaths, "trackedTextPaths");
		if (trackedTextPaths.some((filePath) => !textPaths.includes(filePath))) {
			throw new GitCheckpointError("INVALID_CHECKPOINT", "Checkpoint tracked text paths are not a subset of text paths");
		}
	}
	if (typeof checkpoint.repositoryRoot !== "string" || typeof checkpoint.repositoryCommonDir !== "string") {
		throw new GitCheckpointError("INVALID_CHECKPOINT", "Checkpoint repository identity is missing");
	}
	const current = await findGitRepository(repository.root, { runner, signal });
	if (!current || current.root !== repository.root || current.commonDir !== repository.commonDir) {
		throw new GitCheckpointError(
			"REPOSITORY_CHANGED",
			"The active Git worktree no longer matches the initialized checkpoint repository",
			{ expectedRoot: repository.root, expectedCommonDir: repository.commonDir, current },
		);
	}
	if (checkpoint.repositoryRoot !== current.root || checkpoint.repositoryCommonDir !== current.commonDir) {
		throw new GitCheckpointError(
			"REPOSITORY_MISMATCH",
			"Checkpoint belongs to a different Git repository or worktree",
			{
				expectedRoot: checkpoint.repositoryRoot,
				expectedCommonDir: checkpoint.repositoryCommonDir,
				currentRoot: current.root,
				currentCommonDir: current.commonDir,
			},
		);
	}
	if (typeof checkpoint.sessionRef !== "string" || !/^refs\/pi\/checkpoints\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(checkpoint.sessionRef)) {
		throw new GitCheckpointError("INVALID_CHECKPOINT", "Checkpoint session ref is invalid");
	}

	const worktreeTree = requireObjectId(checkpoint.worktreeTree, "worktreeTree");
	const indexTree = requireObjectId(checkpoint.indexTree, "indexTree");
	const anchorCommit = requireObjectId(checkpoint.anchorCommit, "anchorCommit");
	const indexCommit = requireObjectId(checkpoint.indexCommit, "indexCommit");
	await Promise.all([
		requireObject(current, worktreeTree, "tree", runner, signal),
		requireObject(current, indexTree, "tree", runner, signal),
		requireObject(current, anchorCommit, "commit", runner, signal),
		requireObject(current, indexCommit, "commit", runner, signal),
	]);

	const [anchorRaw, indexRaw, currentAnchor] = await Promise.all([
		runGit(current.root, ["cat-file", "-p", anchorCommit], { runner, signal }),
		runGit(current.root, ["cat-file", "-p", indexCommit], { runner, signal }),
		readCurrentAnchor(current, checkpoint.sessionRef, runner, signal),
	]);
	const anchor = parseCommit(anchorRaw.stdout);
	const index = parseCommit(indexRaw.stdout);
	if (anchor.tree !== worktreeTree || !anchor.parents.includes(indexCommit) || index.tree !== indexTree) {
		throw new GitCheckpointError(
			"CHECKPOINT_LINK_MISMATCH",
			"Checkpoint commit links do not match the recorded worktree and index trees",
			{ anchorCommit, indexCommit, anchor, index },
		);
	}
	if (!currentAnchor) {
		throw new GitCheckpointError(
			"UNANCHORED_CHECKPOINT",
			`Checkpoint ref ${checkpoint.sessionRef} no longer exists`,
			{ ref: checkpoint.sessionRef, anchorCommit },
		);
	}
	const reachable = await runGit(current.root, ["merge-base", "--is-ancestor", anchorCommit, currentAnchor], {
		runner, signal, allowFailure: true,
	});
	if (reachable.code !== 0) {
		throw new GitCheckpointError(
			"UNANCHORED_CHECKPOINT",
			"Checkpoint objects are not reachable from their recorded session ref",
			{ ref: checkpoint.sessionRef, anchorCommit, currentAnchor },
		);
	}
	return current;
}

async function restorePhase(repository, phase, args, runner, signal, env) {
	try {
		return await runGit(repository.root, args, { runner, signal, env });
	} catch (error) {
		if (error instanceof GitCheckpointError && error.code === "ABORTED") throw error;
		throw new GitCheckpointError(
			"RESTORE_FAILED",
			`Git checkpoint restore failed during ${phase}: ${error instanceof Error ? error.message : String(error)}`,
			{ phase, repositoryRoot: repository.root },
			{ cause: error },
		);
	}
}

async function replaceableTextPath(root, relativePath) {
	try {
		await lstat(path.join(root, relativePath));
		return isTextPath(root, relativePath);
	} catch (error) {
		if (error?.code === "ENOENT") return true;
		throw error;
	}
}

async function restoreTextCheckpoint(repository, checkpoint, runner, signal, dependencies) {
	const randomUUID = dependencies.randomUUID ?? nodeRandomUUID;
	const tempIndex = path.join(dependencies.tempDir ?? os.tmpdir(), `pi-git-checkpoint-restore-index-${randomUUID()}`);
	const tempIndexEnv = { GIT_INDEX_FILE: tempIndex };
	try {
		const [worktreePaths, indexPaths] = await Promise.all([
			treePaths(repository, checkpoint.worktreeTree, runner, signal),
			treePaths(repository, checkpoint.indexTree, runner, signal),
		]);
		const worktreePathSet = new Set(worktreePaths);
		const indexPathSet = new Set(indexPaths);
		const savedWorktreePaths = checkpoint.textPaths.filter((filePath) => worktreePathSet.has(filePath));
		const safeWorktreePaths = [];
		for (const filePath of savedWorktreePaths) {
			if (await replaceableTextPath(repository.root, filePath)) safeWorktreePaths.push(filePath);
		}

		await restorePhase(repository, "loading checkpoint text worktree", ["read-tree", checkpoint.worktreeTree], runner, signal, tempIndexEnv);
		for (const batch of batches(safeWorktreePaths)) {
			if (batch.length) await restorePhase(repository, "writing checkpoint text worktree", [
				"checkout-index", "--force", `--prefix=${repository.root}${path.sep}`, "--", ...batch,
			], runner, signal, tempIndexEnv);
		}
		for (const filePath of checkpoint.trackedTextPaths) {
			if (!worktreePathSet.has(filePath) && await replaceableTextPath(repository.root, filePath)) {
				await rm(path.join(repository.root, filePath), { force: true });
			}
		}

		await restorePhase(repository, "loading checkpoint text index", ["read-tree", checkpoint.indexTree], runner, signal, tempIndexEnv);
		const trackedTextPathSet = new Set(checkpoint.trackedTextPaths);
		const entries = (await indexEntries(repository, tempIndex, runner, signal))
			.filter((entry) => trackedTextPathSet.has(entry.path));
		for (const batch of batches(entries, 128)) {
			if (batch.length) await restorePhase(repository, "writing checkpoint text index", [
				"update-index", "--add", ...batch.flatMap((entry) => ["--cacheinfo", `${entry.mode},${entry.oid},${entry.path}`]),
			], runner, signal);
		}
		for (const batch of batches(checkpoint.trackedTextPaths.filter((filePath) => !indexPathSet.has(filePath)))) {
			if (batch.length) await restorePhase(repository, "removing checkpoint text index paths", [
				"update-index", "--force-remove", "--", ...batch,
			], runner, signal);
		}
		const capturedUntrackedPaths = [];
		for (const filePath of checkpoint.textPaths) {
			if (!trackedTextPathSet.has(filePath) && await replaceableTextPath(repository.root, filePath)) {
				capturedUntrackedPaths.push(filePath);
			}
		}
		for (const batch of batches(capturedUntrackedPaths)) {
			if (batch.length) await restorePhase(repository, "unstaging checkpoint text-only untracked paths", [
				"update-index", "--force-remove", "--", ...batch,
			], runner, signal);
		}
	} finally {
		await Promise.all([rm(tempIndex, { force: true }), rm(`${tempIndex}.lock`, { force: true })]);
	}
}

/**
 * Restore checkpoint worktree content and then its saved stage-0 index tree.
 * This deliberately never names a branch or HEAD in a mutating Git command.
 */
export async function restoreCheckpoint(repository, checkpoint, dependencies = {}) {
	const runner = dependencyRunner(dependencies);
	const signal = dependencies.signal;
	const current = await validateCheckpoint(repository, checkpoint, { runner, signal });
	await rejectUnsupportedIndex(current, runner, signal);
	const headBefore = await readHead(current, runner, signal);
	if (checkpoint.version === LEGACY_CHECKPOINT_VERSION) {
		await restorePhase(current, "cleaning current non-ignored untracked paths", ["clean", "-fd", "--", "."], runner, signal);
		await restorePhase(current, "loading checkpoint worktree", ["read-tree", "--reset", "-u", checkpoint.worktreeTree], runner, signal);
		await restorePhase(current, "loading checkpoint index", ["read-tree", "--reset", checkpoint.indexTree], runner, signal);

		const writtenIndex = (await restorePhase(current, "verifying restored index", ["write-tree"], runner, signal)).stdout.trim();
		if (writtenIndex !== checkpoint.indexTree) {
			throw new GitCheckpointError(
				"RESTORE_FAILED",
				"Restored Git index does not match the checkpoint",
				{ phase: "verifying restored index", expected: checkpoint.indexTree, actual: writtenIndex },
			);
		}
	} else {
		await restoreTextCheckpoint(current, checkpoint, runner, signal, dependencies);
	}

	const headAfter = await readHead(current, runner, signal);
	if (headAfter.oid !== headBefore.oid || headAfter.ref !== headBefore.ref) {
		throw new GitCheckpointError(
			"HEAD_CHANGED",
			"Git HEAD changed unexpectedly during checkpoint restoration",
			{ before: headBefore, after: headAfter },
		);
	}
}
