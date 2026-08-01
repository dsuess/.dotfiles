// Planning mode deliberately uses a fail-open policy: commands are allowed
// unless this detector can identify a known mutation. This is a workflow gate,
// not a shell sandbox or a complete proof that an arbitrary program is safe.

const FILE_MUTATORS = new Set([
	"rm",
	"rmdir",
	"mv",
	"cp",
	"mkdir",
	"touch",
	"truncate",
	"tee",
	"chmod",
	"chown",
	"chgrp",
	"ln",
	"install",
	"patch",
	"dd",
	"shred",
	"mkfifo",
	"mknod",
	"scp",
]);

const PROCESS_MUTATORS = new Set([
	"kill",
	"pkill",
	"killall",
	"reboot",
	"shutdown",
	"halt",
	"poweroff",
	"launchctl",
]);

const INTERACTIVE_EDITORS = new Set([
	"vi",
	"vim",
	"nvim",
	"view",
	"nano",
	"emacs",
	"code",
	"code-insiders",
	"subl",
	"sublime_text",
]);

const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh", "fish"]);
const WRAPPERS = new Set(["command", "builtin", "env", "nohup", "time"]);
const COMMAND_SEPARATORS = new Set([";", "&&", "||", "|", "&", "(", ")", "\n"]);
const OUTPUT_REDIRECTIONS = new Set([">", ">>", ">|", "&>", "&>>"]);

function basename(value) {
	return value.replaceAll("\\", "/").split("/").pop()?.toLowerCase() ?? "";
}

function isAssignment(value) {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function tokenize(command) {
	const tokens = [];
	let index = 0;
	let atBoundary = true;

	while (index < command.length) {
		const character = command[index];
		if (character === " " || character === "\t" || character === "\r") {
			index += 1;
			atBoundary = true;
			continue;
		}
		if (character === "\n") {
			tokens.push({ type: "op", value: "\n" });
			index += 1;
			atBoundary = true;
			continue;
		}
		if (character === "#" && atBoundary) {
			while (index < command.length && command[index] !== "\n") index += 1;
			continue;
		}

		const operator = ["&>>", "&&", "||", ">>", ">|", "&>", ">&", "<<", ";", "|", "&", "(", ")", ">", "<"]
			.find((candidate) => command.startsWith(candidate, index));
		if (operator) {
			tokens.push({ type: "op", value: operator });
			index += operator.length;
			atBoundary = true;
			continue;
		}

		let value = "";
		let quoted = false;
		while (index < command.length) {
			const current = command[index];
			if (/\s/.test(current) || ";|&()<>".includes(current)) break;
			if (current === "'") {
				quoted = true;
				index += 1;
				while (index < command.length && command[index] !== "'") value += command[index++];
				if (command[index] === "'") index += 1;
				continue;
			}
			if (current === '"') {
				quoted = true;
				index += 1;
				while (index < command.length && command[index] !== '"') {
					if (command[index] === "\\" && index + 1 < command.length) index += 1;
					value += command[index++];
				}
				if (command[index] === '"') index += 1;
				continue;
			}
			if (current === "\\" && index + 1 < command.length) {
				quoted = true;
				value += command[index + 1];
				index += 2;
				continue;
			}
			value += current;
			index += 1;
		}
		if (value || quoted) tokens.push({ type: "word", value, quoted });
		atBoundary = false;
	}
	return tokens;
}

function extractNestedCommands(command) {
	const nested = [];
	let quote = null;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];
		if (character === "\\") {
			index += 1;
			continue;
		}
		if (quote === "'") {
			if (character === "'") quote = null;
			continue;
		}
		if (character === "'") {
			quote = "'";
			continue;
		}
		if (character === '"') {
			quote = quote === '"' ? null : '"';
			continue;
		}
		if (character === "`" && quote !== "'") {
			let end = index + 1;
			while (end < command.length && command[end] !== "`") {
				if (command[end] === "\\") end += 1;
				end += 1;
			}
			nested.push(command.slice(index + 1, end));
			index = end;
			continue;
		}
		if (character === "$" && command[index + 1] === "(" && quote !== "'") {
			let depth = 1;
			let end = index + 2;
			let innerQuote = null;
			for (; end < command.length && depth > 0; end += 1) {
				const inner = command[end];
				if (inner === "\\") {
					end += 1;
					continue;
				}
				if (innerQuote) {
					if (inner === innerQuote) innerQuote = null;
					continue;
				}
				if (inner === "'" || inner === '"') {
					innerQuote = inner;
					continue;
				}
				if (inner === "(") depth += 1;
				else if (inner === ")") depth -= 1;
			}
			nested.push(command.slice(index + 2, Math.max(index + 2, end - 1)));
			index = end - 1;
		}
	}
	return nested;
}

function blocked(reason, detail) {
	return { blocked: true, reason, detail };
}

function inspectGit(words) {
	let index = 1;
	const optionsWithValues = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
	while (index < words.length && words[index].startsWith("-")) {
		const option = words[index];
		index += 1;
		if (optionsWithValues.has(option) && !option.includes("=")) index += 1;
	}
	const action = words[index]?.toLowerCase();
	const args = words.slice(index + 1).map((word) => word.toLowerCase());
	if (!action) return null;
	if (args.some((arg) => arg === "--output" || arg.startsWith("--output="))) {
		return blocked("Git output file write", `git ${action} --output`);
	}

	const alwaysMutating = new Set([
		"add", "commit", "push", "pull", "merge", "rebase", "reset", "checkout", "switch", "restore",
		"clean", "stash", "cherry-pick", "revert", "init", "clone", "fetch", "am", "apply", "bisect",
		"gc", "prune", "repack", "replace", "notes", "mv", "rm",
	]);
	if (alwaysMutating.has(action)) return blocked("mutating Git command", `git ${action}`);
	if (action === "branch" && args.some((arg) => /^-[dDmM]$/.test(arg) || arg === "--delete" || arg === "--move")) {
		return blocked("mutating Git branch command", "git branch");
	}
	if (action === "tag" && args.length > 0 && !args.some((arg) => ["-l", "--list", "--contains", "--points-at"].includes(arg))) {
		return blocked("mutating Git tag command", "git tag");
	}
	if (action === "worktree" && ![undefined, "list"].includes(args[0])) {
		return blocked("mutating Git worktree command", `git worktree ${args[0]}`);
	}
	if (action === "config") {
		const readOnly = args.some((arg) => ["--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin", "--show-scope"].includes(arg));
		if (!readOnly) return blocked("Git configuration write", "git config");
	}
	return null;
}

function inspectPackageManager(command, words) {
	const rawArgs = words.slice(1);
	const args = rawArgs.map((word) => word.toLowerCase());
	if (command === "pacman" && rawArgs.some((word) => /^-(?:S(?:y|yu)?|R|U)(?:$|[^s])/.test(word))) {
		return blocked("package-manager mutation", "pacman");
	}
	const optionsWithValues = new Set([
		"--prefix", "--workspace", "-w", "--cache", "--registry", "--userconfig", "--cwd", "--directory",
		"--python", "--project", "--config-settings",
	]);
	let actionIndex = 0;
	while (actionIndex < args.length && args[actionIndex].startsWith("-")) {
		const option = args[actionIndex];
		actionIndex += 1;
		if (optionsWithValues.has(option) && !option.includes("=")) actionIndex += 1;
	}
	const action = args[actionIndex];
	const mutating = {
		npm: new Set(["install", "i", "ci", "uninstall", "remove", "rm", "update", "upgrade", "link", "unlink", "publish", "unpublish"]),
		yarn: new Set(["add", "install", "remove", "upgrade", "up", "link", "unlink", "publish"]),
		pnpm: new Set(["add", "install", "i", "remove", "rm", "update", "up", "link", "unlink", "publish", "deploy"]),
		bun: new Set(["add", "install", "i", "remove", "rm", "update", "link", "unlink", "publish"]),
		pip: new Set(["install", "uninstall"]),
		pip3: new Set(["install", "uninstall"]),
		poetry: new Set(["add", "remove", "install", "update", "publish", "build"]),
		cargo: new Set(["add", "remove", "install", "uninstall", "update", "publish"]),
		brew: new Set(["install", "uninstall", "remove", "upgrade", "update", "link", "unlink", "tap", "untap"]),
		apt: new Set(["install", "remove", "purge", "update", "upgrade", "dist-upgrade", "autoremove"]),
		"apt-get": new Set(["install", "remove", "purge", "update", "upgrade", "dist-upgrade", "autoremove"]),
		dnf: new Set(["install", "remove", "upgrade", "update", "autoremove"]),
		yum: new Set(["install", "remove", "upgrade", "update", "autoremove"]),
	};
	if (mutating[command]?.has(action)) return blocked("package-manager mutation", `${command} ${action}`);
	if (command === "uv" && args[0] === "pip" && ["install", "uninstall"].includes(args[1])) {
		return blocked("package-manager mutation", `uv pip ${args[1]}`);
	}
	return null;
}

function inspectWords(words, depth) {
	let index = 0;
	while (index < words.length && isAssignment(words[index])) index += 1;
	while (WRAPPERS.has(basename(words[index] ?? ""))) {
		const wrapper = basename(words[index]);
		index += 1;
		while (index < words.length && words[index].startsWith("-")) {
			const option = words[index];
			if (wrapper === "time" && ["-o", "--output", "-a", "--append"].includes(option)) {
				return blocked("output redirection", `time ${option}`);
			}
			index += 1;
			const consumesValue =
				(wrapper === "env" && ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"].includes(option)) ||
				(wrapper === "time" && ["-f", "--format"].includes(option));
			if (consumesValue && !option.includes("=")) index += 1;
		}
		while (index < words.length && isAssignment(words[index])) index += 1;
	}
	if (index >= words.length) return null;

	const command = basename(words[index]);
	const commandWords = words.slice(index);
	if (command === "sudo" || command === "doas" || command === "su") {
		return blocked("privilege/process mutator", command);
	}
	if (FILE_MUTATORS.has(command)) return blocked("filesystem mutation", command);
	if (PROCESS_MUTATORS.has(command)) return blocked("process or system mutation", command);
	if (INTERACTIVE_EDITORS.has(command)) return blocked("interactive editor", command);
	if (command === "git") return inspectGit(commandWords);

	const packageMutation = inspectPackageManager(command, commandWords);
	if (packageMutation) return packageMutation;

	if ((command === "sed" && commandWords.slice(1).some((word) => /^-.*i/.test(word))) ||
		(["perl", "ruby"].includes(command) && commandWords.slice(1).some((word) => /^-.*i/.test(word)))) {
		return blocked("in-place editor mutation", command);
	}
	if (command === "curl" && commandWords.slice(1).some((word) => /^-[^-]*[oO]/.test(word) || word === "--remote-name" || word === "--output" || word.startsWith("--output="))) {
		return blocked("download output file write", "curl output");
	}
	if (command === "wget") {
		const args = commandWords.slice(1);
		const stdoutOnly = args.some((word, wordIndex) => /^-[^-]*O-$/.test(word) || (word === "-O" && args[wordIndex + 1] === "-") || word === "--output-document=-");
		if (!stdoutOnly) return blocked("download output file write", "wget");
	}
	if (command === "rsync" && !commandWords.slice(1).some((word) => ["--dry-run", "-n", "--list-only"].includes(word))) {
		return blocked("filesystem mutation", "rsync");
	}
	if (command === "tar" && commandWords.slice(1).some((word) => /^(?:-[^-]*)?[cxruA]/.test(word) || ["--create", "--extract", "--get", "--append", "--update", "--concatenate"].includes(word))) {
		return blocked("archive filesystem mutation", "tar");
	}
	if (command === "unzip" && !commandWords.slice(1).some((word) => ["-l", "-t", "-p", "-c", "-Z", "--list"].includes(word))) {
		return blocked("archive filesystem mutation", "unzip");
	}
	if (command === "find") {
		if (commandWords.some((word) => word === "-delete")) return blocked("filesystem mutation", "find -delete");
		const execIndex = commandWords.findIndex((word) => ["-exec", "-execdir", "-ok", "-okdir"].includes(word));
		if (execIndex >= 0) {
			const nestedWords = commandWords.slice(execIndex + 1).filter((word) => word !== ";" && word !== "+");
			const nested = inspectWords(nestedWords, depth + 1);
			if (nested) return blocked(`find execution: ${nested.reason}`, nested.detail);
		}
	}
	if (command === "systemctl" && commandWords.slice(1).some((word) => ["start", "stop", "restart", "reload", "enable", "disable", "mask", "unmask", "daemon-reload"].includes(word.toLowerCase()))) {
		return blocked("service mutation", "systemctl");
	}
	if (command === "service" && commandWords.slice(2).some((word) => ["start", "stop", "restart", "reload", "enable", "disable"].includes(word.toLowerCase()))) {
		return blocked("service mutation", "service");
	}
	if (command === "docker" && commandWords.slice(1).some((word) => ["run", "exec", "start", "stop", "restart", "kill", "rm", "rmi", "build", "pull", "push", "create", "compose"].includes(word.toLowerCase()))) {
		return blocked("container/process mutation", "docker");
	}
	if (command === "kubectl" && commandWords.slice(1).some((word) => ["apply", "create", "delete", "edit", "patch", "replace", "rollout", "scale", "set", "taint", "cordon", "uncordon", "drain"].includes(word.toLowerCase()))) {
		return blocked("service mutation", "kubectl");
	}
	if (["python", "python3"].includes(command)) {
		const moduleIndex = commandWords.findIndex((word) => word === "-m");
		if (moduleIndex >= 0 && ["pip", "pip3"].includes(commandWords[moduleIndex + 1]?.toLowerCase())) {
			const action = commandWords[moduleIndex + 2]?.toLowerCase();
			if (["install", "uninstall"].includes(action)) return blocked("package-manager mutation", `python -m pip ${action}`);
		}
	}
	if (SHELLS.has(command)) {
		const flagIndex = commandWords.findIndex((word, wordIndex) => wordIndex > 0 && /^-[^-]*c/.test(word));
		if (flagIndex >= 0 && commandWords[flagIndex + 1] && depth < 8) {
			const nested = analyzeBashMutation(commandWords[flagIndex + 1], { depth: depth + 1 });
			if (nested.blocked) return blocked(`nested shell: ${nested.reason}`, nested.detail);
		}
	}
	if (command === "xargs") {
		let candidate = 1;
		const optionsWithValues = new Set(["-n", "--max-args", "-P", "--max-procs", "-I", "--replace", "-d", "--delimiter", "-E", "--eof", "-s", "--max-chars"]);
		while (candidate < commandWords.length && commandWords[candidate].startsWith("-")) {
			const option = commandWords[candidate];
			candidate += 1;
			if (optionsWithValues.has(option) && !option.includes("=")) candidate += 1;
		}
		if (candidate < commandWords.length) return inspectWords(commandWords.slice(candidate), depth + 1);
	}
	return null;
}

export function analyzeBashMutation(command, options = {}) {
	if (typeof command !== "string") return blocked("invalid shell command", "non-string input");
	const depth = options.depth ?? 0;
	if (depth > 8) return blocked("nested shell depth exceeded", "maximum depth 8");

	for (const nestedCommand of extractNestedCommands(command)) {
		const nested = analyzeBashMutation(nestedCommand, { depth: depth + 1 });
		if (nested.blocked) return blocked(`command substitution: ${nested.reason}`, nested.detail);
	}

	const tokens = tokenize(command);
	let segment = [];
	const inspectSegment = () => {
		if (segment.length === 0) return null;
		const words = segment.filter((token) => token.type === "word").map((token) => token.value);
		const isConditionalTest = words[0] === "[[";
		if (!isConditionalTest) {
			const redirection = segment.find((token) => token.type === "op" && OUTPUT_REDIRECTIONS.has(token.value));
			if (redirection) return blocked("output redirection", redirection.value);
		}
		return inspectWords(words, depth);
	};

	for (const token of tokens) {
		if (token.type === "op" && COMMAND_SEPARATORS.has(token.value)) {
			const result = inspectSegment();
			if (result) return result;
			segment = [];
		} else {
			segment.push(token);
		}
	}
	const result = inspectSegment();
	return result ?? { blocked: false, reason: null, detail: null };
}

export function isKnownMutatingCommand(command) {
	return analyzeBashMutation(command).blocked;
}
