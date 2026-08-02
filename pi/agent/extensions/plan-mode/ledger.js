import { createHash } from "node:crypto";
import {
	parsePlanDocument,
	replaceManagedProgressReport,
	splitManagedProgressReport,
} from "./plan-document.js";
import { buildDocumentStepProgressRows } from "./progress-widget.js";

function outsideFenceLines(lines) {
	const outside = [];
	let fence = null;
	for (const line of lines) {
		const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
		if (fenceMatch) {
			outside.push(false);
			const marker = fenceMatch[1][0];
			if (fence === null) fence = marker;
			else if (fence === marker) fence = null;
			continue;
		}
		outside.push(fence === null);
	}
	return outside;
}

export function stripLedgerMutations(markdown) {
	const { coreMarkdown } = splitManagedProgressReport(markdown);
	const lines = coreMarkdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
	const outside = outsideFenceLines(lines);
	return lines
		.flatMap((line, index) => {
			if (outside[index] && /^- \*\*Ledger:\*\*/.test(line)) return [];
			return [outside[index]
				? line.replace(/^(### Step \d+|#### \d+\.\d+) \[[^\]]+\]/, "$1 [status]")
				: line];
		})
		.join("\n")
		.trimEnd();
}

export function immutablePlanHash(markdown) {
	return createHash("sha256").update(stripLedgerMutations(markdown), "utf8").digest("hex");
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

	const escapedId = escapeRegExp(taskId);
	const headingPatterns = [
		new RegExp(`^(### Step ${escapedId}) \\[([^\\]]+)\\] (.+)$`),
		new RegExp(`^(#### ${escapedId}) \\[([^\\]]+)\\] (.+)$`),
	];
	const { coreMarkdown } = splitManagedProgressReport(currentMarkdown);
	const lines = coreMarkdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
	let outside = outsideFenceLines(lines);
	const headingIndex = lines.findIndex((line, index) => outside[index] && headingPatterns.some((pattern) => pattern.test(line)));
	if (headingIndex < 0) throw new Error(`Task heading not found for ${taskId}`);
	const headingPattern = headingPatterns.find((pattern) => pattern.test(lines[headingIndex]));
	lines[headingIndex] = lines[headingIndex].replace(headingPattern, `$1 [${ledgerItem.status}] $3`);

	let taskEnd = lines.length;
	for (let index = headingIndex + 1; index < lines.length; index += 1) {
		if (outside[index] && (/^### Step \d+ \[/.test(lines[index]) || /^#### \d+\.\d+ \[/.test(lines[index]) || /^### Stage /.test(lines[index]) || /^## /.test(lines[index]))) {
			taskEnd = index;
			break;
		}
	}
	for (let index = taskEnd - 1; index > headingIndex; index -= 1) {
		if (outside[index] && /^- \*\*Ledger:\*\*/.test(lines[index])) {
			lines.splice(index, 1);
			taskEnd -= 1;
		}
	}
	outside = outsideFenceLines(lines);
	const toolsIndex = lines.findIndex((line, index) => outside[index] && index > headingIndex && index < taskEnd && /^- \*\*Tools \/ APIs:\*\*/.test(line));
	const ledger = JSON.stringify({
		status: ledgerItem.status,
		note: ledgerItem.note ?? null,
		evidence: ledgerItem.evidence ?? null,
	});
	// Version 1/2 plans keep the ledger beside their metadata. Metadata-free
	// version 3 plans place it directly below the stable step heading so
	// stripping the ledger restores the approved Markdown byte-for-byte.
	lines.splice(toolsIndex >= 0 ? toolsIndex + 1 : headingIndex + 1, 0, `- **Ledger:** ${ledger}`);
	const updatedCore = lines.join("\n");
	const updated = parsePlanDocument(updatedCore);
	if (!updated.ok) {
		throw new Error(`Updated plan is no longer valid canonical Markdown: ${updated.errors.map((item) => item.message).join("; ")}`);
	}
	return replaceManagedProgressReport(updatedCore, buildDocumentStepProgressRows(updated.document));
}

export function synchronizeLedgerMarkdown(currentMarkdown, approvedMarkdown, ledger) {
	let next = currentMarkdown;
	for (const [taskId, ledgerItem] of Object.entries(ledger)) {
		next = updateLedgerMarkdown(next, approvedMarkdown, taskId, ledgerItem);
	}
	return next;
}
