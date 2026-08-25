#!/usr/bin/env bash
set -euo pipefail

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly WRAPPER="$(cd "$HERE/../.." && pwd)/bin/pi"
readonly WRAPPER_BIN="$(dirname "$WRAPPER")"
readonly TEST_ROOT="$(mktemp -d)"
readonly HOST_NODE="$(command -v node)"
readonly HOST_GIT="$(command -v git)"
readonly HOST_RG="$(command -v rg)"
readonly HOST_MKTEMP="$(command -v mktemp)"
readonly HOST_AWK="$(command -v awk)"
readonly HOST_GREP="$(command -v grep)"
readonly HOST_ENV="$(command -v env)"

cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT

readonly TEST_HOME="$TEST_ROOT/home"
readonly SANDBOX_HOME="$TEST_HOME/.pi/sandbox"
readonly AGENT_HOME="$TEST_HOME/.pi/agent"
readonly REAL_BIN="$TEST_ROOT/real-bin"
readonly TRUSTED_BIN="$TEST_ROOT/trusted-bin"
readonly NO_QEMU_BIN="$TEST_ROOT/no-qemu-bin"
readonly SHIM_BIN="$TEST_ROOT/workspace"
readonly FIRST_SAFE_BIN="$TEST_ROOT/first-safe-bin"
readonly SECOND_SAFE_BIN="$TEST_ROOT/second-safe-bin"
readonly TOOL_PATH="/usr/bin:/bin"
readonly CLIENT_LOG="$TEST_ROOT/client.log"
readonly REAL_PI_LOG="$TEST_ROOT/real-pi.log"
readonly IMAGE_VERIFY_LOG="$TEST_ROOT/image-verify.log"
readonly RUNTIME_ROOT="$TEST_ROOT/runtime"
readonly IMAGE_DIR="$TEST_ROOT/image"
readonly MODEL_SCOPE_CACHE="$TEST_HOME/.cache/pi-gondolin/model-scope.json"

mkdir -p \
    "$SANDBOX_HOME" \
    "$AGENT_HOME/extensions/gondolin-sandbox" \
    "$AGENT_HOME/sessions" \
    "$REAL_BIN" "$TRUSTED_BIN" "$NO_QEMU_BIN" "$SHIM_BIN" \
    "$FIRST_SAFE_BIN" "$SECOND_SAFE_BIN" "$RUNTIME_ROOT" "$IMAGE_DIR"
cat >"$AGENT_HOME/settings.json" <<'JSON'
{
  "enabledModels": [
    "openai-codex/gpt-5.6-luna",
    "openai-codex/gpt-5.6-terra",
    "openai-codex/gpt-5.6-sol",
    "openai/gpt-5.6-luna",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.6-sol",
    "zai/glm-5.2",
    "zai/glm-5.3",
    "anthropic/claude-fable-5",
    "anthropic/claude-opus-5",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-haiku-4-5"
  ],
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.6-sol",
  "defaultThinkingProvider": "openai-codex",
  "defaultThinkingModel": "gpt-5.6-sol",
  "defaultThinkingLevel": "xhigh"
}
JSON
cat >"$AGENT_HOME/auth.json" <<'JSON'
{
  "zai": { "type": "api_key", "key": "fixture-zai-secret" },
  "openai-codex": { "type": "oauth", "access": "fixture-oauth-secret" }
}
JSON
printf '{"providers":{}}\n' >"$AGENT_HOME/models.json"
printf 'export default function () {}\n' >"$AGENT_HOME/extensions/gondolin-sandbox/index.ts"
cp "$HERE/repository-scope.mjs" "$SANDBOX_HOME/repository-scope.mjs"
cp "$HERE/model-scope-cache.mjs" "$SANDBOX_HOME/model-scope-cache.mjs"
printf '{}\n' >"$SANDBOX_HOME/controller.mjs"
cat >"$SANDBOX_HOME/settings.json" <<'JSON'
{
  "version": 1,
  "externalMounts": [],
  "network": {
    "mode": "public-http",
    "allowedHosts": [],
    "allowWebSockets": false,
    "tcpMappings": []
  }
}
JSON

write_exec_wrapper() {
    local destination="$1" executable="$2"
    printf '#!/bin/bash\nexec %q "$@"\n' "$executable" >"$destination"
    chmod +x "$destination"
}

for directory in "$TRUSTED_BIN" "$NO_QEMU_BIN"; do
    write_exec_wrapper "$directory/node" "$HOST_NODE"
    write_exec_wrapper "$directory/rg" "$HOST_RG"
    write_exec_wrapper "$directory/mktemp" "$HOST_MKTEMP"
    write_exec_wrapper "$directory/git" "$HOST_GIT"
    write_exec_wrapper "$directory/awk" "$HOST_AWK"
    write_exec_wrapper "$directory/grep" "$HOST_GREP"
    write_exec_wrapper "$directory/env" "$HOST_ENV"
done
printf '#!/bin/sh\nexit 0\n' >"$TRUSTED_BIN/qemu-system-aarch64"
printf '#!/bin/sh\nexit 0\n' >"$TRUSTED_BIN/qemu-system-x86_64"
chmod +x "$TRUSTED_BIN/qemu-system-aarch64" "$TRUSTED_BIN/qemu-system-x86_64"


cat >"$SANDBOX_HOME/client-cli.mjs" <<EOF_CLIENT
#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const command = args.shift();
fs.appendFileSync("$CLIENT_LOG", command + " " + args.join(" ") + "\\n");
if (!fs.existsSync("$TEST_ROOT/controller-active")) {
  fs.appendFileSync("$IMAGE_VERIFY_LOG", "verify\\n");
  fs.writeFileSync("$TEST_ROOT/controller-active", "active");
}
const get = (name) => args[args.indexOf(name) + 1];
const launch = fs.realpathSync(get("--launch-dir"));
fs.mkdirSync("$RUNTIME_ROOT", { recursive: true, mode: 0o700 });
const startup = {
  version: 1,
  socketPath: "$RUNTIME_ROOT/controller.sock",
  manifestPath: "$RUNTIME_ROOT/controller.json",
  workspaceKey: createHash("sha256").update(JSON.stringify([launch, null])).digest("hex"),
  workspaceRoot: launch,
  bareCommonDirectory: null,
  runtimeRoot: "$RUNTIME_ROOT"
};
if (command === "preflight") {
  let models = "";
  if (args.includes("--resolve-model-scope")) {
    const { resolveModelScope } = await import("$SANDBOX_HOME/model-scope-cache.mjs");
    models = (await resolveModelScope({
      piPath: get("--pi"), settingsPath: get("--settings"), authPath: get("--auth"),
      modelsPath: get("--models"), cachePath: get("--cache"),
    })).models.join(",");
  }
  const handshakeDirectory = "$RUNTIME_ROOT/handshake-" + process.pid;
  fs.mkdirSync(handshakeDirectory, { recursive: true, mode: 0o700 });
  process.stdout.write([
    Buffer.from(JSON.stringify(startup)).toString("base64"), handshakeDirectory + "/ready.json", models,
  ].join("\\t") + "\\n");
} else {
  process.stdout.write(JSON.stringify(startup) + "\\n");
}
EOF_CLIENT

cat >"$REAL_BIN/pi" <<EOF_PI
#!/usr/bin/env bash
set -euo pipefail
if [[ "\$*" == *"--list-models"* && "\$*" == *"--no-extensions"* ]]; then
    printf 'metadata\n' >>"$REAL_PI_LOG"
    printf 'provider model context max-out thinking images\\n'
    printf 'other unrelated 1K 1K no no\\n'
    printf 'zai glm-5.3 1M 128K yes no\\n'
    printf 'openai-codex gpt-5.6-sol 272K 128K yes yes\\n'
    printf 'zai glm-5.2 1M 128K yes no\\n'
    printf 'openai-codex gpt-5.6-luna 272K 128K yes yes\\n'
    printf 'openai-codex gpt-5.6-terra 272K 128K yes yes\\n'
    if grep -q '"anthropic"' "$AGENT_HOME/auth.json"; then
        printf 'anthropic claude-fable-5 200K 64K yes yes\\n'
        printf 'anthropic claude-opus-5 200K 64K yes yes\\n'
        printf 'anthropic claude-sonnet-5 200K 64K yes yes\\n'
        printf 'anthropic claude-haiku-4-5 200K 64K yes yes\\n'
    fi
    exit 0
fi
printf 'session\n' >>"$REAL_PI_LOG"
if [[ "\$*" == *"--list-models"* ]]; then
    printf 'list_args='; printf '<%s>' "\$@"; printf '\\n'
    printf 'provider model context max-out thinking images\\n'
    printf 'openai-codex gpt-5.6-sol 272K 128K yes yes\\n'
    printf 'other unrelated 1K 1K no no\\n'
    exit 0
fi
if [[ -e "$TEST_ROOT/no-handshake" ]]; then
    exit 0
fi
if [[ -n "\${PI_GONDOLIN_HANDSHAKE_FILE-}" && ! -e "$TEST_ROOT/no-handshake" && ! -e "$TEST_ROOT/fail-image" ]]; then
    node -e '
      const fs = require("node:fs");
      const descriptor = JSON.parse(Buffer.from(process.env.PI_GONDOLIN_STARTUP_DESCRIPTOR, "base64").toString("utf8"));
      const mismatch = fs.existsSync(process.argv[1]);
      const write = () => { fs.appendFileSync("$REAL_PI_LOG", "handshake\\n"); fs.writeFileSync(process.env.PI_GONDOLIN_HANDSHAKE_FILE, JSON.stringify({
        ok: true, workspaceKey: descriptor.workspaceKey, workspaceRoot: descriptor.workspaceRoot,
        policyGeneration: "c".repeat(64), imageGeneration: "d".repeat(64),
        vmId: mismatch ? "" : "fake-vm-id", dockerHealthy: true,
        tools: ["read", "write", "edit", "bash", "grep", "find", "ls"]
      })); };
      if (fs.existsSync(process.argv[2])) setTimeout(write, 200); else write();
    ' "$TEST_ROOT/bad-handshake" "$TEST_ROOT/delay-ready"
fi
printf 'real=%s\\n' "\$0"
printf 'cwd=%s\\n' "\$PWD"
printf 'args='; printf '<%s>' "\$@"; printf '\\n'
printf 'secret=%s\\n' "\${SECRET_SHOULD_NOT_LEAK-unset}"
printf 'project_adc=%s\\n' "\${GOOGLE_APPLICATION_CREDENTIALS-unset}"
printf 'node_options=%s\\n' "\${NODE_OPTIONS-unset}"
printf 'tmpdir=%s\\n' "\${TMPDIR-unset}"
printf 'path=%s\\n' "\$PATH"
printf 'builtins=%s\\n' "\${PI_GONDOLIN_BUILTIN_TOOLS-unset}"
printf 'host_tools=%s\\n' "\${PI_GONDOLIN_HOST_TOOLS-unset}"
printf 'sandbox=%s\\n' "\${PI_GONDOLIN_SANDBOX-unset}"
printf 'descriptor=%s\\n' "\${PI_GONDOLIN_STARTUP_DESCRIPTOR-unset}"
printf 'socket=%s\\n' "\${PI_GONDOLIN_SOCKET-unset}"
printf 'lease=%s\\n' "\${PI_GONDOLIN_LEASE-unset}"
if [[ "\$*" == *"--path-order-probe"* ]]; then
    printf 'git_resolution=%s\\n' "\$(command -v git || printf absent)"
    printf 'git_marker=%s\\n' "\$(git)"
    printf 'pi_resolution=%s\\n' "\$(command -v pi || printf absent)"
fi
if [[ "\$*" == *"--relative-path-probe"* ]]; then
    printf 'relative_probe=%s\\n' "\$(command -v relative-path-probe || printf absent)"
fi
if [[ "\$*" == *"--sleep"* ]]; then
    trap 'exit 143' TERM
    while :; do sleep 1; done
fi
EOF_PI
chmod +x "$REAL_BIN/pi"

cat >"$FIRST_SAFE_BIN/git" <<'EOF'
#!/bin/sh
printf 'first-safe\n'
EOF
cat >"$SECOND_SAFE_BIN/git" <<'EOF'
#!/bin/sh
printf 'second-safe\n'
EOF
chmod +x "$FIRST_SAFE_BIN/git" "$SECOND_SAFE_BIN/git"

mkdir -p "$SHIM_BIN/relative-bin" "$SHIM_BIN/.gcloud"
printf '{}\\n' >"$SHIM_BIN/.gcloud/adc.json"
cat >"$SHIM_BIN/node" <<'EOF'
#!/bin/sh
echo "workspace node ran before sandbox initialization" >&2
exit 97
EOF
cat >"$SHIM_BIN/qemu-system-aarch64" <<'EOF'
#!/bin/sh
exit 97
EOF
cat >"$SHIM_BIN/qemu-system-x86_64" <<'EOF'
#!/bin/sh
exit 97
EOF
cat >"$SHIM_BIN/relative-bin/relative-path-probe" <<'EOF'
#!/bin/sh
printf 'repository-relative\n'
EOF
chmod +x "$SHIM_BIN/node" "$SHIM_BIN/qemu-system-aarch64" "$SHIM_BIN/qemu-system-x86_64" "$SHIM_BIN/relative-bin/relative-path-probe"

run_wrapper() {
    local path_value="$1"
    shift
    (
        cd "$SHIM_BIN"
        HOME="$TEST_HOME" \
        PATH="$path_value" \
        HERDR_ENV= HERDR_SOCKET_PATH= HERDR_PANE_ID= \
        PI_GONDOLIN_HANDSHAKE_TIMEOUT_MS=3000 \
        GOOGLE_APPLICATION_CREDENTIALS= \
        SECRET_SHOULD_NOT_LEAK=secret \
        NODE_OPTIONS="--require=$TEST_ROOT/evil.cjs" \
        "$WRAPPER" "$@"
    )
}

readonly RESOLVED_SHIM_BIN="$(cd "$SHIM_BIN" && pwd -P)"
readonly RESOLVED_REAL_BIN="$(cd "$REAL_BIN" && pwd -P)"
readonly RESOLVED_FIRST_SAFE_BIN="$(cd "$FIRST_SAFE_BIN" && pwd -P)"
readonly BASE_PATH="$SHIM_BIN:$WRAPPER_BIN:$REAL_BIN:$TRUSTED_BIN:$TOOL_PATH"
readonly EXPECTED_SCOPE="openai-codex/gpt-5.6-luna,openai-codex/gpt-5.6-terra,openai-codex/gpt-5.6-sol,zai/glm-5.2,zai/glm-5.3"
readonly EXPECTED_CLAUDE_SCOPE="$EXPECTED_SCOPE,anthropic/claude-fable-5,anthropic/claude-opus-5,anthropic/claude-sonnet-5,anthropic/claude-haiku-4-5"
output="$(run_wrapper "$BASE_PATH" --flag "two words")"
grep -F "real=$RESOLVED_REAL_BIN/pi" <<<"$output" >/dev/null
grep -F "cwd=$RESOLVED_SHIM_BIN" <<<"$output" >/dev/null
grep -F "args=<--models><$EXPECTED_SCOPE><--flag><two words><--no-builtin-tools>" <<<"$output" >/dev/null
[[ "$(grep -c '^metadata$' "$REAL_PI_LOG")" -eq 1 ]]
[[ "$(grep -c '^session$' "$REAL_PI_LOG")" -eq 1 ]]
[[ "$(wc -l <"$IMAGE_VERIFY_LOG")" -eq 1 ]]
node -e 'const fs=require("node:fs"); process.exit((fs.statSync(process.argv[1]).mode & 0o777) === 0o600 ? 0 : 1)' "$MODEL_SCOPE_CACHE"
! grep -F 'fixture-zai-secret' "$MODEL_SCOPE_CACHE" >/dev/null
! grep -F 'fixture-oauth-secret' "$MODEL_SCOPE_CACHE" >/dev/null

# A warm cache starts only the normal Pi process.
: >"$REAL_PI_LOG"
output="$(run_wrapper "$BASE_PATH" --flag warm)"
grep -F "args=<--models><$EXPECTED_SCOPE><--flag><warm><--no-builtin-tools>" <<<"$output" >/dev/null
[[ "$(grep -c '^session$' "$REAL_PI_LOG")" -eq 1 ]]
! grep -q '^metadata$' "$REAL_PI_LOG"
grep -F 'secret=unset' <<<"$output" >/dev/null
grep -F 'node_options=unset' <<<"$output" >/dev/null
grep -F 'tmpdir=/tmp' <<<"$output" >/dev/null
grep -F 'sandbox=1' <<<"$output" >/dev/null
grep -E '^descriptor=[A-Za-z0-9+/=]+$' <<<"$output" >/dev/null
! grep -q '^socket=/\|^lease=[a-f0-9]' <<<"$output"
grep -F 'builtins=read,write,edit,bash,grep,find,ls' <<<"$output" >/dev/null
grep -F 'host_tools=ketch_search,ketch_scrape,ketch_code,ketch_docs,ketch_crawl,ask_user_question,subagent,submit_plan,plan_progress,complete_plan,complete_stage' <<<"$output" >/dev/null
grep -q '^preflight ' "$CLIENT_LOG"
! grep -q '^release ' "$CLIENT_LOG"

# A project-local ADC survives the launcher filter for the mounted workspace;
# arbitrary ambient credentials remain absent from ordinary launches.
output="$(cd "$SHIM_BIN" && HOME="$TEST_HOME" PATH="$BASE_PATH" GOOGLE_APPLICATION_CREDENTIALS="$SHIM_BIN/.gcloud/adc.json" PI_GONDOLIN_HANDSHAKE_TIMEOUT_MS=3000 "$WRAPPER" --flag project-adc)"
grep -F "project_adc=$RESOLVED_SHIM_BIN/.gcloud/adc.json" <<<"$output" >/dev/null

# Explicit tool selection is removed from Pi argv and split into private,
# post-handshake replacement and host-adapter capabilities.
: >"$CLIENT_LOG"
output="$(run_wrapper "$BASE_PATH" --tools read,bash,ketch_search --exclude-tools bash --flag tools)"
grep -F 'builtins=read' <<<"$output" >/dev/null
grep -F 'host_tools=ketch_search' <<<"$output" >/dev/null
! grep -F '<--tools>' <<<"$output" >/dev/null
! grep -F '<--exclude-tools>' <<<"$output" >/dev/null
grep -F '<--no-builtin-tools>' <<<"$output" >/dev/null

: >"$REAL_PI_LOG"
output="$(run_wrapper "$BASE_PATH" --no-tools --flag none)"
grep -F 'builtins=' <<<"$output" >/dev/null
grep -F 'host_tools=' <<<"$output" >/dev/null
[[ "$(grep -c '^session$' "$REAL_PI_LOG")" -eq 1 ]]

if run_wrapper "$BASE_PATH" --no-extensions >"$TEST_ROOT/no-extensions.out" 2>&1; then
    echo "wrapper unexpectedly accepted --no-extensions" >&2
    exit 1
fi
grep -F -- '--no-extensions is incompatible' "$TEST_ROOT/no-extensions.out" >/dev/null

# Trusted PATH order is retained and repository-relative entries are removed.
output="$(run_wrapper "$SHIM_BIN:$WRAPPER_BIN:$REAL_BIN:$FIRST_SAFE_BIN:$SECOND_SAFE_BIN:$FIRST_SAFE_BIN:$TRUSTED_BIN:$TOOL_PATH" --path-order-probe)"
grep -F "git_resolution=$RESOLVED_FIRST_SAFE_BIN/git" <<<"$output" >/dev/null
grep -F 'git_marker=first-safe' <<<"$output" >/dev/null
grep -F "pi_resolution=$RESOLVED_REAL_BIN/pi" <<<"$output" >/dev/null
output="$(cd "$SHIM_BIN" && HOME="$TEST_HOME" PATH="relative-bin:$WRAPPER_BIN:$REAL_BIN:$TRUSTED_BIN:$TOOL_PATH" "$WRAPPER" --relative-path-probe)"
grep -F 'relative_probe=absent' <<<"$output" >/dev/null

# Expired records refresh once, then retain configured order and exclude
# unrelated or unavailable direct-provider entries.
node -e 'const fs=require("node:fs"); const file=process.argv[1]; const value=JSON.parse(fs.readFileSync(file)); value.refreshedAt=0; fs.writeFileSync(file, JSON.stringify(value));' "$MODEL_SCOPE_CACHE"
: >"$REAL_PI_LOG"
output="$(run_wrapper "$BASE_PATH" --flag expired)"
grep -F "args=<--models><$EXPECTED_SCOPE><--flag><expired><--no-builtin-tools>" <<<"$output" >/dev/null
[[ "$(grep -c '^metadata$' "$REAL_PI_LOG")" -eq 1 ]]
[[ "$(grep -c '^session$' "$REAL_PI_LOG")" -eq 1 ]]

# Pi receives the cached native scope in normal and plan mode. An explicit CLI
# model stays active even when it is outside that scope.
: >"$REAL_PI_LOG"
output="$(run_wrapper "$BASE_PATH" --plan)"
grep -F "args=<--models><$EXPECTED_SCOPE><--plan><--no-builtin-tools>" <<<"$output" >/dev/null
[[ "$(grep -c '^session$' "$REAL_PI_LOG")" -eq 1 ]]
: >"$REAL_PI_LOG"
output="$(run_wrapper "$BASE_PATH" --plan --model anthropic/claude-opus-5 --thinking max)"
grep -F "args=<--models><$EXPECTED_SCOPE><--plan><--model><anthropic/claude-opus-5><--thinking><max><--no-builtin-tools>" <<<"$output" >/dev/null
[[ "$(grep -c '^session$' "$REAL_PI_LOG")" -eq 1 ]]

# Explicit scopes and full-list commands bypass automatic discovery, even with
# no cache. The user-requested full list remains unscoped.
mv "$MODEL_SCOPE_CACHE" "$MODEL_SCOPE_CACHE.saved"
: >"$REAL_PI_LOG"
output="$(run_wrapper "$BASE_PATH" --models openai-codex/gpt-5.6-sol --model openai-codex/gpt-5.6-sol)"
grep -F 'args=<--models><openai-codex/gpt-5.6-sol><--model><openai-codex/gpt-5.6-sol><--no-builtin-tools>' <<<"$output" >/dev/null
[[ "$(grep -c '^session$' "$REAL_PI_LOG")" -eq 1 ]]
! grep -q '^metadata$' "$REAL_PI_LOG"
: >"$REAL_PI_LOG"
output="$(run_wrapper "$BASE_PATH" --list-models)"
grep -F 'list_args=<--models><*><--list-models><--no-builtin-tools>' <<<"$output" >/dev/null
grep -F 'provider model context max-out thinking images' <<<"$output" >/dev/null
[[ "$(grep -c '^session$' "$REAL_PI_LOG")" -eq 1 ]]
! grep -q '^metadata$' "$REAL_PI_LOG"
mv "$MODEL_SCOPE_CACHE.saved" "$MODEL_SCOPE_CACHE"

# Adding a provider credential invalidates immediately and admits only that
# provider's preferred direct models on the next normal launch.
cat >"$AGENT_HOME/auth.json" <<'JSON'
{
  "zai": { "type": "api_key", "key": "fixture-zai-secret" },
  "openai-codex": { "type": "oauth", "access": "fixture-oauth-secret" },
  "anthropic": { "type": "api_key", "key": "fixture-anthropic-secret" }
}
JSON
: >"$REAL_PI_LOG"
output="$(run_wrapper "$BASE_PATH" --flag provider-added)"
grep -F "args=<--models><$EXPECTED_CLAUDE_SCOPE><--flag><provider-added><--no-builtin-tools>" <<<"$output" >/dev/null
[[ "$(grep -c '^metadata$' "$REAL_PI_LOG")" -eq 1 ]]
[[ "$(grep -c '^session$' "$REAL_PI_LOG")" -eq 1 ]]
! grep -F 'fixture-anthropic-secret' "$MODEL_SCOPE_CACHE" >/dev/null

# The trusted host Pi process starts before delayed sandbox readiness.
: >"$REAL_PI_LOG"
touch "$TEST_ROOT/delay-ready"
run_wrapper "$BASE_PATH" --flag delayed >"$TEST_ROOT/delayed.out" &
delayed_pid=$!
for _ in {1..100}; do grep -q '^session$' "$REAL_PI_LOG" 2>/dev/null && break; sleep 0.01; done
grep -q '^session$' "$REAL_PI_LOG"
! grep -q '^handshake$' "$REAL_PI_LOG"
wait "$delayed_pid"
rm "$TEST_ROOT/delay-ready"
grep -q '^handshake$' "$REAL_PI_LOG"

# Routing failure never falls back to host tools.
touch "$TEST_ROOT/no-handshake"
if run_wrapper "$BASE_PATH" --flag timeout >"$TEST_ROOT/timeout.out" 2>&1; then
    echo "wrapper unexpectedly ignored a missing routing handshake" >&2
    exit 1
fi
rm "$TEST_ROOT/no-handshake"
grep -E 'exited before|timed out waiting' "$TEST_ROOT/timeout.out" >/dev/null

touch "$TEST_ROOT/bad-handshake"
if run_wrapper "$BASE_PATH" --flag mismatch >"$TEST_ROOT/mismatch.out" 2>&1; then
    echo "wrapper unexpectedly accepted a mismatched routing handshake" >&2
    exit 1
fi
rm "$TEST_ROOT/bad-handshake"
grep -F 'routing extension rejected' "$TEST_ROOT/mismatch.out" >/dev/null

# Signals reach Pi without the launcher owning a controller lease.
: >"$CLIENT_LOG"
(
    cd "$SHIM_BIN"
    HOME="$TEST_HOME" PATH="$BASE_PATH" HERDR_ENV= HERDR_SOCKET_PATH= HERDR_PANE_ID= \
        PI_GONDOLIN_HANDSHAKE_TIMEOUT_MS=3000 exec "$WRAPPER" --sleep >"$TEST_ROOT/signal.out" 2>"$TEST_ROOT/signal.err"
) &
wrapper_pid=$!
for _ in {1..200}; do
    grep -q '^preflight ' "$CLIENT_LOG" 2>/dev/null && grep -q '^real=' "$TEST_ROOT/signal.out" 2>/dev/null && break
    sleep 0.01
done
kill -TERM "$wrapper_pid"
set +e
wait "$wrapper_pid"
signal_status=$?
set -e
[[ "$signal_status" -ne 0 ]]
! grep -q '^release ' "$CLIENT_LOG"

# Missing prerequisites are fail-closed.
if run_wrapper "$SHIM_BIN:$WRAPPER_BIN:$REAL_BIN:$NO_QEMU_BIN:$TOOL_PATH" --flag no-qemu >"$TEST_ROOT/no-qemu.out" 2>&1; then
    echo "wrapper unexpectedly ran without QEMU" >&2
    exit 1
fi
grep -F 'qemu-system-' "$TEST_ROOT/no-qemu.out" >/dev/null

rm -f "$MODEL_SCOPE_CACHE"
touch "$TEST_ROOT/fail-image"
: >"$REAL_PI_LOG"
if run_wrapper "$BASE_PATH" --flag no-image >"$TEST_ROOT/no-image.out" 2>&1; then
    echo "wrapper unexpectedly ran with a missing image" >&2
    exit 1
fi
rm "$TEST_ROOT/fail-image" "$TEST_ROOT/controller-active"
grep -E 'exited before|timed out waiting' "$TEST_ROOT/no-image.out" >/dev/null
[[ -s "$REAL_PI_LOG" ]]

# An existing healthy controller is the only warm-start shortcut. The fake
# controller owns image verification, so the wrapper must not invoke it again.
touch "$TEST_ROOT/hold-controller"
: >"$IMAGE_VERIFY_LOG"
run_wrapper "$BASE_PATH" --flag active-first >/dev/null
[[ "$(wc -l <"$IMAGE_VERIFY_LOG")" -eq 1 ]]
: >"$IMAGE_VERIFY_LOG"
run_wrapper "$BASE_PATH" --flag active-second >/dev/null
[[ ! -s "$IMAGE_VERIFY_LOG" ]]
rm "$TEST_ROOT/hold-controller" "$TEST_ROOT/controller-active"

mv "$SANDBOX_HOME/controller.mjs" "$SANDBOX_HOME/controller.mjs.off"
if run_wrapper "$BASE_PATH" --flag no-controller >"$TEST_ROOT/no-controller.out" 2>&1; then
    echo "wrapper unexpectedly ran without the controller" >&2
    exit 1
fi
mv "$SANDBOX_HOME/controller.mjs.off" "$SANDBOX_HOME/controller.mjs"
grep -F 'controller is missing' "$TEST_ROOT/no-controller.out" >/dev/null

# Missing real Pi is diagnosed after trusted bootstrap succeeds.
if HOME="$TEST_HOME" PATH="$WRAPPER_BIN:$TRUSTED_BIN:$TOOL_PATH" "$WRAPPER" --version >"$TEST_ROOT/no-pi.out" 2>&1; then
    echo "wrapper unexpectedly ran without a real Pi binary" >&2
    exit 1
fi
grep -F 'cannot find the installed Pi binary' "$TEST_ROOT/no-pi.out" >/dev/null

# --yolo bypasses QEMU, controller, image, handshake, environment filtering,
# and private tool normalization, but uses the same automatic model scope as a
# normal session. A cache miss refreshes through the real Pi without starting
# the controller.
rm -f "$MODEL_SCOPE_CACHE"
: >"$REAL_PI_LOG"
yolo_output="$(cd "$SHIM_BIN" && HOME="$TEST_HOME" PATH="$SHIM_BIN:$WRAPPER_BIN:$REAL_BIN:$TRUSTED_BIN:$TOOL_PATH" TMPDIR="$TEST_ROOT/host-tmp" SECRET_SHOULD_NOT_LEAK=host-secret "$WRAPPER" --yolo --tools read --flag "two words")"
grep -F "args=<--models><$EXPECTED_CLAUDE_SCOPE><--tools><read><--flag><two words>" <<<"$yolo_output" >/dev/null
[[ "$(grep -c '^session$' "$REAL_PI_LOG")" -eq 1 ]]
[[ "$(grep -c '^metadata$' "$REAL_PI_LOG")" -eq 1 ]]
grep -F 'secret=host-secret' <<<"$yolo_output" >/dev/null
grep -F 'tmpdir='"$TEST_ROOT"'/host-tmp' <<<"$yolo_output" >/dev/null
grep -F 'sandbox=unset' <<<"$yolo_output" >/dev/null

# A bare yolo launch has no user arguments but must still inject the cached
# scope instead of failing under the launcher's nounset setting.
yolo_output="$(cd "$SHIM_BIN" && HOME="$TEST_HOME" PATH="$SHIM_BIN:$WRAPPER_BIN:$REAL_BIN:$TRUSTED_BIN:$TOOL_PATH" "$WRAPPER" --yolo)"
grep -F "args=<--models><$EXPECTED_CLAUDE_SCOPE>" <<<"$yolo_output" >/dev/null

# An explicit yolo scope remains authoritative, as it does in normal mode.
yolo_output="$(cd "$SHIM_BIN" && HOME="$TEST_HOME" PATH="$SHIM_BIN:$WRAPPER_BIN:$REAL_BIN:$TRUSTED_BIN:$TOOL_PATH" "$WRAPPER" --yolo --models openai-codex/gpt-5.6-sol --tools read)"
grep -F 'args=<--models><openai-codex/gpt-5.6-sol><--tools><read>' <<<"$yolo_output" >/dev/null

echo "wrapper tests passed"
