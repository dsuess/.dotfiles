import assert from "node:assert/strict";
import test from "node:test";

import { analyzeBashMutation, isKnownMutatingCommand } from "../bash-policy.js";

function blocked(command) {
	return analyzeBashMutation(command).blocked;
}

test("blocks filesystem mutations, output redirection, and write-oriented pipelines", () => {
	for (const command of [
		"rm -rf build",
		"mkdir -p out && touch out/result",
		"printf data > result.txt",
		"echo data 2>>errors.log",
		"cat input | tee output",
		"find . -name '*.tmp' -delete",
		"sed -i.bak 's/a/b/' file",
		"perl -pi -e 's/a/b/' file",
		"curl -sLo artifact.tar.gz https://example.test/artifact",
		"wget https://example.test/artifact",
		"tar xf artifact.tar.gz",
		"unzip artifact.zip",
		"rsync source/ destination/",
	]) {
		assert.equal(blocked(command), true, command);
	}
});

test("finds mutations behind chains, wrappers, subshells, and nested shells", () => {
	for (const command of [
		"pwd; command rm file",
		"echo ok || env FOO=1 mv a b",
		"env -u HOME rm file",
		"(cd tmp && cp a b)",
		"bash -c 'git reset --hard'",
		"sh -c \"npm install lodash\"",
		"echo $(touch generated)",
		"printf '%s' `mkdir generated`",
		"xargs rm < files.txt",
		"xargs -n 1 rm < files.txt",
		"find . -name '*.tmp' -exec rm {} \\;",
	]) {
		assert.equal(blocked(command), true, command);
	}
});

test("blocks mutating Git commands while allowing representative reads", () => {
	for (const command of [
		"git add .",
		"git -C ../repo add .",
		"git commit -m test",
		"git checkout main",
		"git branch -D old",
		"git tag v1.0.0",
		"git worktree add ../other",
		"git config user.name Example",
		"git diff --output=changes.patch",
	]) assert.equal(blocked(command), true, command);

	for (const command of [
		"git status --short",
		"git diff --stat",
		"git log -5 --oneline",
		"git show HEAD:README.md",
		"git branch --list",
		"git tag --list",
		"git worktree list",
		"git config --get user.name",
	]) assert.equal(blocked(command), false, command);
});

test("blocks package, process, service, and editor mutations", () => {
	for (const command of [
		"npm install",
		"npm --prefix ./web install",
		"pnpm remove package",
		"uv pip install requests",
		"python3 -m pip uninstall requests",
		"brew upgrade",
		"kill -9 123",
		"systemctl restart api",
		"service nginx stop",
		"docker restart api",
		"kubectl apply -f deployment.yaml",
		"nvim README.md",
		"sudo ls",
	]) assert.equal(blocked(command), true, command);

	for (const command of ["npm view react", "pnpm list", "pip list", "brew info jq", "systemctl status api"]) {
		assert.equal(blocked(command), false, command);
	}
});

test("avoids quoted examples, comparisons, and ordinary read pipelines", () => {
	for (const command of [
		"printf '%s\\n' 'rm -rf example'",
		"echo \"git commit -m example\"",
		"printf '%s' 'npm install foo' | grep npm",
		"[[ alpha > beta ]] && echo sorted",
		"git diff | sed -n '1,20p'",
		"rg 'touch|mkdir' src | head",
		"curl -fsSL https://example.test/data",
		"wget -qO- https://example.test/data",
		"tar tf artifact.tar.gz",
		"unzip -l artifact.zip",
		"rsync --dry-run source/ destination/",
	]) assert.equal(blocked(command), false, command);
});

test("documents the deliberate fail-open contract for unknown commands", () => {
	const result = analyzeBashMutation("acme-inspect --mystery-mode project");
	assert.deepEqual(result, { blocked: false, reason: null, detail: null });
	assert.equal(isKnownMutatingCommand("acme-inspect --mystery-mode project"), false);
});
