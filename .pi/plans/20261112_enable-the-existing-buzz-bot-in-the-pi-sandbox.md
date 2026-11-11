# Enable the existing Buzz bot in the Pi sandbox

## Context

Support normal Buzz CLI commands for the existing `daniel-suess-local` bot. The generated HOME breaks the existing wrapper, and the skill, CLI, and key are outside baseline reads. Preserve existing unrelated sandbox modifications.

## Questions & Answers

| Question | Answer |
| --- | --- |
| May sandboxed commands read the existing bot key? | Yes, the exact key only. Any sandboxed command can disclose the key or act as the bot. |
| Which capabilities are in scope? | Existing-bot commands, not key creation or Pi wake/listener integration. |

## Approach

Grant only reviewed paths and supply a Stow-managed launcher that works with generated HOME. Do not expose other keys or grant write access.

### Part A — Add reviewed runtime access
- **Ledger:** {"status":"completed","note":null,"evidence":"Fixed-location skill and executable reads and exact validated private key; policy revalidates key. Fixture tests cover missing installs, permissions, symlinks and adjacent-key exclusion; node --test host-configuration and srt-policy passes."}

Add narrowly scoped, optional reviewed host-read paths for the existing Buzz skill target, Buzz CLI executable, and exact bot key. Validate canonical paths and private-key permissions without reading or logging secret bytes. Do not grant writes or discover arbitrary symlink targets. Check fixture policies for missing installations, unsafe key paths, and unrelated key denial.

### Part B — Add a sandbox-compatible launcher
- **Ledger:** {"status":"completed","note":null,"evidence":"Added executable Stow launcher using deployed ~/bin spelling for host home, fixed Python and skill paths, and forced host key directory. Fixture verifies generated HOME, argument preservation and key-dir override without secrets or network; focused tests pass."}

Add a Stow-managed `buzz-bot` wrapper that invokes installed Python 3.14 and the reviewed skill path without relying on generated HOME. Point its key directory at the host location without exposing other key files. Verify wrapper arguments and environment with fixtures, without printing secrets or contacting the relay.

### Part C — Document and verify
- **Ledger:** {"status":"completed","note":null,"evidence":"Documented credential authority, installation paths, host deployment and safe verification. Focused suite 11/11 including native SRT fake-key denial and generated-HOME launcher passed; actual reviewed paths validated without key reads; git diff --check passed. npm --prefix pi run check passed UI and deterministic stages but stopped at native compatibility canary because sbx is not signed in and global policy is uninitialized. Deployed controller and relay checks remain for an ordinary host terminal after deployment."}

Document security implications, scope, deployment, and host-side verification. Run focused tests, inspect the diff, and run the project check if possible. Verify the actual sandbox boundary and a safe read-only relay operation when the deployed controller and network are available; do not send messages or alter the bot identity.

## Critical Files

- `pi/sandbox/host-configuration.mjs` and `pi/sandbox/srt-policy.mjs`
- `pi/sandbox/test-host-configuration.mjs` and `pi/sandbox/test-srt-policy.mjs`
- `pi/sandbox/README.md` and a Stow-managed wrapper under `bin/`

## Verification

Use synthetic paths and fake keys to verify exact read authority, denial of adjacent keys, absent/unsafe paths, wrapper behavior, and policy generation. Run the narrowest relevant tests and `npm --prefix pi run check`; report any inability to run the native boundary or full gate. Deployment is reserved for an ordinary host terminal.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Add reviewed runtime access
- ☑ Add a sandbox-compatible launcher
- ☑ Document and verify
<!-- pi-plan-mode:progress:end -->
