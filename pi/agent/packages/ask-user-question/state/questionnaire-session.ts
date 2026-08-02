import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	isKeyRelease,
	isKeyRepeat,
	Key,
	matchesKey,
	type OverlayHandle,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { DiscussionTurnResult } from "../discussion/runtime.js";
import {
	emptyQuestionDiscussion,
	type DiscussionMessage,
	type QuestionDiscussionState,
} from "../discussion/types.js";
import type { QuestionData, QuestionnaireResult, QuestionParams } from "../tool/types.js";
import type { WrappingSelectItem } from "../view/components/wrapping-select.js";
import { COLLAPSED_HINT } from "../view/dialog-builder.js";
import type { QuestionnairePropsAdapter } from "../view/props-adapter.js";
import { buildQuestionnaire } from "./build-questionnaire.js";
import { t } from "./i18n-bridge.js";
import { type QuestionnaireAction, routeKey } from "./key-router.js";
import type { QuestionnaireRuntime, QuestionnaireState } from "./state.js";
import { type ApplyContext, type Effect, reduce } from "./state-reducer.js";

export interface QuestionnaireDiscussionRequest {
	questionIndex: number;
	question: string;
	options: ReadonlyArray<{ label: string; description: string }>;
	userPrompt: string;
	transcript: readonly DiscussionMessage[];
	signal: AbortSignal;
	onActivity: (message: string) => void;
}

export interface QuestionnaireSessionConfig {
	tui: TUI;
	theme: Theme;
	params: QuestionParams;
	itemsByTab: WrappingSelectItem[][];
	done: (result: QuestionnaireResult) => void;
	keybindings: QuestionnaireRuntime["keybindings"];
	/** Opens Pi's configured external editor. Resolve `undefined` on a reported launch failure. */
	editInput: (value: string) => Promise<string | undefined>;
	/** Key spec for the collapse/expand shortcut, e.g. `"ctrl+]"` or `"alt+o"`. */
	collapseKey: string;
	/** Execute one isolated clarification turn. Omitted only in headless unit fixtures. */
	runDiscussion?: (request: QuestionnaireDiscussionRequest) => Promise<DiscussionTurnResult>;
}

export interface QuestionnaireSessionComponent {
	focused: boolean;
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

const DISCUSSION_ACTIONS = ["send", "back", "continue"] as const;
const DISCUSSION_HANDOFF_REASON = "The structured choices need broader investigation";

function discussionEditorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (text) => theme.fg("borderMuted", text),
		selectList: {
			selectedPrefix: (text) => theme.bg("selectedBg", theme.fg("accent", text)),
			selectedText: (text) => theme.bg("selectedBg", theme.bold(text)),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};
}

function initialState(): QuestionnaireState {
	return {
		currentTab: 0,
		optionIndex: 0,
		inputMode: false,
		notesVisible: false,
		answers: new Map(),
		multiSelectChecked: new Set(),
		customDraftsByTab: new Map(),
		notesByTab: new Map(),
		submitChoiceIndex: 0,
		discussionOpenTab: null,
		discussionsByTab: new Map(),
		notesDraft: "",
		collapsed: false,
	};
}

/**
 * Slim runtime: owns the canonical state cell, the headless editor cells, the
 * notes-draft mirror, and the effect runner. State
 * transitions go through the pure `reduce` reducer; UI fan-out goes through
 * the `QuestionnairePropsAdapter` produced by `buildQuestionnaire`.
 */
export class QuestionnaireSession {
	private state: QuestionnaireState = initialState();

	private readonly questions: readonly QuestionData[];
	private readonly isMulti: boolean;
	private readonly itemsByTab: WrappingSelectItem[][];

	private readonly notesInput: Editor;
	private readonly inlineInput: Editor;
	private readonly discussionInput: Editor;
	private readonly viewAdapter: QuestionnairePropsAdapter;
	private readonly keybindings: QuestionnaireRuntime["keybindings"];
	private readonly editInput: QuestionnaireSessionConfig["editInput"];
	private readonly runDiscussion: QuestionnaireSessionConfig["runDiscussion"];
	private readonly collapseKey: string;
	private readonly theme: Theme;
	private inputEditorOpen = false;
	private discussionInputFocused = true;
	private discussionActionIndex = 0;
	private discussionTurnController: AbortController | undefined;
	private discussionTurnId = 0;
	private _focused = false;

	/**
	 * Overlay handle captured by `ctx.ui.custom`'s `onHandle` callback. Lets the session
	 * call `setHidden(true/false)` so pi-tui's overlay stack reflects the collapsed state
	 * and overlay-aware consumers (e.g. `pi-station`) can resume normal behaviour.
	 */
	private overlayHandle: OverlayHandle | undefined;

	private readonly tui: QuestionnaireSessionConfig["tui"];
	private readonly done: QuestionnaireSessionConfig["done"];
	readonly component: QuestionnaireSessionComponent;

	constructor(config: QuestionnaireSessionConfig) {
		this.tui = config.tui;
		this.done = config.done;
		this.questions = config.params.questions;
		this.isMulti = this.questions.length > 1;
		this.itemsByTab = config.itemsByTab;
		this.keybindings = config.keybindings;
		this.editInput = config.editInput;
		this.runDiscussion = config.runDiscussion;
		this.collapseKey = config.collapseKey;
		this.theme = config.theme;
		this.discussionInput = new Editor(this.tui, discussionEditorTheme(config.theme));

		const built = buildQuestionnaire({
			tui: this.tui,
			theme: config.theme,
			questions: this.questions,
			itemsByTab: this.itemsByTab,
			isMulti: this.isMulti,
			initialState: this.state,
			getCurrentTab: () => this.state.currentTab,
		});

		this.notesInput = built.notesInput;
		this.inlineInput = built.inlineInput;
		this.viewAdapter = built.adapter;

		const theme = config.theme;
		// Collapsed render: a single dim row at the bottom of the overlay. pi-tui sizes
		// the overlay to `min(lines.length, maxHeight)`, so returning one line shrinks
		// the bottom-anchored overlay from full-height to one row and the transcript
		// behind it becomes readable (#47). The overlay stays focused and in the
		// stack, so Ctrl+] still routes here to expand.
		const collapsedRender = (_width: number): string[] => [
			theme.fg("dim", ` ${t("hint.expand_line", COLLAPSED_HINT)} `),
		];

		const owner = this;
		this.component = {
			get focused() {
				return owner._focused;
			},
			set focused(value: boolean) {
				owner._focused = value;
				owner.syncDiscussionFocus();
			},
			render: (width) => {
				if (this.state.collapsed) return collapsedRender(width);
				if (this.state.discussionOpenTab != null) return this.renderDiscussion(width);
				return built.render(width);
			},
			invalidate: () => {
				built.invalidate();
				this.discussionInput.invalidate();
			},
			handleInput: (data) => this.dispatch(data),
		};

		this.viewAdapter.apply(this.state);
	}

	dispatch(data: string): void {
		if (this.inputEditorOpen) return;
		if (
			typeof this.collapseKey === "string" &&
			this.collapseKey !== "off" &&
			matchesKey(data, this.collapseKey as Parameters<typeof matchesKey>[1])
		) {
			if (!isKeyRelease(data) && !isKeyRepeat(data)) this.commit({ kind: "toggle_collapsed" });
			return;
		}
		if (this.state.discussionOpenTab != null && !this.state.collapsed) {
			this.dispatchDiscussion(data);
			return;
		}
		const action = routeKey(data, this.state, this.runtime());
		if (action.kind === "ignore") {
			this.handleIgnoreInline(data);
			return;
		}
		this.commit(action);
	}

	private commit(action: QuestionnaireAction): void {
		const result = reduce(this.state, action, this.applyContext());
		this.state = result.state;
		for (const effect of result.effects) this.runEffect(effect);
		this.state = this.mirrorNotesDraft(this.state);
		this.syncDiscussionInputFromState();
		this.syncDiscussionFocus();
		this.viewAdapter.apply(this.state);
	}

	private mirrorNotesDraft(s: QuestionnaireState): QuestionnaireState {
		const draft = this.notesInput.getText();
		return s.notesDraft === draft ? s : { ...s, notesDraft: draft };
	}

	private runEffect(effect: Effect): void {
		switch (effect.kind) {
			case "set_input_buffer":
				this.inlineInput.setText(effect.value);
				return;
			case "clear_input_buffer":
				this.inlineInput.setText("");
				return;
			case "open_input_editor":
				if (this.inputEditorOpen) return;
				this.inputEditorOpen = true;
				void this.editInput(effect.value).then(
					(value) => {
						this.inputEditorOpen = false;
						if (value !== undefined) this.commit({ kind: "input_replace", value });
					},
					() => {
						// The host callback reports launch errors; retain the draft and restore input handling.
						this.inputEditorOpen = false;
					},
				);
				return;
			case "set_notes_value":
				this.notesInput.setText(effect.value);
				return;
			case "set_notes_focused":
				this.notesInput.focused = effect.focused;
				return;
			case "forward_notes_keystroke":
				this.notesInput.handleInput(effect.data);
				return;
			case "set_overlay_hidden":
				// No-op until `setOverlayHandle` has been called (the handle arrives via
				// `ctx.ui.custom`'s `onHandle` right after the overlay is shown).
				this.overlayHandle?.setHidden(effect.hidden);
				return;
			case "done":
				this.done(effect.result);
				return;
		}
	}

	/**
	 * Per-keystroke `ignore` fast path: delegates text editing to Pi's headless
	 * multiline `Editor`, including paste, undo, cursor movement, and configured
	 * `tui.input.newLine` handling. `viewAdapter.apply` then projects its public
	 * text/cursor state without a reducer round-trip.
	 */
	private handleIgnoreInline(data: string): void {
		if (!this.state.inputMode) return;
		this.inlineInput.handleInput(data);
		this.viewAdapter.apply(this.state);
	}

	private dispatchDiscussion(data: string): void {
		const discussion = this.currentDiscussion();
		if (discussion.running) {
			if (this.keybindings.matches(data, "tui.select.cancel")) this.discussionTurnController?.abort();
			return;
		}

		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			this.discussionInputFocused = !this.discussionInputFocused;
			this.syncDiscussionFocus();
			this.tui.requestRender();
			return;
		}

		if (this.discussionInputFocused) {
			if (this.keybindings.matches(data, "tui.select.cancel")) {
				this.commit({ kind: "discussion_back" });
				return;
			}
			if (this.keybindings.matches(data, "tui.input.newLine")) {
				this.discussionInput.handleInput(data);
				this.commit({ kind: "discussion_draft", value: this.discussionInput.getText() });
				return;
			}
			if (this.keybindings.matches(data, "app.editor.external")) {
				this.openDiscussionEditor();
				return;
			}
			if (this.keybindings.matches(data, "tui.select.confirm")) {
				this.startDiscussionTurn();
				return;
			}
			this.discussionInput.handleInput(data);
			this.commit({ kind: "discussion_draft", value: this.discussionInput.getText() });
			return;
		}

		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.discussionInputFocused = true;
			this.syncDiscussionFocus();
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.discussionActionIndex = (this.discussionActionIndex + DISCUSSION_ACTIONS.length - 1) % DISCUSSION_ACTIONS.length;
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.discussionActionIndex = (this.discussionActionIndex + 1) % DISCUSSION_ACTIONS.length;
			this.tui.requestRender();
			return;
		}
		if (!this.keybindings.matches(data, "tui.select.confirm")) return;
		switch (this.discussionActionIndex) {
			case 0:
				this.discussionInputFocused = true;
				this.syncDiscussionFocus();
				this.startDiscussionTurn();
				return;
			case 1:
				this.discussionInputFocused = true;
				this.commit({ kind: "discussion_back" });
				return;
			case 2:
				this.commit({ kind: "discussion_handoff", reason: DISCUSSION_HANDOFF_REASON });
				return;
		}
	}

	private currentDiscussion(): QuestionDiscussionState {
		const tab = this.state.discussionOpenTab ?? this.state.currentTab;
		return this.state.discussionsByTab?.get(tab) ?? emptyQuestionDiscussion();
	}

	private syncDiscussionInputFromState(): void {
		if (this.state.discussionOpenTab == null) return;
		const draft = this.currentDiscussion().draft;
		if (this.discussionInput.getText() !== draft) this.discussionInput.setText(draft);
	}

	private syncDiscussionFocus(): void {
		this.discussionInput.focused =
			this._focused && this.state.discussionOpenTab != null && this.discussionInputFocused && !this.currentDiscussion().running;
	}

	private openDiscussionEditor(): void {
		if (this.inputEditorOpen) return;
		this.inputEditorOpen = true;
		void this.editInput(this.discussionInput.getText()).then(
			(value) => {
				this.inputEditorOpen = false;
				if (value === undefined) return;
				this.discussionInput.setText(value);
				this.commit({ kind: "discussion_draft", value });
			},
			() => {
				this.inputEditorOpen = false;
			},
		);
	}

	private startDiscussionTurn(): void {
		const questionIndex = this.state.discussionOpenTab;
		if (questionIndex == null) return;
		const question = this.questions[questionIndex];
		const userPrompt = this.discussionInput.getText();
		if (!question || userPrompt.trim().length === 0 || this.currentDiscussion().running) return;
		if (!this.runDiscussion) {
			this.commit({ kind: "discussion_failure", error: "Discussion agent is unavailable" });
			return;
		}
		this.commit({ kind: "discussion_draft", value: userPrompt });
		this.commit({ kind: "discussion_start" });
		const controller = new AbortController();
		const turnId = ++this.discussionTurnId;
		this.discussionTurnController = controller;
		void this.runDiscussion({
			questionIndex,
			question: question.question,
			options: question.options,
			userPrompt,
			transcript: this.currentDiscussion().transcript,
			signal: controller.signal,
			onActivity: (message) => {
				if (turnId === this.discussionTurnId) this.commit({ kind: "discussion_activity", message });
			},
		}).then(
			(result) => {
				if (turnId !== this.discussionTurnId) return;
				this.commit({
					kind: "discussion_success",
					response: result.response,
					usage: result.usage,
					...(result.truncated ? { truncated: true } : {}),
				});
			},
			(error) => {
				if (turnId !== this.discussionTurnId) return;
				if (controller.signal.aborted) this.commit({ kind: "discussion_cancel" });
				else this.commit({ kind: "discussion_failure", error: error instanceof Error ? error.message : String(error) });
			},
		).finally(() => {
			if (turnId === this.discussionTurnId) this.discussionTurnController = undefined;
		});
	}

	private renderDiscussion(width: number): string[] {
		const w = Math.max(1, width);
		const questionIndex = this.state.discussionOpenTab ?? this.state.currentTab;
		const question = this.questions[questionIndex];
		const discussion = this.currentDiscussion();
		const border = this.theme.fg("accent", "─".repeat(w));
		const wrap = (text: string, indent = " ") => {
			const available = Math.max(1, w - visibleWidth(indent));
			return wrapTextWithAnsi(text, available).map((line) => truncateToWidth(`${indent}${line}`, w, ""));
		};
		const questionContext: string[] = [];
		if (question) {
			questionContext.push(...wrap(this.theme.bold(question.question)));
			for (let index = 0; index < question.options.length; index++) {
				const option = question.options[index]!;
				questionContext.push(
					...wrap(
						this.theme.fg("muted", `${index + 1}. ${option.label} — ${option.description}`),
						"  ",
					),
				);
			}
		}
		const top: string[] = [
			border,
			...wrap(this.theme.bold(t("discussion.heading", "Discuss this question"))),
			...questionContext,
			"",
		];

		const middle: string[] = [];
		if (discussion.transcript.length === 0) {
			middle.push(...wrap(this.theme.fg("dim", t("discussion.empty", "No discussion yet."))));
		}
		for (const message of discussion.transcript) {
			const label =
				message.role === "user"
					? t("discussion.you", "You")
					: t("discussion.agent", "Discussion agent");
			const color = message.role === "user" ? "accent" : "text";
			middle.push(...wrap(this.theme.fg(color, `${label}: ${message.text}`)));
		}
		if (discussion.running) {
			const activity = discussion.activity.at(-1) ?? "Working";
			middle.push(
				...wrap(
					this.theme.fg(
						"warning",
						`◌ ${activity} — ${t("discussion.running_cancel", "Esc cancels this turn")}`,
					),
				),
			);
		}
		if (discussion.error) {
			const errorText =
				discussion.error === "Turn cancelled"
					? t("discussion.cancelled", "Turn cancelled")
					: discussion.error;
			middle.push(
				...wrap(this.theme.fg("error", `${t("discussion.error", "Error")}: ${errorText}`)),
			);
		}
		middle.push("");

		const input: string[] = [
			...wrap(this.theme.fg("muted", t("discussion.input_label", "Your clarification:"))),
			...this.discussionInput.render(Math.max(1, w - 2)).map((line) => truncateToWidth(` ${line}`, w, "")),
		];
		const actionLabels = [
			t("discussion.send", "Send"),
			t("discussion.back", "Back to question"),
			t("discussion.continue", "Continue in chat"),
		] as const;
		const actions = DISCUSSION_ACTIONS.map((_action, index) => {
			const selected = !this.discussionInputFocused && index === this.discussionActionIndex;
			const unavailable = discussion.running || (index === 0 && discussion.draft.trim().length === 0);
			const label = actionLabels[index]!;
			const unavailableLabel = t("discussion.unavailable", "unavailable");
			const text = `${selected ? "❯" : " "} ${label}${unavailable ? ` (${unavailableLabel})` : ""}`;
			return truncateToWidth(
				selected ? this.theme.fg("accent", this.theme.bold(text)) : this.theme.fg(unavailable ? "dim" : "text", text),
				w,
				"",
			);
		});
		const bottom = [
			...input,
			...actions,
			truncateToWidth(
				this.theme.fg(
					"dim",
					t(
						"discussion.hint",
						"Enter send/select · Shift+Enter newline · Tab actions · Ctrl+G editor · Esc back/cancel",
					),
				),
				w,
				"…",
			),
			border,
		];
		const terminalRows = Math.max(1, this.tui.terminal.rows);
		let lines = [...top, ...middle, ...bottom];
		if (lines.length > terminalRows) {
			const overflowMarker = this.theme.fg("dim", "… earlier discussion hidden …");
			if (top.length + bottom.length + 1 > terminalRows) {
				// Extremely short terminals cannot show every region. Preserve the border,
				// heading, original question, and the action/footer tail rather than
				// dropping all question context with a blind tail slice.
				const essentialTop = [border, ...questionContext];
				const topCount = Math.min(3, essentialTop.length, terminalRows);
				const bottomCount = Math.max(0, terminalRows - topCount);
				lines = [
					...essentialTop.slice(0, topCount),
					...(bottomCount > 0 ? bottom.slice(-bottomCount) : []),
				];
			} else {
				const room = Math.max(0, terminalRows - top.length - bottom.length - 1);
				lines = [...top, overflowMarker, ...middle.slice(-room), ...bottom];
			}
		}
		return lines.map((line) => truncateToWidth(line, w, ""));
	}

	private runtime(): QuestionnaireRuntime {
		const cursor = this.inlineInput.getCursor();
		const lastLine = this.inlineInput.getLines().length - 1;
		return {
			keybindings: this.keybindings,
			inputBuffer: this.inlineInput.getText(),
			canMoveInputUp: cursor.line > 0,
			canMoveInputDown: cursor.line < lastLine,
			questions: this.questions,
			isMulti: this.isMulti,
			currentItem: this.currentItem(),
			items: this.itemsByTab[this.state.currentTab] ?? [],
			collapseKey: this.collapseKey,
		};
	}

	private applyContext(): ApplyContext {
		return {
			questions: this.questions,
			itemsByTab: this.itemsByTab,
		};
	}

	private currentItem(): WrappingSelectItem | undefined {
		const arr = this.itemsByTab[this.state.currentTab] ?? [];
		return this.state.optionIndex < arr.length ? arr[this.state.optionIndex] : undefined;
	}

	/**
	 * Setter for the overlay handle, called by `ctx.ui.custom`'s `onHandle` callback once
	 * the TUI has created the overlay. Until this is called, `set_overlay_hidden` effects
	 * are no-ops — the session still tracks `state.collapsed` for the view layer.
	 */
	setOverlayHandle(handle: OverlayHandle): void {
		this.overlayHandle = handle;
	}

	/**
	 * Public toggle used by the raw terminal input listener registered in `execute()`.
	 * pi-tui does not route input to a hidden overlay's `component.handleInput`, so the
	 * raw listener (which fires for terminal data regardless of overlay visibility)
	 * reaches the session through this method instead of the dispatch path. Routed
	 * through `commit` so the transition stays in the reducer and the overlay hide
	 * happens via the `set_overlay_hidden` effect like every other side effect.
	 */
	toggleCollapsedExternal(): void {
		if (!this.inputEditorOpen) this.commit({ kind: "toggle_collapsed" });
	}

	/** Stop an in-flight child turn during questionnaire close, reload, or session shutdown. */
	dispose(): void {
		this.discussionTurnController?.abort();
	}
}
