# Fix Alfred Audio Device Selection

## Problem

The Script Filter returns the selected device ID correctly in each item's `arg`, and Alfred passes that value to the connected Run Script action. The action ignores this incoming argument and instead embeds `{var:audio_device_id}` in its shell code. Alfred exposes workflow variables to code blocks as environment variables; `{var:...}` expansion is for Alfred object fields. Run Script actions configured for argv input must consume the selected Script Filter `arg` as `$1`.

## Plan

- [x] Add a regression assertion for both Run Script commands.
- [x] Pass Alfred's incoming argv value to `audio.js` for input and output switching.
- [x] Verify JavaScript fixtures, plist structure, workflow graph references, and whitespace.

## Success Criteria

- Selecting a Script Filter row passes its numeric `arg` to `switchDevice`.
- Both input and output actions use the same argument path.
- Existing audio parsing and notification fixtures still pass.

## Verification

Passed the Node fixture suite, JavaScript syntax check, plist parsing, workflow graph-reference checks, argv-mode assertions, and `git diff --check`. Live Alfred/Core Audio verification remains unavailable in the Linux sandbox.
