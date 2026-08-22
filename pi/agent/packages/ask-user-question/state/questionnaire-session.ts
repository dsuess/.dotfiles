import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import type { DiscussionForkResult } from "../discussion/runtime.js";
import { emptyDiscussionUsage, type DiscussionThread } from "../discussion/types.js";
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
  multiSelect: boolean;
  thread?: DiscussionThread;
  lastConsumedResolutionId?: string;
  signal: AbortSignal;
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
  /** Launch or resume the question's persisted interactive child thread. */
  runDiscussion?: (request: QuestionnaireDiscussionRequest) => Promise<DiscussionForkResult>;
}

export interface QuestionnaireSessionComponent {
  focused: boolean;
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
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
    discussionsByTab: new Map(),
    notesDraft: "",
    collapsed: false,
  };
}

/**
 * Owns only the ordinary questionnaire controls. Selecting Discuss this starts
 * one asynchronous fork effect; the child takes over the terminal, then this
 * unchanged overlay is rendered again with an optional outcome/suggestion.
 */
export class QuestionnaireSession {
  private state: QuestionnaireState = initialState();
  private readonly questions: readonly QuestionData[];
  private readonly isMulti: boolean;
  private readonly itemsByTab: WrappingSelectItem[][];
  private readonly notesInput: Editor;
  private readonly inlineInput: Editor;
  private readonly viewAdapter: QuestionnairePropsAdapter;
  private readonly keybindings: QuestionnaireRuntime["keybindings"];
  private readonly editInput: QuestionnaireSessionConfig["editInput"];
  private readonly runDiscussion: QuestionnaireSessionConfig["runDiscussion"];
  private readonly collapseKey: string;
  private inputEditorOpen = false;
  private discussionController: AbortController | undefined;
  private discussionLaunchId = 0;
  private _focused = false;
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

    const owner = this;
    this.component = {
      get focused() {
        return owner._focused;
      },
      set focused(value: boolean) {
        owner._focused = value;
      },
      render: (width) =>
        this.state.collapsed ? [config.theme.fg("dim", ` ${t("hint.expand_line", COLLAPSED_HINT)} `)] : built.render(width),
      invalidate: () => built.invalidate(),
      handleInput: (data) => this.dispatch(data),
    };
    this.viewAdapter.apply(this.state);
  }

  dispatch(data: string): void {
    if (this.inputEditorOpen) return;
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
    this.viewAdapter.apply(this.state);
  }

  private mirrorNotesDraft(state: QuestionnaireState): QuestionnaireState {
    const draft = this.notesInput.getText();
    return state.notesDraft === draft ? state : { ...state, notesDraft: draft };
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
        this.overlayHandle?.setHidden(effect.hidden);
        return;
      case "launch_discussion":
        this.startDiscussion(effect.questionIndex);
        return;
      case "done":
        this.done(effect.result);
        return;
    }
  }

  private handleIgnoreInline(data: string): void {
    if (!this.state.inputMode) return;
    this.inlineInput.handleInput(data);
    this.viewAdapter.apply(this.state);
  }

  private startDiscussion(questionIndex: number): void {
    const question = this.questions[questionIndex];
    const discussion = this.state.discussionsByTab?.get(questionIndex);
    if (!question || !discussion?.launching) return;
    if (!this.runDiscussion) {
      this.commit({ kind: "discussion_finished", usage: emptyDiscussionUsage(), error: "Discussion child is unavailable." });
      return;
    }
    this.discussionController?.abort();
    const controller = new AbortController();
    const launchId = ++this.discussionLaunchId;
    this.discussionController = controller;
    void this.runDiscussion({
      questionIndex,
      question: question.question,
      options: question.options,
      multiSelect: question.multiSelect === true,
      thread: discussion.thread,
      lastConsumedResolutionId: discussion.lastConsumedResolutionId,
      signal: controller.signal,
    }).then(
      (result) => {
        if (launchId !== this.discussionLaunchId) return;
        this.commit({
          kind: "discussion_finished",
          thread: result.thread,
          resolution: result.resolution,
          usage: result.usage,
          error: result.error,
        });
      },
      (error) => {
        if (launchId !== this.discussionLaunchId) return;
        this.commit({
          kind: "discussion_finished",
          usage: discussion.usage,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    ).finally(() => {
      if (launchId === this.discussionLaunchId) this.discussionController = undefined;
    });
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
    return { questions: this.questions, itemsByTab: this.itemsByTab };
  }

  private currentItem(): WrappingSelectItem | undefined {
    const items = this.itemsByTab[this.state.currentTab] ?? [];
    return this.state.optionIndex < items.length ? items[this.state.optionIndex] : undefined;
  }

  setOverlayHandle(handle: OverlayHandle): void {
    this.overlayHandle = handle;
  }

  toggleCollapsedExternal(): void {
    if (!this.inputEditorOpen) this.commit({ kind: "toggle_collapsed" });
  }

  /** Cancel only a child currently being launched; normal child Ctrl+D is unresolved by design. */
  dispose(): void {
    this.discussionController?.abort();
  }
}
