# Fork provenance and maintenance

## Baseline

- Upstream: [`juicesharp/rpiv-mono`](https://github.com/juicesharp/rpiv-mono)
- Package: `packages/rpiv-ask-user-question`
- Baseline tag/package: `v2.3.1` / `@juicesharp/rpiv-ask-user-question@2.3.1`
- Published tarball integrity: `sha512-2FeQ3U3GXLNKBU7BBC2wVdBmoBb7Asb7DIJLw5o2ZsHgRttIHEaZD8kLRCIVAUpmQEsC2xywiEaplvZNqWgZgg==`
- License: MIT

The repository imported the complete upstream package tree at that tag. This private local fork is versioned as `2.4.0-local.*` and is not intended for npm publication.

## Local decision: persisted clarification forks

Upstream has no clarification-agent lifecycle. This fork keeps **Discuss this** as a reserved questionnaire row and implements it as a persisted native Pi child session.

The choice is intentionally local and reversible:

- Terminal selection creates or resumes one child session per question. The child forks before the parent `ask_user_question` tool call, so it has valid parent history and no unmatched tool call. Its header records `parentSession` provenance.
- `/resolve [outcome]` exists only in that child. It stores a bounded observable outcome and a no-workspace-tool classification. Normal child exit does not resolve.
- The parent remains blocked until the questionnaire settles. Returned complete suggestions are preselected in normal controls and require Enter or Next; context-only results preserve the user's candidate answer state.
- The child inherits the effective parent model, thinking level, system instructions, trust, cwd, sandbox, and already-active compatible tools. Questionnaire recursion, delegation, parent workflow completion, parent session identity, and Herdr/broker identity are excluded.
- RPC and ACP cannot own a nested terminal child. Their **Discuss this** choice uses the existing non-cancelled normal-chat handoff instead.

This decision is documented here and in the package reference rather than an ADR because it is a narrow, local UX/runtime implementation choice.

## Deployment

The local source replaces the upstream npm package in `pi/agent/settings.json` so one extension registers `ask_user_question`.

```sh
./install.sh config
```

`install.sh` installs local package production dependencies after Stow deploys `pi/`. Do not modify the npm store, copy files into `~/.pi`, or create symlinks outside Stow.

## Updating from upstream

1. Select an explicit upstream tag. Never follow `main` implicitly.
2. Download and verify the release archive or published integrity.
3. Compare before copying. Preserve the local child runtime, resolution contract, tests, documentation, and locale inventory.
4. Reconcile upstream changes deliberately in `ask-user-question.ts`, `state/`, `view/`, `rpc-fallback.ts`, `discussion/`, `tool/`, and `reconcile.ts`.
5. Verify the installed Pi API before changing this code. The current local development pin is Pi `0.84.2`.
6. Run:

   ```sh
   npm --prefix pi/agent/packages/ask-user-question install --include=dev
   npm --prefix pi/agent/packages/ask-user-question test
   npm --prefix pi/agent/packages/ask-user-question run typecheck
   ```

7. Run repository integration/runtime checks, deploy through `./install.sh config`, verify `pi list`, and smoke-test one terminal fork → `/resolve` → confirmation cycle.
