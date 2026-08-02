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

cleanup() {
    rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

canonical_dir() {
    (cd "$1" && pwd -P)
}

readonly TEST_HOME="$TEST_ROOT/home"
readonly SANDBOX_HOME="$TEST_HOME/.pi/sandbox"
readonly REAL_BIN="$TEST_ROOT/real-bin"
readonly TRUSTED_BIN="$TEST_ROOT/trusted-bin"
readonly NO_GIT_BIN="$TEST_ROOT/no-git-bin"
readonly FAIL_GIT_BIN="$TEST_ROOT/fail-git-bin"
readonly CAPTURE="$TEST_ROOT/effective-policy.json"
readonly BOOTSTRAP_MARKER="$TEST_ROOT/bootstrap-shim-ran"
readonly BASE_POLICY="$SANDBOX_HOME/settings.json"

mkdir -p \
    "$SANDBOX_HOME/node_modules/.bin" \
    "$TEST_HOME/.pi/agent/sessions" \
    "$REAL_BIN" \
    "$TRUSTED_BIN" \
    "$NO_GIT_BIN" \
    "$FAIL_GIT_BIN"

write_exec_wrapper() {
    local destination="$1"
    local executable="$2"
    printf '#!/bin/bash\nexec %q "$@"\n' "$executable" >"$destination"
    chmod +x "$destination"
}

for directory in "$TRUSTED_BIN" "$NO_GIT_BIN" "$FAIL_GIT_BIN"; do
    write_exec_wrapper "$directory/node" "$HOST_NODE"
    write_exec_wrapper "$directory/rg" "$HOST_RG"
    write_exec_wrapper "$directory/mktemp" "$HOST_MKTEMP"
    printf '#!/bin/bash\nexit 0\n' >"$directory/bwrap"
    printf '#!/bin/bash\nexit 0\n' >"$directory/socat"
    chmod +x "$directory/bwrap" "$directory/socat"
done
write_exec_wrapper "$TRUSTED_BIN/git" "$HOST_GIT"
printf '#!/bin/bash\nexit 42\n' >"$FAIL_GIT_BIN/git"
chmod +x "$FAIL_GIT_BIN/git"

write_base_policy() {
    "$HOST_NODE" - "$BASE_POLICY" "${1-}" <<'NODE'
const fs = require("node:fs");
const [output, duplicateScope] = process.argv.slice(2);
const policy = {
  marker: { untouched: true, nested: ["one", "two"] },
  network: {
    allowedDomains: ["example.invalid"],
    deniedDomains: ["blocked.invalid"],
    strictAllowlist: true,
    allowUnixSockets: [],
    allowAllUnixSockets: false,
    allowLocalBinding: true,
  },
  filesystem: {
    denyRead: ["~"],
    allowRead: ["."],
    allowWrite: [".", "/tmp"],
    denyWrite: ["/base/deny"],
    allowGitConfig: false,
  },
  credentials: { files: [{ path: "~/.netrc", mode: "deny" }], envVars: [] },
  enableWeakerNestedSandbox: false,
  enableWeakerNetworkIsolation: false,
  allowAppleEvents: false,
  allowPty: true,
};
if (duplicateScope) {
  policy.filesystem.allowRead.push(duplicateScope);
  policy.filesystem.allowWrite.push(duplicateScope);
}
fs.writeFileSync(output, `${JSON.stringify(policy, null, 2)}\n`);
NODE
}

write_base_policy
cp "$HERE/herdr-status-broker.mjs" "$SANDBOX_HOME/herdr-status-broker.mjs"
cat >"$SANDBOX_HOME/unrestricted-network.mjs" <<EOF
#!/usr/bin/env node
import { cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] !== "--settings" || args[2] !== "--") process.exit(2);
console.log(\`policy_path=\${args[1]}\`);
console.log(\`srt_cwd=\${process.cwd()}\`);
cpSync(args[1], "$CAPTURE");
const result = spawnSync(args[3], args.slice(4), { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
EOF

cat >"$SANDBOX_HOME/node_modules/.bin/srt" <<EOF
#!/bin/bash
set -euo pipefail
[[ "\$1" == "--settings" ]]
[[ -r "\$2" ]]
[[ "\$3" == "--" ]]
printf 'policy_path=%s\n' "\$2"
printf 'srt_cwd=%s\n' "\$PWD"
/bin/cp "\$2" "$CAPTURE"
shift 3
exec "\$@"
EOF

cat >"$REAL_BIN/pi" <<'EOF'
#!/bin/bash
printf 'pi_cwd=%s\n' "$PWD"
printf 'args='
printf '<%s>' "$@"
printf '\n'
printf 'secret=%s\n' "${SECRET_SHOULD_NOT_LEAK-unset}"
printf 'node_options=%s\n' "${NODE_OPTIONS-unset}"
printf 'git_dir=%s\n' "${GIT_DIR-unset}"
EOF
chmod +x "$SANDBOX_HOME/node_modules/.bin/srt" "$REAL_BIN/pi"

make_repository_shims() {
    local root="$1"
    local shim_dir="$root/bootstrap-shims"
    local name

    mkdir -p "$shim_dir"
    for name in node rg git mktemp pi bwrap socat; do
        cat >"$shim_dir/$name" <<EOF
#!/bin/bash
printf '%s\n' '$name' >>'$BOOTSTRAP_MARKER'
exit 97
EOF
        chmod +x "$shim_dir/$name"
    done
    printf '%s\n' "$shim_dir"
}

assert_policy_preserves_base() {
    "$HOST_NODE" - "$BASE_POLICY" "$CAPTURE" <<'NODE'
const fs = require("node:fs");
const [basePath, effectivePath] = process.argv.slice(2);
const base = JSON.parse(fs.readFileSync(basePath, "utf8"));
const effective = JSON.parse(fs.readFileSync(effectivePath, "utf8"));
for (const [key, value] of Object.entries(base)) {
  if (key === "filesystem") continue;
  if (JSON.stringify(effective[key]) !== JSON.stringify(value)) {
    throw new Error(`base field changed: ${key}`);
  }
}
for (const key of ["denyRead", "allowRead", "allowWrite", "denyWrite"]) {
  const prefix = effective.filesystem[key].slice(0, base.filesystem[key].length);
  if (JSON.stringify(prefix) !== JSON.stringify(base.filesystem[key])) {
    throw new Error(`base filesystem.${key} was not preserved`);
  }
}
if (effective.filesystem.allowGitConfig !== base.filesystem.allowGitConfig) {
  throw new Error("allowGitConfig changed");
}
const generatedPolicy = effective.filesystem.denyWrite.find(
  value => /\/pi-sandbox-policy\.[^/]+\/settings\.json$/.test(value),
);
if (!generatedPolicy) throw new Error("effective policy does not protect itself");
NODE
}

assert_scope_counts() {
    local expected_worktree="$1"
    local expected_common="${2-}"
    "$HOST_NODE" - "$CAPTURE" "$expected_worktree" "$expected_common" <<'NODE'
const fs = require("node:fs");
const [policyPath, worktree, common] = process.argv.slice(2);
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
for (const key of ["allowRead", "allowWrite"]) {
  const worktreeCount = policy.filesystem[key].filter(value => value === worktree).length;
  if (worktreeCount !== 1) throw new Error(`${key} has ${worktreeCount} worktree entries`);
  if (common) {
    const commonCount = policy.filesystem[key].filter(value => value === common).length;
    if (commonCount !== 1) throw new Error(`${key} has ${commonCount} common entries`);
  }
}
NODE
}

assert_not_granted() {
    local forbidden="$1"
    "$HOST_NODE" - "$CAPTURE" "$forbidden" <<'NODE'
const fs = require("node:fs");
const [policyPath, forbidden] = process.argv.slice(2);
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
for (const key of ["allowRead", "allowWrite"]) {
  if (policy.filesystem[key].includes(forbidden)) {
    throw new Error(`${key} unexpectedly grants ${forbidden}`);
  }
}
NODE
}

assert_worktree_denies() {
    local root="$1"
    "$HOST_NODE" - "$CAPTURE" "$root" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [policyPath, root] = process.argv.slice(2);
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
for (const relative of [
  ".gitconfig", ".gitmodules", ".bashrc", ".bash_profile", ".zshrc",
  ".zprofile", ".profile", ".ripgreprc", ".mcp.json", ".vscode",
  ".idea", ".claude/commands", ".claude/agents", ".git/hooks", ".git/config",
]) {
  const expected = path.join(root, relative);
  if (!policy.filesystem.denyWrite.includes(expected)) {
    throw new Error(`missing worktree deny: ${expected}`);
  }
}
NODE
}

run_wrapper() {
    local launch_dir="$1"
    local shim_dir="$2"
    local trusted_bin="$3"
    shift 3

    rm -f "$CAPTURE" "$BOOTSTRAP_MARKER"
    local output
    output="$(
        cd "$launch_dir"
        HOME="$TEST_HOME" \
        PATH="$shim_dir:$WRAPPER_BIN:$REAL_BIN:$trusted_bin" \
        HERDR_ENV= \
        HERDR_SOCKET_PATH= \
        HERDR_PANE_ID= \
        SECRET_SHOULD_NOT_LEAK=secret \
        NODE_OPTIONS="--require=$shim_dir/evil-node-options.cjs" \
        BASH_ENV="$shim_dir/evil-bash-env" \
        GIT_DIR="$TEST_ROOT/ambient.git" \
        GIT_WORK_TREE="$TEST_ROOT/ambient-worktree" \
        GIT_CONFIG_GLOBAL="$shim_dir/ambient-gitconfig" \
        "$WRAPPER" "$@"
    )"
    printf '%s\n' "$output"

    [[ -s "$CAPTURE" ]]
    [[ ! -e "$BOOTSTRAP_MARKER" ]]
    grep -F "pi_cwd=$(canonical_dir "$launch_dir")" <<<"$output" >/dev/null
    grep -F 'secret=unset' <<<"$output" >/dev/null
    grep -F 'node_options=unset' <<<"$output" >/dev/null
    grep -F 'git_dir=unset' <<<"$output" >/dev/null
    local policy_path
    policy_path="$(awk -F= '/^policy_path=/{print substr($0, index($0, "=") + 1); exit}' <<<"$output")"
    [[ -n "$policy_path" && ! -e "$policy_path" && ! -e "${policy_path%/*}" ]]
    assert_policy_preserves_base
}

# Non-repository launches retain the physical launch directory boundary.
NON_REPO="$TEST_ROOT/non repository"
mkdir -p "$NON_REPO/nested"
NON_REPO_SHIMS="$(make_repository_shims "$NON_REPO/nested")"
output="$(run_wrapper "$NON_REPO/nested" "$NON_REPO_SHIMS" "$TRUSTED_BIN" --flag 'two words')"
grep -F "srt_cwd=$(canonical_dir "$NON_REPO/nested")" <<<"$output" >/dev/null
grep -F 'args=<--flag><two words>' <<<"$output" >/dev/null
assert_not_granted "$(canonical_dir "$NON_REPO")"

# Root and nested launches in a normal repository use the canonical worktree root.
NORMAL_REPO="$TEST_ROOT/normal repository"
mkdir -p "$NORMAL_REPO/nested/deep"
"$HOST_GIT" -C "$NORMAL_REPO" init -q
NORMAL_ROOT="$(canonical_dir "$NORMAL_REPO")"
NORMAL_SHIMS="$(make_repository_shims "$NORMAL_REPO")"
output="$(run_wrapper "$NORMAL_REPO" "$NORMAL_SHIMS" "$TRUSTED_BIN" --root-launch)"
grep -F "srt_cwd=$NORMAL_ROOT" <<<"$output" >/dev/null
assert_worktree_denies "$NORMAL_ROOT"

output="$(run_wrapper "$NORMAL_REPO/nested/deep" "$NORMAL_SHIMS" "$TRUSTED_BIN" --nested-launch)"
grep -F "srt_cwd=$NORMAL_ROOT" <<<"$output" >/dev/null
assert_scope_counts "$NORMAL_ROOT"
assert_worktree_denies "$NORMAL_ROOT"

# An already-present scope is not duplicated during composition.
write_base_policy "$NORMAL_ROOT"
run_wrapper "$NORMAL_REPO/nested/deep" "$NORMAL_SHIMS" "$TRUSTED_BIN" --deduplicated >/dev/null
assert_scope_counts "$NORMAL_ROOT"
write_base_policy

# Malformed/stale metadata and a failing or unavailable trusted Git fail narrow.
STALE_REPO="$TEST_ROOT/stale repository"
mkdir -p "$STALE_REPO/nested"
printf 'gitdir: ../missing-metadata\n' >"$STALE_REPO/.git"
STALE_ROOT="$(canonical_dir "$STALE_REPO")"
STALE_SHIMS="$(make_repository_shims "$STALE_REPO")"
output="$(run_wrapper "$STALE_REPO/nested" "$STALE_SHIMS" "$TRUSTED_BIN" --stale)"
grep -F "srt_cwd=$(canonical_dir "$STALE_REPO/nested")" <<<"$output" >/dev/null
assert_not_granted "$STALE_ROOT"

NO_GIT_REPO="$TEST_ROOT/no trusted git repository"
mkdir -p "$NO_GIT_REPO/nested"
"$HOST_GIT" -C "$NO_GIT_REPO" init -q
NO_GIT_ROOT="$(canonical_dir "$NO_GIT_REPO")"
NO_GIT_SHIMS="$(make_repository_shims "$NO_GIT_REPO")"
output="$(run_wrapper "$NO_GIT_REPO/nested" "$NO_GIT_SHIMS" "$NO_GIT_BIN" --no-git)"
grep -F "srt_cwd=$(canonical_dir "$NO_GIT_REPO/nested")" <<<"$output" >/dev/null
assert_not_granted "$NO_GIT_ROOT"

output="$(run_wrapper "$NO_GIT_REPO/nested" "$NO_GIT_SHIMS" "$FAIL_GIT_BIN" --failed-git)"
grep -F "srt_cwd=$(canonical_dir "$NO_GIT_REPO/nested")" <<<"$output" >/dev/null
assert_not_granted "$NO_GIT_ROOT"

# A bare-backed linked worktree receives exactly the root and bare common scopes.
SEED="$TEST_ROOT/seed"
BARE_REPO="$TEST_ROOT/bare common repository.git"
BARE_WORKTREE="$TEST_ROOT/bare linked worktree"
BARE_SIBLING="$TEST_ROOT/unrelated sibling worktree"
"$HOST_GIT" init -q "$SEED"
"$HOST_GIT" -C "$SEED" -c user.name=Test -c user.email=test@example.invalid \
    commit --allow-empty -qm initial
"$HOST_GIT" init --bare -q "$BARE_REPO"
"$HOST_GIT" -C "$SEED" remote add origin "$BARE_REPO"
"$HOST_GIT" -C "$SEED" push -q origin HEAD:main
"$HOST_GIT" --git-dir="$BARE_REPO" symbolic-ref HEAD refs/heads/main
"$HOST_GIT" --git-dir="$BARE_REPO" worktree add -q "$BARE_WORKTREE" main
"$HOST_GIT" --git-dir="$BARE_REPO" worktree add -q -b sibling "$BARE_SIBLING" main
mkdir -p "$BARE_WORKTREE/nested"
BARE_ROOT="$(canonical_dir "$BARE_WORKTREE")"
BARE_COMMON="$(canonical_dir "$BARE_REPO")"
BARE_SIBLING_ROOT="$(canonical_dir "$BARE_SIBLING")"
BARE_SHIMS="$(make_repository_shims "$BARE_WORKTREE")"
output="$(run_wrapper "$BARE_WORKTREE/nested" "$BARE_SHIMS" "$TRUSTED_BIN" --bare)"
grep -F "srt_cwd=$BARE_ROOT" <<<"$output" >/dev/null
assert_scope_counts "$BARE_ROOT" "$BARE_COMMON"
assert_not_granted "$BARE_SIBLING_ROOT"
assert_worktree_denies "$BARE_ROOT"
"$HOST_NODE" - "$CAPTURE" "$BARE_COMMON" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [policyPath, common] = process.argv.slice(2);
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
for (const relative of ["hooks", "config"]) {
  const expected = path.join(common, relative);
  if (!policy.filesystem.denyWrite.includes(expected)) {
    throw new Error(`missing bare deny: ${expected}`);
  }
}
NODE

# A linked worktree whose common repository is non-bare receives no metadata scope.
NONBARE_MAIN="$TEST_ROOT/nonbare main repository"
NONBARE_WORKTREE="$TEST_ROOT/nonbare linked worktree"
mkdir -p "$NONBARE_MAIN"
"$HOST_GIT" -C "$NONBARE_MAIN" init -q
"$HOST_GIT" -C "$NONBARE_MAIN" -c user.name=Test -c user.email=test@example.invalid \
    commit --allow-empty -qm initial
"$HOST_GIT" -C "$NONBARE_MAIN" worktree add -q -b linked "$NONBARE_WORKTREE"
mkdir -p "$NONBARE_WORKTREE/nested"
NONBARE_ROOT="$(canonical_dir "$NONBARE_WORKTREE")"
NONBARE_COMMON="$(canonical_dir "$NONBARE_MAIN/.git")"
NONBARE_SHIMS="$(make_repository_shims "$NONBARE_WORKTREE")"
output="$(run_wrapper "$NONBARE_WORKTREE/nested" "$NONBARE_SHIMS" "$TRUSTED_BIN" --nonbare)"
grep -F "srt_cwd=$NONBARE_ROOT" <<<"$output" >/dev/null
assert_scope_counts "$NONBARE_ROOT"
assert_not_granted "$NONBARE_COMMON"
assert_not_granted "$(canonical_dir "$NONBARE_MAIN")"

# Explicit --yolo remains a direct, unfiltered bypass without selecting a
# repository-local Pi shim or requiring a sandbox runtime.
rm -f "$BOOTSTRAP_MARKER"
yolo_output="$(
    cd "$NORMAL_REPO/nested/deep"
    HOME="$TEST_HOME" \
    PATH="$NORMAL_SHIMS:$WRAPPER_BIN:$REAL_BIN:$TRUSTED_BIN" \
    SECRET_SHOULD_NOT_LEAK=host-secret \
    "$WRAPPER" --yolo --yolo-arg 'two words'
)"
grep -F "pi_cwd=$NORMAL_REPO/nested/deep" <<<"$yolo_output" >/dev/null
grep -F 'args=<--yolo-arg><two words>' <<<"$yolo_output" >/dev/null
grep -F 'secret=host-secret' <<<"$yolo_output" >/dev/null

# The checked-in base fixture itself must remain byte-for-byte reusable.
BASE_BEFORE="$("$HOST_NODE" -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$BASE_POLICY")"
run_wrapper "$NORMAL_REPO/nested/deep" "$NORMAL_SHIMS" "$TRUSTED_BIN" --final >/dev/null
BASE_AFTER="$("$HOST_NODE" -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$BASE_POLICY")"
[[ "$BASE_BEFORE" == "$BASE_AFTER" ]]

echo "repository scope tests passed"
