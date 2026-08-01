import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readlink, rename, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	CHECKPOINT_VERSION,
	GitCheckpointError,
	captureCheckpoint,
	findGitRepository,
	restoreCheckpoint,
} from "../git-checkpoints.js";
import {
	createRepository,
	diff,
	exists,
	fileMode,
	git,
	headState,
	indexContent,
	makeSymlink,
	read,
	runCommand,
	status,
	treePaths,
	write,
} from "./fixtures.mjs";

function capture(repository, overrides = {}, dependencies = {}) {
	return captureCheckpoint(repository, {
		sessionId: "018f-test-session",
		reason: "before-prompt",
		representedLeafId: "leaf-before-prompt",
		...overrides,
	}, dependencies);
}

test("detects and canonicalizes a worktree root, and returns null outside Git", async (t) => {
	const root = await createRepository(t);
	const nested = path.join(root, "nested", "directory");
	await mkdir(nested, { recursive: true });
	const repository = await findGitRepository(nested);
	assert.ok(repository);
	assert.equal(repository.root, await pathToRealpath(root));
	assert.equal(repository.bare, false);

	const outside = await mkdtemp(path.join(os.tmpdir(), "pi-no-git-"));
	t.after(async () => rm(outside, { recursive: true, force: true }));
	assert.equal(await findGitRepository(outside), null);
});

test("captures a clean checkpoint without changing the real index or worktree", async (t) => {
	const root = await createRepository(t);
	const repository = await findGitRepository(root);
	const before = {
		status: await status(root),
		cached: await diff(root, { cached: true }),
		worktree: await diff(root),
		head: await headState(root),
	};
	const checkpoint = await capture(repository);

	assert.equal(checkpoint.version, CHECKPOINT_VERSION);
	assert.equal(checkpoint.repositoryRoot, repository.root);
	assert.equal(checkpoint.repositoryCommonDir, repository.commonDir);
	assert.equal(checkpoint.reason, "before-prompt");
	assert.equal(checkpoint.representedLeafId, "leaf-before-prompt");
	assert.equal(checkpoint.head.oid, before.head.oid);
	assert.equal(checkpoint.head.ref, before.head.ref);
	assert.match(checkpoint.worktreeTree, /^[0-9a-f]{40,64}$/);
	assert.match(checkpoint.indexTree, /^[0-9a-f]{40,64}$/);
	assert.match(checkpoint.anchorCommit, /^[0-9a-f]{40,64}$/);
	assert.match(checkpoint.indexCommit, /^[0-9a-f]{40,64}$/);
	assert.equal((await git(root, ["rev-parse", checkpoint.sessionRef])).stdout.trim(), checkpoint.anchorCommit);
	assert.deepEqual({
		status: await status(root),
		cached: await diff(root, { cached: true }),
		worktree: await diff(root),
		head: await headState(root),
	}, before);
});

test("captures dirty state repeatedly, anchors history, and cleans temporary indexes", async (t) => {
	const root = await createRepository(t);
	const repository = await findGitRepository(root);
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-checkpoint-index-success-"));
	t.after(async () => rm(tempDir, { recursive: true, force: true }));
	await write(root, "partial.txt", "staged snapshot\n");
	await git(root, ["add", "partial.txt"]);
	await write(root, "partial.txt", "worktree snapshot\n");
	await write(root, "captured-untracked.txt", "untracked snapshot\n");
	await write(root, "cache.ignored", "ignored snapshot\n");
	const beforeFirst = { status: await status(root), cached: await diff(root, { cached: true }), worktree: await diff(root) };
	const first = await capture(repository, { representedLeafId: "leaf-1" }, { tempDir });
	assert.deepEqual(
		{ status: await status(root), cached: await diff(root, { cached: true }), worktree: await diff(root) },
		beforeFirst,
	);
	assert.deepEqual(await treePathsFromDirectory(tempDir), []);
	assert.ok((await treePaths(root, first.worktreeTree)).includes("captured-untracked.txt"));
	assert.ok(!(await treePaths(root, first.worktreeTree)).includes("cache.ignored"));

	await write(root, "tracked.txt", "second checkpoint\n");
	const beforeSecond = await status(root);
	const second = await capture(repository, { representedLeafId: "leaf-2" }, { tempDir });
	assert.equal(await status(root), beforeSecond);
	assert.equal((await git(root, ["rev-parse", second.sessionRef])).stdout.trim(), second.anchorCommit);
	assert.equal((await git(root, ["merge-base", "--is-ancestor", first.anchorCommit, second.anchorCommit], { allowFailure: true })).code, 0);
	const identity = (await git(root, ["show", "-s", "--format=%an%x00%ae", second.anchorCommit])).stdout.trim();
	assert.equal(identity, "Pi Code Checkpoints\u0000pi-checkpoints@localhost.invalid");
	assert.deepEqual(await treePathsFromDirectory(tempDir), []);
});

test("cleans temporary indexes after command failure, cancellation, and ref-update failure", async (t) => {
	const root = await createRepository(t);
	const repository = await findGitRepository(root);
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-checkpoint-index-failure-"));
	t.after(async () => rm(tempDir, { recursive: true, force: true }));

	const failAddRunner = async (command, args, options) => {
		if (command === "git" && args[0] === "add" && options.env?.GIT_INDEX_FILE) {
			return { stdout: "", stderr: "injected add failure", code: 9, killed: false };
		}
		return runCommand(command, args, options);
	};
	await assert.rejects(
		capture(repository, {}, { tempDir, runner: failAddRunner }),
		(error) => error instanceof GitCheckpointError && error.code === "GIT_COMMAND_FAILED",
	);
	assert.deepEqual(await treePathsFromDirectory(tempDir), []);

	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		capture(repository, {}, { tempDir, signal: controller.signal }),
		(error) => error instanceof GitCheckpointError && error.code === "ABORTED",
	);
	assert.deepEqual(await treePathsFromDirectory(tempDir), []);

	const failRefRunner = async (command, args, options) => {
		if (command === "git" && args.includes("update-ref")) {
			return { stdout: "", stderr: "injected ref race", code: 5, killed: false };
		}
		return runCommand(command, args, options);
	};
	await assert.rejects(
		capture(repository, {}, { tempDir, runner: failRefRunner }),
		(error) => error instanceof GitCheckpointError && error.code === "REF_UPDATE_FAILED",
	);
	assert.deepEqual(await treePathsFromDirectory(tempDir), []);
	assert.equal((await git(root, ["rev-parse", "--verify", "--quiet", "refs/pi/checkpoints/018f-test-session"], { allowFailure: true })).code, 1);
});

test("restores tracked, staged, unstaged, deleted, renamed, executable, symlink, and untracked state", async (t) => {
	const root = await createRepository(t);
	await git(root, ["config", "core.filemode", "true"]);
	const repository = await findGitRepository(root);

	await write(root, "staged.txt", "staged target\n");
	await git(root, ["add", "staged.txt"]);
	await write(root, "partial.txt", "partial staged\n");
	await git(root, ["add", "partial.txt"]);
	await write(root, "partial.txt", "partial worktree\n");
	await write(root, "unstaged.txt", "unstaged target\n");
	await unlink(path.join(root, "delete-me.txt"));
	await git(root, ["mv", "rename-me.txt", "renamed.txt"]);
	await chmod(path.join(root, "script.sh"), 0o755);
	await makeSymlink(root, "tracked.txt", "target-link");
	await write(root, "untracked/target.txt", "untracked target\n");
	await write(root, "ignored/cache.ignored", "ignored at capture\n");

	const expected = {
		status: await status(root),
		cached: await diff(root, { cached: true }),
		worktree: await diff(root),
	};
	const checkpoint = await capture(repository);
	const capturedPaths = await treePaths(root, checkpoint.worktreeTree);
	assert.ok(capturedPaths.includes("untracked/target.txt"));
	assert.ok(capturedPaths.includes("target-link"));
	assert.ok(!capturedPaths.includes("ignored/cache.ignored"));

	await git(root, ["add", "-A"]);
	await write(root, "staged.txt", "later staged\n");
	await write(root, "partial.txt", "later partial\n");
	await write(root, "unstaged.txt", "later unstaged\n");
	await write(root, "delete-me.txt", "later replacement\n");
	if (await exists(root, "renamed.txt")) await unlink(path.join(root, "renamed.txt"));
	await write(root, "rename-me.txt", "later old path\n");
	await chmod(path.join(root, "script.sh"), 0o644);
	if (await exists(root, "target-link")) await unlink(path.join(root, "target-link"));
	await write(root, "untracked/target.txt", "later target\n");
	await write(root, "untracked/later.txt", "remove me\n");
	await write(root, "later-directory/nested.txt", "remove me too\n");
	await write(root, "ignored/cache.ignored", "ignored survives restore\n");
	const beforeRestoreHead = await headState(root);

	await restoreCheckpoint(repository, checkpoint);

	assert.deepEqual(await headState(root), beforeRestoreHead);
	assert.equal(await status(root), expected.status);
	assert.equal(await diff(root, { cached: true }), expected.cached);
	assert.equal(await diff(root), expected.worktree);
	assert.equal(await read(root, "staged.txt"), "staged target\n");
	assert.equal(await indexContent(root, "staged.txt"), "staged target\n");
	assert.equal(await read(root, "partial.txt"), "partial worktree\n");
	assert.equal(await indexContent(root, "partial.txt"), "partial staged\n");
	assert.equal(await read(root, "unstaged.txt"), "unstaged target\n");
	assert.equal(await exists(root, "delete-me.txt"), false);
	assert.equal(await exists(root, "rename-me.txt"), false);
	assert.equal(await read(root, "renamed.txt"), "rename me\n");
	assert.ok((await fileMode(root, "script.sh")) & 0o100, "executable bit restored");
	assert.equal(await readlink(path.join(root, "target-link")), "tracked.txt");
	assert.equal(await read(root, "untracked/target.txt"), "untracked target\n");
	assert.equal(await exists(root, "untracked/later.txt"), false);
	assert.equal(await exists(root, "later-directory"), false);
	assert.equal(await read(root, "ignored/cache.ignored"), "ignored survives restore\n");
});

test("keeps every historical checkpoint reachable through the session ref", async (t) => {
	const root = await createRepository(t);
	const repository = await findGitRepository(root);
	await write(root, "tracked.txt", "checkpoint one\n");
	const first = await capture(repository, { representedLeafId: "leaf-1" });
	await write(root, "tracked.txt", "checkpoint two\n");
	await write(root, "second-untracked.txt", "second\n");
	const second = await capture(repository, { representedLeafId: "leaf-2" });

	assert.equal(first.sessionRef, second.sessionRef);
	assert.equal((await git(root, ["rev-parse", second.sessionRef])).stdout.trim(), second.anchorCommit);
	assert.equal((await git(root, ["merge-base", "--is-ancestor", first.anchorCommit, second.anchorCommit], { allowFailure: true })).code, 0);
	for (const object of [first.anchorCommit, first.indexCommit, first.worktreeTree, first.indexTree]) {
		assert.equal((await git(root, ["cat-file", "-e", object], { allowFailure: true })).code, 0);
	}

	const reloadedFirst = JSON.parse(JSON.stringify(first));
	await restoreCheckpoint(repository, reloadedFirst);
	assert.equal(await read(root, "tracked.txt"), "checkpoint one\n");
	assert.equal(await exists(root, "second-untracked.txt"), false);
	await restoreCheckpoint(repository, second);
	assert.equal(await read(root, "tracked.txt"), "checkpoint two\n");
	assert.equal(await read(root, "second-untracked.txt"), "second\n");
});

test("does not move the branch or HEAD when commits were added after capture", async (t) => {
	const root = await createRepository(t);
	const repository = await findGitRepository(root);
	await write(root, "tracked.txt", "old checkpoint worktree\n");
	await write(root, "partial.txt", "old checkpoint index\n");
	await git(root, ["add", "partial.txt"]);
	const checkpoint = await capture(repository);

	await git(root, ["restore", "--staged", "--worktree", "."]);
	await write(root, "later-commit.txt", "new commit\n");
	await git(root, ["add", "later-commit.txt"]);
	await git(root, ["commit", "-m", "advance head"]);
	const advanced = await headState(root);

	await restoreCheckpoint(repository, checkpoint);
	assert.deepEqual(await headState(root), advanced);
	assert.equal(await read(root, "tracked.txt"), "old checkpoint worktree\n");
	assert.equal(await indexContent(root, "partial.txt"), "old checkpoint index\n");
	assert.equal(await exists(root, "later-commit.txt"), false);
	assert.equal((await git(root, ["write-tree"])).stdout.trim(), checkpoint.indexTree);
});

test("captures and restores an unborn repository", async (t) => {
	const root = await createRepository(t, { unborn: true });
	await write(root, ".gitignore", "*.ignored\n");
	await write(root, "first.txt", "first target\n");
	await write(root, "private.ignored", "ignored target\n");
	const repository = await findGitRepository(root);
	const checkpoint = await capture(repository, { representedLeafId: null });
	assert.equal(checkpoint.head.oid, null);
	assert.equal(checkpoint.head.ref, "refs/heads/main");

	await write(root, "first.txt", "later\n");
	await write(root, "later.txt", "remove\n");
	await write(root, "private.ignored", "ignored survives\n");
	const beforeRestoreHead = await headState(root);
	await restoreCheckpoint(repository, checkpoint);

	assert.deepEqual(await headState(root), beforeRestoreHead);
	assert.equal(await read(root, "first.txt"), "first target\n");
	assert.equal(await exists(root, "later.txt"), false);
	assert.equal(await read(root, "private.ignored"), "ignored survives\n");
	assert.match(await status(root), /^\?\? \.gitignore\n\?\? first\.txt\n/m);
});

test("validates version, repository identity, object IDs, and ref reachability before mutation", async (t) => {
	const root = await createRepository(t);
	const repository = await findGitRepository(root);
	const checkpoint = await capture(repository);
	await write(root, "tracked.txt", "must remain untouched\n");
	await write(root, "later-untracked.txt", "must remain too\n");
	const before = await status(root);
	const invalidCases = [
		[{ ...checkpoint, version: 999 }, "UNSUPPORTED_CHECKPOINT_VERSION"],
		[{ ...checkpoint, repositoryRoot: `${checkpoint.repositoryRoot}-other` }, "REPOSITORY_MISMATCH"],
		[{ ...checkpoint, worktreeTree: "f".repeat(checkpoint.worktreeTree.length) }, "MISSING_CHECKPOINT_OBJECT"],
		[{ ...checkpoint, sessionRef: "refs/pi/checkpoints/missing-session" }, "UNANCHORED_CHECKPOINT"],
	];
	for (const [invalid, code] of invalidCases) {
		await assert.rejects(
			restoreCheckpoint(repository, invalid),
			(error) => error instanceof GitCheckpointError && error.code === code,
			code,
		);
		assert.equal(await status(root), before, `${code} mutated repository state`);
	}
});

test("preserves later nested Git repositories while removing ordinary later untracked paths", async (t) => {
	const root = await createRepository(t);
	const repository = await findGitRepository(root);
	const checkpoint = await capture(repository);
	const nested = path.join(root, "nested-repository");
	await mkdir(nested, { recursive: true });
	await git(nested, ["init", "--initial-branch=main"]);
	await write(root, "nested-repository/local.txt", "nested data\n");
	await write(root, "ordinary-later.txt", "remove me\n");

	await restoreCheckpoint(repository, checkpoint);
	assert.equal(await read(root, "nested-repository/local.txt"), "nested data\n");
	assert.equal(await exists(root, "ordinary-later.txt"), false);
});

test("rejects intent-to-add and unmerged indexes without publishing false checkpoints", async (t) => {
	const intentRoot = await createRepository(t);
	await write(intentRoot, "intent.txt", "intent content\n");
	await git(intentRoot, ["add", "--intent-to-add", "intent.txt"]);
	const intentRepository = await findGitRepository(intentRoot);
	await assert.rejects(
		capture(intentRepository),
		(error) => error instanceof GitCheckpointError && error.code === "INTENT_TO_ADD",
	);
	assert.equal((await git(intentRoot, ["rev-parse", "--verify", "--quiet", "refs/pi/checkpoints/018f-test-session"], { allowFailure: true })).code, 1);

	const root = await createRepository(t);
	await git(root, ["checkout", "-b", "conflict"]);
	await write(root, "tracked.txt", "conflict branch\n");
	await git(root, ["commit", "-am", "conflict branch"]);
	await git(root, ["checkout", "main"]);
	await write(root, "tracked.txt", "main branch\n");
	await git(root, ["commit", "-am", "main branch"]);
	const merge = await git(root, ["merge", "conflict"], { allowFailure: true });
	assert.notEqual(merge.code, 0);
	const repository = await findGitRepository(root);
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-checkpoint-index-test-"));
	t.after(async () => rm(tempDir, { recursive: true, force: true }));

	await assert.rejects(
		capture(repository, {}, { tempDir }),
		(error) => error instanceof GitCheckpointError && error.code === "UNMERGED_INDEX",
	);
	assert.deepEqual(await treePathsFromDirectory(tempDir), []);
	assert.equal((await git(root, ["show-ref", "--verify", "--quiet", "refs/pi/checkpoints/018f-test-session"], { allowFailure: true })).code, 1);
});

test("rejects sparse checkout semantics before capture", async (t) => {
	const root = await createRepository(t);
	await git(root, ["config", "core.sparseCheckout", "true"]);
	const repository = await findGitRepository(root);
	await assert.rejects(
		capture(repository),
		(error) => error instanceof GitCheckpointError && error.code === "SPARSE_CHECKOUT",
	);
	assert.equal((await git(root, ["rev-parse", "--verify", "--quiet", "refs/pi/checkpoints/018f-test-session"], { allowFailure: true })).code, 1);
});

test("reports a structured restore phase when Git mutation fails", async (t) => {
	const root = await createRepository(t);
	const repository = await findGitRepository(root);
	const checkpoint = await capture(repository);
	const headBefore = await headState(root);
	const failWorktreeRunner = async (command, args, options) => {
		if (command === "git" && args[0] === "read-tree" && args.includes("-u")) {
			return { stdout: "", stderr: "injected checkout failure", code: 7, killed: false };
		}
		return runCommand(command, args, options);
	};
	await assert.rejects(
		restoreCheckpoint(repository, checkpoint, { runner: failWorktreeRunner }),
		(error) => error instanceof GitCheckpointError
			&& error.code === "RESTORE_FAILED"
			&& error.details.phase === "loading checkpoint worktree",
	);
	assert.deepEqual(await headState(root), headBefore);
});

test("refuses to overwrite a current unmerged index during restore", async (t) => {
	const root = await createRepository(t);
	const repository = await findGitRepository(root);
	const checkpoint = await capture(repository);
	await git(root, ["checkout", "-b", "conflict"]);
	await write(root, "tracked.txt", "conflict branch\n");
	await git(root, ["commit", "-am", "conflict branch"]);
	await git(root, ["checkout", "main"]);
	await write(root, "tracked.txt", "main branch\n");
	await git(root, ["commit", "-am", "main branch"]);
	assert.notEqual((await git(root, ["merge", "conflict"], { allowFailure: true })).code, 0);
	const before = await status(root);

	await assert.rejects(
		restoreCheckpoint(repository, checkpoint),
		(error) => error instanceof GitCheckpointError && error.code === "UNMERGED_INDEX",
	);
	assert.equal(await status(root), before);
});

async function pathToRealpath(value) {
	return (await import("node:fs/promises")).realpath(value);
}

async function treePathsFromDirectory(directory) {
	return (await import("node:fs/promises")).readdir(directory);
}
