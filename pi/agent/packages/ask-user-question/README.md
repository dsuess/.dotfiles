# Local `ask_user_question` Fork

A locally maintained Pi extension that lets the model ask up to four structured questions instead of guessing. This fork is based on [`@juicesharp/rpiv-ask-user-question` 2.3.1](https://github.com/juicesharp/rpiv-mono/tree/v2.3.1/packages/rpiv-ask-user-question), retains its MIT license and attribution, and adds in-question clarification with a tool-capable child Pi agent.

See [FORK.md](./FORK.md) for provenance, maintenance, and update instructions.

## Deployment

The package lives at `pi/agent/packages/ask-user-question` in the dotfiles repository. `pi/agent/settings.json` loads it through the local source `packages/ask-user-question`; the upstream npm package may remain installed in Pi's package-manager store but is not loaded.

Deploy only through GNU Stow:

```sh
./install.sh config
```

The installer stows `pi/` into `~/.pi`, then installs production dependencies for local packages. Do not copy the package or create links manually.

## Questionnaire flow

Every question renders in this order:

1. 2-4 model-authored choices
2. **Discuss this** (extension-owned)
3. **Type something.** (extension-owned)
4. **Next** for multi-select questions only

`Discuss this` and the other sentinel labels are reserved and must not be authored by the model.

Selecting **Discuss this** opens a panel tied to that question. It preserves answers, checkbox selections, notes, custom drafts, preview focus, tab position, and collapse state. The panel supports repeated multiline clarification turns and shows bounded child activity, responses, retryable errors, and three explicit actions:

- **Send** — ask another clarification.
- **Back to question** — restore the unchanged structured question.
- **Continue in chat** — close the entire questionnaire and enqueue one contextual normal-chat user continuation. This is a handoff, not a cancellation.

The discussion agent may explain or recommend, but it cannot select, rewrite, or dismiss the authored choices.

## Child-agent capabilities, cost, and safety

Each clarification turn runs in an isolated ephemeral Pi child process with:

- the current model and thinking level;
- the effective parent system instructions;
- bounded compaction-aware parent conversation context;
- the current working directory and inherited whole-process sandbox;
- the parent's active child-compatible capabilities, in their current order.

All active compatible capabilities are inherited, including mutation-capable tools such as `edit`, `write`, or `bash` when they are active. The fork does **not** add a read-only policy or a second confirmation layer. It removes only questionnaire recursion, subagent delegation, and parent planning/workflow completion tools. Planning-mode restrictions remain effective because the child inherits the already-active tool set and system instructions.

Child model usage and cost are aggregated onto the `ask_user_question` tool result and therefore count in Pi's normal session totals. Discussion context and output are bounded; truncation is marked in both the panel and result metadata. Prompt files are mode `0600`, live in a temporary directory under the current workspace, and are removed after every turn.

An active child is terminated on turn cancellation, questionnaire close, reload, session shutdown, or provider failure. The clarification draft remains available after cancellation or error, and **Back to question** / **Continue in chat** remain available.

## Keyboard

### Structured question

- `↑` / `↓`: move between rows
- `Enter`: select or activate the focused row
- `Space`: toggle a multi-select option; suppressed on **Discuss this**, custom input, and **Next**
- `n`: edit per-question notes
- `Tab` / `Shift+Tab`: switch question tabs (only outside discussion)
- `Ctrl+]`: collapse or reopen the questionnaire (configurable)
- `Esc`: cancel the questionnaire

### Discussion panel

- `Enter`: send a clarification or activate the focused action
- `Shift+Enter`: newline
- `Tab` / `Shift+Tab`: move between input and actions
- `↑` / `↓`: navigate actions
- `Ctrl+G`: round-trip the clarification draft through Pi's external editor
- `Esc`: cancel a running child turn; otherwise return focus from actions or go back to the question

The panel propagates focus to Pi's multiline `Editor` for IME positioning, clips every line to terminal width, and keeps its total height within the terminal. Existing side-by-side/stacked previews, overflow scrolling, and collapse behavior are unchanged when the structured question is visible.

## Host behavior

- **Terminal TUI:** persistent discussion panel inside the questionnaire shell.
- **RPC / ACP native dialogs:** repeated clarification turns through select/input dialogs, with the response or error shown in the next dialog; users can return, ask again, or continue in chat.
- **Non-interactive:** `ask_user_question` is removed from the active tool list.

## Configuration

Optional settings remain at `~/.config/rpiv-ask-user-question/config.json`:

| Setting | Default | Purpose |
| --- | --- | --- |
| `collapseKey` | `"ctrl+]"` | Collapse/reopen shortcut; `"off"` disables it. |
| `guidance.promptSnippet` | built in | One-line model guidance. |
| `guidance.promptGuidelines` | 5 built-in lines | Full model usage guidance. |

## Reference

- [Tool schema and results](./docs/tool-schema.md)
- [Keyboard and layout](./docs/keyboard.md)
- [Hosts and runtime behavior](./docs/hosts.md)
- [Configuration](./docs/configuration.md)
- [Localization](./docs/localization.md)

## Requirements

- Node.js 22+
- Pi 0.82.1-compatible extension APIs
- A configured model/provider and authentication for discussion turns
- An interactive terminal or RPC/ACP host

## License

MIT. The original copyright and license are retained in [LICENSE](./LICENSE).
