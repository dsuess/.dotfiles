# Label Herdr worktree spaces with repository and checkout names

## Context

Herdr currently derives an ordinary workspace label from the Git checkout root, so `/Users/dsuess/src/visonic/ad20-polishing` appears only as `ad20-polishing`. The existing Space row then shows the branch separately. This loses the shared repository identity in a flat list of independently opened worktrees.

The Visonic layout uses an embedded bare repository at `visonic/.bare` and linked checkouts such as `dev` and `ad20-polishing`. For these checkouts, `git rev-parse --git-dir` and `--git-common-dir` differ, while the common directory identifies the shared `visonic` repository.

Herdr 0.8.2 supports local plugins, `workspace.created` event hooks, startup hooks, and workspace rename commands. Its plugin context supplies the workspace ID and working directory. This permits a small local plugin to rename only linked-worktree spaces without changing normal repository spaces or requiring users to adopt Herdr-managed worktree groups. Herdr’s built-in sidebar tokens do not include a repository-name token; custom metadata would require the same automation while duplicating the visible workspace name, so renaming is the simpler fit. See the [Herdr configuration reference](https://raw.githubusercontent.com/herdrdev/herdr/v0.8.2/docs/next/website/src/content/docs/configuration.mdx), [plugin documentation](https://raw.githubusercontent.com/herdrdev/herdr/v0.8.2/docs/next/website/src/content/docs/plugins.mdx), and [plugin context implementation](https://raw.githubusercontent.com/herdrdev/herdr/v0.8.2/src/app/api/plugins/context.rs).

The installed client is 0.8.2, but the live server is still 0.8.0 and protocol-incompatible with the client. Implementation must not stop that server automatically because doing so exits its panes. Automated tests can validate the feature without touching the live session; final visual verification requires a user-controlled Herdr restart.

No domain glossary or ADR change is warranted: this is a reversible presentation convention, not a domain-model or architectural decision.

## Questions & Answers

| Question | Answer |
|---|---|
| How should worktrees from the same repository appear in Herdr’s Spaces bar? | Flat repo / checkout: for example, `visonic / dev` and `visonic / ad20-polishing`, while retaining the branch and Git status on the second row. |

## Approach

Use a repository-owned local Herdr plugin rather than native worktree grouping. The plugin will derive a stable display label from Git’s worktree metadata and rename eligible spaces to `<repository> / <checkout>`. Existing `ui.sidebar.spaces.rows = [["state_icon", "workspace"], ["branch", "git_status"]]` remains unchanged, so branch and ahead/behind status continue to render as they do now.

### Part A — Implement worktree-aware workspace labeling
- **Ledger:** {"status":"completed","note":"Implemented the dependency-free local Node plugin and manifest with startup and workspace.created hooks.","evidence":"`node --check herdr/plugins/worktree-label/index.js` passed; logic compares Git and common directories, preserves manual labels, and invokes Herdr through argv arrays."}

Add a small dependency-free Node plugin under the ignored `herdr/plugins/` source boundary, with a valid Herdr manifest and one script used by both startup and workspace lifecycle hooks.

For each candidate workspace, resolve its effective workspace CWD, ask Git for the checkout root, Git directory, and common Git directory, and label it only when the Git directory differs from the common directory. Derive the checkout component from the checkout root basename and the repository component from the common directory: use the parent directory for embedded `.bare` and conventional `.git` layouts, matching Herdr’s own repository-name convention. Preserve spaces and punctuation by using argument arrays rather than shell interpolation.

Apply the rename when the current label is still the automatic checkout basename or already equals the derived label. Preserve any unrelated manually assigned workspace name. Skip non-Git directories, ordinary single-checkout repositories, detached worktrees with a valid checkout path, missing/deleted paths, and Git command failures without affecting Herdr startup. Make repeated runs idempotent.

Handle newly created spaces from the event context and restored spaces from the startup hook. Startup processing should enumerate current workspaces and resolve each workspace’s active pane/CWD through Herdr’s JSON CLI, while lifecycle processing should prefer the event’s `workspace_cwd`. Keep failures isolated per workspace so one stale space cannot block the remainder.

Acceptance outcome: Visonic’s linked checkouts become `visonic / dev` and `visonic / ad20-polishing`; `.dotfiles` and other ordinary repositories retain their existing labels; a manual custom name remains unchanged.

### Part B — Register the local plugin through the dotfiles installer
- **Ledger:** {"status":"completed","note":"Registered the local plugin from the config deployment path without contacting the running server.","evidence":"`bash -n install.sh` passed. The installer resolves `$SCRIPT_DIR/herdr/plugins/worktree-label`, requires Herdr/Node/Git, and links it enabled through an intentionally offline socket so stale server protocols cannot interrupt deployment."}

Extend `install.sh` so `./install.sh config` links and enables the repository-owned plugin through `herdr plugin link`, using its resolved absolute source path. Keep registration idempotent and repair a stale registration if the dotfiles checkout moves. Do not create manual symlinks; continue to let Stow deploy `herdr/config.toml`, while `herdr/.stow-local-ignore` keeps plugin source out of the config target.

Require only tools already mandatory on the supported configuration path: Herdr, Node, and Git. Do not add npm dependencies or alter the existing sidebar layout. Do not stop or restart a running Herdr server from the installer.

Acceptance outcome: a fresh config deployment registers the plugin, and repeated deployments neither duplicate registration nor disable it.

### Part C — Add focused regression coverage and deployment guidance
- **Ledger:** {"status":"completed","note":"Added regression/integration coverage and deployed the registration without touching the live Herdr server.","evidence":"`node --test herdr/plugins/worktree-label/test/index.test.js` passed (4/4); `bash -n install.sh` passed; `./install.sh config` registered the plugin offline; repeated offline link plus `herdr plugin list --plugin worktree-label --json` reported exactly one enabled local plugin at `/Users/dsuess/.dotfiles/herdr/plugins/worktree-label`; `stow -nvvv herdr -t ~/.config/herdr` listed only `.gitignore` and `config.toml`, not `plugins/`."}

Add Node built-in tests around label derivation and rename policy. Cover an embedded `.bare` repository with multiple linked worktrees, nested workspace CWDs, a normal repository, non-Git paths, already-correct labels, manual labels, paths containing spaces, and Git failures. Add a lightweight fake-Herdr integration test for startup enumeration and event-driven rename invocation so JSON/API assumptions are checked without requiring a live session.

Record the current client/server version mismatch in the completion guidance. Deploy through `./install.sh config`, but leave the active Herdr server running. Explain that the user must restart Herdr when convenient for the 0.8.2 server and plugin startup hook to take effect; stopping the current server would terminate its panes.

Acceptance outcome: repository tests pass, plugin registration is inspectable without a live compatible server, and the only deferred check is the user-controlled visual smoke test after restart.

## Critical Files

- `herdr/config.toml` — Existing Space-row presentation; remains the boundary that displays the renamed workspace and existing branch/status line.
- `herdr/plugins/worktree-label/` — New local plugin manifest, labeling implementation, and focused tests.
- `herdr/.stow-local-ignore` — Keeps local plugin source from being stowed into `~/.config/herdr`; verify the existing `plugins` exclusion remains effective.
- `install.sh` — Registers and enables the local plugin through Herdr during config deployment.
- `.pi/plans/` — The canonical plan document must be committed with the implementation per repository policy.

## Verification

- **Regression checks:** run the plugin’s Node test suite and `bash -n install.sh`; confirm normal repositories and manual workspace names are not renamed.
- **New-feature scenarios:** create temporary standard and embedded-bare Git fixtures in tests; verify linked checkouts derive `<repo> / <checkout>` from both checkout-root and nested CWD inputs.
- **Installer check:** run the narrow plugin-registration path or `./install.sh config` as appropriate, then inspect `herdr plugin list --plugin <plugin-id> --json` for one enabled local plugin pointing at the current dotfiles checkout.
- **Configuration check:** use a Stow dry run to confirm plugin source remains excluded and `config.toml` remains the only Herdr config payload.
- **Visual smoke test after user-controlled restart:** confirm the Spaces bar shows `visonic / dev` and `visonic / ad20-polishing`, keeps each branch/status row, and leaves `.dotfiles` unchanged. Failure signals are a protocol-mismatch response, absent plugin startup log, a stale plugin path, or any ordinary repository/manual label being rewritten.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Implement worktree-aware workspace labeling
- ☑ Register the local plugin through the dotfiles installer
- ☑ Add focused regression coverage and deployment guidance
<!-- pi-plan-mode:progress:end -->
