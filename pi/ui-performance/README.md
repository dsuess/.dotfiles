# Pi UI performance checks

## Manual commands

Run the lightweight suite:

```sh
npm --prefix pi run check:ui
```

Before completion, run the full gate from an ordinary host terminal:

```sh
npm --prefix pi run check
```

Both `check` and `check:deterministic` start with the lightweight suite.
The suite uses temporary repositories, actual extension handlers, and an installed Pi runtime with a fake local transport.
It requires Node, Git, and the installed Pi test runtime. Missing prerequisites cause failure.
Outside Homebrew installations, `PI_PACKAGE_ROOT` identifies the installed Pi package.

## Fixed regression inputs

- Footer: 20,000 branch entries, 200 redraws, zero history scans or context projections, less than 100ms.
- Capture: seven tracked text files, three serialized repeated prompts, one enumeration and alternate-index load per capture, less than 1s.
- Cold capture: separate timing report, not part of the repeated-prompt budget.
- Transitions: text edits, binary content, attributes, cancellation, and rapid consecutive submissions.
- Runtime: checkpoint persistence before agent start, then a 120ms fake provider delay.
- Sensitivity: a disposable expensive footer must fail the structural assertion.

The runner terminates the suite process group after 30 seconds. Existing correctness suites remain separate.
Timings measure local preparation, not live provider latency or end-to-end interactive responsiveness.

## Test-only execution

The suite runs only through explicit test commands.
`check:ui`, `check:deterministic`, and `check` include these tests.
Pi sessions do not watch source saves or run the suite in the background.
Configuration deployment does not install a Git hook for these tests.
