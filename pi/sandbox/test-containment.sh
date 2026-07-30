#!/usr/bin/env bash
set -euo pipefail

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SRT="$HERE/node_modules/.bin/srt"
readonly SETTINGS="$HERE/settings.json"
readonly TEST_BIN="$HERE/test-bin"
readonly REPO_ROOT="$(cd "$HERE/../.." && pwd)"
readonly TEST_ROOT="$(mktemp -d)"
readonly OUTSIDE_READ="$REPO_ROOT/.pi-sandbox-read-test.$$"
readonly OUTSIDE_WRITE="$REPO_ROOT/.pi-sandbox-write-test.$$"

cleanup() {
    rm -rf "$TEST_ROOT"
    rm -f "$OUTSIDE_READ" "$OUTSIDE_WRITE"
}
trap cleanup EXIT

[[ -x "$SRT" ]] || {
    echo "sandbox runtime is not installed; run npm ci in $HERE" >&2
    exit 1
}

printf 'must remain unreadable\n' >"$OUTSIDE_READ"

(
    cd "$TEST_ROOT"

    PATH="$TEST_BIN:$PATH" "$SRT" --settings "$SETTINGS" -- bash -c '
        set -e
        printf "workspace\n" > allowed
        test "$(cat allowed)" = workspace
    '

    if PATH="$TEST_BIN:$PATH" "$SRT" --settings "$SETTINGS" -- \
        bash -c 'cat "$1" >/dev/null' _ "$OUTSIDE_READ"
    then
        echo "sandbox unexpectedly read outside the workspace" >&2
        exit 1
    fi

    if PATH="$TEST_BIN:$PATH" "$SRT" --settings "$SETTINGS" -- \
        bash -c 'printf denied >"$1"' _ "$OUTSIDE_WRITE"
    then
        echo "sandbox unexpectedly wrote outside the workspace" >&2
        exit 1
    fi

    if [[ "$OSTYPE" == darwin* && -t 0 ]]; then
        PATH="$TEST_BIN:$PATH" "$SRT" --settings "$SETTINGS" -- node -e '
            if (!process.stdin.isTTY || !process.stdin.setRawMode) {
                throw new Error("stdin is not a raw-mode-capable TTY");
            }
            let raw = false;
            try {
                process.stdin.setRawMode(true);
                raw = true;
            } finally {
                if (raw) process.stdin.setRawMode(false);
            }
        '
    elif [[ "$OSTYPE" == darwin* ]]; then
        echo "skipping raw-mode check because stdin is not a TTY" >&2
    fi

    PATH="$TEST_BIN:$PATH" "$SRT" --settings "$SETTINGS" -- \
        curl -fsSI https://pypi.org/ >/dev/null

    if PATH="$TEST_BIN:$PATH" "$SRT" --settings "$SETTINGS" -- \
        curl -fsSI https://example.com/ >/dev/null 2>&1
    then
        echo "sandbox unexpectedly reached an unlisted domain" >&2
        exit 1
    fi
)

[[ ! -e "$OUTSIDE_WRITE" ]]
echo "containment tests passed"
