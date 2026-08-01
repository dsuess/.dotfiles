export const VALID_PLAN = `# Add Reliable Cache Invalidation

## Why

Stale cache entries survive successful writes and return outdated data. Invalidation must restore consistency without changing the public cache API.

## What

Add explicit invalidation after successful writes, preserve valid entries after failed writes, and prove idempotent behavior at the cache boundary.

### Step 1 [pending] Define the cache contract

- **Targets:** \`src/cache.ts\`, \`test/cache.test.ts\`
- **Tools / APIs:** read, edit, Node test runner

Document key ownership and expected expiry behavior. Acceptance requires executable contract tests for successful and failed writes.

### Step 2 [in_progress] Implement invalidation

- **Targets:** \`src/cache.ts\`
- **Tools / APIs:** edit, \`Map.delete\`

Delete matching entries after successful writes. Failed writes must preserve the last valid cached value.

### Step 3 [blocked] Verify edge cases

- **Targets:** \`test/cache.test.ts\`
- **Tools / APIs:** bash, Node test runner

Cover misses, repeated invalidation, expiry races, and the stopping condition when the public API would need to change.

## Stages

| Stage | Description | Steps |
|---|---|---|
| 1 | Freeze the cache behavior and executable contract. | 1 |
| 2 | Implement invalidation and verify edge cases. | 2, 3 |
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
