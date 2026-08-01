import { createHash } from "node:crypto";
import { parsePlanDocument } from "./plan-document.js";

export function stripLedgerMutations(markdown) {
	return markdown
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.split("\n")
		.filter((line) => !/^- \*\*Ledger:\*\*/.test(line))
		.map((line) => line.replace(/^(#### \d+\.\d+) \[[^\]]+\]/, "$1 [status]"))
		.join("\n")
		.trimEnd();
}

export function immutablePlanHash(markdown) {
	return createHash("sha256").update(stripLedgerMutations(markdown), "utf8").digest("hex");
}

export function updateLedgerMarkdown(currentMarkdown, approvedMarkdown, taskId, ledgerItem) {
	if (immutablePlanHash(currentMarkdown) !== immutablePlanHash(approvedMarkdown)) {
		throw new Error("Plan content drifted outside ledger fields; status update refused");
	}
	const parsed = parsePlanDocument(currentMarkdown);
	if (!parsed.ok) throw new Error("Current plan is no longer valid canonical Markdown");
	if (!parsed.document.stages.flatMap((stage) => stage.tasks).some((task) => task.id === taskId)) {
		throw new Error(`Unknown task ID ${taskId}`);
	}
	const lines = currentMarkdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
	const headingPattern = new RegExp(`^#### ${taskId.replace(".", "\\.")} \\[([^\\]]+)\\] (.+)$`);
	const headingIndex = lines.findIndex((line) => headingPattern.test(line));
	if (headingIndex < 0) throw new Error(`Task heading not found for ${taskId}`);
	lines[headingIndex] = lines[headingIndex].replace(headingPattern, `#### ${taskId} [${ledgerItem.status}] $2`);
	let taskEnd = lines.length;
	for (let index = headingIndex + 1; index < lines.length; index += 1) {
		if (/^#### \d+\.\d+ \[/.test(lines[index]) || /^### Stage /.test(lines[index]) || /^## /.test(lines[index])) {
			taskEnd = index;
			break;
		}
	}
	for (let index = taskEnd - 1; index > headingIndex; index -= 1) {
		if (/^- \*\*Ledger:\*\*/.test(lines[index])) {
			lines.splice(index, 1);
			taskEnd -= 1;
		}
	}
	const toolsIndex = lines.findIndex((line, index) => index > headingIndex && index < taskEnd && /^- \*\*Tools \/ APIs:\*\*/.test(line));
	if (toolsIndex < 0) throw new Error(`Task ${taskId} has no Tools / APIs metadata`);
	const ledger = JSON.stringify({
		status: ledgerItem.status,
		note: ledgerItem.note ?? null,
		evidence: ledgerItem.evidence ?? null,
	});
	lines.splice(toolsIndex + 1, 0, `- **Ledger:** ${ledger}`);
	return lines.join("\n");
}
