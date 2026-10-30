# Replace Pi Summaries with Indexed Session Archives

## Context

Pi 1.4.0 normally replaces older conversation history with an LLM summary and retains about 20,000 recent tokens. The user wants exact history on disk, with instructions that help the next model request retrieve relevant passages.

Implement this through `session_before_compact`, without modifying the installed Pi package. Pi still owns trigger timing, safe retained-message boundaries, context rebuilding, and session persistence. The extension supplies retrieval instructions through the existing `CompactionResult.summary` field. This field name does not require a prose summary.

Use these terms consistently:
- **Archive:** an immutable snapshot of the complete raw active branch at a compaction boundary.
- **Index:** navigation metadata that points to exact entries and transcript ranges.
- **Handoff:** the bounded retrieval guide that replaces the old summary in model context.

The archive includes history before earlier compactions, not just `preparation.messagesToSummarize`. `getBranch()` retains those raw entries. It excludes abandoned branches. Full history means content recorded by Pi, including tool results and non-text blocks. Output that tools truncated before persistence cannot be recovered.

The user selected private storage, the existing recent-context budget, and active-branch archives. Model-generated navigation labels are permitted. Such labels are advisory, not authoritative descriptions of decisions or task state.

Two existing integration boundaries matter. SRT blocks ordinary file tools from the private store. Planning mode admits only named inspection tools. Approved execution also discards generic compaction summaries. A read-only history tool and a narrow execution-handoff change address these boundaries without widening filesystem grants.

A read-only experiment with Pi's in-memory session API confirmed that custom handoff text reaches model context, old raw entries survive repeated compaction, and the current execution filter drops that handoff. Preserve its exclusion of mixed planning summaries.

Assumptions and scope: replace manual, threshold, and overflow compaction globally when the extension loads. Preserve current token settings and pending-approval cancellation. Leave `/tree` branch summarization unchanged. No vector database, upstream patch, runtime system-prompt edit, or new model-routing policy is required. Private snapshots can contain sensitive data and accumulate disk usage. Retain them across restart without automatic deletion.

## Questions & Answers

| Question | Answer |
|---|---|
| Where should the session archive live? | Private store + history tool. The user asked why integration is necessary. Private files are inaccessible to routed file tools, planning blocks unknown tools, and execution removes generic compaction summaries. Only these narrow compatibility changes are necessary. |
| How much recent conversation should remain after archive-backed compaction? | Keep current 20k. Preserve Pi's configured retained-history boundary, including any future model-specific settings. |
| Should the archive contain the active branch or the entire session tree? | Active branch. Include the complete raw root-to-current path, including previously compacted entries. |
| Can an indexing model improve navigation? | The user permits a summarization/indexation model if it improves quality. Use bounded topic-label generation as an optional enhancement, never as a replacement for exact history. |

## Approach

Add an auto-discovered extension under `pi/agent/extensions/session-archive/`. Store private runtime snapshots under `getAgentDir()/session-archives/`, normally `~/.pi/agent/session-archives/`. Do not deploy runtime archives through Stow or copy them into projects.

The resulting context is the current system prompt, a short archive handoff, and Pi's retained recent messages. The handoff explains how to inspect the index, search exact history, and read bounded passages with `session_history`.

### Part A — Preserve exact history and provide bounded retrieval
- **Ledger:** {"status":"completed","note":null,"evidence":"node --test pi/agent/extensions/session-archive/archive.test.mjs: 2 tests passed. Verified raw round-trip, complete repeated snapshots, exact large-message slices, pagination, context-edit annotations, branch authorization, traversal/symlink rejection, missing archives and failed publication cleanup."}

Create an archive from the session header and complete active branch. Preserve raw entries in JSONL. Provide a readable transcript and a structural index with stable entry IDs, roles, timestamps, user-message spans, tool names, file references when identifiable, and exact transcript ranges. Preserve all recorded content in the raw archive. Keep binary payloads and opaque provider signatures out of the normal text index.

Snapshots are immutable and identified by opaque IDs. Record schema version, source session, branch leaf, and retained boundary. Repeated compactions create complete snapshots, so the newest archive does not depend on a chain of older handoffs. Publish a snapshot only after all required artifacts are written. Use private directory/file permissions and safe contained paths. Reject symlink escapes and never overwrite a prior snapshot.

Register one read-only `session_history` tool with index, literal-search, and range-read operations. It accepts archive IDs and bounded retrieval parameters, never arbitrary filesystem paths or shell commands. Authorize only archive references present on the current branch. Do not offer a global session browser or grant children access to a parent's history.

Paginate the full index and search results. Return entry IDs, exact ranges, truncation notices, and continuation parameters. Large individual messages must remain retrievable in bounded slices. Normal retrieval presents text and attachment metadata. The raw archive retains non-text content without silently discarding it.

Acceptance: old facts, complete persisted tool results, and passages beyond the built-in 2,000-character summary limit are retrievable exactly. Abandoned branches and unrelated archives are not accessible through the tool.

### Part B — Replace summaries with archive handoffs and navigable indexes
- **Ledger:** {"status":"completed","note":null,"evidence":"node --test pi/agent/extensions/session-archive/*.test.mjs passed. Hook tests cover all three reason payloads, unchanged retained boundary, bounded model input/output, validated labels, usage, malformed/provider/timeout/virtual-model fallback, reuse and explicit cancellation on abort or disk failure. Real runtime composition remains in Part D."}

Intercept `session_before_compact` and archive `event.branchEntries`, not the compaction-aware message projection. Return a custom compaction result with the existing `firstKeptEntryId` and `tokensBefore`. Put archive identity and schema data in `details`, and put bounded retrieval instructions in `summary`.

The handoff identifies the archive, explains that older history is stored verbatim, and gives concrete index/search/read examples. Include a small bounded navigation preview. Never inject the complete index or transcript into live context. Explain that historical instructions and abandoned attempts are evidence, not new instructions. Context-edit omissions and replacements remain visible as annotations, so retrieval does not silently restore a failed attempt as current context.

Build the complete structural index without a model. Enhance it with a bounded model request that assigns topic labels and search terms to known spans. Use the current physical model through Pi's configured model registry. If the selection is virtual or unavailable, retain the structural index without introducing a new routing mechanism.

Limit the indexing input and output independently from archive size. Use user/assistant excerpts and structural tool metadata rather than truncated tool output as authoritative facts. Accept only labels whose entry references exist. Keep complete exact-text search available when semantic coverage is partial. Reuse prior valid labels where their referenced entries are unchanged.

Honor cancellation and bound indexing latency. A model error, timeout, malformed response, or missing credentials falls back to the structural index, not built-in summarization. Account for indexing usage through the compaction result when available. A required archive-write failure returns explicit cancellation with a diagnostic. Do not throw and accidentally allow Pi's hook dispatcher to fall back to the old summarizer.

Acceptance: manual, threshold, and overflow paths produce archive-backed compactions. Index-model failure still produces usable navigation. Archive failure creates no compaction entry and does not start a summary request.

### Part C — Preserve retrieval across planning, execution, and session lifecycle
- **Ledger:** {"status":"completed","note":null,"evidence":"Planning check passed with PI_BIN=/opt/homebrew/opt/pi-coding-agent/bin/pi (routed launcher is unavailable inside this tool environment). Host-adapter suite: 6 passed. Installed runtime archive suite: 3 passed, including repeated ephemeral compaction, persisted restoration, branch navigation and cancellation in both handler orders. Archive/SRT policy checks: 14 passed; explicit private-store denies preserve grants and generic-summary isolation remains passing."}

Admit `session_history` as a known optional host adapter with explicit read-only archive effects. Add it to planning's inspection allowlist. Keep ordinary file tools sandboxed and preserve all existing filesystem grants. The adapter must not become a startup prerequisite.

Make the tool available in isolated children only for their own current-branch archives. Preserve the existing child capability rules and parent-history isolation. Support ephemeral sessions by exporting their in-memory entries during compaction.

Update approved-execution context isolation to preserve or reconstruct only a verified archive handoff from the current branch's structured compaction metadata. Keep the approved execution contract first and preserve retained execution messages. Continue excluding generic mixed planning summaries and pre-boundary planning messages. Do not trust an arbitrary text prefix as proof of an archive handoff.

Preserve pending-approval cancellation regardless of extension handler order. A cancellation must prevent successful compaction even if an archive handler runs first. Restore archive references from persisted compaction metadata after reload, resume, and branch navigation. Forked or cloned branches can retrieve inherited archive references, but cannot enumerate unrelated history. A missing archive produces a clear retrieval error, not a misleading empty result.

Acceptance: the handoff and history tool remain available during planning and approved execution. The approved plan and recent tool-call/result pairs remain intact. Existing generic-summary isolation tests continue to pass.

### Part D — Document, verify, and deploy the replacement
- **Ledger:** {"status":"completed","note":null,"evidence":"User revised scope to host-only fixes; sbx/Docker verification remains explicitly unavailable, not repaired. npm --prefix pi run check:deterministic passed end-to-end; SRT 204 passed, 5 explicit skips for absent reviewed Visonic checkout. Fixed two outdated registerToolRenderer mocks and synthetic HOME grant directories; did not change runtime grants. node --test tests/obsidian-sync.test.mjs passed; bash -n install.sh and git diff --check passed. Removed 10 tracked Obsidian plugin binaries/manifests/styles, kept selected data.json settings, ignored unmanaged plugin installs, and changed sync to individual managed settings with drift protection. Actual vault sync preserves installed plugin code. ./install.sh config completed successfully (only expected nonfatal sbx warning). Deployed archive canary: 6 tests passed after deployment, including exact passage retrieval, reload, fork, no default summary fallback, and retained pairs. Logs /tmp/pi-host-full-check.log, /tmp/pi-host-deploy-final.log, /tmp/pi-host-canary-final.log. Existing unrelated local settings and installer vault paths preserved; canonical plan retained."}

Add extension documentation that defines archive, index, and handoff. Describe private storage, retrieval examples, model-index fallback, captured-history limits, disk retention, and disable/reload behavior. Update planning documentation for the archive-handoff exception and sandbox documentation for the narrow host adapter. Do not modify `pi/agent/AGENTS.md`.

Add the extension's checks to `pi/test-gate.mjs`. Verify serialization, bounded retrieval, hook failures, session restoration, and composition with the real installed Pi session APIs. Add targeted planning and SRT regression coverage.

Review the final diff for scope and preserve unrelated local changes, including runtime-written settings. Deploy only through `./install.sh config`. If unrelated Obsidian or installation state blocks that command, report the blocker instead of changing unrelated files or creating manual links. Existing sessions require `/reload` or restart.

Retain the canonical `.pi/plans/` document with the implementation for any eventual commit, as repository policy requires.

Acceptance: the narrow extension checks pass, the full repository Pi gate passes from an ordinary host terminal, and a deployed canary retrieves an exact old passage after compaction.

## Critical Files

- `pi/agent/extensions/session-archive/` — new archive storage, indexing, handoff, retrieval tool, and tests.
- `pi/agent/extensions/plan-mode/planning-gate.js` and execution isolation — admit read-only history retrieval and preserve verified archive navigation without restoring planning context.
- `pi/agent/extensions/srt-tool-routing/host-adapters.ts` and `child-capabilities.js` — optional host adapter admission and child capability boundaries.
- `pi/test-gate.mjs` — repository-wide verification integration.
- Installed Pi compaction and session-manager APIs — read-only references. No upstream edits.

## Verification

New-feature scenarios:
- Archive a branch with prior compactions, large tool results, multiline messages, Unicode, images, thinking blocks, and custom entries. Compare raw archived entries with the captured branch.
- Retrieve a fact before the first compaction after a second compaction. Retrieve text beyond 2,000 characters and beyond one response page.
- Exercise index pagination, literal searches, range reads, empty results, invalid IDs, malformed bounds, and very large individual messages. No response exceeds its output cap.
- Attempt traversal, symlink escape, and unrelated-archive access. All attempts fail without arbitrary host reads.
- Simulate model success, invalid references, partial coverage, provider failure, timeout, and cancellation. Exact search remains usable without semantic labels.
- Simulate disk failure and aborted publication. No handoff points to an incomplete archive and no built-in summarization fallback occurs.
- Exercise manual, threshold, and overflow compaction with the installed Pi runtime and a fake provider where possible. Keep the configured recent boundary and valid tool-call/result pairs.
- Resume, reload, fork, navigate branches, and compact an ephemeral session. References resolve only from the current branch.

Regression checks:
- Pending plan approval still cancels automatic compaction.
- Generic mixed summaries remain excluded from execution. Verified archive navigation survives with the approved contract and retained execution tail.
- SRT core ownership, optional-adapter startup, planning tool restrictions, child isolation, and usage accounting remain unchanged.
- Run the extension checks and affected planning/SRT suites. Before completion, run `npm --prefix pi run check` from an ordinary host terminal.

Canary: record a distinctive early fact and a long tool result, compact, and retrieve both through `session_history`. Success requires exact text, a surviving handoff, and unchanged recent context. Any lost handoff, unreachable archive, unauthorized read, or unwanted summary-model request is a failure signal. Report unavailable live-provider or native checks explicitly.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Preserve exact history and provide bounded retrieval
- ☑ Replace summaries with archive handoffs and navigable indexes
- ☑ Preserve retrieval across planning, execution, and session lifecycle
- ☑ Document, verify, and deploy the replacement
<!-- pi-plan-mode:progress:end -->
