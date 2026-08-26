import { createHash } from "node:crypto";
import {
	parsePlanDocument,
	replaceManagedProgressReport,
	splitManagedProgressReport,
} from "./plan-document.js";
import { buildDocumentProgressRows } from "./progress-widget.js";

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
		.flatMap((line, index) => outside[index] && /^- \*\*Ledger:\*\*/.test(line) ? [] : [line])
		.join("\n")
		.trimEnd();
}

export function immutablePlanHash(markdown) {
	return createHash("sha256").update(stripLedgerMutations(markdown), "utf8").digest("hex");
}

export function updateLedgerMarkdown(currentMarkdown, approvedMarkdown, partId, ledgerItem) {
	if (immutablePlanHash(currentMarkdown) !== immutablePlanHash(approvedMarkdown)) {
		throw new Error("Plan content drifted outside ledger fields; status update refused");
	}
	const currentCore = splitManagedProgressReport(currentMarkdown).coreMarkdown;
	const parsed = parsePlanDocument(currentCore);
	if (!parsed.ok) throw new Error("Current plan is no longer valid canonical Markdown");
	if (!parsed.document.parts.some((part) => part.id === partId)) {
		throw new Error(`Unknown Part ID ${partId}`);
	}

	const headingPattern = new RegExp(`^### Part ${partId} — (.+)$`);
	const lines = currentCore.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
	let outside = outsideFenceLines(lines);
	const headingIndex = lines.findIndex((line, index) => outside[index] && headingPattern.test(line));
	if (headingIndex < 0) throw new Error(`Part heading not found for ${partId}`);

	let partEnd = lines.length;
	for (let index = headingIndex + 1; index < lines.length; index += 1) {
		if (outside[index] && (/^### Part [A-Z]+ — /.test(lines[index]) || /^## /.test(lines[index]))) {
			partEnd = index;
			break;
		}
	}
	for (let index = partEnd - 1; index > headingIndex; index -= 1) {
		if (outside[index] && /^- \*\*Ledger:\*\*/.test(lines[index])) lines.splice(index, 1);
	}
	outside = outsideFenceLines(lines);
	const ledger = JSON.stringify({
		status: ledgerItem.status,
		note: ledgerItem.note ?? null,
		evidence: ledgerItem.evidence ?? null,
	});
	// The extension-owned row follows the stable Part heading so stripping it
	// restores the approved Markdown byte-for-byte.
	lines.splice(headingIndex + 1, 0, `- **Ledger:** ${ledger}`);
	const updatedCore = lines.join("\n");
	const updated = parsePlanDocument(updatedCore);
	if (!updated.ok) {
		throw new Error(`Updated plan is no longer valid canonical Markdown: ${updated.errors.map((item) => item.message).join("; ")}`);
	}
	return replaceManagedProgressReport(updatedCore, buildDocumentProgressRows(updated.document));
}

export function synchronizeLedgerMarkdown(currentMarkdown, approvedMarkdown, ledger) {
	let next = currentMarkdown;
	for (const [partId, ledgerItem] of Object.entries(ledger)) {
		next = updateLedgerMarkdown(next, approvedMarkdown, partId, ledgerItem);
	}
	return next;
}
