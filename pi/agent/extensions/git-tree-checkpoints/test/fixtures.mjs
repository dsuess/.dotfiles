import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runCommand(command, args, options = {}) {
	try {
		const result = await execFileAsync(command, args, {
			cwd: options.cwd,
			encoding: "utf8",
			env: { ...process.env, ...(options.env ?? {}) },
			maxBuffer: 10 * 1024 * 1024,
			signal: options.signal,
		});
		return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
	} catch (error) {
		return {
			stdout: error.stdout ?? "",
			stderr: error.stderr ?? error.message,
			code: typeof error.code === "number" ? error.code : 1,
			killed: Boolean(error.killed || options.signal?.aborted),
		};
	}
}

export async function git(cwd, args, options = {}) {
	const result = await runCommand("git", args, { cwd, env: options.env, signal: options.signal });
	if (result.code !== 0 && !options.allowFailure) {
		throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
	}
	return result;
}

export async function createRepository(t, { unborn = false } = {}) {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-git-tree-checkpoints-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	await git(root, ["init", "--initial-branch=main"]);
	await git(root, ["config", "user.name", "Fixture User"]);
	await git(root, ["config", "user.email", "fixture@example.invalid"]);
	await git(root, ["config", "commit.gpgsign", "false"]);
	if (!unborn) {
		await write(root, ".gitignore", "ignored/\n*.ignored\n");
		await write(root, "tracked.txt", "tracked base\n");
		await write(root, "partial.txt", "partial base\n");
		await write(root, "unstaged.txt", "unstaged base\n");
		await write(root, "delete-me.txt", "delete me\n");
		await write(root, "rename-me.txt", "rename me\n");
		await write(root, "script.sh", "#!/bin/sh\necho base\n");
		await git(root, ["add", "-A"]);
		await git(root, ["commit", "-m", "fixture baseline"]);
	}
	return root;
}

export async function write(root, relativePath, content, options = {}) {
	const absolutePath = path.join(root, relativePath);
	await mkdir(path.dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, content, options.encoding ?? "utf8");
	if (options.mode !== undefined) await chmod(absolutePath, options.mode);
	return absolutePath;
}

export async function read(root, relativePath) {
	return readFile(path.join(root, relativePath), "utf8");
}

export async function exists(root, relativePath) {
	try {
		await lstat(path.join(root, relativePath));
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

export async function makeSymlink(root, target, relativePath) {
	const absolutePath = path.join(root, relativePath);
	await mkdir(path.dirname(absolutePath), { recursive: true });
	await symlink(target, absolutePath);
	return absolutePath;
}

export async function fileMode(root, relativePath) {
	return (await lstat(path.join(root, relativePath))).mode & 0o777;
}

export async function status(root) {
	return (await git(root, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout;
}

export async function diff(root, { cached = false } = {}) {
	return (await git(root, ["diff", ...(cached ? ["--cached"] : []), "--binary"])).stdout;
}

export async function indexContent(root, relativePath) {
	return (await git(root, ["show", `:${relativePath}`])).stdout;
}

export async function headState(root) {
	const [oid, ref] = await Promise.all([
		git(root, ["rev-parse", "--verify", "HEAD"], { allowFailure: true }),
		git(root, ["symbolic-ref", "--quiet", "HEAD"], { allowFailure: true }),
	]);
	return {
		oid: oid.code === 0 ? oid.stdout.trim() : null,
		ref: ref.code === 0 ? ref.stdout.trim() : null,
	};
}

export async function treePaths(root, tree) {
	const output = (await git(root, ["ls-tree", "-r", "--name-only", tree])).stdout.trim();
	return output ? output.split("\n") : [];
}
