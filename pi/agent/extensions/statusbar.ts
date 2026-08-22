/**
 * Rich Statusbar Extension — Catppuccin Mocha Powerline
 *
 * Matches the @owloops/claude-powerline color scheme:
 *   Segment 1: CWD              — mauve/plan-peach bg, dark text (#1e1e2e)
 *   Segment 2: Model + thinking — surface0 bg (#313244), text fg
 *   Segment 3: Current context  — surface0 bg (#313244), blue accent (#89b4fa)
 *   Segment 4: Session cost     — surface0 bg (#313244), muted accent
 *
 *   separator transitions:  ▸ CWD→surface0  ▸ surface0→term
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { selectContextDisplay } from "./statusbar-context.ts";
import {
	SANDBOX_LIFECYCLE_EVENT,
	type SandboxLifecycleEvent,
} from "./gondolin-sandbox/events.ts";
import {
	PLAN_MODE_WORKFLOW_STATE_EVENT,
	type PlanModeWorkflowStateEvent,
} from "./plan-mode/events.ts";

// ── Catppuccin Mocha RGB ───────────────────────────────────────────

const P = {
	mauve:    [203, 166, 247] as const, // #cba6f7
	blue:     [137, 180, 250] as const, // #89b4fa
	lavender: [180, 190, 254] as const, // #b4befe
	green:    [166, 227, 161] as const, // #a6e3a1
	peach:    [250, 179, 135] as const, // #fab387
	red:      [243, 139, 168] as const, // #f38ba8
	text:     [205, 214, 244] as const, // #cdd6f4
	subtext0: [166, 173, 200] as const, // #a6adc8
	overlay0: [108, 112, 134] as const, // #6c7086
	overlay1: [127, 132, 156] as const, // #7f849c
	overlay2: [147, 153, 178] as const, // #9399b2
	surface0: [49, 50, 68] as const,    // #313244
	base:     [30, 30, 46] as const,    // #1e1e2e
	crust:    [17, 17, 27] as const,    // #11111b
};

// ── ANSI helpers ───────────────────────────────────────────────────

const fg = (...rgb: readonly [number, number, number]) =>
	`\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
const bg = (...rgb: readonly [number, number, number]) =>
	`\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
const R = "\x1b[0m";

/** Fg-only colored text — does NOT reset, safe inside an active bg segment */
function cf(rgb: readonly [number, number, number], s: string) {
	return fg(...rgb) + s;
}

// ── Powerline  separator ───────────────────────────────────────────

function sep(
	prevRgb: readonly [number, number, number],
	nextRgb: readonly [number, number, number],
): string {
	return fg(...prevRgb) + bg(...nextRgb) + "\ue0b0" + R;
}

// ── Utilities ──────────────────────────────────────────────────────

function fishShorten(path: string, home = process.env.HOME || ""): string {
	let p = path;
	if (home && p.startsWith(home)) p = "~" + p.slice(home.length);
	if (p === "/" || p === "~") return p;
	const parts = p.split("/").filter(Boolean);
	if (parts.length <= 2) return p;
	return [...parts.slice(0, -2).map((s) => s[0]), ...parts.slice(-2)].join("/");
}

/** Dotted progress bar using ╸ for filled and ┄ for empty */
function dottedBar(pct: number, width: number): string {
	const filled = Math.round((Math.min(pct, 100) / 100) * width);
	return "\u2578".repeat(filled) + "\u2504".repeat(width - filled);
}

function formatDuration(seconds: number): string {
	if (seconds < 0) return "?";
	const d = Math.floor(seconds / 86400);
	const h = Math.floor((seconds % 86400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const parts: string[] = [];
	if (d > 0) parts.push(`${d}d`);
	if (h > 0) parts.push(`${h}h`);
	if (m > 0 || parts.length === 0) parts.push(`${m}m`);
	return parts.join(" ");
}

function fmtCost(dollars: number): string {
	if (dollars < 0.01) return `$${dollars.toFixed(3)}`;
	if (dollars < 1) return `$${dollars.toFixed(2)}`;
	return `$${dollars.toFixed(2)}`;
}

function composeWithRightMarker(left: string, marker: string, width: number): string {
	const safeWidth = Math.max(0, width);
	if (safeWidth === 0) return "";

	const markerWidth = visibleWidth(marker);
	if (safeWidth <= markerWidth) return truncateToWidth(marker, safeWidth, "");

	const leftWidth = safeWidth - markerWidth - 1;
	const clippedLeft = truncateToWidth(left, leftWidth, "");
	const gap = " ".repeat(safeWidth - visibleWidth(clippedLeft) - markerWidth);
	return clippedLeft + R + gap + marker;
}

// ── Nerd Font icons ────────────────────────────────────────────────

// Gauge icons that dynamically change with context fill level
const GAUGE = {
	unknown: "\uf108", //
	empty:   "\uf108", //
	low:     "\uf109", //
	medium:  "\uf10a", //
	high:    "\uf10b", //
	full:    "\uf10c", //
};

function gaugeIcon(pct: number | undefined): string {
	if (pct === undefined) return GAUGE.unknown;
	if (pct <= 0)  return GAUGE.empty;
	if (pct <= 25) return GAUGE.low;
	if (pct <= 50) return GAUGE.medium;
	if (pct <= 75) return GAUGE.high;
	return GAUGE.full;
}

const I = {
	dir: "\uf07b",   //
	model: "\uf85a", // 󰚩
	clock: "\uf017", //
};

// ── Extension ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let currentModelId: string | undefined;
	let workflowMode: PlanModeWorkflowStateEvent["mode"] = "off";
	let sandboxLifecycle: SandboxLifecycleEvent | undefined;
	let requestFooterRender: (() => void) | undefined;

	pi.events.on(SANDBOX_LIFECYCLE_EVENT, (data) => {
		sandboxLifecycle = data as SandboxLifecycleEvent;
		requestFooterRender?.();
	});

	pi.events.on(PLAN_MODE_WORKFLOW_STATE_EVENT, (data) => {
		const { mode } = data as PlanModeWorkflowStateEvent;
		if (workflowMode === mode) return;
		workflowMode = mode;
		requestFooterRender?.();
	});

	pi.on("thinking_level_select", () => {
		requestFooterRender?.();
	});

	pi.on("model_select", (event) => {
		currentModelId = event.model.id;
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setFooter((tui, _theme, footerData) => {
			const renderFooter = () => tui.requestRender();
			requestFooterRender = renderFooter;
			const unsub = footerData.onBranchChange(renderFooter);

			return {
				dispose: () => {
					unsub?.();
					if (requestFooterRender === renderFooter) requestFooterRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					let line = "";
					const planningActive = workflowMode === "planning" || workflowMode === "approval";
					const cwdColor = planningActive ? P.peach : P.mauve;

					// ── Segment 1: CWD — mode color bg, dark text ──
					const cwd = fishShorten(ctx.cwd);
					line += bg(...cwdColor) + cf(P.base, ` ${I.dir} ${cwd} `) + R;

					// ──  separator: CWD → surface0 ──
					line += sep(cwdColor, P.surface0);

					// ── Segments 2–4: all on surface0 bg ──
					// Set bg ONCE. Use cf() (fg-only) inside so bg is never cleared.
					// Reset only at the very end before the closing separator.
					line += bg(...P.surface0);

					// Segment 2: Model + thinking
					const modelId = currentModelId ?? ctx.model?.id ?? "unknown";
					const thinkingLevel = pi.getThinkingLevel();
					const thinkStr = cf(P.overlay1, ` [${thinkingLevel}]`);
					line += cf(P.text, ` ${I.model} ${modelId}`) + thinkStr + cf(P.text, " ");

					if (sandboxLifecycle) {
						const health = sandboxLifecycle.health;
						const color = health === "healthy" ? P.green : health === "failed" ? P.red : P.peach;
						const label = health === "healthy"
							? `vm:${sandboxLifecycle.vmId?.slice(0, 6) ?? "ready"}`
							: health;
						line += cf(color, ` ${health === "healthy" ? "●" : "◌"} ${label} `);
					}

					// Segment 3: Current context usage — blue accent
					const contextDisplay = selectContextDisplay(ctx.getContextUsage());
					const gaugePercent = contextDisplay.gaugePercent;

					const gaugeBar = gaugePercent === undefined ? " ".repeat(9) : dottedBar(gaugePercent, 9);
					line += cf(P.blue, ` ${gaugeIcon(gaugePercent)} `) +
						cf(P.blue, gaugeBar) +
						cf(P.blue, ` ${contextDisplay.count} `);

					// Segment 4: Cumulative session cost
					let totalCost = 0;
					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as AssistantMessage;
							totalCost += m.usage.cost.total;
						}
					}
					line += cf(P.overlay0, I.clock) + "  " +
						cf(P.overlay1, `(${fmtCost(totalCost)}) `) +
						R;

					// ── Final  separator: surface0 → crust ──
					line += sep(P.surface0, P.crust) + R;

					if (!planningActive) return [truncateToWidth(line, width)];
					const marker = R + cf(P.overlay0, "[PLANNING]") + R;
					return [composeWithRightMarker(line, marker, width)];
				},
			};
		});
	});
}
