import { stripLedgerMutationsWithMap, authoredPlanHash } from "./ledger.js";

export type PlanComparisonStatus = "none" | "unavailable" | "identical" | "compared";

export interface AffectedSection {
	id: string;
	label: string;
	added: number;
	removed: number;
	status: "added" | "removed" | "modified";
	summary: string;
}

export interface MarkedBlock {
	startLine: number;
	endLine: number;
	text: string;
	lines: string[];
	status: "unchanged" | "added" | "modified";
}

export interface PlanComparison {
	status: PlanComparisonStatus;
	baselineRevision?: number;
	currentRevision?: number;
	message?: string;
	headerSubtitle?: string;
	affectedSections?: AffectedSection[];
	changeMapLines?: string[];
	currentBlocks?: MarkedBlock[];
	stats?: { added: number; removed: number };
}

export interface DocumentSection {
	id: string;
	label: string;
	level: number;
	startLine: number; // 1-based
	endLine: number; // 1-based
}

export function outsideFenceLines(lines: readonly string[]): boolean[] {
	const outside: boolean[] = [];
	let fence: string | null = null;
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

export function parseDocumentSections(lines: readonly string[]): DocumentSection[] {
	const sections: DocumentSection[] = [];
	const outside = outsideFenceLines(lines);
	let current: DocumentSection = { id: "title", label: "Title", level: 1, startLine: 1, endLine: lines.length };
	sections.push(current);

	for (let index = 0; index < lines.length; index += 1) {
		if (!outside[index]) continue;
		const line = lines[index];
		const h3PartMatch = line.match(/^###\s+Part\s+([A-Z]+)\s*—\s*(.+)$/);
		if (h3PartMatch) {
			current.endLine = index;
			current = {
				id: `part-${h3PartMatch[1]}`,
				label: `Part ${h3PartMatch[1]}`,
				level: 3,
				startLine: index + 1,
				endLine: lines.length,
			};
			sections.push(current);
			continue;
		}

		const h2Match = line.match(/^##\s+(.+)$/);
		if (h2Match) {
			const label = h2Match[1].trim();
			current.endLine = index;
			current = {
				id: label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "section",
				label,
				level: 2,
				startLine: index + 1,
				endLine: lines.length,
			};
			sections.push(current);
			continue;
		}

		const h1Match = line.match(/^#\s+(.+)$/);
		if (h1Match) {
			current.endLine = index;
			current = {
				id: "title",
				label: "Title",
				level: 1,
				startLine: index + 1,
				endLine: lines.length,
			};
			sections.push(current);
			continue;
		}
	}

	// Filter out empty preamble if title immediately overrode it
	return sections.filter((s) => s.endLine >= s.startLine);
}

export type DiffOp =
	| { type: "equal"; aIndex: number; bIndex: number; line: string }
	| { type: "delete"; aIndex: number; line: string }
	| { type: "insert"; bIndex: number; line: string };

export function diffLines(a: readonly string[], b: readonly string[]): DiffOp[] {
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) {
		start += 1;
	}
	let aEnd = a.length - 1;
	let bEnd = b.length - 1;
	while (aEnd >= start && bEnd >= start && a[aEnd] === b[bEnd]) {
		aEnd -= 1;
		bEnd -= 1;
	}

	const prefix: DiffOp[] = [];
	for (let i = 0; i < start; i += 1) {
		prefix.push({ type: "equal", aIndex: i, bIndex: i, line: a[i] });
	}

	const suffix: DiffOp[] = [];
	const aSuffixStart = aEnd + 1;
	const bSuffixStart = bEnd + 1;
	for (let i = 0; i < a.length - aSuffixStart; i += 1) {
		suffix.push({
			type: "equal",
			aIndex: aSuffixStart + i,
			bIndex: bSuffixStart + i,
			line: a[aSuffixStart + i],
		});
	}

	const midA = a.slice(start, aEnd + 1);
	const midB = b.slice(start, bEnd + 1);

	let middle: DiffOp[] = [];
	if (midA.length === 0) {
		middle = midB.map((line, idx) => ({ type: "insert", bIndex: start + idx, line }));
	} else if (midB.length === 0) {
		middle = midA.map((line, idx) => ({ type: "delete", aIndex: start + idx, line }));
	} else {
		// Myers shortest edit script algorithm bounded by N + M
		const n = midA.length;
		const m = midB.length;
		const max = n + m;
		const v = new Map<number, number>();
		v.set(1, 0);
		const trace: Array<Map<number, number>> = [];

		for (let d = 0; d <= max; d += 1) {
			const vCopy = new Map(v);
			trace.push(vCopy);
			for (let k = -d; k <= d; k += 2) {
				let x: number;
				if (k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))) {
					x = v.get(k + 1) ?? 0;
				} else {
					x = (v.get(k - 1) ?? 0) + 1;
				}
				let y = x - k;
				while (x < n && y < m && midA[x] === midB[y]) {
					x += 1;
					y += 1;
				}
				v.set(k, x);
				if (x >= n && y >= m) {
					let currX = n;
					let currY = m;
					for (let depth = d; depth > 0; depth -= 1) {
						const stepV = trace[depth];
						const currK = currX - currY;
						let prevK: number;
						if (currK === -depth || (currK !== depth && (stepV.get(currK - 1) ?? 0) < (stepV.get(currK + 1) ?? 0))) {
							prevK = currK + 1;
						} else {
							prevK = currK - 1;
						}
						const prevX = stepV.get(prevK) ?? 0;
						const prevY = prevX - prevK;
						while (currX > prevX && currY > prevY) {
							middle.unshift({ type: "equal", aIndex: start + currX - 1, bIndex: start + currY - 1, line: midA[currX - 1] });
							currX -= 1;
							currY -= 1;
						}
						if (depth > 0) {
							if (currX === prevX) {
								middle.unshift({ type: "insert", bIndex: start + currY - 1, line: midB[currY - 1] });
								currY -= 1;
							} else {
								middle.unshift({ type: "delete", aIndex: start + currX - 1, line: midA[currX - 1] });
								currX -= 1;
							}
						}
					}
					while (currX > 0 && currY > 0) {
						middle.unshift({ type: "equal", aIndex: start + currX - 1, bIndex: start + currY - 1, line: midA[currX - 1] });
						currX -= 1;
						currY -= 1;
					}
					break;
				}
			}
			if (middle.length > 0) break;
		}
	}

	return [...prefix, ...middle, ...suffix];
}

export function parseDocumentBlocks(lines: readonly string[]): Array<{ startLine: number; endLine: number; lines: string[]; text: string }> {
	const blocks: Array<{ startLine: number; endLine: number; lines: string[]; text: string }> = [];
	const outside = outsideFenceLines(lines);

	let inBlock = false;
	let blockStart = 1;
	let blockLines: string[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const isOutside = outside[index];
		const isFenceBoundary = !isOutside && (line.match(/^\s*(`{3,}|~{3,})/) !== null);

		if (isOutside && line.trim() === "") {
			if (inBlock) {
				blocks.push({
					startLine: blockStart,
					endLine: index,
					lines: [...blockLines],
					text: blockLines.join("\n"),
				});
				inBlock = false;
				blockLines = [];
			}
			continue;
		}

		if (!inBlock) {
			inBlock = true;
			blockStart = index + 1;
			blockLines = [line];
		} else {
			blockLines.push(line);
		}
	}

	if (inBlock && blockLines.length > 0) {
		blocks.push({
			startLine: blockStart,
			endLine: lines.length,
			lines: [...blockLines],
			text: blockLines.join("\n"),
		});
	}

	return blocks;
}

function lineUnit(count: number): string {
	return count === 1 ? "1 line" : `${count} lines`;
}

function formatSectionSummary(added: number, removed: number): string {
	if (added > 0 && removed > 0) {
		return `+${lineUnit(added)}, -${lineUnit(removed)}`;
	}
	if (added > 0) {
		return `+${lineUnit(added)}`;
	}
	if (removed > 0) {
		return `-${lineUnit(removed)}`;
	}
	return "unchanged";
}

export function computePlanComparison(
	baselineMarkdown: string | null | undefined,
	currentMarkdown: string,
	baselineRevision?: number,
	currentRevision: number = 1,
): PlanComparison {
	if (currentRevision <= 1) {
		return {
			status: "none",
			currentRevision,
			headerSubtitle: `Plan candidate — revision ${currentRevision}`,
		};
	}

	if (!baselineMarkdown || baselineRevision === undefined || baselineRevision <= 0) {
		return {
			status: "unavailable",
			baselineRevision,
			currentRevision,
			message: "Comparison unavailable",
			headerSubtitle: `Plan candidate — revision ${currentRevision} (comparison unavailable)`,
		};
	}

	let baselineAuthored: string;
	let currentAuthored: string;
	try {
		baselineAuthored = stripLedgerMutationsWithMap(baselineMarkdown).authoredMarkdown;
		currentAuthored = stripLedgerMutationsWithMap(currentMarkdown).authoredMarkdown;
	} catch {
		return {
			status: "unavailable",
			baselineRevision,
			currentRevision,
			message: "Comparison unavailable",
			headerSubtitle: `Plan candidate — revision ${currentRevision} (comparison unavailable)`,
		};
	}

	if (authoredPlanHash(baselineMarkdown) === authoredPlanHash(currentMarkdown)) {
		return {
			status: "identical",
			baselineRevision,
			currentRevision,
			message: `No authored changes since revision ${baselineRevision}`,
			headerSubtitle: `Plan candidate — revision ${currentRevision} (no authored changes since revision ${baselineRevision})`,
		};
	}

	const baseLines = baselineAuthored.split("\n");
	const currLines = currentAuthored.split("\n");

	const diffOps = diffLines(baseLines, currLines);

	const baseSections = parseDocumentSections(baseLines);
	const currSections = parseDocumentSections(currLines);

	// Line-by-line status in current document
	const currentLineStatuses: Array<"unchanged" | "added" | "modified"> = new Array(currLines.length).fill("unchanged");

	// Mark line statuses from diff operations
	for (let i = 0; i < diffOps.length; i += 1) {
		const op = diffOps[i];
		if (op.type === "insert") {
			// Check if adjacent to delete (replacement / edit)
			const prev = i > 0 ? diffOps[i - 1] : null;
			const next = i < diffOps.length - 1 ? diffOps[i + 1] : null;
			const isReplacement = (prev && prev.type === "delete") || (next && next.type === "delete");
			currentLineStatuses[op.bIndex] = isReplacement ? "modified" : "added";
		}
	}

	// Count additions and deletions per section
	const addedByCurrSection = new Map<string, number>();
	const removedByBaseSection = new Map<string, number>();

	for (const op of diffOps) {
		if (op.type === "insert") {
			const lineNum = op.bIndex + 1;
			const section = currSections.find((s) => lineNum >= s.startLine && lineNum <= s.endLine);
			const secId = section?.id ?? "unknown";
			addedByCurrSection.set(secId, (addedByCurrSection.get(secId) ?? 0) + 1);
		} else if (op.type === "delete") {
			const lineNum = op.aIndex + 1;
			const section = baseSections.find((s) => lineNum >= s.startLine && lineNum <= s.endLine);
			const secId = section?.id ?? "unknown";
			removedByBaseSection.set(secId, (removedByBaseSection.get(secId) ?? 0) + 1);
		}
	}

	// Build affected sections in document order
	const affectedSections: AffectedSection[] = [];
	const seenBaseSections = new Set<string>();

	// Trace diff ops to order deleted-only baseline sections accurately in document order
	let lastCurrSectionId: string | null = null;
	for (const op of diffOps) {
		if (op.type === "equal" || op.type === "insert") {
			const lineNum = op.bIndex + 1;
			const sec = currSections.find((s) => lineNum >= s.startLine && lineNum <= s.endLine);
			if (sec && sec.id !== lastCurrSectionId) {
				lastCurrSectionId = sec.id;
			}
		} else if (op.type === "delete") {
			const lineNum = op.aIndex + 1;
			const baseSec = baseSections.find((s) => lineNum >= s.startLine && lineNum <= s.endLine);
			if (baseSec && !seenBaseSections.has(baseSec.id)) {
				// If this baseline section doesn't exist in current sections, it's a deleted section
				const existsInCurrent = currSections.some((s) => s.id === baseSec.id);
				if (!existsInCurrent) {
					seenBaseSections.add(baseSec.id);
					const removed = removedByBaseSection.get(baseSec.id) ?? 0;
					affectedSections.push({
						id: baseSec.id,
						label: baseSec.label,
						added: 0,
						removed,
						status: "removed",
						summary: formatSectionSummary(0, removed),
					});
				}
			}
		}
	}

	// Now check all current sections
	for (const sec of currSections) {
		const added = addedByCurrSection.get(sec.id) ?? 0;
		const removed = removedByBaseSection.get(sec.id) ?? 0;
		if (added > 0 || removed > 0) {
			const status = added > 0 && removed === 0 ? "added" : (added === 0 && removed > 0 ? "removed" : "modified");
			affectedSections.push({
				id: sec.id,
				label: sec.label,
				added,
				removed,
				status,
				summary: formatSectionSummary(added, removed),
			});
		}
	}

	// De-duplicate any sections in affectedSections while preserving order
	const uniqueSections: AffectedSection[] = [];
	const seenIds = new Set<string>();
	for (const sec of affectedSections) {
		if (!seenIds.has(sec.id)) {
			seenIds.add(sec.id);
			uniqueSections.push(sec);
		}
	}

	// Build marked blocks for the current document
	const rawBlocks = parseDocumentBlocks(currLines);
	const currentBlocks: MarkedBlock[] = rawBlocks.map((b) => {
		let hasAdded = false;
		let hasModified = false;
		let allAdded = true;
		let hasNonBlank = false;

		for (let lineNum = b.startLine; lineNum <= b.endLine; lineNum += 1) {
			const lineIdx = lineNum - 1;
			const line = currLines[lineIdx];
			if (line.trim() === "") continue;
			hasNonBlank = true;
			const status = currentLineStatuses[lineIdx];
			if (status === "added") {
				hasAdded = true;
			} else if (status === "modified") {
				hasModified = true;
				allAdded = false;
			} else {
				allAdded = false;
			}
		}

		let status: "unchanged" | "added" | "modified" = "unchanged";
		if (hasNonBlank) {
			if (allAdded && hasAdded) {
				status = "added";
			} else if (hasAdded || hasModified) {
				status = "modified";
			}
		}

		return {
			startLine: b.startLine,
			endLine: b.endLine,
			lines: b.lines,
			text: b.text,
			status,
		};
	});

	let totalAdded = 0;
	let totalRemoved = 0;
	for (const sec of uniqueSections) {
		totalAdded += sec.added;
		totalRemoved += sec.removed;
	}

	const changeMapLines: string[] = [];
	if (uniqueSections.length > 0) {
		changeMapLines.push(`Change map (vs rev ${baselineRevision}):`);
		for (const sec of uniqueSections) {
			changeMapLines.push(`  ${sec.label}: ${sec.summary}`);
		}
	}

	return {
		status: "compared",
		baselineRevision,
		currentRevision,
		headerSubtitle: `Plan candidate — revision ${currentRevision} (compared with revision ${baselineRevision})`,
		affectedSections: uniqueSections,
		changeMapLines,
		currentBlocks,
		stats: { added: totalAdded, removed: totalRemoved },
	};
}
