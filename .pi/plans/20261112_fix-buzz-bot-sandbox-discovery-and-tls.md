# Fix Buzz bot use in the Pi sandbox

## Context

Sandboxed commands use a generated HOME. The installed `~/.local/bin/buzz-bot` searches the wrong skill path; the Stow-managed `~/bin/buzz-bot` is not deployed. Running the existing launcher logic inside the sandbox finds the key, but the real Buzz CLI fails TLS verification. Preserve the exact-key read exception and unrelated changes.

## Questions & Answers

| Question | Answer |
| --- | --- |
| Allow macOS trustd access for TLS? | Yes. The service is available to all sandboxed commands, not just Buzz, and increases IPC authority. |

## Approach

Clarify the supported launcher and enable macOS system trust without disabling TLS verification. Preserve existing credential and filesystem boundaries.

### Part A — Fix discovery guidance
- **Ledger:** {"status":"completed","note":null,"evidence":"Added agents/skills/buzz-bot-pi/SKILL.md and clarified pi/sandbox/README.md deployment, generated HOME, and failure distinctions. Checked skill metadata and installer targets; node --test pi/sandbox/test-buzz-launcher.mjs passed. Existing untracked skill link untouched."}

Add a small Pi-specific companion skill with generated-HOME guidance: use the deployed `~/bin/buzz-bot` launcher, check `whoami` instead of listing `$HOME`, and distinguish deployment, key, and network failures. Preserve the external Buzz skill and the user's untracked skill link. Update sandbox documentation with host deployment and verification steps. Check skill metadata, paths, and commands against the installation.

### Part B — Enable system TLS verification
- **Ledger:** {"status":"completed","note":null,"evidence":"Enabled SRT's top-level enableWeakerNetworkIsolation and documented trustd IPC/exfiltration risk. Seven focused policy/launcher tests passed, including actual generated macOS profile and key isolation policy. Added native controlled TLS regression to test:native; execution blocked by outer sandbox EPERM binding SRT mux Unix socket, so host verification remains required."}

Enable the SRT macOS trustd option, preserving existing filesystem, Docker, and key boundaries. Document its broader IPC authority and exfiltration risk. Add policy and native regression coverage for the option and certificate verification with a controlled TLS fixture where practical. Do not disable TLS verification or expose additional credentials. Check policy and run focused tests.

### Part C — Verify integration
- **Ledger:** {"status":"completed","note":null,"evidence":"In this sandbox with generated HOME, synthetic launcher test passed argument forwarding and host key-directory selection; 21 focused policy, host configuration, client policy and launcher tests and 3 launcher routing mock tests passed. Native Buzz and TLS tests attempted but SRT initialization failed EPERM binding mux socket under outer sandbox. Live relay, real user-Bash routing and native key isolation remain unverified; command -v currently finds old ~/.local/bin launcher. git diff --check and checks for both new files passed. Host deployment and full npm --prefix pi run check remain required."}

Exercise launcher logic through a sandboxed command with generated HOME and safe read-only operations when possible. Do not send messages or change identities. Review the diff and run focused tests and `git diff --check`. Report blocked checks and give exact next steps. Deployment and the full Pi check require an ordinary host terminal. The host user must deploy with `./install.sh config` and start a new session.

## Critical Files

- `agents/skills/` and `pi/sandbox/README.md`
- `pi/sandbox/srt-policy.mjs` and focused sandbox tests

## Verification

Check synthetic key isolation, launcher argument forwarding, trustd policy, a native TLS fixture, and skill discovery guidance. Report whether the live relay and real routed Bash path were tested, including outer-sandbox limitations.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Fix discovery guidance
- ☑ Enable system TLS verification
- ☑ Verify integration
<!-- pi-plan-mode:progress:end -->
