# Git Tree Checkpoints

This global Pi extension couples `/tree` conversation navigation with optional Git-backed code restoration. It does not replace or register `/tree`; it uses Pi's supported `before_agent_start` and `session_before_tree` hooks.

## Behavior

Before each user prompt, the extension captures the repository state represented by the current conversation leaf. The checkpoint includes:

- tracked worktree content, including deletions, modes, and symlinks;
- non-ignored untracked files;
- the real stage-0 index tree, separately from worktree content.

Ignored files are neither captured nor cleaned. The current branch, `HEAD`, commits, normal stash stack, and refs outside `refs/pi/checkpoints/` are not changed.

### `/tree` flow

Pi's built-in **Summarize branch?** choice appears first (unless disabled in Pi settings). The extension then asks:

1. **Restore checkpointed code** — restore code and ordinary staging to the destination checkpoint.
2. **Keep current code** — navigate only the conversation and intentionally allow code/conversation divergence.
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
2. load that tree into the alternate index;
3. run `git add -A` there to collect tracked and non-ignored untracked worktree content;
4. write the resulting worktree tree;
5. create synthetic index and worktree commits;
6. atomically advance `refs/pi/checkpoints/<session-id>`.

Each worktree anchor links to its index commit and the previous session anchor, so historical checkpoint objects remain reachable through Git GC. Synthetic commits use an extension-local identity and do not require the user's Git identity.

Restore validates repository identity, metadata version, object types, commit links, and reachability before mutation. It then uses `git clean -fd`, `git read-tree --reset -u <worktree-tree>`, and `git read-tree --reset <index-tree>`. It never uses `git reset --hard`, checks out a branch ref, moves `HEAD`, runs `git clean -x`, or force-cleans nested repositories.

> Non-ignored untracked files enter Git objects. Ignore secret or generated paths that must not be checkpointed.

## Limits and unsupported states

- **Outside a Git worktree:** the enhancement disables itself for that session; normal `/tree` navigation remains available.
- **Unmerged indexes:** capture and restore are rejected before mutation.
- **Intent-to-add entries:** capture is rejected because their special index state cannot be represented by the two saved trees.
- **Sparse checkouts:** rejected; skip-worktree and sparse materialization semantics are not supported.
- **Commits after capture:** restore leaves the newer `HEAD` untouched. The old saved index is loaded exactly, so status relative to the newer commit can show staged additions or deletions that did not appear at capture time.
- **Ignored paths:** never captured or removed. An ignored path that obstructs restoring a tracked path can make restore fail and trigger safety recovery.
- **Nested Git repositories:** `git clean -fd` intentionally does not remove them. A nested repository created after a checkpoint can therefore remain after restore.
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
