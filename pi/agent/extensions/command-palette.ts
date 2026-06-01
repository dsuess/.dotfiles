/**
 * Command Palette Extension
 *
 * Ctrl+P opens a searchable overlay listing every pi action — all keybinding
 * actions (app.* and tui.*), built-in slash commands, and extension commands.
 * Each item shows its current shortcut. Selecting an item executes it when an
 * extension API exists; otherwise the palette closes and shows a notification
 * with the shortcut to press.
 *
 * Layout (overlay, top-center):
 *   ╭──────────────────────────────────────────╮
 *   │ ❯ search query▎                          │
 *   │──────────────────────────────────────────│
 *   │ > Toggle Tool Output        Ctrl+O       │
 *   │   Cycle Thinking Level    Shift+Tab      │
 *   │   Toggle Thinking Blocks    Ctrl+T       │
 *   │   ...                                    │
 *   │──────────────────────────────────────────│
 *   │ type to filter · ↑↓ · ↵ select · esc    │
 *   ╰──────────────────────────────────────────╯
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, keyText } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import {
	Container,
	Key,
	SelectList,
	Text,
	type SelectItem,
	fuzzyFilter,
	matchesKey,
} from "@earendil-works/pi-tui";

// ── Types ──────────────────────────────────────────────────────────

interface CommandEntry {
	id: string;
	label: string;
	keybindingId?: string;
	category: string;
	/** True for tui.* editor shortcuts — shown with ⟡ indicator */
	isEditorShortcut?: boolean;
	execute?: (pi: ExtensionAPI, ctx: ExtensionContext) => void | Promise<void>;
}

// ── Constants ──────────────────────────────────────────────────────

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

/** Built-in interactive commands (not returned by pi.getCommands()) */
const BUILT_IN_COMMANDS: CommandEntry[] = [
	{
		id: "cmd.clone",
		label: "/clone — Clone Session",
		category: "Built-in Commands",
		execute: (pi) => pi.sendUserMessage("/clone"),
	},
	{
		id: "cmd.settings",
		label: "/settings — Settings",
		category: "Built-in Commands",
		execute: (pi) => pi.sendUserMessage("/settings"),
	},
	{
		id: "cmd.reload",
		label: "/reload — Reload Extensions",
		category: "Built-in Commands",
		execute: (pi) => pi.sendUserMessage("/reload"),
	},
	{
		id: "cmd.login",
		label: "/login — Manage API Keys",
		category: "Built-in Commands",
		execute: (pi) => pi.sendUserMessage("/login"),
	},
	{
		id: "cmd.cost",
		label: "/cost — Show Cost",
		category: "Built-in Commands",
		execute: (pi) => pi.sendUserMessage("/cost"),
	},
	{
		id: "cmd.help",
		label: "/help — Help",
		category: "Built-in Commands",
		execute: (pi) => pi.sendUserMessage("/help"),
	},
	{
		id: "cmd.scoped-models",
		label: "/scoped-models — Manage Models",
		category: "Built-in Commands",
		execute: (pi) => pi.sendUserMessage("/scoped-models"),
	},
];

// ── Key formatting ─────────────────────────────────────────────────

/** Format a raw key ID (e.g. "ctrl+shift+p") into a human-readable label */
function formatKey(key: string): string {
	return key
		.split("+")
		.map((part) => {
			switch (part) {
				case "ctrl":
					return "Ctrl";
				case "shift":
					return "Shift";
				case "alt":
					return "Alt";
				case "escape":
					return "Esc";
				case "backspace":
					return "⌫";
				case "delete":
					return "Del";
				case "enter":
				case "return":
					return "↵";
				case "tab":
					return "⇥";
				case "space":
					return "Space";
				case "pageUp":
					return "PgUp";
				case "pageDown":
					return "PgDn";
				case "left":
					return "←";
				case "right":
					return "→";
				case "up":
					return "↑";
				case "down":
					return "↓";
				case "home":
					return "Home";
				case "end":
					return "End";
				case "insert":
					return "Ins";
				default:
					if (part.length === 1) return part.toUpperCase();
					return part.charAt(0).toUpperCase() + part.slice(1);
			}
		})
		.join("+");
}

/** Resolve the shortcut text for a keybinding ID using pi's keyText() */
function getShortcut(kbId: string): string {
	try {
		const text = keyText(kbId as any);
		if (text) return text;
	} catch {
		/* keybinding not in registry */
	}
	return "";
}

/** Resolve shortcut via KeybindingsManager (used inside ctx.ui.custom callback) */
function getShortcutFromManager(keybindings: any, kbId: string): string {
	try {
		const keys = keybindings.getKeys(kbId) as string[] | undefined;
		if (keys && keys.length > 0) {
			return keys.map(formatKey).join(", ");
		}
	} catch {
		/* keybinding not in registry */
	}
	return "";
}

// ── Command definitions ────────────────────────────────────────────

function buildCommands(pi: ExtensionAPI): CommandEntry[] {
	const commands: CommandEntry[] = [
		// ════════════════════════════════════════════════
		//  Tier 1 — app.* keybinding actions
		// ════════════════════════════════════════════════

		// ── General ────────────────────────────────────
		{
			id: "app.interrupt",
			label: "Cancel / Abort",
			keybindingId: "app.interrupt",
			category: "General",
		},
		{
			id: "app.clear",
			label: "Clear Editor",
			keybindingId: "app.clear",
			category: "General",
		},
		{
			id: "app.exit",
			label: "Exit pi",
			keybindingId: "app.exit",
			category: "General",
		},
		{
			id: "app.suspend",
			label: "Suspend to Background",
			keybindingId: "app.suspend",
			category: "General",
		},
		{
			id: "app.editor.external",
			label: "Open External Editor",
			keybindingId: "app.editor.external",
			category: "General",
		},
		{
			id: "app.clipboard.pasteImage",
			label: "Paste Image from Clipboard",
			keybindingId: "app.clipboard.pasteImage",
			category: "General",
		},

		// ── Sessions ───────────────────────────────────
		{
			id: "app.session.new",
			label: "New Session",
			keybindingId: "app.session.new",
			category: "Sessions",
			execute: async (_pi, ctx) => {
				await ctx.newSession();
			},
		},
		{
			id: "app.session.resume",
			label: "Resume Session",
			keybindingId: "app.session.resume",
			category: "Sessions",
			execute: (pi) => pi.sendUserMessage("/resume"),
		},
		{
			id: "app.session.fork",
			label: "Fork Session",
			keybindingId: "app.session.fork",
			category: "Sessions",
			execute: (pi) => pi.sendUserMessage("/fork"),
		},
		{
			id: "app.session.tree",
			label: "Session Tree Navigator",
			keybindingId: "app.session.tree",
			category: "Sessions",
			execute: (pi) => pi.sendUserMessage("/tree"),
		},
		{
			id: "app.session.toggleSort",
			label: "Toggle Session Sort Mode",
			keybindingId: "app.session.toggleSort",
			category: "Sessions",
		},
		{
			id: "app.session.toggleNamedFilter",
			label: "Toggle Named-Only Filter",
			keybindingId: "app.session.toggleNamedFilter",
			category: "Sessions",
		},
		{
			id: "app.session.rename",
			label: "Rename Session",
			keybindingId: "app.session.rename",
			category: "Sessions",
		},
		{
			id: "app.session.delete",
			label: "Delete Session",
			keybindingId: "app.session.delete",
			category: "Sessions",
		},
		{
			id: "app.session.deleteNoninvasive",
			label: "Delete Session (when empty)",
			keybindingId: "app.session.deleteNoninvasive",
			category: "Sessions",
		},

		// ── Models & Thinking ──────────────────────────
		{
			id: "app.model.select",
			label: "Select Model",
			keybindingId: "app.model.select",
			category: "Models & Thinking",
			execute: (pi) => pi.sendUserMessage("/model"),
		},
		{
			id: "app.model.cycleForward",
			label: "Cycle to Next Model",
			keybindingId: "app.model.cycleForward",
			category: "Models & Thinking",
			execute: (pi, ctx) => {
				const available = ctx.modelRegistry.getAvailable();
				if (available.length === 0) return;
				const current = ctx.model;
				if (!current) {
					pi.setModel(available[0]);
					return;
				}
				const idx = available.findIndex(
					(m) => m.provider === current.provider && m.id === current.id,
				);
				const next = available[(idx + 1) % available.length];
				pi.setModel(next);
			},
		},
		{
			id: "app.model.cycleBackward",
			label: "Cycle to Previous Model",
			keybindingId: "app.model.cycleBackward",
			category: "Models & Thinking",
			execute: (pi, ctx) => {
				const available = ctx.modelRegistry.getAvailable();
				if (available.length === 0) return;
				const current = ctx.model;
				if (!current) {
					pi.setModel(available[available.length - 1]);
					return;
				}
				const idx = available.findIndex(
					(m) => m.provider === current.provider && m.id === current.id,
				);
				const prev = available[(idx - 1 + available.length) % available.length];
				pi.setModel(prev);
			},
		},
		{
			id: "app.thinking.cycle",
			label: "Cycle Thinking Level",
			keybindingId: "app.thinking.cycle",
			category: "Models & Thinking",
			execute: (pi) => {
				const current = pi.getThinkingLevel();
				const idx = THINKING_LEVELS.indexOf(current);
				const next = THINKING_LEVELS[(idx + 1) % THINKING_LEVELS.length];
				pi.setThinkingLevel(next);
			},
		},
		{
			id: "app.thinking.toggle",
			label: "Toggle Thinking Blocks",
			keybindingId: "app.thinking.toggle",
			category: "Models & Thinking",
		},
		// Specific thinking levels — executable
		...THINKING_LEVELS.map(
			(level): CommandEntry => ({
				id: `thinking.set.${level}`,
				label: `Set Thinking: ${level.charAt(0).toUpperCase() + level.slice(1)}`,
				category: "Models & Thinking",
				execute: (pi) => pi.setThinkingLevel(level),
			}),
		),

		// ── Display & Messages ─────────────────────────
		{
			id: "app.tools.expand",
			label: "Toggle Tool Output",
			keybindingId: "app.tools.expand",
			category: "Display & Messages",
			execute: (_pi, ctx) => ctx.ui.setToolsExpanded(!ctx.ui.getToolsExpanded()),
		},
		{
			id: "app.message.followUp",
			label: "Queue Follow-up Message",
			keybindingId: "app.message.followUp",
			category: "Display & Messages",
		},
		{
			id: "app.message.dequeue",
			label: "Restore Queued Messages",
			keybindingId: "app.message.dequeue",
			category: "Display & Messages",
		},

		// ── Tree Navigation ────────────────────────────
		{
			id: "app.tree.foldOrUp",
			label: "Fold Branch / Move Up",
			keybindingId: "app.tree.foldOrUp",
			category: "Tree Navigation",
		},
		{
			id: "app.tree.unfoldOrDown",
			label: "Unfold Branch / Move Down",
			keybindingId: "app.tree.unfoldOrDown",
			category: "Tree Navigation",
		},
		{
			id: "app.tree.editLabel",
			label: "Edit Tree Label",
			keybindingId: "app.tree.editLabel",
			category: "Tree Navigation",
		},
		{
			id: "app.tree.toggleLabelTimestamp",
			label: "Toggle Label Timestamps",
			keybindingId: "app.tree.toggleLabelTimestamp",
			category: "Tree Navigation",
		},
		{
			id: "app.tree.filter.default",
			label: "Tree Filter: Default",
			keybindingId: "app.tree.filter.default",
			category: "Tree Navigation",
		},
		{
			id: "app.tree.filter.noTools",
			label: "Tree Filter: Hide Tools",
			keybindingId: "app.tree.filter.noTools",
			category: "Tree Navigation",
		},
		{
			id: "app.tree.filter.userOnly",
			label: "Tree Filter: User Only",
			keybindingId: "app.tree.filter.userOnly",
			category: "Tree Navigation",
		},
		{
			id: "app.tree.filter.labeledOnly",
			label: "Tree Filter: Labeled Only",
			keybindingId: "app.tree.filter.labeledOnly",
			category: "Tree Navigation",
		},
		{
			id: "app.tree.filter.all",
			label: "Tree Filter: All",
			keybindingId: "app.tree.filter.all",
			category: "Tree Navigation",
		},
		{
			id: "app.tree.filter.cycleForward",
			label: "Tree Filter: Cycle Forward",
			keybindingId: "app.tree.filter.cycleForward",
			category: "Tree Navigation",
		},
		{
			id: "app.tree.filter.cycleBackward",
			label: "Tree Filter: Cycle Backward",
			keybindingId: "app.tree.filter.cycleBackward",
			category: "Tree Navigation",
		},

		// ── Scoped Models Selector ─────────────────────
		{
			id: "app.models.save",
			label: "Save Model Selection",
			keybindingId: "app.models.save",
			category: "Scoped Models",
		},
		{
			id: "app.models.enableAll",
			label: "Enable All Models",
			keybindingId: "app.models.enableAll",
			category: "Scoped Models",
		},
		{
			id: "app.models.clearAll",
			label: "Clear All Models",
			keybindingId: "app.models.clearAll",
			category: "Scoped Models",
		},
		{
			id: "app.models.toggleProvider",
			label: "Toggle Provider Models",
			keybindingId: "app.models.toggleProvider",
			category: "Scoped Models",
		},
		{
			id: "app.models.reorderUp",
			label: "Move Model Up",
			keybindingId: "app.models.reorderUp",
			category: "Scoped Models",
		},
		{
			id: "app.models.reorderDown",
			label: "Move Model Down",
			keybindingId: "app.models.reorderDown",
			category: "Scoped Models",
		},

		// ════════════════════════════════════════════════
		//  Tier 2 — tui.* editor/input/selection shortcuts
		// ════════════════════════════════════════════════

		// Cursor Movement
		{
			id: "tui.editor.cursorUp",
			label: "Cursor Up",
			keybindingId: "tui.editor.cursorUp",
			category: "Editor: Cursor",
			isEditorShortcut: true,
		},
		{
			id: "tui.editor.cursorDown",
			label: "Cursor Down",
			keybindingId: "tui.editor.cursorDown",
			category: "Editor: Cursor",
			isEditorShortcut: true,
		},
		{
			id: "tui.editor.cursorLeft",
			label: "Cursor Left",
			keybindingId: "tui.editor.cursorLeft",
			category: "Editor: Cursor",
			isEditorShortcut: true,
		},
		{
			id: "tui.editor.cursorRight",
			label: "Cursor Right",
			keybindingId: "tui.editor.cursorRight",
			category: "Editor: Cursor",
			isEditorShortcut: true,
		},
		{
			id: "tui.editor.cursorWordLeft",
			label: "Cursor Word Left",
			keybindingId: "tui.editor.cursorWordLeft",
			category: "Editor: Cursor",
			isEditorShortcut: true,
		},
		{
			id: "tui.editor.cursorWordRight",
			label: "Cursor Word Right",
			keybindingId: "tui.editor.cursorWordRight",
			category: "Editor: Cursor",
			isEditorShortcut: true,
		},
		{
			id: "tui.editor.cursorLineStart",
			label: "Cursor to Line Start",
			keybindingId: "tui.editor.cursorLineStart",
			category: "Editor: Cursor",
			isEditorShortcut: true,
		},
		{
			id: "tui.editor.cursorLineEnd",
			label: "Cursor to Line End",
			keybindingId: "tui.editor.cursorLineEnd",
			category: "Editor: Cursor",
			isEditorShortcut: true,
		},
		{
			id: "tui.editor.jumpForward",
			label: "Jump Forward to Character",
			keybindingId: "tui.editor.jumpForward",
			category: "Editor: Cursor",
			isEditorShortcut: true,
		},
		{
			id: "tui.editor.jumpBackward",
			label: "Jump Backward to Character",
			keybindingId: "tui.editor.jumpBackward",
			category: "Editor: Cursor",
			isEditorShortcut: true,
		},
		{
			id: "tui.editor.pageUp",
			label: "Page Up",
			keybindingId: "tui.editor.pageUp",
			category: "Editor: Cursor",
			isEditorShortcut: true,
		},
		{
			id: "tui.editor.pageDown",
			label: "Page Down",
			keybindingId: "tui.editor.pageDown",
			category: "Editor: Cursor",
			isEditorShortcut: true,
		},

		// Deletion
		{
			id: "tui.editor.deleteCharBackward",
			label: "Delete Character Backward",
			keybindingId: "tui.editor.deleteCharBackward",
			category: "Editor: Deletion",
			isEditorShortcut: true,
		},
		{
			id: "tui.editor.deleteCharForward",
			label: "Delete Character Forward",
			keybindingId: "tui.editor.deleteCharForward",
			category: "Editor: Deletion",
			isEditorShortcut: true,
		},
		{
			id: "tui.editor.deleteWordBackward",
			label: "Delete Word Backward",
			keybindingId: "tui.editor.deleteWordBackward",
			category: "Editor: Deletion",
			isEditorShortcut: true,
		},
		{
			id: "tui.editor.deleteWordForward",
			label: "Delete Word Forward",
			keybindingId: "tui.editor.deleteWordForward",
			category: "Editor: Deletion",
			isEditorShortcut: true,
		},
		{
			id: "tui.editor.deleteToLineStart",
			label: "Delete to Line Start",
			keybindingId: "tui.editor.deleteToLineStart",
			category: "Editor: Deletion",
			isEditorShortcut: true,
		},
		{
			id: "tui.editor.deleteToLineEnd",
			label: "Delete to Line End",
			keybindingId: "tui.editor.deleteToLineEnd",
			category: "Editor: Deletion",
			isEditorShortcut: true,
		},

		// Input
		{
			id: "tui.input.newLine",
			label: "Insert New Line",
			keybindingId: "tui.input.newLine",
			category: "Editor: Input",
			isEditorShortcut: true,
		},
		{
			id: "tui.input.submit",
			label: "Submit Input",
			keybindingId: "tui.input.submit",
			category: "Editor: Input",
			isEditorShortcut: true,
		},
		{
			id: "tui.input.tab",
			label: "Tab / Autocomplete",
			keybindingId: "tui.input.tab",
			category: "Editor: Input",
			isEditorShortcut: true,
		},

		// Kill Ring
		{
			id: "tui.editor.yank",
			label: "Yank (Paste)",
			keybindingId: "tui.editor.yank",
			category: "Editor: Kill Ring",
			isEditorShortcut: true,
		},
		{
			id: "tui.editor.yankPop",
			label: "Yank Pop (Cycle)",
			keybindingId: "tui.editor.yankPop",
			category: "Editor: Kill Ring",
			isEditorShortcut: true,
		},
		{
			id: "tui.editor.undo",
			label: "Undo",
			keybindingId: "tui.editor.undo",
			category: "Editor: Kill Ring",
			isEditorShortcut: true,
		},

		// Clipboard & Selection
		{
			id: "tui.input.copy",
			label: "Copy Selection",
			keybindingId: "tui.input.copy",
			category: "Editor: Selection",
			isEditorShortcut: true,
		},
		{
			id: "tui.select.up",
			label: "Selection Up",
			keybindingId: "tui.select.up",
			category: "Editor: Selection",
			isEditorShortcut: true,
		},
		{
			id: "tui.select.down",
			label: "Selection Down",
			keybindingId: "tui.select.down",
			category: "Editor: Selection",
			isEditorShortcut: true,
		},
		{
			id: "tui.select.pageUp",
			label: "Selection Page Up",
			keybindingId: "tui.select.pageUp",
			category: "Editor: Selection",
			isEditorShortcut: true,
		},
		{
			id: "tui.select.pageDown",
			label: "Selection Page Down",
			keybindingId: "tui.select.pageDown",
			category: "Editor: Selection",
			isEditorShortcut: true,
		},
		{
			id: "tui.select.confirm",
			label: "Confirm Selection",
			keybindingId: "tui.select.confirm",
			category: "Editor: Selection",
			isEditorShortcut: true,
		},
		{
			id: "tui.select.cancel",
			label: "Cancel Selection",
			keybindingId: "tui.select.cancel",
			category: "Editor: Selection",
			isEditorShortcut: true,
		},

		// ════════════════════════════════════════════════
		//  Tier 3 — Session actions (no default shortcut)
		// ════════════════════════════════════════════════
		{
			id: "action.compact",
			label: "Compact Conversation",
			category: "Session Actions",
			execute: (_pi, ctx) => ctx.compact(),
		},
	];

	// ── Tier 3 — Built-in slash commands ──────────────
	commands.push(...BUILT_IN_COMMANDS);

	// ── Tier 3 — Extension / skill / prompt commands ──
	for (const cmd of pi.getCommands()) {
		const category =
			cmd.source === "extension"
				? "Extension Commands"
				: cmd.source === "skill"
					? "Skill Commands"
					: "Prompt Templates";
		commands.push({
			id: `ext.${cmd.name}`,
			label: `/${cmd.name}`,
			category,
			execute: (pi) => pi.sendUserMessage(`/${cmd.name}`),
		});
	}

	return commands;
}

// ── Main extension ─────────────────────────────────────────────────

export default function commandPaletteExtension(pi: ExtensionAPI) {
	pi.registerShortcut("ctrl+p", {
		description: "Open command palette",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;

			const commands = buildCommands(pi);
			// Capture shortcut text resolved inside the custom callback
			const shortcutMap = new Map<string, string>();

			const result = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
				// Build select items with resolved shortcuts
				const items: SelectItem[] = commands.map((cmd) => {
					let shortcut = "";
					if (cmd.keybindingId) {
						// Try keyText() first (uses global keybindings), fall back to injected manager
						shortcut = getShortcut(cmd.keybindingId) || getShortcutFromManager(keybindings, cmd.keybindingId);
						if (shortcut) shortcutMap.set(cmd.id, shortcut);
					}

					// Editor shortcuts get a ⟡ indicator
					const desc = cmd.isEditorShortcut
						? shortcut
							? `⟡ ${shortcut}`
							: "⟡"
						: shortcut || "—";

					return {
						value: cmd.id,
						label: cmd.label,
						description: desc,
					};
				});

				// Search state
				let searchQuery = "";

				// SelectList
				const selectList = new SelectList(items, 14, {
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => theme.fg("accent", theme.bold(t)),
					description: (t) => theme.fg("muted", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				});

				selectList.onSelect = (item) => done(item.value);
				selectList.onCancel = () => done(null);

				/** Fuzzy-filter the list and update the SelectList's internal state */
				function applyFuzzyFilter(query: string): void {
					// Match against label, description, AND the command's category for richer fuzzy hits
					// (e.g. typing "session" matches all items in the Sessions category)
					const cmdMap = new Map(items.map((item) => [item.value, commands.find((c) => c.id === item.value)]));
					const filtered = fuzzyFilter(items, query, (item) => {
						const cmd = cmdMap.get(item.value);
						return `${item.label} ${item.description ?? ""} ${cmd?.category ?? ""}`;
					});
					// Directly update SelectList internals (items/filteredItems are not truly private)
					(selectList as any).filteredItems = filtered;
					(selectList as any).selectedIndex = 0;
				}

				// Search prompt
				const searchLine = new Text(
					theme.fg("accent", " ❯ ") + theme.fg("accent", "▎"),
					0,
					0,
				);

				// Separator between search and list
				const separator = new DynamicBorder((s: string) => theme.fg("border", s));

				// Assemble layout
				const container = new Container();
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(searchLine);
				container.addChild(separator);
				container.addChild(selectList);
				container.addChild(
					new Text(
						theme.fg("dim", " type to filter · ↑↓ navigate · ↵ select · esc close"),
						1,
						0,
					),
				);
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						// Escape → close palette
						if (matchesKey(data, Key.escape)) {
							done(null);
							return;
						}

						// Enter → confirm selection
						if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
							selectList.handleInput(data);
							tui.requestRender();
							return;
						}

						// Navigation keys → pass to SelectList
						if (
							matchesKey(data, Key.up) ||
							matchesKey(data, Key.down) ||
							matchesKey(data, Key.pageUp) ||
							matchesKey(data, Key.pageDown)
						) {
							selectList.handleInput(data);
							tui.requestRender();
							return;
						}

						// Ctrl+U → clear search
						if (matchesKey(data, Key.ctrl("u"))) {
							searchQuery = "";
							searchLine.setText(
								theme.fg("accent", " ❯ ") + theme.fg("accent", "▎"),
							);
							applyFuzzyFilter("");
							container.invalidate();
							tui.requestRender();
							return;
						}

						// Ctrl+W → delete last word
						if (matchesKey(data, Key.ctrl("w"))) {
							const trimmed = searchQuery.trimEnd();
							const lastSpace = trimmed.lastIndexOf(" ");
							searchQuery = lastSpace >= 0 ? trimmed.slice(0, lastSpace + 1) : "";
							searchLine.setText(
								theme.fg("accent", " ❯ ") + searchQuery + theme.fg("accent", "▎"),
							);
							applyFuzzyFilter(searchQuery);
							container.invalidate();
							tui.requestRender();
							return;
						}

						// Backspace → delete last char
						if (matchesKey(data, Key.backspace)) {
							searchQuery = searchQuery.slice(0, -1);
							searchLine.setText(
								theme.fg("accent", " ❯ ") + searchQuery + theme.fg("accent", "▎"),
							);
							applyFuzzyFilter(searchQuery);
							container.invalidate();
							tui.requestRender();
							return;
						}

						// Printable character → append to search
						if (data.length === 1 && data.charCodeAt(0) >= 32) {
							searchQuery += data;
							searchLine.setText(
								theme.fg("accent", " ❯ ") + searchQuery + theme.fg("accent", "▎"),
							);
							applyFuzzyFilter(searchQuery);
							container.invalidate();
							tui.requestRender();
							return;
						}
					},
				};
			}, {
				overlay: true,
				overlayOptions: {
					anchor: "top-center",
					width: "60%",
					minWidth: 50,
					maxHeight: "80%",
					margin: { top: 1 },
				},
			});

			// ── Handle selection ────────────────────────
			if (result === null) return;

			const command = commands.find((cmd) => cmd.id === result);
			if (!command) return;

			if (command.execute) {
				await command.execute(pi, ctx);
			} else if (command.isEditorShortcut) {
				// Editor shortcut — show the key binding
				const shortcut = shortcutMap.get(command.id);
				if (shortcut) {
					ctx.ui.notify(`Editor shortcut: ${shortcut}`, "info");
				} else {
					ctx.ui.notify(`${command.label} — no shortcut bound`, "info");
				}
			} else {
				// TUI-only action — close palette + show shortcut reminder
				const shortcut = shortcutMap.get(command.id);
				if (shortcut) {
					ctx.ui.notify(
						`Press ${shortcut} to ${command.label.toLowerCase()}`,
						"info",
					);
				} else {
					ctx.ui.notify(
						`${command.label} — no shortcut bound`,
						"info",
					);
				}
			}
		},
	});
}
