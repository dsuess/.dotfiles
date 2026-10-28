# Remove manual Pi host-adapter provenance checks

## Context

The user requested removal of manual host-adapter checks after Pi reported a startup failure for Ketch tools and `ask_user_question`.

The routing extension treats all manifest entries as startup requirements. It also compares host-adapter metadata against manually maintained package paths and source labels.

Host extensions already run with host permissions. This change retains the known adapter names, core SRT provenance checks, controller readiness checks, and routed MCP approval requirements.

Implementation and verification are complete. This document records the change before the requested commit.

## Approach

Replace manual host-adapter provenance checks with admission by known tool name. Keep optional adapter availability independent of startup readiness. Commit only the changes for this request, with this plan document.

### Part A — Remove manual host-adapter checks
- **Ledger:** {"status":"completed","note":null,"evidence":"Implementation and documentation updated; 24 focused tests passed; real normal Pi startup published ok:true; full gate attempted and its remaining failures recorded."}

Admit registered known host adapters by name. Remove package provenance fields and matching helpers from the adapter manifest. Omit missing optional adapters from the active tool set instead of failing startup. Apply the behavior to normal startup and retained off-mode reloads.

Add regression coverage for missing adapters, changed adapter metadata, callable adapters, and retained off-mode reloads. Preserve checks for unknown tools, source-spoofed core replacements, and unapproved MCP tools. Update the security contract and repository development instructions.

Acceptance: the new regression cases pass and a real normal Pi launch publishes a successful routing handshake.

### Part B — Commit only this change
- **Ledger:** {"status":"pending","note":null,"evidence":null}

Commit the routing implementation, regression tests, relevant documentation hunks, and this plan document. Preserve unrelated working-tree changes, including filesystem-grant edits and the existing shared-agent access plan.

Acceptance: review the staged diff, run `git diff --cached --check`, create the commit, and inspect its file list and remaining working-tree changes.

## Verification

- The initial new regression cases failed before implementation.
- Sixteen host-adapter and routed-tool tests passed after implementation.
- Eight focused extension tests passed, including startup, optional adapters, off-mode reload, core provenance, connection failure, and MCP admission.
- A real launcher invocation in RPC mode completed a successful routing handshake without a model request.
- `git diff --check` and `git diff --cached --check` passed.
- `npm --prefix pi run check` ran but did not pass. The SRT stage reported eight failures involving MCP fixture compatibility, a missing Visonic checkout, and controller readiness. The full gate did not reach native verification.
- No broad deployment is necessary: existing Stow links resolve to the edited repository files.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Remove manual host-adapter checks
- ☐ Commit only this change
<!-- pi-plan-mode:progress:end -->
