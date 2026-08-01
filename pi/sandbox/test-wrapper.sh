#!/usr/bin/env bash
set -euo pipefail

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly WRAPPER="$(cd "$HERE/../.." && pwd)/bin/pi"
readonly TEST_ROOT="$(mktemp -d)"

cleanup() {
    rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

readonly TEST_HOME="$TEST_ROOT/home"
readonly REAL_BIN="$TEST_ROOT/real-bin"
readonly PREREQ_BIN="$TEST_ROOT/prereq-bin"
readonly SHIM_BIN="$TEST_ROOT/workspace"
readonly WRAPPER_BIN="$(dirname "$WRAPPER")"
readonly TOOL_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p \
    "$TEST_HOME/.pi/sandbox/node_modules/.bin" \
    "$REAL_BIN" \
    "$PREREQ_BIN" \
    "$SHIM_BIN"
printf '{}\n' >"$TEST_HOME/.pi/sandbox/settings.json"

cat >"$TEST_HOME/.pi/sandbox/node_modules/.bin/srt" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

[[ "$1" == "--settings" ]]
[[ -r "$2" ]]
[[ "$3" == "--" ]]
shift 3
exec "$@"
EOF

cat >"$REAL_BIN/pi" <<'EOF'
#!/usr/bin/env bash
printf 'real=%s\n' "$0"
printf 'args='
printf '<%s>' "$@"
printf '\n'
printf 'secret=%s\n' "${SECRET_SHOULD_NOT_LEAK-unset}"
printf 'tmpdir=%s\n' "$TMPDIR"
printf 'path=%s\n' "$PATH"
printf 'herdr_env=%s\n' "${HERDR_ENV-unset}"
printf 'herdr_socket=%s\n' "${HERDR_SOCKET_PATH-unset}"
printf 'herdr_pane=%s\n' "${HERDR_PANE_ID-unset}"
EOF

cat >"$SHIM_BIN/node" <<'EOF'
#!/bin/sh
echo "workspace node ran before sandbox initialization" >&2
exit 97
EOF

cat >"$SHIM_BIN/rg" <<'EOF'
#!/bin/sh
echo "workspace rg ran before sandbox initialization" >&2
exit 97
EOF

cat >"$SHIM_BIN/bash-env" <<'EOF'
echo "BASH_ENV ran before sandbox initialization" >&2
exit 97
EOF

chmod +x \
    "$TEST_HOME/.pi/sandbox/node_modules/.bin/srt" \
    "$REAL_BIN/pi" \
    "$SHIM_BIN/node" \
    "$SHIM_BIN/rg"
readonly RESOLVED_REAL_BIN="$(cd "$REAL_BIN" && pwd -P)"

output="$(
    cd "$SHIM_BIN"
    HOME="$TEST_HOME" \
    PATH="$SHIM_BIN:$WRAPPER_BIN:$REAL_BIN:$TOOL_PATH" \
    BASH_ENV="$SHIM_BIN/bash-env" \
    SECRET_SHOULD_NOT_LEAK="leak" \
    HERDR_ENV= \
    HERDR_SOCKET_PATH= \
    HERDR_PANE_ID= \
    "$WRAPPER" --flag "two words"
)"

grep -F "real=$RESOLVED_REAL_BIN/pi" <<<"$output" >/dev/null
grep -F 'args=<--flag><two words>' <<<"$output" >/dev/null
grep -F 'secret=unset' <<<"$output" >/dev/null
grep -F 'tmpdir=/tmp' <<<"$output" >/dev/null
grep -F "path=$RESOLVED_REAL_BIN:" <<<"$output" >/dev/null
grep -F 'herdr_env=unset' <<<"$output" >/dev/null
grep -F 'herdr_socket=unset' <<<"$output" >/dev/null
grep -F 'herdr_pane=unset' <<<"$output" >/dev/null

herdr_output="$(
    cd "$SHIM_BIN"
    HOME="$TEST_HOME" \
    PATH="$SHIM_BIN:$WRAPPER_BIN:$REAL_BIN:$TOOL_PATH" \
    HERDR_ENV=1 \
    HERDR_SOCKET_PATH="$TEST_ROOT/herdr.sock" \
    HERDR_PANE_ID="pane-7" \
    "$WRAPPER"
)"
grep -F 'herdr_env=1' <<<"$herdr_output" >/dev/null
grep -F "herdr_socket=$TEST_ROOT/herdr.sock" <<<"$herdr_output" >/dev/null
grep -F 'herdr_pane=pane-7' <<<"$herdr_output" >/dev/null

rm "$TEST_HOME/.pi/sandbox/node_modules/.bin/srt"
if HOME="$TEST_HOME" \
    PATH="$WRAPPER_BIN:$REAL_BIN:$TOOL_PATH" \
    "$WRAPPER" --version >"$TEST_ROOT/fail.out" 2>&1
then
    echo "wrapper unexpectedly ran without SRT" >&2
    exit 1
fi

grep -F 'sandbox runtime is not installed' "$TEST_ROOT/fail.out" >/dev/null
! grep -F 'real=' "$TEST_ROOT/fail.out" >/dev/null

mkdir -p "$TEST_HOME/.pi/sandbox/node_modules/.bin"
cp "$HERE/test-bin/which" "$TEST_HOME/.pi/sandbox/node_modules/.bin/srt"
chmod +x "$TEST_HOME/.pi/sandbox/node_modules/.bin/srt"
printf '#!/bin/sh\nexec %q "$@"\n' "$(command -v node)" >"$PREREQ_BIN/node"
printf '#!/bin/sh\nexit 0\n' >"$PREREQ_BIN/rg"
chmod +x "$PREREQ_BIN/node" "$PREREQ_BIN/rg"

if HOME="$TEST_HOME" \
    PATH="$WRAPPER_BIN:$PREREQ_BIN:/usr/bin:/bin" \
    "$WRAPPER" --version >"$TEST_ROOT/no-pi.out" 2>&1
then
    echo "wrapper unexpectedly ran without a real Pi binary" >&2
    exit 1
fi

grep -F 'cannot find the installed Pi binary' "$TEST_ROOT/no-pi.out" >/dev/null

echo "wrapper tests passed"
