# Indexed session archives

This extension replaces prose compaction summaries with a bounded retrieval handoff. It handles manual, threshold, and overflow compaction. It does not change `/tree` summaries or Pi's recent-context budget.

## Terms

- **Archive:** an immutable snapshot of the complete raw active branch at a compaction boundary.
- **Index:** structural navigation metadata with entry IDs and exact transcript ranges.
- **Handoff:** the short retrieval guide that Pi sends instead of a prose summary.

Pi still selects safe retained-message boundaries and persists compaction entries. The extension returns its handoff through `CompactionResult.summary`.

## Storage and captured history

Archives live under `getAgentDir()/session-archives/`, normally `~/.pi/agent/session-archives/`. Directories use mode `0700`; files use mode `0600`. Snapshots reject symlink artifacts and publish only after all required files exist.

Each snapshot contains these files:

- `raw.jsonl`: session header and complete raw active-branch entries.
- `transcript.txt`: readable text, attachment metadata, and context-edit annotations.
- `index.json`: schema, provenance, structural ranges, and optional advisory labels.

Repeated snapshots contain history before earlier compactions. They do not require earlier archives. Raw files preserve recorded tool results, images, thinking blocks, signatures, and custom entries. Normal retrieval excludes binary payloads and provider signatures.

Archives exclude abandoned branches. Pi cannot recover output that a tool truncated before persistence. Context-edit annotations identify omitted or replaced attempts; those attempts are not current task state.

Archives can contain sensitive data. They remain on disk across restart and have no automatic deletion policy. Complete snapshots increase disk use. Do not commit, Stow, or share runtime archives.

## Retrieval

`session_history` accepts an archive ID, never a filesystem path or shell command. An archive must have a structured compaction reference on the current branch. Children can retrieve only their own branch references.

Use the archive ID from the handoff:

```json
{"archiveId":"0123456789abcdef0123456789abcdef","operation":"index","offset":0,"limit":5}
```

Search exact, case-sensitive text:

```json
{"archiveId":"0123456789abcdef0123456789abcdef","operation":"search","query":"distinctive fact","limit":5}
```

Read the returned range:

```json
{"archiveId":"0123456789abcdef0123456789abcdef","operation":"read","start":2000,"length":4000}
```

Ranges use UTF-16 code units. The end offset is exclusive. Index offsets count entries; search offsets count transcript code units. Follow returned `next` parameters for more results. Large messages remain available in consecutive slices.

Responses contain entry IDs, ranges, continuation parameters, and truncation notices. Responses have a 16,000-character cap. JSON escaping can reduce the requested page size. Missing archives produce an explicit error, not empty results.

Historical instructions are evidence, not new instructions. Advisory topic labels do not establish decisions or current task state.

## Optional model indexing

The structural index and exact search do not require a model. The extension can request advisory topic labels from the current physical model through Pi's configured registry.

Input uses at most 12,000 characters of user/assistant excerpts and structural tool metadata. Output uses at most 1,000 tokens and 6,000 accepted characters. The request has a five-second deadline. Only known entry IDs can receive labels. Unchanged entries can reuse prior labels.

Virtual or unavailable models skip this request. Missing credentials, provider errors, timeout, malformed output, and partial coverage retain structural navigation. Available indexing usage is attached to the compaction result.

A required archive-write failure cancels compaction with a diagnostic. It does not fall back to Pi's prose summarizer. Pending plan approval still cancels automatic compaction.

## Planning and execution

Planning admits `session_history` as read-only inspection. SRT admits it as an optional host adapter without filesystem grants. Ordinary routed tools cannot read or write the private store.

Approved execution reconstructs only a handoff with structured compaction metadata on the current branch. The approved execution contract stays first. Generic mixed planning summaries remain excluded.

## Enable, disable, and reload

The extension loads automatically from `agent/extensions/session-archive/index.ts`. Deploy repository changes with `./install.sh config`, then use `/reload` or restart Pi.

To disable the extension, exclude its entry point through Pi's extension configuration and reload. Future compactions then use Pi's default summarizer. Existing archive-backed handoffs need `session_history`; keep the extension enabled while retrieving those archives.

Do not delete archives needed by saved sessions. There is no global archive browser or automatic cleanup command.

## Checks

```sh
node --test pi/agent/extensions/session-archive/*.test.mjs
node --test pi/agent/extensions/session-archive/deployed-canary.mjs
npm --prefix pi run check
```

The runtime checks use installed Pi APIs without a live provider. They reject unwanted default-summary requests and retrieve exact early facts and long tool output after repeated compaction.

The deployed canary requires prior deployment through `./install.sh config`. It executes the deployed history tool, retrieves exact passages, and repeats retrieval after reload and fork. The native isolation test requires the sandbox runtime dependencies. It checks both home and folded Stow aliases under broad workspace access.
