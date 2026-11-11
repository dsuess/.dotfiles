---
name: buzz-bot-pi
description: Use the Buzz bot skill from a sandboxed Pi session, including launcher discovery, key checks, and relay troubleshooting.
---

# Buzz bot in Pi

Use the `buzz-bot` skill for bot commands and safety. Pi's sandbox gives commands a generated
`HOME`, so listing `$HOME` does not show the host installation or key directory.

- Use the Stow-managed host `~/bin/buzz-bot` launcher, not the older `~/.local/bin/buzz-bot`.
  Run `command -v buzz-bot` and check that it resolves to the host's `bin/buzz-bot`. If it does
  not, ask the user to deploy with `./install.sh config` in a host terminal and start a new Pi
  session. Do not create links from the sandbox.
- Run `buzz-bot whoami daniel-suess-local` to check local launcher and key access without
  printing the private key. Pi permits only this reviewed key, not arbitrary bot identities.
  If the key is missing or inaccessible, ask the user to check it in a host terminal. Do not
  create or replace an identity.
- If `whoami` works but a read-only relay command fails, investigate network, TLS, relay, or
  membership errors separately. Do not disable certificate verification. Never infer that the
  key is missing from a network failure.

See `pi/sandbox/README.md` for deployment, security boundaries, and verification.
