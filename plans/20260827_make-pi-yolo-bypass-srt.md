# Make Pi `--yolo` Bypass SRT

## Context

`--yolo` must explicitly launch the installed Pi binary without SRT preflight, routing extensions, or the native built-in-tool disablement. Normal launches remain fail-closed and SRT-routed.

## Plan

1. Consume `--yolo` in the launcher and directly execute the real Pi binary before SRT initialization.
2. Update the SRT development invariant and ADR to document the explicit yolo exception.
3. Verify yolo requires no SRT runtime files and forwards no SRT restriction, then run the Pi check gate.

## Completion

- [x] `pi --yolo` bypasses SRT completely.
- [x] Normal Pi launches retain SRT fail-closed routing.
- [x] Focused and full Pi checks pass.
