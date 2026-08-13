import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ContextUsageSnapshot {
	tokens: number | null;
	percent: number | null;
}

export interface ContextDisplay {
	count: string;
	gaugePercent: number | undefined;
}

export function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}

/** Select current context display data from Pi's compaction-aware usage snapshot. */
export function selectContextDisplay(usage: ContextUsageSnapshot | undefined): ContextDisplay {
	if (!usage || usage.tokens === null || usage.percent === null) {
		return { count: "?", gaugePercent: undefined };
	}

	return {
		count: fmtTokens(usage.tokens),
		gaugePercent: Math.max(0, Math.min(100, usage.percent)),
	};
}

/** Register no runtime behavior; statusbar.ts imports the display helpers. */
export default function statusbarContextExtension(_pi: ExtensionAPI): void {}
