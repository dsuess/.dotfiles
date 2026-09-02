# Fix bin/pi Startup Lock Race and Recursive Relaunch Loop

## Context

`bin/pi --yolo` failed with `Error: timed out waiting for controller startup
lock` from `withStartupLock` in `pi/sandbox/client.mjs`. That function acquires
a `mkdirSync`-based mutex and self-heals an orphaned lock once its directory's
mtime exceeds a 10s staleness threshold, but the overall wait loop was capped
at a fixed 300 attempts × 20ms = 6000ms before throwing — shorter than the
10s staleness threshold it depends on. Any legitimate holder (spawning the
controller, waiting for it to publish state) taking 6-10s, which is realistic
under load, made every other waiter give up before the lock could ever be
recognized as stale and reclaimed.

Fixing that alone did not resolve the reported symptom of `bin/pi --yolo`
"still hanging." Live diagnosis (`ps aux`, `bash -x bin/pi`) found a second,
unrelated, more serious bug: an infinite recursive re-exec loop in `bin/pi`'s
`find_real_pi()`. `/Users/dsuess/bin/pi` is a separate, hand-written, untracked
host wrapper (a real file, not a stow symlink) that defaults to a specific
litellm provider/model and then `exec`s into `~/.dotfiles/bin/pi`. It sits
earlier on `$PATH` than the actual installed Pi binary
(`/opt/homebrew/bin/pi`). `find_real_pi()` only excluded its own resolved path
and anything under `~/.dotfiles`/cwd, so it picked this wrapper as "real,"
which exec'd straight back into `~/.dotfiles/bin/pi` — forever. Each cycle
prepended another `~/Users/dsuess/bin:` onto `$PATH` and another
`--no-builtin-tools` flag onto argv; a live repro accumulated 1188 such flags
over 7 minutes and was still growing.

## Approach

Two independent, narrowly-scoped fixes, both in this commit:

**`pi/sandbox/client.mjs` (`withStartupLock`)** — replace the fixed
300-attempt loop with a time-based deadline derived from the same staleness
constant (`staleMs + 5_000` margin), so the wait budget can never again drift
below the staleness threshold it depends on.

**`bin/pi` (`find_real_pi`)** — track every resolved "pi" path already
exec'd through in this launch chain via a `PI_LAUNCHER_CHAIN` env var
(colon-separated, seeded with `self`, extended with the chosen `real_pi`
before every exec). `find_real_pi()` skips any candidate already present in
that chain. This is a general loop-breaker — it does not hardcode
`~/bin/pi` — so it handles any depth of host-wrapper bounce-back, not just
this specific one.

## Critical Files

- `pi/sandbox/client.mjs` — `withStartupLock` (workspace startup mutex).
- `bin/pi` — `find_real_pi` and the `chain`/`PI_LAUNCHER_CHAIN` plumbing
  around both `exec` sites (the `--yolo` branch and the final SRT-routed
  handoff).

## Verification

- Reproduced the lock race in a throwaway harness: a waiter against an 8s
  legitimate hold threw under the old fixed-attempt-count logic (~7s) and
  succeeded under the new time-based deadline (~8s).
- Ran `beginControllerStartup` directly against the live `~/.dotfiles`
  workspace — succeeds, confirming no regression.
- Killed the live runaway process (pid 10485, 1188 accumulated
  `--no-builtin-tools` flags); confirmed no stale lock was left behind and
  the underlying controller for this workspace was healthy throughout.
- Re-ran `bash -x bin/pi --yolo --version`: `find_real_pi()` visibly skips
  `/Users/dsuess/bin/pi` on the second pass (already in
  `PI_LAUNCHER_CHAIN`) and resolves to `/opt/homebrew/bin/pi`, producing
  clean output (`0.84.4`) with a non-repeating `PATH` and no leftover
  processes afterward.
- `grep -rn "withStartupLock" pi/` confirms the function has exactly one
  caller (`beginControllerStartup`), so no other code depends on the old
  attempt-count timing.
