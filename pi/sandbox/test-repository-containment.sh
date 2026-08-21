#!/usr/bin/env bash
set -euo pipefail

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly WRAPPER="$(cd "$HERE/../.." && pwd)/bin/pi"
readonly TEST_ROOT="$(mktemp -d "$HOME/.pi-repository-containment.XXXXXX")"

cleanup() {
    rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

canonical_dir() {
    (cd "$1" && pwd -P)
}

readonly TEST_HOME="$TEST_ROOT/home"
readonly SANDBOX_HOME="$TEST_HOME/.pi/sandbox"
readonly REAL_BIN="$TEST_HOME/.local/bin"
readonly WORKSPACE_PARENT="$TEST_HOME/workspaces"
readonly HOST_GIT="$(command -v git)"
readonly HOST_NODE="$(command -v node)"
readonly HOST_RG="$(command -v rg)"
readonly HOST_MKTEMP="$(command -v mktemp)"

[[ -x "$HERE/node_modules/.bin/srt" ]] || {
    echo "sandbox runtime is not installed; run npm ci in $HERE" >&2
    exit 1
}

mkdir -p \
    "$SANDBOX_HOME" \
    "$TEST_HOME/.pi/agent/sessions" \
    "$REAL_BIN" \
    "$WORKSPACE_PARENT"
printf '{}\n' >"$TEST_HOME/.pi/agent/settings.json"
ln -s "$HERE/node_modules" "$SANDBOX_HOME/node_modules"
cp "$HERE/settings.json" "$SANDBOX_HOME/settings.json"
cp "$HERE/unrestricted-network.mjs" "$SANDBOX_HOME/unrestricted-network.mjs"
cp "$HERE/herdr-status-broker.mjs" "$SANDBOX_HOME/herdr-status-broker.mjs"

cat >"$REAL_BIN/pi" <<'EOF'
#!/bin/bash
set -euo pipefail

if [[ "$*" == *"--list-models"* ]]; then
    printf 'Provider Model\n'
    exit 0
fi

mode="$1"
launch="$2"
root="$3"
sibling="$4"
parent_file="$5"
common="${6-}"

[[ "$PWD" == "$launch" ]]
printf 'root write\n' >"$root/root-write"
/bin/bash -c 'printf "nested child write\n" >"$1"' _ "$root/nested-child-write"
mkdir -p "$root/config-source"
printf 'tracked startup source\n' >"$root/config-source/.zshrc"

expect_blocked() {
    local description="$1"
    shift
    if "$@" >/dev/null 2>&1; then
        echo "sandbox unexpectedly allowed $description" >&2
        exit 1
    fi
}

expect_blocked "parent read" /bin/cat "$parent_file"
expect_blocked "parent write" /bin/bash -c 'printf denied >"$1"' _ "$parent_file"
expect_blocked "sibling read" /bin/cat "$sibling/secret"
expect_blocked "sibling write" /bin/bash -c 'printf denied >"$1"' _ "$sibling/denied"
expect_blocked "Bash startup write" /bin/bash -c 'printf denied >>"$1"' _ "$root/.bashrc"
expect_blocked "zsh startup write" /bin/bash -c 'printf denied >>"$1"' _ "$root/.zshrc"
expect_blocked "editor config write" /bin/bash -c 'printf denied >>"$1"' _ "$root/.vscode/settings.json"
expect_blocked "agent command write" /bin/bash -c 'printf denied >>"$1"' _ "$root/.claude/commands/test.md"

if [[ "$mode" == normal ]]; then
    expect_blocked "Git config write" /bin/bash -c 'printf denied >>"$1"' _ "$root/.git/config"
    expect_blocked "Git hook write" /bin/bash -c 'printf denied >"$1"' _ "$root/.git/hooks/pi-test"
else
    expect_blocked "bare config write" /bin/bash -c 'printf denied >>"$1"' _ "$common/config"
    expect_blocked "bare hook write" /bin/bash -c 'printf denied >"$1"' _ "$common/hooks/pi-test"
    printf 'bare commit\n' >"$root/bare-commit.txt"
    git -C "$root" add bare-commit.txt
    git -C "$root" -c user.name=Test -c user.email=test@example.invalid commit -qm sandbox-commit
    git -C "$root" branch sandbox-created-branch
    printf 'commit=%s\n' "$(git -C "$root" rev-parse HEAD)"
fi
EOF
chmod +x "$REAL_BIN/pi"

readonly TOOL_PATH="$(dirname "$HOST_NODE"):$(dirname "$HOST_GIT"):$(dirname "$HOST_RG"):$(dirname "$HOST_MKTEMP"):/usr/bin:/bin"
run_sandboxed_fixture() {
    local launch="$2"
    (
        cd "$launch"
        HOME="$TEST_HOME" \
        PATH="$(dirname "$WRAPPER"):$REAL_BIN:$TOOL_PATH" \
        HERDR_ENV= \
        HERDR_SOCKET_PATH= \
        HERDR_PANE_ID= \
        "$WRAPPER" "$@"
    )
}

prepare_protected_paths() {
    local root="$1"
    mkdir -p "$root/.vscode" "$root/.claude/commands"
    printf 'startup\n' >"$root/.bashrc"
    printf 'startup\n' >"$root/.zshrc"
    printf '{}\n' >"$root/.vscode/settings.json"
    printf 'command\n' >"$root/.claude/commands/test.md"
}

# Normal repository: root, inherited child, and nested dotfile-source writes
# succeed; parent, sibling, and root execution-config writes remain blocked.
NORMAL_ROOT="$WORKSPACE_PARENT/normal repository"
NORMAL_SIBLING="$WORKSPACE_PARENT/normal sibling"
PARENT_FILE="$WORKSPACE_PARENT/parent-secret"
mkdir -p "$NORMAL_ROOT/nested/deep" "$NORMAL_SIBLING"
printf 'parent secret\n' >"$PARENT_FILE"
printf 'sibling secret\n' >"$NORMAL_SIBLING/secret"
"$HOST_GIT" -C "$NORMAL_ROOT" init -q
prepare_protected_paths "$NORMAL_ROOT"
NORMAL_ROOT="$(canonical_dir "$NORMAL_ROOT")"
NORMAL_LAUNCH="$(canonical_dir "$NORMAL_ROOT/nested/deep")"
NORMAL_SIBLING="$(canonical_dir "$NORMAL_SIBLING")"
run_sandboxed_fixture normal "$NORMAL_LAUNCH" "$NORMAL_ROOT" "$NORMAL_SIBLING" "$PARENT_FILE"
[[ -f "$NORMAL_ROOT/root-write" && -f "$NORMAL_ROOT/nested-child-write" ]]
[[ "$(<"$NORMAL_ROOT/config-source/.zshrc")" == "tracked startup source" ]]
[[ ! -e "$NORMAL_SIBLING/denied" ]]

# Bare-backed worktree: Git can update objects, refs, logs, and worktree state,
# while the other worktree, parent, and bare execution config remain blocked.
SEED="$TEST_ROOT/seed"
BARE_COMMON="$WORKSPACE_PARENT/shared bare.git"
BARE_ROOT="$WORKSPACE_PARENT/primary worktree"
BARE_SIBLING="$WORKSPACE_PARENT/secondary worktree"
"$HOST_GIT" init -q "$SEED"
"$HOST_GIT" -C "$SEED" -c user.name=Test -c user.email=test@example.invalid \
    commit --allow-empty -qm initial
"$HOST_GIT" init --bare -q "$BARE_COMMON"
"$HOST_GIT" -C "$SEED" remote add origin "$BARE_COMMON"
"$HOST_GIT" -C "$SEED" push -q origin HEAD:main
"$HOST_GIT" --git-dir="$BARE_COMMON" symbolic-ref HEAD refs/heads/main
"$HOST_GIT" --git-dir="$BARE_COMMON" worktree add -q "$BARE_ROOT" main
"$HOST_GIT" --git-dir="$BARE_COMMON" worktree add -q -b secondary "$BARE_SIBLING" main
mkdir -p "$BARE_ROOT/nested/deep"
printf 'sibling secret\n' >"$BARE_SIBLING/secret"
prepare_protected_paths "$BARE_ROOT"
BARE_COMMON="$(canonical_dir "$BARE_COMMON")"
BARE_ROOT="$(canonical_dir "$BARE_ROOT")"
BARE_LAUNCH="$(canonical_dir "$BARE_ROOT/nested/deep")"
BARE_SIBLING="$(canonical_dir "$BARE_SIBLING")"
old_head="$("$HOST_GIT" -C "$BARE_ROOT" rev-parse HEAD)"
output="$(run_sandboxed_fixture bare "$BARE_LAUNCH" "$BARE_ROOT" "$BARE_SIBLING" "$PARENT_FILE" "$BARE_COMMON")"
new_head="$("$HOST_GIT" -C "$BARE_ROOT" rev-parse HEAD)"
[[ "$new_head" != "$old_head" ]]
[[ "$output" == *"commit=$new_head"* ]]
"$HOST_GIT" --git-dir="$BARE_COMMON" show-ref --verify --quiet refs/heads/sandbox-created-branch
[[ -f "$BARE_ROOT/root-write" && -f "$BARE_ROOT/nested-child-write" ]]
[[ "$(<"$BARE_ROOT/config-source/.zshrc")" == "tracked startup source" ]]
[[ ! -e "$BARE_SIBLING/denied" ]]

echo "repository containment tests passed"
