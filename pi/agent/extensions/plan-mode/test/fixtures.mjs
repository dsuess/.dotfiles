export const PART_PLAN = `# Add Reliable Cache Invalidation

## Context

Successful writes leave stale entries in the repository cache. The cache remains the read-path authority, so invalidation must preserve the public data-access contract and the last valid value after failed writes. Research confirmed that \`src/cache.ts\` owns key expiry; this selective anchor matters because invalidation and expiry must share key identity.

## Approach

Make successful-write invalidation part of the cache lifecycle while preserving compatibility and exposing uncertainty through observable checks.

### Part A — Define cache consistency

Clarify ownership, expiry, and invalidation outcomes for successful and failed writes. This establishes the behavioral boundary required by Part B and is accepted when every write outcome has one unambiguous cache result.

### Part B — Implement reliable invalidation

Invalidate matching entries after successful writes, retain valid entries after failed writes, and keep repeated invalidation idempotent. Preserve the existing public interface and stop if cache-key identity cannot be shared with expiry.

### Part C — Cover boundary behavior

Exercise misses, repeated invalidation, and expiry races after Part B. Accept the Part when compatibility and consistency hold at the cache boundary.

## Critical Files

- \`src/cache.ts\` — modification boundary that owns key expiry and invalidation.
- \`docs/cache-lifecycle.md\` — read-only terminology reference for the public lifecycle.

## Verification

Regression checks preserve failed-write values and the existing public cache behavior. New-feature scenarios cover successful writes, hits, misses, repeated invalidation, and expiry races. A successful-write read returning fresh data is the smoke signal; any stale read or key-identity mismatch is a failure signal that invalidates the shared-key assumption.
`;

export const PART_PLAN_WITH_QUESTIONS = `# Add Reliable Cache Invalidation

## Context

Successful writes leave stale entries in the repository cache. The cache remains the read-path authority, so invalidation must preserve the public data-access contract.

## Questions & Answers

| Question | Answer |
|---|---|
| Should failed writes invalidate a valid cache entry? | No. Retain the last valid value. |
| Must the public cache interface change? | No. Preserve compatibility. |

## Approach

Make successful-write invalidation part of the cache lifecycle while preserving compatibility.

### Part A — Define cache consistency

Clarify ownership and invalidation outcomes for successful and failed writes.

### Part B — Implement reliable invalidation

Invalidate matching entries after successful writes and retain valid entries after failed writes.

## Verification

Exercise successful and failed writes, cache hits and misses, and repeated invalidation.
`;

export const PART_PARALLEL_PLAN = PART_PLAN.replace("## Critical Files", `## Parallel Execution

| Wave | Worker | Part | Source Part | Depends On | Ownership |
|---|---|---|---|---|---|
| 1 | worker-a | A | A | — | cache contract |
| 1 | worker-b | B | B | — | cache implementation |
| 2 | worker-c | C | C | A, B | cache tests |

## Critical Files`);

export const PART_SPLIT_PARALLEL_PLAN = PART_PLAN
	.replace(
		"Clarify ownership, expiry, and invalidation outcomes for successful and failed writes. This establishes the behavioral boundary required by Part B and is accepted when every write outcome has one unambiguous cache result.",
		"Clarify ownership, expiry, and invalidation outcomes for successful and failed writes.\n\n### Part B — Finish cache consistency\n\nThis establishes the behavioral boundary required by Part B and is accepted when every write outcome has one unambiguous cache result.",
	)
	.replace("### Part B — Implement reliable invalidation", "### Part C — Implement reliable invalidation")
	.replace("### Part C — Cover boundary behavior", "### Part D — Cover boundary behavior")
	.replace("## Critical Files", `## Parallel Execution

| Wave | Worker | Part | Source Part | Depends On | Ownership |
|---|---|---|---|---|---|
| 1 | worker-a | A | A | — | contract wording |
| 1 | worker-b | B | A | — | acceptance wording |
| 2 | worker-c | C | B | A, B | cache implementation |
| 3 | worker-d | D | C | C | cache tests |

## Critical Files`);

export const INVALID_PART_PARALLEL_PLAN = PART_PARALLEL_PLAN.replace("| 1 | worker-b | B | B | — | cache implementation |", "| 1 | worker-a | B | B | — | cache implementation |");

export const PART_MINIMAL_PLAN = `# Clarify Cache Documentation

## Context

The cache lifecycle is difficult for maintainers to understand in the wider data-access flow.

## Approach

Explain the existing behavior without changing runtime behavior.

### Part A — Clarify the cache lifecycle

Describe writes, expiry, and ownership using repository terminology. The work is accepted when the documentation explains the lifecycle without introducing a new contract.
`;

export const BACKGROUND_CHANGES_PLAN = `# Historical shape

## Background

This is a former document shape.

## Changes

This former document shape used status-bearing task headings.

### Step 1 [pending] Do work

Do the work.
`;

export const WHY_WHAT_PLAN = `# Historical shape

## Why

This is a former document shape.

## What

This former document shape used status-bearing task headings.

### Step 1 [pending] Do work

Do the work.

## Stages

| Stage | Description | Steps |
|---|---|---|
| 1 | Do work. | 1 |
`;

export const STAGE_GROUPED_PLAN = `# Historical shape

## Objective / Goal Statement

This is a former document shape.

## Stages Overview

| Stage | Name | Purpose |
|---|---|---|
| 1 | Work | Do work. |

### Stage 1 — Work

#### 1.1 [pending] Do work

Do the work.
`;
