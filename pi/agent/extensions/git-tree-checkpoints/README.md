# Git Tree Checkpoints

This global Pi extension couples `/tree` conversation navigation with optional Git-backed code restoration. It does not replace or register `/tree`; it uses Pi's supported `before_agent_start` and `session_before_tree` hooks.

## Behavior

Before each user prompt, the extension captures the repository state represented by the current conversation leaf. The checkpoint includes:

- text worktree content (tracked and non-ignored untracked), including modes and symlinks;
- the stage-0 index entries for those tracked text paths, separately from worktree content.

Text detection honors a `.gitattributes` `text` setting first. Otherwise, a regular file must be valid UTF-8 and contain no NUL byte. Binary, unreadable, and otherwise uncertain files are excluded. Ignored files are excluded too. The current branch, `HEAD`, commits, normal stash stack, and refs outside `refs/pi/checkpoints/` are not changed.

### `/tree` flow

Pi's built-in **Summarize branch?** choice appears first (unless disabled in Pi settings). The extension then asks:

1. **Keep current code** (default) — navigate only the conversation and intentionally allow code/conversation divergence.
2. **Restore checkpointed code** — restore code and ordinary staging to the destination checkpoint.
3. **Cancel navigation** — leave both conversation and code in place. Escape also cancels.

Old conversation points without a checkpoint offer only **Keep current code and navigate** or cancellation. This preserves conversation-only navigation for sessions created before the extension existed.

Every non-cancelled departure first gets a safety checkpoint. This captures code produced after the latest prompt and makes the abandoned branch recoverable. If destination restoration fails, the extension immediately attempts to restore that safety checkpoint and cancels conversation navigation. If safety recovery also fails, the UI reports both errors and leaves the session ref available for manual inspection.

In non-UI modes, code is never restored implicitly. A departure safety checkpoint is still captured when possible, then Pi retains its historical conversation-only navigation behavior.

## Checkpoint granularity

Routine checkpoints are taken once per user prompt, before Pi persists that prompt. Selecting an assistant message, tool result, or another entry inside one response therefore restores the code state from the start of that prompt, not an unverifiable intermediate tool state.

Each checkpoint is persisted as a `git-tree-checkpoint` custom session entry. Custom entries are part of Pi's conversation tree but are excluded from LLM context. Exact conversation-leaf associations take precedence; otherwise the nearest checkpoint ancestor is used. This survives `/reload` and Pi restarts without relying on an in-memory map.

Choosing **Keep current code** is deliberate divergence. The next prompt captures that code on the newly selected conversation branch.

## Git storage

Capture uses a temporary alternate index:

1. write the user's real index tree;
2. load only the selected tracked text entries into an alternate index;
3. run path-limited `git add -A` there to collect selected text worktree content and non-ignored text untracked files;
4. write the resulting worktree tree;
5. create synthetic index and worktree commits;
6. atomically advance `refs/pi/checkpoints/<session-id>`.

Each worktree anchor links to its index commit and the previous session anchor, so historical checkpoint objects remain reachable through Git GC. Synthetic commits use an extension-local identity and do not require the user's Git identity.

Version 2 restore validates repository identity, metadata version, object types, commit links, and reachability before selectively writing checkpointed text paths and their index entries. It does not run `git clean`, and does not touch excluded binary paths. Later untracked files are preserved; a checkpointed untracked text path is restored to its saved contents, but no untracked path is deleted. A current binary file at a checkpointed text path is also preserved rather than overwritten. Version 1 checkpoints remain restorable with their historical full-tree restore behavior.

> Checkpointed non-ignored text files enter Git objects. Ignore secret text paths that must not be checkpointed.

## Limits and unsupported states

- **Outside a Git worktree:** the enhancement disables itself for that session; normal `/tree` navigation remains available.
- **Unmerged indexes:** capture and restore are rejected before mutation.
- **Intent-to-add entries:** capture is rejected because their special index state cannot be represented by the two saved trees.
- **Sparse checkouts:** rejected; skip-worktree and sparse materialization semantics are not supported.
- **Commits after capture:** restore leaves the newer `HEAD` untouched. Only saved text index entries change, so later binary and unselected index entries remain as they are.
- **Ignored and later untracked paths:** never captured or removed. An ignored path that obstructs restoring a selected text path can make restore fail and trigger safety recovery.
- **Deleted files without a `text` attribute:** a missing file cannot be inspected, so it is conservatively excluded unless `.gitattributes` marks it as text.
- **Nested Git repositories:** never removed by version 2 restore. A nested repository created after a checkpoint remains after restore.
- **Submodules:** only the superproject gitlink/index state is represented. Dirty or untracked content inside a submodule is not checkpointed or restored and must be managed separately.
- **Linked worktrees:** metadata binds a checkpoint to both its canonical worktree root and common Git directory. A checkpoint cannot be applied through another worktree.
- **Git object retention:** objects remain reachable while their session ref exists. Removing the ref permits normal Git GC to reclaim them eventually.

## Inspection and cleanup

List checkpoint refs:

```bash
git for-each-ref --format='%(refname) %(objectname:short) %(creatordate:iso8601)' refs/pi/checkpoints/
```

Inspect one session's synthetic history (the session ID is shown by Pi's `/session` command):

```bash
git log --graph --oneline --decorate refs/pi/checkpoints/<session-id>
git cat-file -p refs/pi/checkpoints/<session-id>
```

Checkpoint object IDs and represented conversation leaves are also recorded in the session JSONL as `git-tree-checkpoint` custom entries.

Delete one stale ref manually:

```bash
git update-ref -d refs/pi/checkpoints/<session-id>
```

Delete every Pi checkpoint ref in the current repository:

```bash
git for-each-ref --format='delete %(refname)' refs/pi/checkpoints/ | git update-ref --stdin
```

The extension never prunes refs automatically. Pi exposes no reliable session-deletion lifecycle event, so automatic pruning could discard recovery data for a session that still exists.
