# Allow Codex Git Metadata Writes

## Problem

The `cwd-only` permission profile permits writes in the workspace but does not
permit Git to create lock files in the active workspace's `.git` directory.
This prevents staging and committing otherwise authorized changes.

## Plan

- [x] Add a workspace-relative write rule for `.git`.
- [x] Validate the profile can create and remove a Git-metadata probe file.

## Success Criteria

- Codex can create Git's lock files for the active workspace.
- The permission remains restricted to the active workspace's Git metadata.

## Verification

`codex --strict-config --version` accepted the updated configuration. The
active workspace profile created and removed `.git/codex-write-probe`, and
`git diff --check` passed.
