# Limit Pi Git Checkpoints to Text Files

## Goal

Avoid prompt-time Git checkpointing of generated and binary repository content while retaining tracked and non-ignored untracked text files.

## Implementation

1. Publish version-2 checkpoint metadata with selected text and tracked-text path manifests.
2. Classify paths from `.gitattributes` `text` settings first; otherwise accept only UTF-8 regular files without NUL bytes. Preserve uncertain and binary paths.
3. Build partial alternate-index trees from those paths only, then selectively restore their worktree and index entries without `git clean`.
4. Keep version-1 checkpoint parsing and restoration for existing sessions.
5. Cover binary exclusion and untracked preservation in unit and integration tests; document the changed restore semantics.

## Verification

`npm --prefix pi/agent/extensions/git-tree-checkpoints run check`
