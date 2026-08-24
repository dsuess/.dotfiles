# Bridge Skills and Clipboard Images into Gondolin

## Context

Pi skill discovery and Gondolin tool access are separate concerns. Host Pi already discovers shared skills from `~/.agents/skills`—both as a built-in global location and through the existing `agent/settings.json` entry—and advertises host-absolute `SKILL.md` paths to the model. The sandboxed `read` tool then resolves those paths inside the guest, where the host-home alias does not exist. Changing only the configured skill directory would not reliably solve this: Pi still auto-discovers `~/.agents/skills`, and the current sandbox canonicalizes ordinary external mounts, while the model needs the original lexical path that Pi advertised. Pi’s documented workflow explicitly expects the model to load a skill with `read`, so the host and guest must agree on that path ([Pi skills documentation](https://raw.githubusercontent.com/earendil-works/pi/v0.84.2/packages/coding-agent/docs/skills.md)).

“Pasted image” means an image that Pi itself extracts from the clipboard and represents as a `pi-clipboard-<uuid>.<ext>` path. Pi currently creates that file under `os.tmpdir()` ([upstream clipboard implementation](https://sourcegraph.com/github.com/earendil-works/pi/-/blob/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2937-L2939)); the launcher gives host Pi `TMPDIR=/tmp`, but the guest has an unrelated `/tmp`. Setting all of host Pi’s `TMPDIR` to a shared directory would expose unrelated host temporary files, so the bridge should move only validated clipboard images.

The proposed boundary is two narrow, code-enforced, read-only guest mounts:

- Canonical host `~/.agents/skills` at the exact lexical guest path Pi advertises, such as `/Users/dsuess/.agents/skills`.
- Secure host `/tmp/pi` at exact guest path `/tmp/pi`.

These are trusted host-to-guest resources, not user-managed `externalMounts`. General external-mount overlap and canonicalization rules remain unchanged. The skill alias may resolve into the active dotfiles workspace; that narrowly scoped read-only alias is safe because the workspace already grants access to its own files, while unrelated workspaces gain only read access. `/tmp/pi` remains read-only in the guest; the trusted host extension alone places clipboard files there. Explicit `--yolo` launches remain unaffected.

Accepted risks are limited to normal temporary-file lifetime under `/tmp` and the existing fact that the active dotfiles workspace can modify its own `agents/skills` source through the workspace path. No credentials, general host temporary files, or Pi state become guest-readable.

## Approach

Implement the fix at the host/guest boundary rather than changing Pi’s valid discovery configuration. The sandbox policy will expose only the two trusted resource roots at the exact paths shown to the model, while the host routing extension will relocate only validated Pi clipboard images before an agent turn. Tests and documentation will keep these aliases narrow, read-only, and independent from user-managed external mounts.

### Part A — Add lexical read-only resource mounts
- **Ledger:** {"status":"blocked","note":"Implementation is blocked by the active Gondolin policy.","evidence":"A direct write to /Users/dsuess/.dotfiles/pi/sandbox/policy.mjs was denied: write denied by protected-path policy. The policy treats the active dotfiles workspace's pi/ control-plane directory as protected, so all planned code, test, and documentation files under pi/ cannot be modified from this sandboxed session."}

Extend the sandbox policy with narrowly defined resource mounts that preserve separate canonical host and lexical guest paths. Resolve the host skill root safely, mount it at the original `~/.agents/skills` host-home spelling when present, and omit it cleanly when absent. Securely create or validate `/tmp/pi` as a real directory owned by the current user with private permissions, rejecting symlinks, non-directories, or unsafe ownership instead of following them.

Mount both resources through `ReadonlyProvider`, include them in policy generation and controller status, and retain their exact guest aliases (`/Users/.../.agents/skills` and `/tmp/pi`) even when macOS canonicalizes their host sources to another path. Do not weaken ordinary `externalMounts` validation, expose custom guest destinations, or make either resource editable through `/sandbox`.

Acceptance outcomes:

- A `SKILL.md` path copied verbatim from Pi’s available-skills prompt is readable by sandbox tools in any workspace.
- Skill helper files referenced relative to `SKILL.md` resolve through the same alias.
- `/tmp/pi` is visible to sandbox tools but rejects guest writes.
- Missing or unsafe resource roots fail with deliberate, tested behavior; no broad home or `/tmp` mount is introduced.

### Part B — Route only Pi clipboard images into the bridge
- **Ledger:** {"status":"blocked","note":"The host routing extension is under the same protected pi/ control-plane root.","evidence":"Part B requires pi/agent/extensions/gondolin-sandbox/index.ts. The active policy's protected-path error for pi/sandbox/policy.mjs establishes that this pi/ control-plane tree is intentionally non-writable from the current sandboxed session; attempting a second write would not change the result."}

Add a small host-side clipboard bridge to the existing `gondolin-sandbox` extension. On Pi’s `input` event, inspect submitted text for Pi-generated clipboard image paths directly under the launcher’s host `/tmp`. Validate the basename pattern, supported image extension, and regular-file status; reject symlinks and leave arbitrary paths untouched. Move each validated image atomically into `/tmp/pi` and return transformed input containing the new path before file-reference expansion and the agent turn begin.

Keep the bridge inert outside `PI_GONDOLIN_SANDBOX=1`. Handle multiple pasted images, missing files, collisions, and failed moves without rewriting text to a nonexistent destination. Preserve the current host `TMPDIR=/tmp`; do not expose Pi bash logs, editor scratch files, or other temporary content. Use the existing random clipboard filename rather than introducing a new user-visible attachment syntax.

Acceptance outcomes:

- Pasting an image submits `/tmp/pi/pi-clipboard-….<ext>` and the sandboxed `read` tool can consume it as an image.
- Multiple clipboard images are all bridged.
- Ordinary image paths and spoofed, unsupported, missing, or symlinked `pi-clipboard-*` paths are not moved.
- A bridge failure is observable and never silently produces a broken replacement path.

### Part C — Document and lock in the path contract
- **Ledger:** {"status":"blocked","note":"The documentation and invariant files are also inside the protected pi/ root.","evidence":"Part C requires pi/sandbox/README.md and pi/AGENTS.md. Both are inside the control-plane directory denied by the active workspace protected-path policy. No files were changed and tests cannot validate unimplemented work."}

Update the Gondolin filesystem documentation to distinguish discovered host resources, lexical guest aliases, and editable external mounts. Document `/tmp/pi` as the clipboard-image bridge and explain why it is read-only in the guest. Record a Pi repository invariant that paths advertised to the model for shared skills and clipboard images must remain directly resolvable by sandbox tools.

Keep `agent/settings.json` unchanged: its existing skill entry is valid for host discovery, and changing it would address the wrong boundary. Preserve the plan document generated for this work in the implementation commit, as required by the repository workflow.

## Critical Files

- `pi/sandbox/policy.mjs` — constructs trusted mounts, enforces host-path safety, and preserves lexical guest aliases.
- `pi/agent/extensions/gondolin-sandbox/index.ts` and a focused bridge helper — run the host input transformation without widening tool authority.
- `pi/sandbox/test-policy.mjs` and `pi/agent/extensions/gondolin-sandbox/index.test.mjs` — define policy and clipboard-transform regressions.
- `pi/sandbox/README.md` and `pi/AGENTS.md` — document the resource boundary and durable path invariant.
- `agent/settings.json` — read-only reference confirming host skill discovery already targets `~/.agents/skills`.

## Verification

Regression checks:

- Run the Gondolin unit, extension, wrapper, repository, and Ketch-config suite with `npm --prefix pi/sandbox test`.
- Run `npm --prefix pi/sandbox run test:native` for the real QEMU/controller/tool inventory boundary.
- Confirm existing external-mount overlap rejection, protected workspace writes, fail-closed routing, planning children, and `--yolo` behavior remain unchanged.

New-feature scenarios:

- Policy tests use a symlinked `~/.agents/skills` source and a canonicalizing temp root, then verify the guest keys retain the lexical paths and both providers reject writes.
- Extension tests cover one and multiple clipboard images plus missing files, unsupported extensions, symlinks, unrelated paths, move failure, and unsandboxed mode.
- A native canary launched from a workspace outside the dotfiles repository reads a shared `SKILL.md` through the exact system-prompt path, reads a bridged PNG through `/tmp/pi`, and fails attempts to write either mount.
- After deployment with `./install.sh config`, start normal sandboxed Pi, paste a real screenshot, and verify the submitted path begins with `/tmp/pi/pi-clipboard-`, the `read` tool receives image content, and `/sandbox` reports both read-only resource mounts.

Failure signals include any advertised `/Users/.../.agents/skills` path remaining inaccessible, `/tmp/pi` resolving only as `/private/tmp/pi`, guest writes succeeding, non-clipboard temp files becoming visible, arbitrary pasted paths being moved, or a normal launch falling back to host built-ins.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ⛔ Add lexical read-only resource mounts
- ⛔ Route only Pi clipboard images into the bridge
- ⛔ Document and lock in the path contract
<!-- pi-plan-mode:progress:end -->
