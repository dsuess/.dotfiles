---
name: graphite-pr-comments
description: Address review comments on a Graphite pull request one at a time, explain and implement each agreed resolution, leave short thread replies, fold changes into the existing PR commit, and verify that commit independently. Use when the user asks to work through Graphite PR feedback or resolve review threads on a stacked PR.
compatibility: Requires authenticated GitHub CLI (gh), Graphite CLI (gt), and the repository's verification tools.
---

# Address Graphite PR comments

Work through review threads with the user, one at a time. Keep each resolution surgical, reply briefly in its thread, then fold the agreed changes into the existing PR commit. Do not create a separate feedback commit or submit the stack unless requested.

## 1. Inspect before changing anything

Extract the repository and PR number from the Graphite URL. Use authenticated `gh` APIs for private PRs rather than scraping Graphite.

Inspect:
- PR title, body, base/head branches, reviews, and general comments.
- Review threads, including replies, resolved/outdated state, and thread IDs.
- The current working tree, staged and unstaged changes, branch history, and Graphite parent relationships.
- Relevant source, tests, package guidance, and verification commands.

Useful commands:

```bash
gh pr view NUMBER --repo OWNER/REPO --json title,body,headRefName,baseRefName,reviews,comments,url
gh api --paginate repos/OWNER/REPO/pulls/NUMBER/comments
git status --short
git log -10 --oneline
gt info
gt log --stack --steps 10 --no-interactive
```

Use GraphQL to fetch `reviewThreads` with `id`, `isResolved`, `isOutdated`, `path`, `line`, and comments containing `databaseId`, `body`, `author`, and `url`. Paginate if necessary. General PR comments may contain artifact requests or architectural discussion not represented by inline threads.

Present a compact inventory. Distinguish requested changes, already-addressed items, future-work discussion, and requests for evidence. Do not equate an unresolved thread with an unimplemented fix.

## 2. Resolve one thread at a time

Follow the user's chosen thread order. Otherwise, start with the first actionable unresolved thread. Do not implement subsequent threads while discussing the current one.

For each thread:
1. Read its full discussion and inspect the current implementation.
2. Explain whether the concern is correct, what the code actually does, and the smallest useful resolution.
3. Identify consequential choices rather than silently choosing behavior. Ask only when repository evidence and safe inspection cannot settle them. This workflow is intentionally one-thread-at-a-time, not a bulk questionnaire.
4. Implement the agreed change and update affected contracts, precedence documentation, and CLI help when behavior changes.
5. Run the narrowest useful verification. For a behavior bug, reproduce the failure before fixing it when practical.
6. Leave a short reply in that thread once the resolution is implemented and checked.
7. Move to the next thread only after completing this resolution or explicitly deferring it.

Do not treat "have a look" or a question about correctness as permission to implement. Once the user asks to address the feedback, perform agreed routine fixes without repeatedly asking for approval.

Prefer extending an existing test over introducing a parallel test. Use parametrization when the cases verify a coherent contract; do not multiply unrelated dimensions or redundant combinations. Check that a precedence test contains both competing sources, not merely the winning source alone. Move tests with their code without adding unrelated coverage or cleanup.

Recheck working-tree state when the user says files changed externally. Preserve unrelated edits, including staged changes. Never describe changes as committed or published before verifying that state.

## 3. Reply briefly in the actual thread

Use one or two factual sentences: what changed and, if useful, how it was covered. Mention parametrizations when they are the resolution. Avoid long summaries, apologies, or claims that unpushed work is already available remotely.

Example:

> Added both as parametrizations of the existing test: with/without voxel geometry, and complete/partial settings blocks.

For published replies, the REST endpoint is:

```bash
gh api --method POST repos/OWNER/REPO/pulls/NUMBER/comments/COMMENT_ID/replies -f body='SHORT_REPLY'
```

An existing pending review can cause REST replies to fail with HTTP 422. Add the reply to the thread through GraphQL instead:

```bash
gh api graphql \
  -f query='mutation($body:String!, $thread:ID!) { addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread, body:$body}) { comment { url state } } }' \
  -f thread='THREAD_NODE_ID' \
  -f body='SHORT_REPLY'
```

Inspect the returned state. If it is `PENDING`, tell the user the reply is in their draft review, not published. Do not submit or delete an existing review merely to publish one reply: it may contain unrelated draft comments. Do not mark threads resolved automatically unless requested.

## 4. Fold into the existing PR commit

When the agreed feedback pass is complete and folding is authorized:
1. Identify the exact branch and commit belonging to the PR. Do not amend the current stack tip just because it is checked out.
2. Inspect Graphite tracking and Git ancestry before rewriting. A branch label can point to an older stack while the current tip contains a newer rebased copy. Repair metadata only after confirming the actual intended ancestry; preserve recoverable refs or stashes before moving history. Never blindly reset to a stale PR branch or trust an outdated parent relationship.
3. Preserve working changes and transplant only the intended hunks to the target PR branch. Do not transplant complete files from the stack tip when they contain later PR features.
4. Keep adaptations to callers introduced by a later PR in that later PR's commit. The target commit must not acquire upstack-only code just to accommodate the move.
5. Run relevant tests and lint on the target branch, review the diff, and stage only intended files.
6. Amend with `gt modify --no-interactive` on the target branch, or use `gt modify --into TARGET_BRANCH --no-interactive` when the staged patch can apply correctly downstack.
7. Restack descendants. Resolve conflicts by preserving both the agreed resolution and the descendant's existing intent; use `gt continue` after staging each resolution.

If verification exposes import-order or formatting failures in files included in the PR, make the minimum mechanical corrections needed for the requested passing checks. Do not use this as an excuse for broad cleanup.

Do not push, run `gt submit`, or publish pending reviews unless requested.

## 5. Verify the amended commit independently

Check out the amended PR branch and verify its exact committed tree with a clean working tree. A passing run on the stack tip is not evidence that a downstack commit passes.

Run:
- Relevant tests available at that commit, using its package environment and required dependency groups.
- The repository's pinned linter and formatter against all Python files added or modified by the PR, not just the latest feedback hunks.
- `git diff HEAD^ HEAD --check` for a single-commit PR.
- `gt info` and `gt log` to confirm the commit and parent relationships.

Then verify the integrated stack tip when restacking or caller adaptations could affect it. Restore the user's original working branch when practical, leaving no unexplained changes.

Report the amended commit hash, independent test count, lint/format results, integration results, skipped or unavailable checks, and whether anything was pushed. State pending reply status separately. Preserve recovery stashes until integration is verified; remove only task-created backups when safe.
