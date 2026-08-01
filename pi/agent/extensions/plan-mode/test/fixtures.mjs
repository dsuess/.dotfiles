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
