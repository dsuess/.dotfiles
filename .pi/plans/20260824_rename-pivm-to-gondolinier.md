# Rename `pivm` to `gondolinier`

## Goal

Rename the Stow-managed Gondolin VM and Docker-storage CLI from `pivm` to `gondolinier`. The old executable, module, test name, script name, command output, and operator documentation must no longer present `pivm` as a current interface. Historical plan records remain unchanged.

## Plan

1. **Rename the implementation surface.** Rename the Stow launcher, sandbox module, and focused test; update exported symbols and the storage lease client ID.
   **Check:** imports resolve and the focused test runs through `gondolinier`.
2. **Update the public contract.** Replace CLI usage/errors, package test script, and sandbox README examples with `gondolinier`.
   **Check:** the operator docs and help show only the new command.
3. **Verify and review.** Run the focused test, full sandbox test suite, whitespace check, and inspect the diff.
   **Check:** tests pass and no non-historical `pivm` references remain.

## Ledger

- [x] Rename implementation surface.
- [x] Update public contract.
- [x] Verify and review — `npm --prefix pi/sandbox test`, direct module/launcher help, and `git diff --check` passed. The only remaining `pivm` strings are historical or pre-existing plan records.
