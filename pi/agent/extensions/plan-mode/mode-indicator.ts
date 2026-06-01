/**
 * Mode Indicator Editor — CustomEditor subclass that shows the current
 * plan-mode phase as a colored badge in the top-left of the editor border.
 *
 * Pattern: embed status in the border like vim's modeline.
 * Uses fitBorder() to place text inside the border line without
 * breaking the box-drawing characters.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { phaseBadge, phaseColor, type Phase } from "./utils.ts";

// ─── Border fitting utility ────────────────────────────────────────────────
// Places left/right text inside a horizontal border line like:
//   ┌─ 🔍 EXPLORE ────────────────────────────┐

function fitBorder(
	left: string,
	right: string,
	width: number,
	border: (text: string) => string,
	fill: (text: string) => string = border,
): string {
	if (width <= 0) return "";
	if (width === 1) return border("─");

	let leftText = left;
	let rightText = right;
	const fixedWidth = 2; // two border chars (┌ and ┐)
	const minimumGap = 3;

	// Shrink right text first if overflow
	while (
		fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
		visibleWidth(rightText) > 0
	) {
		rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
	}
	// Then shrink left text if still overflow
	while (
		fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
		visibleWidth(leftText) > 0
	) {
		leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
	}

	const gapWidth = Math.max(
		0,
		width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText),
	);
	return `${border("─")}${leftText}${fill("─".repeat(gapWidth))}${rightText}${border("─")}`;
}

// ─── Mutable phase reference ───────────────────────────────────────────────
// The extension updates this; the editor reads it during render.
// This avoids tight coupling — the editor just reads a value.

export interface PhaseRef {
	phase: Phase;
}

// ─── ModeIndicatorEditor ───────────────────────────────────────────────────

export class ModeIndicatorEditor extends CustomEditor {
	private phaseRef: PhaseRef;
	private appTheme: Theme;

	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		phaseRef: PhaseRef,
		appTheme: Theme,
	) {
		super(tui, editorTheme, keybindings, { paddingX: 0 });
		this.phaseRef = phaseRef;
		this.appTheme = appTheme;
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length < 2) return lines;

		const phase = this.phaseRef.phase;

		// Build the mode badge for the top-left corner
		const badge =
			phase !== "off"
				? this.appTheme.fg(phaseColor(phase), ` ${phaseBadge(phase)}`)
				: "";

		const borderColor = (text: string) => this.borderColor(text);

		lines[0] = fitBorder(badge, "", width, borderColor);
		return lines;
	}
}

// ─── Factory function ──────────────────────────────────────────────────────
// Returns a factory that the extension can pass to ctx.ui.setEditorComponent()

export function createModeEditorFactory(
	phaseRef: PhaseRef,
	getTheme: () => Theme,
) {
	return (tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) =>
		new ModeIndicatorEditor(tui, editorTheme, keybindings, phaseRef, getTheme());
}
