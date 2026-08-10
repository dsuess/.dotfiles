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

export const PART_MINIMAL_PLAN = `# Clarify Cache Documentation

## Context

The cache lifecycle is difficult for maintainers to understand in the wider data-access flow.

## Approach

Explain the existing behavior without changing runtime behavior.

### Part A — Clarify the cache lifecycle

Describe writes, expiry, and ownership using repository terminology. The work is accepted when the documentation explains the lifecycle without introducing a new contract.
`;

export const VALID_PLAN = `# Add Reliable Cache Invalidation

## Background

Stale cache entries survive successful writes and return outdated data. This change restores consistency while preserving the cache's role within the repository.

## Changes

Make invalidation an explicit part of successful writes while preserving the last valid cached value after failed writes.

### Step 1 [pending] Define the cache behavior

Clarify ownership, expiry, and invalidation behavior at the cache boundary, including the expected outcome of successful and failed writes.

### Step 2 [in_progress] Add reliable invalidation

Invalidate matching entries after successful writes without changing externally visible cache behavior.

### Step 3 [blocked] Cover boundary conditions

Handle misses, repeated invalidation, and expiry races. Stop and revisit the plan if compatibility cannot be preserved.

## Testing Plan

Exercise successful and failed writes, cache hits and misses, expiry races, and repeated invalidation. Verify both consistency and compatibility at the cache boundary.

## Assumptions / Decisions

The user decided that the existing public cache behavior must remain compatible.

## Stages

| Stage | Description | Steps |
|---|---|---|
| 1 | Establish expected behavior before implementation. | 1 |
| 2 | Implement and verify the behavior; the two changes may proceed together once Stage 1 is settled. | 2, 3 |
`;

export const SMALL_PLAN = `# Clarify Cache Documentation

## Background

The cache behavior is difficult for maintainers to understand in the wider data-access flow.

## Changes

Clarify the lifecycle at a repository-facing level without prescribing implementation details.

### Step 1 [pending] Clarify the cache lifecycle

Explain the high-level lifecycle and its relationship to writes and expiry.
`;

export const VERSION_2_PLAN = `# Add Reliable Cache Invalidation

## Why

Stale cache entries survive successful writes and return outdated data. Invalidation must restore consistency without changing the public cache API.

## What

Add explicit invalidation after successful writes and preserve valid entries after failed writes.

### Step 1 [pending] Implement invalidation

- **Targets:** \`src/cache.ts\`
- **Tools / APIs:** edit, \`Map.delete\`

Delete matching entries after successful writes.

## Stages

| Stage | Description | Steps |
|---|---|---|
| 1 | Implement and verify invalidation. | 1 |
`;

export const LEGACY_PLAN = `# Add Reliable Cache Invalidation

## Objective / Goal Statement

Invalidate stale cache entries without changing public API behavior.

## Stages Overview

| Stage | Name | Purpose |
|---|---|---|
| 1 | Contract | Freeze behavior and tests. |
| 2 | Implementation | Add invalidation and verify it. |

### Stage 1 — Contract

#### 1.1 [pending] Define the cache contract

- **Targets:** \`src/cache.ts\`, \`test/cache.test.ts\`
- **Tools / APIs:** read, edit, Node test runner

Document key ownership and expected expiry behavior.

### Stage 2 — Implementation

#### 2.1 [in_progress] Implement invalidation

- **Targets:** \`src/cache.ts\`
- **Tools / APIs:** edit, \`Map.delete\`

Delete matching entries after successful writes.

#### 2.2 [blocked] Verify edge cases

- **Targets:** \`test/cache.test.ts\`
- **Tools / APIs:** bash, Node test runner

Cover misses, repeated invalidation, and expiry races.

## Conditional Logic and Edge Cases

- If a key is already absent, invalidation remains idempotent.
- Failed writes do not invalidate a valid cached value.

## Parallel Subagent Recommendations

Tests and implementation share files, so execute sequentially in one worker.

## Testing Requirements and Edge Cases

Run unit tests for hits, misses, expiry, repeated invalidation, and failed writes.

## Stopping Criteria / Guardrails

Stop if the public cache API must change or required tests cannot run.
`;
