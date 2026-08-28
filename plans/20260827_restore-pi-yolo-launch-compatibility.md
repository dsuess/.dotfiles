# Restore Pi `--yolo` Launch Compatibility

## Context

The SRT launcher rejects `pi --yolo`, even though the flag was previously a wrapper-only launch mode. The SRT security boundary no longer permits its former host-built-in bypass.

## Plan

1. Consume `--yolo` in the launcher before forwarding arguments, while preserving SRT routing and native built-in-tool disablement.
2. Add a launcher fixture that verifies `--yolo` starts the real Pi binary and does not forward the compatibility flag.
3. Run the focused launcher test and the Pi check gate.

## Completion

- [x] `--yolo` is accepted without restoring a host-built-in bypass.
- [x] The real Pi binary receives no `--yolo` argument.
- [x] Focused and full Pi checks pass.
