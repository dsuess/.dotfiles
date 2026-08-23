# Align Pi `--yolo` Model Scoping

## Context

`bin/pi --yolo` bypassed the normal cached availability-aware model scope and let Pi consume every configured `enabledModels` entry. That made unavailable configured models produce no-match warnings.

## Plan

1. Extract the automatic-scope eligibility rules so normal and yolo launches use one decision path.
2. Run the existing cache helper before a yolo launch when automatic scoping is eligible, without adding sandbox setup or tool normalization.
3. Cover automatic and explicit yolo model scopes in the wrapper fixture, then run focused verification.

## Completion

- [x] Normal and yolo paths share automatic-scope eligibility.
- [x] Yolo injects the availability-filtered cache result while preserving host bypass behavior.
- [x] Wrapper tests cover yolo automatic and explicit scope behavior.
- [x] Bare yolo launches safely handle an empty forwarded-argument array.
