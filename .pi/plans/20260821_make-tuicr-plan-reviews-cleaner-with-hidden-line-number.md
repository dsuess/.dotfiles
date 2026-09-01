# Clean Up Tuicr Plan Reviews

## Context

Plan-mode review currently launches tuicr 0.19.1 with an isolated `pi-plan-review-neutral-additions` theme. The theme correctly neutralizes tuicr's all-added file-annotation background, but its generic dark palette and fallback syntax highlighting produce the visually noisy result in the supplied screenshot.

Tuicr 0.19.1 has no setting or command that disables the line-number gutter. Its unified renderer always emits line numbers using the shared `fg_dim` theme color, and the version's documented config contains no line-number visibility option ([renderer source](https://raw.githubusercontent.com/agavra/tuicr/v0.19.1/src/ui/diff_unified.rs), [configuration reference](https://raw.githubusercontent.com/agavra/tuicr/v0.19.1/docs/CONFIG.md)). The accepted solution is therefore presentation-only: make `fg_dim` equal the Mocha panel background so numbers disappear visually. Tuicr will still reserve the blank gutter, and other text that uses the same dim token can also disappear. This tradeoff is limited to the disposable plan-review configuration and does not affect normal tuicr sessions.

The revised theme will use the Catppuccin Mocha palette already used by the repository's status bar, while retaining neutral foreground/background values for additions because `--file` models the plan as an all-added diff. A small plan-review-specific TextMate theme will cover Markdown syntax with Mocha colors rather than copying the full upstream general-purpose syntax theme. No domain glossary or ADR is warranted: this is an isolated, reversible presentation choice.

## Questions & Answers

| Question | Answer |
|---|---|
| Tuicr 0.19.1 cannot disable its line-number gutter; which result do you want? | Visually hide (Recommended). |

## Approach

Replace the generic review-only presentation resources with a cohesive Catppuccin Mocha treatment, preserve tuicr's isolated review/session safety boundaries, and lock the intended visual behavior into focused tests and documentation.

### Part A — Restyle isolated plan reviews
- **Ledger:** {"status":"completed","note":"Restyled the isolated review theme and added a private Markdown syntax resource; preserved launch, isolation, and comment lifecycle behavior.","evidence":"`PI_PACKAGE_ROOT=/opt/homebrew/Cellar/pi-coding-agent/0.84.2/libexec/lib/node_modules/@earendil-works/pi-coding-agent npm --prefix pi/agent/extensions/plan-mode run check` passed (138 tests plus smoke/integration/palette/TUI checks). Focused tuicr review test passed (17 tests). `plutil -lint` passed for the new tmTheme; direct tuicr startup reached session creation without theme/syntax diagnostics (interactive visual confirmation is unavailable because this sandbox has no TTY). `~/.pi/agent/extensions` resolves to this repository, and the installed resource matches the source. `./install.sh config` was attempted but stopped while removing protected unrelated ~/.zshrc/~.bashrc links."}

Rework `tuicr-plan-review-theme.toml` around canonical Mocha base, surface, text, and accent colors. Keep `diff_add_bg` and `syntax_add_bg` on the Mocha base and use normal Mocha text for additions so the whole Markdown plan does not appear green. Set the shared dim foreground to the base color to visually hide line numbers, accepting the documented blank-gutter and shared-dim side effects. Use Mocha accents consistently for focus, cursor, comments, status, warnings, errors, and other chrome.

Add a compact Markdown-oriented `.tmTheme` resource for headings, emphasis, links, inline/code blocks, lists, quotes, and punctuation, and reference it from the tuicr TOML. Extend `prepareIsolatedConfiguration` in `tuicr-plan-review.ts` to install both resources into each private XDG config root before launch. Rename the internal theme identifier if needed so its purpose reflects the Mocha presentation rather than the old generic palette; keep the command's `--file`, `--theme`, and `--no-update-check` behavior and all snapshot immutability, session isolation, comment extraction, and terminal restoration behavior unchanged.

Update the focused review tests to assert the selected theme name, neutral all-added colors, hidden-number color relationship, syntax-theme reference, and presence of both isolated resources. Update the plan-mode README to describe the Mocha review treatment and the intentional visual-hiding limitation instead of claiming a generic bundled dark palette. Deploy through `./install.sh config` so the new resource is managed through the existing Stow workflow. This Part is accepted when plan review opens with a Mocha-like Markdown palette, no visible line-number digits, no full-screen green addition tint, and unchanged review/comment lifecycle behavior.

## Critical Files

- `pi/agent/extensions/plan-mode/tuicr-plan-review-theme.toml` — review-only tuicr UI palette and neutral-addition treatment.
- `pi/agent/extensions/plan-mode/tuicr-plan-review.ts` — isolated resource installation and exact tuicr launch contract.
- `pi/agent/extensions/plan-mode/test/tuicr-plan-review.test.mjs` — regression boundary for launch, isolation, resources, and review behavior.

## Verification

Regression checks run the plan-mode package's `npm run check` and confirm snapshot/canonical-plan immutability, private XDG storage, comment normalization, failure cleanup, and terminal stop/start restoration remain green.

New presentation checks verify that the isolated TOML and Markdown syntax theme are both installed, the launch selects the new theme, line-number foreground equals the Mocha panel background, and addition backgrounds remain neutral.

A live interactive smoke review of a representative Markdown plan is the visual canary. Success means Catppuccin Mocha-like headings, emphasis, links, code, borders, and cursor accents; no visible line-number digits; readable plan text; and comments returning to Pi after exit. Visible digits, green full-row tinting, unreadable Markdown, a tuicr theme parse warning, or failure to restore Pi's terminal are failure signals.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Restyle isolated plan reviews
<!-- pi-plan-mode:progress:end -->
