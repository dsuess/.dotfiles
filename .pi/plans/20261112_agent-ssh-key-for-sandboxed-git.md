# Add a dedicated agent SSH identity for sandboxed Git

## Context

Sandboxed Pi tools currently cannot use SSH for Git. Several controls block it:

- The controller (`pi/sandbox/controller.mjs`, `boundedEnvironment`) clears `SSH_AUTH_SOCK`.
- The SRT policy (`pi/sandbox/srt-policy.mjs`) denies reads under the home directory. Only `~/.ssh/config` and `~/.ssh/known_hosts` are allowlisted through `resolveHostReadManifest` (`pi/sandbox/host-configuration.mjs`).
- Saved grants cannot target `~/.ssh` because it is a protected root in `pi/sandbox/filesystem-grants.mjs`.

As a result, sandboxed `git fetch` and `git push` against `git@github.com` and `git@bitbucket.org` fail. Your normal key, `~/.ssh/id_ed25519`, must stay unavailable to the sandbox.

Research: GitHub deploy keys and Bitbucket repository or project access keys are read-only, but each one covers only one repository or project. Account SSH keys work for every repository the account can access, but they inherit the account's write permission. The user chose account keys. This means the agent key **can push**. Its isolation comes from being a separate key that you can revoke independently. It is not read-only.

Current state:

- `~/.ssh/agent/` exists with mode 0700. It is also OpenSSH's default ssh-agent socket directory, so it contains `s.*` sockets and a `git/` subdirectory. ssh-agent cleans up only stale `s.*` sockets, so a key file in this directory is safe. The new key must not use an `s.` prefix.
- `~/.ssh/known_hosts` already has entries for github.com and bitbucket.org.
- `gh` is authenticated with HTTPS scopes `repo` etc. It does not have `admin:public_key`, so `gh ssh-key add` first needs `gh auth refresh -h github.com -s admin:public_key`. That command needs your interactive browser approval.
- OpenSSH resolves `~/.ssh` from the passwd home, not `$HOME`. The generated sandbox HOME therefore does not hide or provide SSH files. The SSH command must use explicit absolute paths.

Terminology and documentation conflicts:

- `pi/sandbox/README.md` says: "Only the configured signing-key exception may be granted from SSH storage". It also says that tools "do not receive … SSH/GPG agents … credentials".
- `pi/AGENTS.md` says not to expose "SSH agents, credential stores" through grants.

The new identity is not a filesystem grant, and it does not forward an SSH agent. It is a separate, explicitly configured credential exception. The docs must state this exception so that they do not contradict the code.

Accepted risk: sandboxed tools can read the agent private key and push or delete branches anywhere your GitHub and Bitbucket accounts allow. To mitigate this, use a unique key title and comment, so that you can revoke the key in one step.

## Questions & Answers

| Question | Answer |
|---|---|
| Which access level should the agent key have? (account keys: all repos but push-capable; vs. read-only per-repo deploy/access keys) | Account keys (Recommended) |
| Where should the sandbox key path be configured? (sandbox `config.json` vs. fixed `~/.ssh/agent/id_ed25519` convention) | sandbox config.json (Recommended) |
| How should the public keys be registered? (`gh` for GitHub + Bitbucket web UI, vs. manual both) | gh + Bitbucket web (Recommended) |
| (Earlier) Which Bitbucket service? | Bitbucket Cloud |

## Approach

Add an optional `git` section to the versioned sandbox configuration (`pi/sandbox/config.json`), for example:

```json
{ "version": 1, "filesystem": { "readOnly": ["~/.agents"], "readWrite": [] }, "git": { "sshIdentityFile": "~/.ssh/agent/id_ed25519" } }
```

The identity follows the same per-client snapshot semantics as grants. The controller validates it when it composes a client's effective policy. Changes take effect for new clients or after `/sandbox reload`, and the identity file becomes part of the policy generation hash.

When the identity is set, the effective policy does two things:

- It adds exactly that private key file to `allowRead`. The home `denyRead` still covers all other `~/.ssh` contents.
- It adds a controller-owned `GIT_SSH_COMMAND` to the tool environment. That command uses absolute paths:
  - `ssh -F /dev/null -i <key> -o IdentitiesOnly=yes -o IdentityAgent=none -o UserKnownHostsFile=<real ~/.ssh/known_hosts> -o StrictHostKeyChecking=yes`

`-F /dev/null` avoids the unreadable Colima `Include` and host aliases. Strict host checking with the existing read-only known_hosts prevents writes and trust-on-first-use. `GIT_SSH_COMMAND` takes precedence over repository `core.sshCommand`. The controller value must override request-supplied values, so that tools cannot silently use a different identity.

When the section is absent, behavior is exactly as it is now.

### Part A — Create and register the agent key
- **Ledger:** {"status":"completed","note":null,"evidence":"Existing key mode 0600; GitHub lists the matching pi-agent authentication key; explicit identity-only host SSH authenticated as dsuess on GitHub and successfully authenticated on Bitbucket."}

Generate a new ed25519 key on the host at `~/.ssh/agent/id_ed25519`, with an empty passphrase. It must have no passphrase because no agent is available in the sandbox. Use a distinctive comment such as `pi-agent@<hostname>`. Confirm that the private key has mode 0600, and do not overwrite a key that already exists.

For GitHub, you run `gh auth refresh -h github.com -s admin:public_key` interactively. Then run `gh ssh-key add ~/.ssh/agent/id_ed25519.pub --type authentication --title "pi-agent <hostname>"`.

For Bitbucket Cloud, print the public key. You paste it at Personal settings → SSH keys.

Acceptance: from the host, run `ssh -F /dev/null -i ~/.ssh/agent/id_ed25519 -o IdentitiesOnly=yes -o IdentityAgent=none -T` against `git@github.com` and `git@bitbucket.org`. Each one must authenticate as your account. Do not commit private material; nothing from `~/.ssh` enters the repository.

### Part B — Extend the saved configuration schema with `git.sshIdentityFile`
- **Ledger:** {"status":"completed","note":null,"evidence":"Added strict schema, path/mode validation, RPC shape and frozen grant-edit preservation; 30 focused configuration, grant and client-policy tests pass (including new invalid cases and add/remove round trips)."}

In `pi/sandbox/filesystem-grants.mjs` (`validateFilesystemConfiguration`), accept an optional `git` object with exactly one key, `sshIdentityFile`. Other unknown keys still fail. The protocol validator for `policy.prepare` (`pi/sandbox/protocol.mjs`) must accept the same shape.

Validation of the identity file:

- Use the absolute or `~/` path rules.
- The lexical and canonical paths must both be directly inside `~/.ssh/agent/`.
- It must be a regular file, not a symlink that escapes that directory.
- It must have no group or other permission bits.
- Its basename must not start with `s.`.
- Reject `~/.ssh/id_*` and the signing key.

`pi/sandbox/filesystem-configuration.mjs` (`immutableConfig`, `prepareFilesystemGrantChange`) currently rebuilds the configuration from `filesystem` only. It must preserve the `git` section through `/sandbox grants add/remove` edits. Saved bytes remain atomic and preserve the Stow target.

Acceptance: unit tests show that a valid section passes, that every invalid case is rejected, and that a grant add or remove keeps the `git` section unchanged.

### Part C — Compose the identity into the effective policy and tool environment
- **Ledger:** {"status":"completed","note":null,"evidence":"Per-client policies now validate and snapshot the identity, hash the command, allow only its canonical file, and inject it into exec and stdio after overrides. 41 focused tests pass, including native file-boundary and environment checks."}

In `pi/sandbox/client-policy.mjs` (`compose`), pass the validated identity together with the grants to `buildPolicy`. In `pi/sandbox/srt-policy.mjs` (`buildSrtPolicy`), add the canonical key file to `allowRead`. Also expose a frozen `gitSshCommand` value in the returned policy and include it in the generation hash.

In `pi/sandbox/controller.mjs`, `spawnSandbox` and the stdio session spawn pass `effectivePolicy.gitSshCommand` into `boundedEnvironment`. That function sets `GIT_SSH_COMMAND` last when present, so a request override cannot replace it. When no identity is configured, a request may still supply its own value; current behavior stays unchanged. `SSH_AUTH_SOCK` stays empty.

Set `git.sshIdentityFile` in the tracked `pi/sandbox/config.json`.

Acceptance: policy tests show that only the key file under `~/.ssh` is readable. Siblings such as `id_ed25519` remain denied. Controller lifecycle tests show that `GIT_SSH_COMMAND` reaches the tool, that it overrides a request value, and that it is absent when the section is not configured.

### Part D — Update sandbox documentation and repository rules
- **Ledger:** {"status":"blocked","note":"User deferred restarting Pi; the specified restarted-session canary and full native Docker gate remain unverified. Shared srt-policy.mjs also acquired concurrent unrelated Buzz changes, so a scoped commit needs care.","evidence":"Rechecked host SSH: GitHub and Bitbucket both authenticate. Sandbox suite passed 237 tests, 5 skipped. Fresh SRT controller without Docker passed GitHub/Bitbucket ls-remote, primary-key denial, empty SSH_AUTH_SOCK, and direct SSH denial. node pi/test-gate.mjs completed deterministic checks but native Docker routing fails because the pi-srt app is not signed in and its policy is uninitialized. User deferred restarting Pi."}

Update `pi/sandbox/README.md` in two places:

- The security contract: describe the optional agent Git identity exception, its location restrictions, its push-capable nature, and the fact that SSH agents are still never forwarded.
- The saved configuration section: state that the schema now includes an optional `git.sshIdentityFile`, and explain its snapshot and reload behavior.

Add a matching rule to `pi/AGENTS.md`: the only SSH private material readable by sandboxed tools is the configured `~/.ssh/agent/` identity. Never expose the user's primary keys or agent socket.

Commit this plan document together with the implementation, following the repository rule. Do not run `./install.sh` from the sandboxed session. The existing Stow symlink for `~/.pi/sandbox/config.json` already points to the tracked file.

## Critical Files

- `pi/sandbox/filesystem-grants.mjs` / `pi/sandbox/filesystem-configuration.mjs` — schema validation and preserving the section through grant edits.
- `pi/sandbox/protocol.mjs` — the `policy.prepare` shape check, which must accept the new section.
- `pi/sandbox/client-policy.mjs`, `pi/sandbox/srt-policy.mjs` — per-client effective policy: read allowance and generation.
- `pi/sandbox/controller.mjs` (`boundedEnvironment`) — injection of `GIT_SSH_COMMAND`.
- `pi/sandbox/config.json`, `pi/sandbox/README.md`, `pi/AGENTS.md` — configuration and documented contract.

## Verification

Regression checks:

- `npm --prefix pi/sandbox test` and `node pi/test-gate.mjs` pass.
- Existing grant edit, protected-root, and `SSH_AUTH_SOCK` tests are unchanged and pass.

New feature scenarios (unit tests):

- A config with the `git` section validates. A symlink or path outside `~/.ssh/agent`, a key with mode 0644, an `s.*` name, or an extra key is rejected.
- A grant add or remove preserves `git` in the saved bytes.
- The policy reads the key file, but `~/.ssh/id_ed25519` stays denied.
- The tool environment contains a controller-owned `GIT_SSH_COMMAND` that overrides a request value.

End-to-end canary (after restarting Pi):

- In a sandboxed session, `ssh -T git@github.com` fails as before, because it does not use the identity. `git ls-remote git@github.com:dsuess/.dotfiles.git` succeeds.
- `git ls-remote` against a Bitbucket repository succeeds.
- `cat ~/.ssh/id_ed25519` is still denied.
- `echo $SSH_AUTH_SOCK` is empty.

Failure signals:

- `Host key verification failed` means a known_hosts entry is missing or the path is wrong. Do not relax `StrictHostKeyChecking`.
- `Permission denied (publickey)` means registration did not complete, or the policy read allowance is missing.
- If ssh reports that it cannot read the Colima include, `-F /dev/null` was not applied.

<!-- pi-plan-mode:progress:start -->
## Part Progress

- ☑ Create and register the agent key
- ☑ Extend the saved configuration schema with `git.sshIdentityFile`
- ☑ Compose the identity into the effective policy and tool environment
- ⛔ Update sandbox documentation and repository rules
<!-- pi-plan-mode:progress:end -->
