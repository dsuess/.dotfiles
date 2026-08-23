# Local `ask_user_question` Fork

A locally maintained Pi extension for asking up to four structured questions. It is based on [`@juicesharp/rpiv-ask-user-question` 2.3.1](https://github.com/juicesharp/rpiv-mono/tree/v2.3.1/packages/rpiv-ask-user-question), retains its MIT license and attribution, and adds persisted clarification threads.

See [FORK.md](./FORK.md) for provenance and maintenance.

## Deployment

The package lives at `pi/agent/packages/ask-user-question`. `pi/agent/settings.json` loads that local source. Deploy only through Stow:

```sh
./install.sh config
```

Do not copy the package or create links manually.

## Questionnaire flow

Each question renders, in order:

1. 2–4 authored choices
2. **Discuss this**
3. **Type something.**
4. **Next** for multi-select questions

These labels are reserved. The model cannot author them.

### Terminal discussion threads

In a terminal, selecting **Discuss this** suspends the questionnaire TUI and opens a normal interactive Pi child session. The child is persisted under Pi's normal session tree with `parentSession` provenance, and one child is retained for each question. Selecting **Discuss this** again resumes that child.

The child inherits the effective parent system instructions, model, thinking level, trust decision, cwd, sandbox, and already-active compatible tools. It excludes questionnaire recursion, subagent delegation, and parent workflow-completion tools. Parent session identity variables are removed before launch.

Use `/resolve [optional outcome]` inside the child to return to the still-active questionnaire. Without text, Pi classifies the latest observable assistant response. Ctrl+D or another ordinary child exit leaves the questionnaire unchanged. The resolver makes one bounded, no-workspace-tool classification call with the child model. Invalid output or provider failure becomes context-only.

After `/resolve`, the ordinary question dialog shows a bounded outcome. Context-only results do not choose an answer. A valid complete option, multi-option set, or custom answer is preselected in the existing controls, but is never submitted automatically: press Enter or Next to confirm, or select something else.

Child conversation and resolver usage are aggregated into the final `ask_user_question` tool result. Only bounded observable text is returned; thinking and images are excluded. The temporary file used to transfer the parent system prompt is private and removed after the child exits.

### Hosts

- **Terminal TUI:** persisted native child thread and `/resolve` return.
- **RPC / ACP:** **Discuss this** immediately returns the existing non-cancelled normal-chat handoff. It does not open a nested terminal or a select/input discussion loop.
- **Non-interactive:** the tool is removed from the model tool list.

## Keyboard

### Structured questions

- `↑` / `↓`: move between rows
- `Enter`: select, open **Discuss this**, or commit text
- `Space`: toggle a multi-select option
- `n`: edit a per-question note
- `Tab` / `Shift+Tab`: switch question tabs
- `Ctrl+]`: collapse or reopen the questionnaire
- `Esc`: cancel the questionnaire

Inside a child thread, use Pi's normal chat controls. `/resolve` is the only path that returns a result to the questionnaire.

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
- Pi 0.84.2-compatible extension APIs
- A configured model/provider and authentication for terminal child threads
- An interactive terminal or RPC/ACP host

## License

MIT. The original copyright and license remain in [LICENSE](./LICENSE).
