import * as os from "node:os";
import * as path from "node:path";

/**
 * Utility functions for the plan-mode extension.
 * Based on the pi examples/extensions/plan-mode/utils.ts with extensions for
 * phase management, comment extraction, and plan diffing.
 */

// ─── Command safety (from the example) ──────────────────────────────────────

const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

export function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
	return !isDestructive && isSafe;
}

// ─── Phase model ────────────────────────────────────────────────────────────

export type Phase = "off" | "explore" | "draft" | "review" | "approved";

export const PHASE_ORDER: Phase[] = ["off", "explore", "draft", "review", "approved"];

export function nextPhase(current: Phase): Phase {
	const idx = PHASE_ORDER.indexOf(current);
	return idx < PHASE_ORDER.length - 1 ? PHASE_ORDER[idx + 1] : current;
}

export function isGatedPhase(phase: Phase): boolean {
	return phase === "explore" || phase === "draft" || phase === "review";
}

export function phaseLabel(phase: Phase): string {
	const labels: Record<Phase, string> = {
		off: "",
		explore: "🔍 explore",
		draft: "📝 draft",
		review: "👁 review",
		approved: "✅ approved",
	};
	return labels[phase];
}

// ─── Mode indicator helpers ───────────────────────────────────────────────

/** Short uppercase badge for the editor border (e.g. "🔍 EXPLORE ") */
export function phaseBadge(phase: Phase): string {
	const badges: Record<Phase, string> = {
		off: "",
		explore: "🔍 EXPLORE ",
		draft: "📝 DRAFT ",
		review: "👁 REVIEW ",
		approved: "✅ APPROVED ",
	};
	return badges[phase];
}

/** Theme color key for a given phase */
export function phaseColor(phase: Phase): "dim" | "accent" | "warning" | "success" {
	const colors: Record<Phase, "dim" | "accent" | "warning" | "success"> = {
		off: "dim",
		explore: "accent",
		draft: "warning",
		review: "accent",
		approved: "success",
	};
	return colors[phase];
}

/** Terminal title prefix for a given phase */
export function titlePrefix(phase: Phase): string {
	if (phase === "off") return "";
	return `${phaseLabel(phase)} | `;
}

// ─── Comment extraction ─────────────────────────────────────────────────────

/**
 * Extract HTML comments (<!-- ... -->) from a markdown string.
 * These represent user feedback during the review phase.
 */
export function extractComments(markdown: string): string[] {
	const comments: string[] = [];
	const pattern = /<!--\s*([\s\S]*?)\s*-->/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(markdown)) !== null) {
		const text = match[1].trim();
		if (text.length > 0) {
			comments.push(text);
		}
	}
	return comments;
}

/**
 * Diff two strings line-by-line and return added lines that aren't HTML comments.
 * Useful for detecting inline prose the user added during review.
 */
export function diffAddedLines(before: string, after: string): string[] {
	const beforeLines = new Set(before.split("\n").map((l) => l.trim()));
	const added: string[] = [];
	for (const line of after.split("\n")) {
		const trimmed = line.trim();
		if (trimmed && !beforeLines.has(trimmed) && !trimmed.startsWith("<!--")) {
			added.push(trimmed);
		}
	}
	return added;
}

/**
 * Collect all user feedback from a reviewed plan:
 * HTML comments + any added prose lines.
 */
export function extractReviewFeedback(before: string, after: string): string[] {
	const comments = extractComments(after);
	const addedProse = diffAddedLines(before, after);
	return [...comments, ...addedProse];
}

// ─── State shape ────────────────────────────────────────────────────────────

export interface PlanState {
	phase: Phase;
	planPath: string;        // temp path for the plan file
	preReviewContent: string; // snapshot before editor opens (for diffing)
	finalPath: string;        // user-chosen final path (default ./PLAN.md)
	reviewRound: number;      // how many review cycles completed
}

export function defaultPlanState(sessionId: string): PlanState {
	return {
		phase: "off",
		planPath: path.join(os.tmpdir(), `pi-plan-${sessionId}.md`),
		preReviewContent: "",
		finalPath: "",
		reviewRound: 0,
	};
}
