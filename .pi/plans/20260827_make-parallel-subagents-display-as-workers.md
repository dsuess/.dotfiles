# Make Parallel Subagents Display as Workers

## Context

Parallel plan execution dispatches implementation children with a task that begins `[PARALLEL PLAN WORKER]`. The subagent UI classifies roles by keyword precedence, where `plan` matches the planner role before implementation terms match the worker role. The label is presentation-only, but it incorrectly shows implementation children as planners. The public subagent schema intentionally permits only prompt, model, and thinking-level inputs, so the correction must not add a caller-supplied role field.

## Approach

Add a narrowly scoped, validated presentation directive at the beginning of delegated prompts. Preserve keyword inference as the fallback for ordinary subagents. Have parallel-plan dispatch emit the worker directive, then prove both the directive precedence and the parallel worker contract with focused tests.

### Part A — Add validated role presentation directives

Recognize only a leading canonical directive with a known role name before applying the existing keyword classifier. Keep malformed, unknown, and non-leading text on the existing inference path. This Part is accepted when a leading worker directive overrides later planning language without changing ordinary classifications.

### Part B — Mark parallel implementation workers explicitly

Prefix each parallel worker prompt with the canonical worker directive while retaining its existing implementation contract. This Part is accepted when the generated worker prompt declares the worker presentation role and continues to require isolated implementation and verification.

## Critical Files

- `pi/agent/extensions/subagent/ui.ts` — role presentation and validated fallback inference.
- `pi/agent/extensions/plan-mode/execution-helpers.js` — parallel worker prompt contract.
- `pi/agent/extensions/subagent/test/tui-smoke.mjs` — UI role-regression coverage.
- `pi/agent/extensions/plan-mode/test/execution-helpers.test.mjs` — parallel dispatch contract coverage.

## Verification

Run the subagent TUI smoke test and the plan-mode execution-helper tests, then run the repository Pi check suite. The success signal is a parallel prompt whose displayed role resolves to worker despite its approved-plan context; malformed or absent directives retain normal keyword inference.
