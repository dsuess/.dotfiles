# Add Shared Filesystem Grants to the Pi Sandbox

## Context

Normal Pi tools run under a controller-built SRT policy. The controller dynamically grants the canonical workspace, linked-worktree metadata when needed, reviewed host configuration files, and installed tool roots. It does not currently load persistent filesystem grants: `controller.mjs` passes `grants: []`, so `~/.agents/` is blocked even though it contains shared skills used by the host-side Pi runtime.

Add a small, versioned, checked-in configuration at `pi/sandbox/config.json`, deployed by the existing Pi Stow package to `~/.pi/sandbox/config.json`. Its initial filesystem configuration will grant `~/.agents` read-only and leave the read-write list empty. The proposed shape is deliberately narrow:

```json
{
  "version": 1,
  "filesystem": {
    "readOnly": ["~/.agents"],
    "readWrite": []
  }
}
```

A read-write grant means both read and write access. Entries identify existing directories, accept absolute paths or `~/...`, and are canonicalized by trusted host-side startup code before entering the SRT policy. Because Stow-managed shared directories can contain lexical paths or symlinks whose canonical targets are elsewhere, policy construction must preserve the explicitly configured access path while validating its canonical target; otherwise granting only the canonical dotfiles target would not make `~/.agents/...` traversable. Both forms remain bounded to the configured directory, and protected credential/runtime roots remain non-grantable.

This intentionally changes the current documented decision that controller policy has no persistent settings. It does not restore the retired editable `/sandbox` settings UI, dynamic permission lifetimes, sidecar mounts, ingress, or live policy reloads. `/sandbox` remains read-only but should report the effective configured filesystem grants. Configuration changes take effect on the next normal Pi launch; including the configuration bytes in controller generation identity ensures that launch retires a controller built from stale grants.

No domain glossary or `CONTEXT.md` is warranted: this is a security-policy configuration change, not a domain-language decision. No ADR is warranted because the format is small and reversible, but operator and maintainer documentation must explain the explicit trust boundary. Preserve the unrelated existing modification to `pi/agent/settings.json`.

## Approach

Implement a strict host-side configuration boundary, feed its validated output into the immutable startup policy, and make the effective grants observable without turning `/sandbox` into a mutation surface.

### Part A — Load and validate persistent filesystem grants
- **Ledger:** {"status":"completed","note":"Implemented checked-in strict grant configuration, host-side loader, lexical/canonical SRT policy grants, RW read implication, status payload, and source digest input.","evidence":"Added pi/sandbox/config.json and filesystem-grants.mjs; node --test pi/sandbox/test-filesystem-grants.mjs passes (4/4)."}

Add a dedicated configuration loader beside the controller code. It will require the versioned, exact-key schema, bounded unique arrays, and existing directories. Expand only `~` and `~/...`; reject relative paths, NULs, unsupported access values, duplicate canonical entries, overlapping read-only/read-write entries, whole-root or whole-home access, active-workspace overlap, controller/broker state, and existing protected credential/runtime roots such as `.pi`, `.ssh`, `.docker`, `.sbx`, cloud credentials, and uv credentials. Invalid or missing checked-in configuration must fail controller startup rather than silently reducing or widening access.

Resolve and validate grants on the trusted host before SRT initialization. Retain the configured lexical directory and canonical target as needed for Stow/symlink traversal, while ensuring neither form escapes the validated boundary. Feed read-only grants into `allowRead`; feed read-write grants into both `allowRead` and `allowWrite`. Do not add them to `allowCompleteWorkspaceWrites`, sidecar mounts, PATH, generated HOME, or environment forwarding.

Include `config.json` and the loader in the controller source/configuration digest. A subsequent Pi launch after a config change must reject the old controller state and start a policy generation derived from the new validated grants. Keep capabilities and status free of config contents beyond canonical grant paths and access modes.

Acceptance outcomes: a routed read of a file below `~/.agents` succeeds; writes there remain denied; a configured read-write fixture supports both operations; and prohibited, malformed, duplicate, or overlapping entries stop startup before tools activate.

### Part B — Expose effective grants and align the security contract
- **Ledger:** {"status":"completed","note":"Added effective grant display to read-only /sandbox and updated Pi sandbox security contract documentation.","evidence":"node --test pi/agent/extensions/srt-tool-routing/sandbox-status.test.mjs passes; status test asserts read-only/read-write rendering."}

Extend controller status with the effective canonical filesystem grants and render them in the read-only `/sandbox` status output. Do not expose a settings editor, reload action, arbitrary grant operation, or model-writable control channel. The status should make read-only versus read-write authority clear and continue to direct Docker lifecycle management to `pi-sbx`.

Update `pi/sandbox/README.md` and `pi/AGENTS.md` to replace the conflicting claims that policy has no persistent configuration. Document that the controller still derives one immutable policy at startup, but incorporates the validated checked-in shared-path configuration; changes apply through a later normal launch/controller replacement, not live reload. Document lexical/symlink handling, protected roots, the distinction between tool-plane grants and Docker sidecar mounts, and the initial read-only `~/.agents` grant.

Acceptance outcomes: `/sandbox` reports the active grants without reading or editing the config itself, and documentation no longer claims that persistent filesystem grants are unsupported.

### Part C — Verify startup, policy enforcement, and deployment behavior
- **Ledger:** {"status":"in_progress","note":"Running focused checks, deployment, required repository gates, and final diff review.","evidence":null}

Add focused loader and policy tests for schema strictness, home expansion, canonical duplicate detection, protected roots, workspace/controller overlap, read-write implying read access, and lexical Stow-style aliases. Extend controller lifecycle tests to prove config bytes affect controller identity and stale controllers are replaced on a later launch. Add routed/native coverage that reads an actual skill through the `~/.agents` path and proves the same path is not writable.

Extend status tests for effective grant rendering and retained read-only command behavior. Run the sandbox package suite, the deterministic repository gate, deploy only through `./install.sh config`, and then run the full Pi gate from an ordinary host terminal. Review the final diff and `git diff --check`, preserving the unrelated settings change and committing the generated plan document with the implementation.

## Critical Files

- `pi/sandbox/config.json` and a new loader module — checked-in schema, path expansion, canonical validation, and initial `~/.agents` read-only grant.
- `pi/sandbox/client.mjs`, `controller.mjs`, and `srt-policy.mjs` — configuration generation identity, startup loading, and immutable SRT read/write policy composition.
- `pi/agent/extensions/srt-tool-routing/status-view.ts` — read-only display of effective grants.
- `pi/sandbox/README.md` and `pi/AGENTS.md` — operator and maintainer security contract.
- `pi/sandbox/test-*.mjs` and routing status tests — deterministic and native regression boundaries.

## Verification

**Regression checks**

- Existing workspace writes, tool-root reads, controller/broker denial, credential denial, routed tools, child attachment, and sidecar behavior continue to pass.
- `/sandbox` remains read-only and does not create, edit, reload, or reset policy or sidecar state.
- A config-only change invalidates stale controller reuse without changing workspace identity or exposing host-native tools.

**New behavior scenarios**

- `read` can load `~/.agents/skills/grill-with-docs/SKILL.md` through the routed tool path after deployment.
- A routed write below `~/.agents` fails under the initial read-only grant.
- A temporary configured read-write directory can be read and written but does not gain complete-workspace write exceptions or Docker visibility.
- Missing, malformed, unknown-key, duplicate, overlapping, nonexistent, credential-root, whole-home, workspace, and controller-state grants fail closed with bounded diagnostics.

**Required gates**

- Run the focused sandbox tests, then `npm --prefix pi run check:deterministic`.
- Deploy with `./install.sh config` only.
- Run `npm --prefix pi run check` from an ordinary host terminal, followed by `git diff --check` and a final changed-file review.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Load and validate persistent filesystem grants
- ☑ Expose effective grants and align the security contract
- ▶ Verify startup, policy enforcement, and deployment behavior
<!-- pi-plan-mode:progress:end -->
