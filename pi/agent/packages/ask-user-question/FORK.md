# Fork provenance and maintenance

## Baseline

- Upstream: [`juicesharp/rpiv-mono`](https://github.com/juicesharp/rpiv-mono)
- Package: `packages/rpiv-ask-user-question`
- Baseline release/tag: `v2.3.1`
- Published package: `@juicesharp/rpiv-ask-user-question@2.3.1`
- Published tarball integrity: `sha512-2FeQ3U3GXLNKBU7BBC2wVdBmoBb7Asb7DIJLw5o2ZsHgRttIHEaZD8kLRCIVAUpmQEsC2xywiEaplvZNqWgZgg==`
- License: MIT; upstream `LICENSE`, authorship, repository metadata, changelog, tests, documentation, and locale history are retained.

The repository imported the complete upstream package tree at that tag, including tests and documentation. The package is private and locally versioned as `2.3.1-local.*`; it is not intended for npm publication.

## Why this fork exists

Upstream 2.3.1 has no embedded clarification-agent lifecycle. This fork adds **Discuss this**, an extension-owned action that keeps the questionnaire active while an isolated tool-capable child Pi agent answers clarification requests. It also adds an explicit non-cancellation handoff to normal chat.

The local source replaces the npm package in `pi/agent/settings.json` so only one `ask_user_question` extension registers. The package-manager copy is not deleted.

## Deployment

The Stow package mirrors `~/.pi/agent/packages/ask-user-question`. Deploy from the dotfiles root only:

```sh
./install.sh config
```

`install.sh` installs local package production dependencies after stowing. `node_modules`, coverage, and temporary test/runtime directories remain untracked.

## Updating from upstream

1. Pick an explicit upstream tag; never follow `main` implicitly.
2. Download the release package/archive and verify its published integrity/checksum.
3. Compare that tag against this fork before copying. Preserve `LICENSE`, provenance, local discussion modules, result additions, tests, docs, and locales.
4. Rebase upstream changes deliberately. Pay particular attention to:
   - `ask-user-question.ts` lifecycle and host routing;
   - `state/` reducer/actions and per-question preservation;
   - `view/` row order, indices, width, focus, and preview logic;
   - `rpc-fallback.ts` semantic parity;
   - tool schema, reserved labels, response envelope, usage accounting, and public events;
   - Pi SDK/TUI API changes.
5. Update this file's baseline, the private local version, lockfile, and compatibility statement.
6. Run `npm install --include=dev`, `npm test`, and `npm run typecheck` in this directory.
7. Run the repository integration/runtime checks and deploy with `./install.sh config`.
8. Confirm `pi list` names only `packages/ask-user-question` for this capability and a runtime smoke registers `ask_user_question` exactly once.

Do not manually modify the npm store, copy files into `~/.pi`, or create symlinks outside Stow.
