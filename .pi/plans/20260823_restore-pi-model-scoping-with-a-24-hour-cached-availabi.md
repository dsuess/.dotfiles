# Restore a Cached Preferred Pi Model Scope

## Context

Pi’s documented `enabledModels` setting is a model **scope**, not a hard security allowlist. It limits normal model selection and cycling to matching authenticated models while explicit CLI model choices can still take precedence. The repository previously added a launcher preflight that started `pi --list-models` before every real session, intersected that catalog with `enabledModels`, and passed the result through `--models`. The recent startup optimization correctly removed that duplicate process and delegated scope resolution to Pi, but the current working-tree edit also removes `enabledModels` from `pi/agent/settings.json`. Native scope resolution then has no preferred list, while restoring static entries alone would produce a warning for every preferred provider that is not authenticated.

Use one cached, non-interactive Pi catalog refresh to retain availability-aware scoping without restoring the per-launch cost. “Available” will mean that Pi itself reports the model through a configured direct provider. “Registered provider” is too broad in Pi terminology because built-in and extension providers can be registered without usable credentials; the cache key will instead track credential-provider identity and relevant model configuration. A successful `/login` or `/logout` that changes the configured provider set will invalidate the cache on the next launcher invocation. The cache is lazy rather than timer-driven: the first eligible launch after 24 hours refreshes it.

The preferred direct routes are `openai-codex` and `openai` for GPT, `zai` for GLM, and `anthropic` for Claude. Gateway duplicates through OpenRouter and OpenCode are excluded. The exact preferred families are:

- `glm-5.2` and `glm-5.3` (not `glm-5.2-highspeed`)
- `gpt-5.6-luna`, `gpt-5.6-terra`, and `gpt-5.6-sol`
- `claude-fable-5`, `claude-opus-5`, and `claude-sonnet-5`, plus `claude-haiku-4-5` because the installed Pi catalog has no Claude Haiku 5 ID

The current machine’s authoritative `pi --list-models` output exposes the three GPT 5.6 models through `openai-codex` and both requested GLM models through `zai`; `auth.json` currently has those two providers. Anthropic is not currently authenticated, although Pi 0.84.2’s installed direct catalog contains Fable, Opus, Sonnet, and Haiku 4.5. The current custom command palette conflicts with Pi’s scope semantics: its selector and Ctrl+`.`/Ctrl+Shift+`.` cycle actions enumerate `ctx.modelRegistry.getAvailable()` instead of the documented `ctx.scopedModels`, so they can bypass any restored scope.

Preserve the user’s current `defaultModel: "gpt-5.6-sol"` working-tree change and all unrelated dirty files. The implementation must restore only the requested scope behavior around that current state. This reversible cache and UI correction does not warrant an ADR or glossary document.

## Questions & Answers

| Question | Answer |
|---|---|
| Which models constitute the Claude group? | Use Claude 5 Fable, Opus, and Sonnet, and also add Haiku. Because Pi 0.84.2 has no Haiku 5 ID, use `claude-haiku-4-5`. |
| Which provider routes should qualify? | Use direct routes only; do not add OpenCode or OpenRouter duplicates. |
| How should availability be discovered without paying for a second Pi process on every startup? | Use Pi itself to find available models, cache the result, rebuild it every 24 hours, and invalidate it when login adds a provider. |
| What should happen when no preferred provider group is available? | Preserve normal Pi fallback and authentication guidance rather than stopping the launch. |

## Approach

Keep `enabledModels` as the canonical, reviewable preferred-model configuration. Add a small cache boundary that periodically obtains Pi’s authenticated catalog, then let the normal Pi process remain the final authority when resolving the selected `--models` scope. Do not query vendor endpoints independently or infer model entitlement solely from credential-file presence.

### Part A — Add cached authoritative model-scope discovery
- **Ledger:** {"status":"completed","note":"Restored the ordered direct-provider preferred scope, added a schema-versioned/private/atomic 24-hour catalog cache with source and credential-provider invalidation plus stale/fallback policy, and integrated sanitized bounded metadata discovery after controller acquisition with CLI precedence preserved.","evidence":"bash -n bin/pi; node --check pi/sandbox/model-scope-cache.mjs; live sanitized helper refresh returned exactly openai-codex Luna/Terra/Sol and zai GLM-5.2/5.3; generated cache was mode 0600 in a 0700 directory and stored only source hashes, provider/type identities, timestamps, and catalog IDs."}

Restore `enabledModels` in `pi/agent/settings.json` with exact provider-qualified IDs for the selected direct routes, including both OpenAI direct provider IDs, the two Z.ai models, the three Claude 5 IDs, and Haiku 4.5. Preserve the current implementation and planning defaults and all unrelated settings.

Add a focused helper under `pi/sandbox/` that reads the configured preferred IDs, obtains a full authenticated catalog from the real Pi executable on a cache miss, validates and parses the tabular `--list-models` result, and returns the preferred IDs that actually occur in that catalog while retaining settings order. The metadata invocation must use `--models "*"` so the configured scope does not filter its own discovery. Because only built-in direct routes and `models.json` routes qualify, disable extension and unrelated resource discovery for this metadata invocation; it must create no persistent session, make no model request, expose no tools, and receive the launcher’s sanitized environment.

Store only schema-versioned metadata, source fingerprints, timestamps, provider/model IDs, and credential provider names/types under a private `~/.cache/pi-gondolin/` boundary. Never persist credential values. Use a 24-hour TTL, bounded parsing, private permissions, and atomic replacement so concurrent launches cannot observe partial JSON. Invalidate a fresh cache when the real Pi executable revision changes, `models.json` changes, or the sorted credential provider/type set changes; adding or removing a provider through `/login` or `/logout` therefore forces discovery on the next launch without invalidating on ordinary OAuth token refreshes. Reject malformed or future-dated cache records.

Integrate the helper after the Gondolin controller lease is healthy but before the real session process starts. This preserves the existing rule that a missing or corrupt controller/image stops the launch before any Pi metadata preflight. On a warm cache, start only the normal Pi process. On a cache refresh, allow one bounded ephemeral metadata Pi process followed by the normal process. Explicit `--models` remains authoritative and skips automatic discovery; `--list-models`, help/version, package commands, and `--yolo` retain their existing special paths. A full-list command must remain unscoped. If refresh fails with a stale cache from the same source fingerprint, use that stale catalog and warn once; if there is no trustworthy cache or the provider fingerprint changed, omit the injected scope and preserve Pi’s normal fallback/authentication behavior.

Acceptance outcomes: the current credentials produce exactly the three `openai-codex` GPT entries and two `zai` GLM entries; unavailable Anthropic and OpenAI-direct routes produce no normal-startup no-match warnings; a cache hit does not start a metadata Pi process; a cache older than 24 hours refreshes; and adding an Anthropic credential makes all four requested Claude entries eligible on the next launch.

### Part B — Make custom model controls honor the session scope
- **Ledger:** {"status":"completed","note":"Command palette selection and both cycle directions now consume one session-scope-aware model list, with registry fallback only for an empty/no scope and deterministic outside-scope cycle entry.","evidence":"Loaded command-palette.ts and the new helper through Pi's jiti runtime; a scoped fixture returned only scoped models and backward cycling from an out-of-scope active model selected the final scoped model."}

Refactor the command palette’s model-list selection into a small testable boundary that uses `ctx.scopedModels.map(entry => entry.model)` whenever the session has a scope and falls back to `ctx.modelRegistry.getAvailable()` only when no scope exists. Apply the same ordered list to “Select Model,” forward cycling, and backward cycling so the custom palette matches Pi’s built-in `/model`, completion, and cycling semantics.

Preserve current-model-first sorting in the selector when the current model is in scope. If an explicit CLI model is active outside the automatic scope, forward cycling must enter at the first scoped model and backward cycling at the last, rather than using the current negative-index behavior. Do not turn the preferred scope into a hard ban: explicit model selection and plan-mode’s existing default routing remain higher-level behaviors.

Acceptance outcomes: the command palette exposes only the five models currently selected by the cached scope, cycles deterministically within that set, and reverts to the full authenticated registry only in the documented no-scope fallback case.

### Part C — Lock in cache, launcher, and scope behavior
- **Ledger:** {"status":"completed","note":"Added deterministic cache, launcher, and palette tests; documented the cache lifecycle; deployed via Stow; verified live scoped startup, full-list bypass, performance, and native Gondolin behavior.","evidence":"Focused cache 10/10, palette 6/6, wrapper pass; complete non-native sandbox suite pass; plan-mode 139/139 after making its implementation-default assertion follow settings; subagent 29/29; ask-user-question 594/594; native sandbox suite pass. Live RPC scope contained exactly Codex Luna/Terra/Sol and Z.ai GLM-5.2/5.3. Five-sample warm-cache benchmark reported metadata_pi_launch=0 and real_pi_launch=1 for all measured samples; forced refresh was 1877.8 ms with 2 Pi processes versus 1340.9 ms and 1 process warm."}

Add deterministic tests for cache hits, 24-hour expiry, provider-set invalidation, Pi/models configuration invalidation, malformed output, atomic cache records, stale-on-transient-failure behavior, and no-cache fallback. Extend the wrapper fixture to distinguish metadata and session Pi invocations and to prove that a warm launch invokes Pi once, a refresh invokes it twice, a new provider credential refreshes immediately, preferred entries retain configured order, unrelated catalog models are excluded, and explicit scopes/full-list commands bypass automatic scoping. Preserve controller/image failure, argument quoting, environment filtering, tool routing, plan-mode priority, and signal/lease cleanup assertions.

Add focused command-palette tests for scoped selection, no-scope fallback, selector ordering, and both cycle directions when the active model is inside or outside the scope. Update `pi/sandbox/README.md` so the startup contract no longer claims an unconditional single Pi process: normal warm-cache startup uses one process, while a bounded metadata process can run at most once per 24-hour/source-fingerprint interval. Document the cache location, invalidation inputs, direct-provider limitation, fallback behavior, and the fact that login invalidation takes effect on the next launch. Keep the approved plan document in the implementation commit as required by the repository workflow.

## Critical Files

- `pi/agent/settings.json` — canonical ordered preferred-model scope; preserve the current default-model edits.
- `bin/pi` — explicit-CLI precedence, cached-scope injection, sanitized metadata execution, and controller-before-preflight ordering.
- `pi/sandbox/model-scope-cache.mjs` — bounded cache schema, fingerprints, TTL, catalog refresh, intersection, and fallback policy.
- `pi/agent/extensions/command-palette.ts` — custom selector and cycle behavior that must consume `ctx.scopedModels`.
- `pi/sandbox/test-wrapper.sh` and focused cache/palette tests — process-count, invalidation, precedence, and scope regressions.
- `pi/sandbox/README.md` — authoritative startup and cache lifecycle documentation.

## Verification

**New-feature scenarios:** With the current `openai-codex` and `zai` credentials, verify a normal session’s `/model`, command-palette selector, and Ctrl+`.` cycling expose only GPT 5.6 Luna/Terra/Sol and GLM 5.2/5.3. Verify the first missing/stale-cache launch records one metadata invocation and one normal invocation, while the next launch records only the normal invocation. Age the cache beyond 24 hours and confirm one refresh. Add an Anthropic provider fixture without aging the cache and confirm provider-fingerprint invalidation plus Fable, Opus, Sonnet, and Haiku 4.5. Confirm cache files contain no credential values and have private, atomically written state.

**Regression checks:** Run the focused Node cache and command-palette tests, `npm --prefix pi/sandbox run test:wrapper`, the complete non-native sandbox suite, plan-mode tests, and Bash/diff checks. Prove explicit `--models` is unchanged, `--list-models` still prints the complete authenticated catalog, plan and implementation defaults remain independent, and controller/image/handshake failures remain fail-closed. Confirm cache refresh failures either use a same-fingerprint stale catalog or fall back to native Pi behavior without blocking startup.

**Performance checks:** Run the existing startup benchmark from an unsandboxed terminal with at least five samples after clearing the catalog cache once. The untimed warm-up may perform the metadata refresh; measured warm-cache samples must report one normal Pi launch and remain near the post-optimization baseline. Record a separate forced-refresh observation to ensure the bounded daily refresh is materially cheaper than the former every-launch preflight. Finally run the required native sandbox suite; if QEMU or host prerequisites prevent it, report that limitation explicitly rather than claiming full verification.

<!-- pi-plan-mode:progress:start -->
## Part Progress

<!-- Generated by Pi plan mode. Do not edit. -->

- ☑ Add cached authoritative model-scope discovery
- ☑ Make custom model controls honor the session scope
- ☑ Lock in cache, launcher, and scope behavior
<!-- pi-plan-mode:progress:end -->
