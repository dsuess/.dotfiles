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
readonly FIRST_SAFE_BIN="$TEST_ROOT/first-safe-bin"
readonly SECOND_SAFE_BIN="$TEST_ROOT/second-safe-bin"
readonly RELATIVE_BIN="$SHIM_BIN/relative-bin"
readonly WRAPPER_BIN="$(dirname "$WRAPPER")"
readonly TOOL_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

node -e '
const settings = require(process.argv[1]);
if (!settings.filesystem.allowWrite.includes("~/.dotfiles/pi/agent")) {
  throw new Error("Stow source for Pi agent state must be writable");
}
' "$HERE/settings.json"

mkdir -p \
    "$TEST_HOME/.pi/sandbox/node_modules/.bin" \
    "$TEST_HOME/.pi/agent/sessions" \
    "$REAL_BIN" \
    "$PREREQ_BIN" \
    "$SHIM_BIN" \
    "$FIRST_SAFE_BIN" \
    "$SECOND_SAFE_BIN" \
    "$RELATIVE_BIN" \
    "$TEST_ROOT/tmp"
printf '{}\n' >"$TEST_HOME/.pi/agent/settings.json"
cat >"$TEST_HOME/.pi/sandbox/settings.json" <<'EOF'
{
  "network": {"allowedDomains": [], "deniedDomains": [], "strictAllowlist": true},
  "filesystem": {
    "denyRead": ["~"],
    "allowRead": ["."],
    "allowWrite": [".", "/tmp"],
    "denyWrite": [],
    "allowGitConfig": false
  }
}
EOF
cp "$HERE/herdr-status-broker.mjs" "$TEST_HOME/.pi/sandbox/herdr-status-broker.mjs"
cat >"$TEST_HOME/.pi/sandbox/unrestricted-network.mjs" <<'EOF'
#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] !== "--settings" || args[2] !== "--") process.exit(2);
const result = spawnSync(args[3], args.slice(4), { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
EOF

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
if [[ "$*" == *"--list-models"* ]]; then
    printf 'Provider Model\n'
    printf 'openai-codex gpt-5.6-sol\n'
    printf 'openai-codex gpt-5.6-terra\n'
    exit 0
fi
printf 'real=%s\n' "$0"
printf 'args='
printf '<%s>' "$@"
printf '\n'
printf 'default_injected=%s\n' "${PI_PLAN_MODE_DEFAULT_MODEL-unset}"
printf 'secret=%s\n' "${SECRET_SHOULD_NOT_LEAK-unset}"
printf 'tmpdir=%s\n' "$TMPDIR"
printf 'path=%s\n' "$PATH"
printf 'herdr_env=%s\n' "${HERDR_ENV-unset}"
printf 'herdr_socket=%s\n' "${HERDR_SOCKET_PATH-unset}"
printf 'herdr_pane=%s\n' "${HERDR_PANE_ID-unset}"
printf 'herdr_status_port=%s\n' "${HERDR_PI_STATUS_PORT-unset}"
printf 'herdr_status_token=%s\n' "${HERDR_PI_STATUS_TOKEN-unset}"
if [[ "$*" == *"--path-order-probe"* ]]; then
    printf 'git_resolution=%s\n' "$(command -v git || printf absent)"
    printf 'git_marker=%s\n' "$(git)"
    printf 'pi_resolution=%s\n' "$(command -v pi || printf absent)"
fi
if [[ "$*" == *"--relative-path-probe"* ]]; then
    printf 'relative_probe=%s\n' "$(command -v relative-path-probe || printf absent)"
fi
EOF

cat >"$FIRST_SAFE_BIN/git" <<'EOF'
#!/bin/sh
printf 'first-safe\n'
EOF

cat >"$SECOND_SAFE_BIN/git" <<'EOF'
#!/bin/sh
printf 'second-safe\n'
EOF

cat >"$RELATIVE_BIN/relative-path-probe" <<'EOF'
#!/bin/sh
printf 'repository-relative\n'
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
    "$FIRST_SAFE_BIN/git" \
    "$SECOND_SAFE_BIN/git" \
    "$RELATIVE_BIN/relative-path-probe" \
    "$SHIM_BIN/node" \
    "$SHIM_BIN/rg"
readonly RESOLVED_REAL_BIN="$(cd "$REAL_BIN" && pwd -P)"
readonly RESOLVED_WRAPPER_BIN="$(cd "$WRAPPER_BIN" && pwd -P)"
readonly RESOLVED_FIRST_SAFE_BIN="$(cd "$FIRST_SAFE_BIN" && pwd -P)"
readonly RESOLVED_SECOND_SAFE_BIN="$(cd "$SECOND_SAFE_BIN" && pwd -P)"

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
grep -F 'herdr_status_port=unset' <<<"$output" >/dev/null
grep -F 'herdr_status_token=unset' <<<"$output" >/dev/null

path_order_output="$(
    cd "$SHIM_BIN"
    HOME="$TEST_HOME" \
    PATH="$SHIM_BIN:$WRAPPER_BIN:$REAL_BIN:$FIRST_SAFE_BIN:$SECOND_SAFE_BIN:$FIRST_SAFE_BIN:$TOOL_PATH" \
    HERDR_ENV= \
    HERDR_SOCKET_PATH= \
    HERDR_PANE_ID= \
    "$WRAPPER" --path-order-probe
)"
grep -F "path=$RESOLVED_REAL_BIN:$RESOLVED_WRAPPER_BIN:$RESOLVED_FIRST_SAFE_BIN:$RESOLVED_SECOND_SAFE_BIN:" <<<"$path_order_output" >/dev/null
grep -F "git_resolution=$RESOLVED_FIRST_SAFE_BIN/git" <<<"$path_order_output" >/dev/null
grep -F 'git_marker=first-safe' <<<"$path_order_output" >/dev/null
grep -F "pi_resolution=$RESOLVED_REAL_BIN/pi" <<<"$path_order_output" >/dev/null
[[ "$(grep '^path=' <<<"$path_order_output" | grep -oF "$RESOLVED_FIRST_SAFE_BIN" | wc -l | tr -d ' ')" == 1 ]]

relative_path_output="$(
    cd "$SHIM_BIN"
    HOME="$TEST_HOME" \
    PATH="relative-bin:$WRAPPER_BIN:$REAL_BIN:$TOOL_PATH" \
    HERDR_ENV= \
    HERDR_SOCKET_PATH= \
    HERDR_PANE_ID= \
    "$WRAPPER" --relative-path-probe
)"
grep -F 'relative_probe=absent' <<<"$relative_path_output" >/dev/null

herdr_output="$(
    cd "$SHIM_BIN"
    HOME="$TEST_HOME" \
    PATH="$SHIM_BIN:$WRAPPER_BIN:$REAL_BIN:$TOOL_PATH" \
    TMPDIR="$TEST_ROOT/tmp" \
    HERDR_ENV=1 \
    HERDR_SOCKET_PATH="$TEST_ROOT/herdr.sock" \
    HERDR_PANE_ID="pane-7" \
    "$WRAPPER"
)"
grep -F 'herdr_env=1' <<<"$herdr_output" >/dev/null
grep -F 'herdr_socket=unset' <<<"$herdr_output" >/dev/null
grep -F 'herdr_pane=pane-7' <<<"$herdr_output" >/dev/null
grep -E '^herdr_status_port=[0-9]+$' <<<"$herdr_output" >/dev/null
grep -E '^herdr_status_token=[0-9a-f]{64}$' <<<"$herdr_output" >/dev/null
for _ in {1..100}; do
    compgen -G "$TEST_ROOT/tmp/pi-herdr-status.*" >/dev/null || break
    sleep 0.01
done
if compgen -G "$TEST_ROOT/tmp/pi-herdr-status.*" >/dev/null; then
    echo "Herdr status broker did not exit with its wrapper parent" >&2
    exit 1
fi

rm "$TEST_HOME/.pi/sandbox/node_modules/.bin/srt"
yolo_output="$(
    cd "$SHIM_BIN"
    HOME="$TEST_HOME" \
    PATH="$SHIM_BIN:$WRAPPER_BIN:$REAL_BIN:$TOOL_PATH" \
    TMPDIR="$TEST_ROOT/host-tmp" \
    SECRET_SHOULD_NOT_LEAK="host-secret" \
    "$WRAPPER" --yolo --flag "two words"
)"
grep -F "real=$RESOLVED_REAL_BIN/pi" <<<"$yolo_output" >/dev/null
grep -F 'args=<--flag><two words>' <<<"$yolo_output" >/dev/null
grep -F 'secret=host-secret' <<<"$yolo_output" >/dev/null
grep -F "tmpdir=$TEST_ROOT/host-tmp" <<<"$yolo_output" >/dev/null
grep -F "path=$SHIM_BIN:$WRAPPER_BIN:$REAL_BIN:$TOOL_PATH" <<<"$yolo_output" >/dev/null

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

cat >"$TEST_HOME/.pi/agent/settings.json" <<'EOF'
{
  "enabledModels": [
    "openai-codex/gpt-5.6-sol",
    "openai-codex/gpt-5.6-terra"
  ],
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.6-terra",
  "defaultThinkingProvider": "openai-codex",
  "defaultThinkingModel": "gpt-5.6-sol",
  "defaultThinkingLevel": "high"
}
EOF
model_output="$(
    HOME="$TEST_HOME" PATH="$WRAPPER_BIN:$REAL_BIN:$TOOL_PATH" "$WRAPPER" --flag ordinary
)"
grep -F 'args=<--models><openai-codex/gpt-5.6-sol,openai-codex/gpt-5.6-terra><--model><openai-codex/gpt-5.6-terra><--thinking><high><--flag><ordinary>' <<<"$model_output" >/dev/null
grep -F 'default_injected=1' <<<"$model_output" >/dev/null
plan_output="$(
    HOME="$TEST_HOME" PATH="$WRAPPER_BIN:$REAL_BIN:$TOOL_PATH" "$WRAPPER" --plan
)"
grep -F 'args=<--models><openai-codex/gpt-5.6-sol,openai-codex/gpt-5.6-terra><--model><openai-codex/gpt-5.6-sol><--thinking><high><--plan>' <<<"$plan_output" >/dev/null
grep -F 'default_injected=1' <<<"$plan_output" >/dev/null
explicit_output="$(
    HOME="$TEST_HOME" PATH="$WRAPPER_BIN:$REAL_BIN:$TOOL_PATH" "$WRAPPER" --plan --model openai-codex/gpt-5.6-terra --thinking max
)"
grep -F 'args=<--models><openai-codex/gpt-5.6-sol,openai-codex/gpt-5.6-terra><--plan><--model><openai-codex/gpt-5.6-terra><--thinking><max>' <<<"$explicit_output" >/dev/null
grep -F 'default_injected=unset' <<<"$explicit_output" >/dev/null
node -e 'const fs = require("node:fs"); const path = process.argv[1]; const settings = JSON.parse(fs.readFileSync(path)); delete settings.defaultThinkingProvider; fs.writeFileSync(path, JSON.stringify(settings));' "$TEST_HOME/.pi/agent/settings.json"
unavailable_plan_output="$(
    HOME="$TEST_HOME" PATH="$WRAPPER_BIN:$REAL_BIN:$TOOL_PATH" "$WRAPPER" --plan
)"
grep -F 'args=<--models><openai-codex/gpt-5.6-sol,openai-codex/gpt-5.6-terra><--plan>' <<<"$unavailable_plan_output" >/dev/null
grep -F 'default_injected=unset' <<<"$unavailable_plan_output" >/dev/null

echo "wrapper tests passed"
