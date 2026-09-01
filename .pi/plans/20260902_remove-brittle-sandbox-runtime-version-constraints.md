# Remove Brittle Sandbox Runtime Pins

## Context

Normal Pi launches disable native built-ins and let `pi/agent/extensions/srt-tool-routing` register routed replacements. The routing extension then admits core tools and selected host adapters only after an inventory check. That check currently combines security provenance with compatibility fingerprints: exact JSON-schema hashes for every replacement and host adapter, exact package versions, and an exact Docker Sandboxes (`sbx`) release and commit.

The reported failure is a compatibility fingerprint failure, not evidence that host Bash took ownership. `host-adapters.ts` uses one generic “not owned” error for both provenance and schema mismatches. The checked-in Bash hash is the Pi 0.84.4 schema (`1ad6…`), while the stack trace came from Pi 0.84.2, whose Bash schema is `4564…`; all other built-in schemas match. This made plan-mode’s post-transition verification fail closed even though the replacement still came from the SRT routing extension. The current tests also expose the drift: `tools.test.mjs` still expects the 0.84.2 Bash hash while the runtime manifest expects 0.84.4.

The accepted scope is to remove **runtime compatibility pins**: tool-schema hashes, host-adapter package-version checks, and exact `sbx` version/commit enforcement. Security identity checks remain. Routed replacements must still come from the canonical SRT extension; host adapters must still match their configured user-scoped canonical source boundary; unknown or source-spoofed tools remain denied. Capability protocol versions, controller source digests, SRT dependency lock and verified patch pre/postimages, and the immutable Docker template digest remain pinned because they protect protocol coherence, patch safety, or artifact identity rather than asserting dependency compatibility. Existing sidecar capability, secret, policy, port, workspace, and ownership checks also remain fail-closed.

Terminology must change with the trust model: after package-version and schema review fingerprints are removed, these are **trusted provenance adapters**, not adapters whose currently installed bytes are proven by an “audited” version/schema tuple. This is a material refinement of ADR 0001’s host/guest boundary and should be documented there rather than creating a separate ADR.

## Questions & Answers

| Question | Answer |
|---|---|
| Which compatibility pins should the plan remove? | Remove runtime pins: tool-schema hashes, host-adapter package-version checks, and exact sbx version/commit checks. Keep source provenance, behavioral canaries, protocol versions, SRT patch safety hashes, and the immutable template digest. |

## Approach

Use provenance for authority and executable behavior checks for compatibility. Do not replace the removed fingerprints with a second version allowlist or silently fall back to host tools.

### Part A — Make tool admission version-independent
- **Ledger:** {"status":"completed","note":"Removed runtime schema/package-version fingerprints, renamed admission to trusted provenance, hardened canonical path checks, and added provenance/version-drift regressions.","evidence":"`node --test pi/agent/extensions/srt-tool-routing/host-adapters.test.mjs pi/agent/extensions/srt-tool-routing/tools.test.mjs pi/agent/extensions/srt-tool-routing/index.test.mjs` passed 22/22. Tests cover Pi 0.84.2/current Bash contracts, Ketch package metadata/source-label version drift, wrong path/package/scope/origin/baseDir, missing/spoofed/unknown tools, and execution blocking."}

Refactor the inventory boundary in `pi/agent/extensions/srt-tool-routing/host-adapters.ts` so routed built-ins are accepted by canonical extension ownership and trusted host adapters by canonical user-scoped source identity, without hashing parameter schemas or reading exact package versions. For package adapters, avoid treating a version-bearing package-manager source label as an authorization pin; identity must still be constrained by the expected package path, package origin, user scope, and base directory. Preserve exact-name allowlisting, required ownership of every routed built-in slot, active-tool filtering, unknown-tool rejection, and the fail-closed execution gate.

Rename code and explanatory language that claims currently installed adapters are “audited” when the surviving guarantee is trusted provenance. Improve inventory diagnostics so a missing or wrong-source replacement is reported as a provenance/ownership failure rather than conflating it with schema drift. Remove obsolete hash/version constants, package reads, cache state, and schema-only tests. Replace them with regressions proving that benign parameter-schema and package-version drift is accepted from the correct source, while wrong path, scope, origin, base directory, missing replacement slots, and unknown tools remain rejected.

Acceptance outcome: both the Pi 0.84.2-shaped and Pi 0.84.4-shaped Bash parameter contracts can be registered by the canonical SRT extension without changing an allowlist, but a same-named Bash tool from any other source cannot become active or execute.

### Part B — Replace the exact sbx release gate with capability checks
- **Ledger:** {"status":"completed","note":"Removed exact sbx release/commit authorization; version is now bounded diagnostic availability, while command results and observable sidecar/Docker contracts remain fail-closed. Tightened the Docker dial check to reject any stdout prefix contamination.","evidence":"`node --test pi/sandbox/test-srt-compatibility-canary.mjs pi/sandbox/test-docker-sidecar.mjs` passed 8/8, covering differing sbx version text, unavailable/empty version diagnostics, auth, policy, MCP, agent/kits/secrets/session/workspace/template/network drift, ports/skills, and Docker dial contamination. `npm --prefix pi/sandbox test` was also attempted inside the active SRT guest: relevant canary/sidecar tests passed, while 13 controller/policy tests failed only on nested-sandbox EPERM or overlong translated Unix-socket paths; host-terminal rerun remains in Part C verification."}

Remove `REQUIRED_SBX_VERSION`, `REQUIRED_SBX_COMMIT`, and exact-release rejection from `pi/sandbox/srt-compatibility-canary.mjs`. Keep `sbx version` as a bounded availability/diagnostic command if useful, but do not parse or authorize by release number or commit. Compatibility must instead be established by the existing commands and observable contracts: daemon health, authentication, diagnostics, disabled SSH-agent forwarding, allow-all dedicated-app policy, empty MCP registry, template inventory, sidecar create/inspect shape, uncontaminated Docker Engine dial, and the private broker path.

Retain the reviewed template digest and all sidecar inspect/ownership checks. A newer `sbx` that preserves required commands and behavior should pass; a release with incompatible command syntax, missing fields, altered policy, extra capabilities/secrets, unexpected ports, wrong template image, or contaminated Docker transport must still fail closed at the relevant capability check. Update deterministic canary tests to accept differing well-formed version output while preserving every security and behavior rejection.

Acceptance outcome: upgrading `sbx` alone no longer requires editing a version/commit constant, while incompatible behavior remains observable and blocks Docker-sidecar use without affecting core SRT file/shell routing.

### Part C — Align the documented security contract and regression gate
- **Ledger:** {"status":"completed","note":"Updated ADR 0001, sandbox operations guidance, Pi development invariants, plan-mode terminology, and the deterministic regression gate. Added dedicated-app authentication diagnostics for policy commands after the native canary exposed an expired-session cooldown.","evidence":"Focused routing/sidecar suite passed 31/31; subagent runtime passed 17/17; ask-user-question runtime passed 5/5; `git diff --check` passed. User ran `./install.sh config`, resolved the dedicated `pi-srt` authentication cooldown with `sbx --app-name pi-srt login`, then confirmed `npm --prefix pi run check` and normal startup, plan transition, and `/sandbox` smoke checks all passed. Unrelated `pi/agent/settings.json` and `oh-my-zsh` changes remain untouched."}

Update ADR 0001 and `pi/sandbox/README.md` to distinguish trusted provenance, behavioral compatibility checks, immutable artifact pins, and protocol/patch integrity. Remove troubleshooting instructions that demand the exact reviewed `sbx` release; direct users to capability diagnostics, dedicated-app authentication, and template availability instead. Preserve the documented `--yolo` escape hatch and normal-launch fail-closed policy.

Keep the repository plan document in the implementation commit as required. Do not modify unrelated runtime-written `pi/agent/settings.json` changes or the unrelated `oh-my-zsh` submodule state.

Acceptance outcome: code, tests, ADR terminology, and operational guidance all state the same policy—dependency versions and tool schemas may evolve, but authority boundaries and security-relevant runtime behavior may not silently drift.

## Critical Files

- `pi/agent/extensions/srt-tool-routing/host-adapters.ts` — trusted provenance and tool-inventory admission boundary.
- `pi/agent/extensions/srt-tool-routing/index.ts` — fail-closed activation and execution enforcement that consumes the inventory decision.
- `pi/sandbox/srt-compatibility-canary.mjs` — Docker Sandboxes capability preflight and disposable canary.
- `pi/sandbox/docker-sidecar.mjs` — read-only reference for retained template, inspect, ownership, and broker safeguards.
- `pi/adr/0001-srt-tool-routing.md` — authoritative host/guest trust decision and consequences.

## Verification

Regression checks must prove that schema/package/release-version drift no longer causes rejection when provenance and behavior remain valid. Add focused inventory cases for an alternate Bash schema and host-package metadata version, and `sbx` cases with differing version text. Failure-path checks must continue to reject source-spoofed or missing core tools, untrusted host adapters, malformed/unavailable `sbx` commands, authentication failures, non-empty MCP registration, restrictive policy drift, unexpected sidecar secrets/capabilities/ports, wrong workspace or template digest, and contaminated Docker dial output.

Run the focused SRT routing and sandbox deterministic suites first. Then deploy only through `./install.sh config` and run the repository-required `npm --prefix pi run check` from an ordinary host terminal, including native SRT/Docker checks. Finally smoke-test a normal Pi startup and a plan-mode transition on the installed current Pi runtime; success is no inventory error, SRT-owned Bash remains active, and `/sandbox` reports healthy routing. Any activation of a host-native built-in, loss of a retained sidecar safeguard, or need to add a new version/schema fingerprint is a failure signal.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Make tool admission version-independent
- ☑ Replace the exact sbx release gate with capability checks
- ☑ Align the documented security contract and regression gate
<!-- pi-plan-mode:progress:end -->
