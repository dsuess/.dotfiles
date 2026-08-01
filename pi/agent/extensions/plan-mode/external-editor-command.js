export function splitEditorCommand(command) {
	const words = [];
	let value = "";
	let quote = null;
	let escaped = false;
	for (const character of command.trim()) {
		if (escaped) { value += character; escaped = false; continue; }
		if (character === "\\" && quote !== "'") { escaped = true; continue; }
		if (quote) { if (character === quote) quote = null; else value += character; continue; }
		if (character === "'" || character === '"') { quote = character; continue; }
		if (/\s/.test(character)) { if (value) { words.push(value); value = ""; } continue; }
		value += character;
	}
	if (escaped) value += "\\";
	if (value) words.push(value);
	return words;
}

export function prepareEditorInvocation(command, planPath) {
	const words = splitEditorCommand(command);
	if (words.length === 0) throw new Error("External editor command is empty");
	const executable = words[0];
	const args = words.slice(1);
	const name = executable.replaceAll("\\", "/").split("/").pop()?.toLowerCase();
	if (["code", "code-insiders", "codium", "subl", "sublime_text", "mate"].includes(name ?? "") && !args.includes("--wait") && !args.includes("-w")) {
		args.push("--wait");
	}
	if (name === "open" && !args.includes("-W") && !args.includes("--wait-apps")) args.push("-W");
	args.push(planPath);
	return { executable, args };
}
