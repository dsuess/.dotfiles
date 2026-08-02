#!/usr/bin/env bash
set -euo pipefail

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SRT="$HERE/node_modules/.bin/srt"
readonly RUNNER="$HERE/unrestricted-network.mjs"
readonly SETTINGS="$HERE/settings.json"
readonly TEST_BIN="$HERE/test-bin"
readonly TEST_ROOT="$(mktemp -d)"
readonly EXPECTED_BACKEND="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).backend' "$HERE/../../ketch/config.json")"

cleanup() {
    rm -rf "$TEST_ROOT"
    rm -f \
        "$HOME/.config/ketch/.sandbox-write-test" \
        "$HOME/Library/Application Support/ketch/.sandbox-write-test" \
        "$HOME/.dotfiles/ketch/.sandbox-write-test"
}
trap cleanup EXIT

[[ -x "$SRT" ]] || {
    echo "sandbox runtime is not installed; run npm ci in $HERE" >&2
    exit 1
}

if ! command -v ketch >/dev/null 2>&1; then
    echo "skipping live Ketch tests: ketch is not installed" >&2
    exit 0
fi

run_srt() {
    XDG_CACHE_HOME="$HOME/.cache/pi-sandbox" \
        PATH="$TEST_BIN:$PATH" \
        node "$RUNNER" --settings "$SETTINGS" -- "$@"
}

assert_no_x509() {
    if grep -Fq 'OSStatus -26276' "$@"; then
        echo "Ketch still reports the macOS trust-service TLS error" >&2
        return 1
    fi
}

assert_nonempty_json_result() {
    node -e '
        const fs = require("node:fs");
        const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        if (!Array.isArray(value) || value.length === 0) {
            throw new Error("expected at least one result");
        }
    ' "$1"
}

retry_json_results() {
    local name="$1"
    shift
    local output="$TEST_ROOT/$name.json"
    local error="$TEST_ROOT/$name.err"

    for attempt in 1 2 3; do
        if run_srt ketch "$@" >"$output" 2>"$error" && assert_nonempty_json_result "$output"; then
            assert_no_x509 "$output" "$error"
            return 0
        fi
        assert_no_x509 "$output" "$error"
        [[ "$attempt" == 3 ]] || sleep $((attempt * 5))
    done

    echo "$name failed after three attempts" >&2
    cat "$error" >&2
    return 1
}

# Effective config and cache must be healthy inside the sandbox.
run_srt ketch config --json >"$TEST_ROOT/config.json"
run_srt ketch cache --json >"$TEST_ROOT/cache.json"
node -e '
    const fs = require("node:fs");
    const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const cache = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const home = process.env.HOME;
    const isMac = process.platform === "darwin";
    const expectedConfig = isMac
        ? `${home}/Library/Application Support/ketch/config.json`
        : `${home}/.config/ketch/config.json`;
    const expectedCachePrefix = isMac
        ? `${home}/Library/Caches/ketch/`
        : `${home}/.cache/pi-sandbox/ketch/`;
    if (config.backend !== process.argv[3]) throw new Error(`unexpected backend: ${config.backend}`);
    if (config.config_path !== expectedConfig) throw new Error(`unexpected config path: ${config.config_path}`);
    if (!cache.path.startsWith(expectedCachePrefix)) throw new Error(`unexpected cache path: ${cache.path}`);
    if (cache.locked) throw new Error("Ketch cache is locked");
' "$TEST_ROOT/config.json" "$TEST_ROOT/cache.json" "$EXPECTED_BACKEND"

cache_db="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).path' "$TEST_ROOT/cache.json")"
cache_dir="$(dirname "$cache_db")"
run_srt bash -c 'set -e; p="$1/.sandbox-write-test"; printf ok >"$p"; test "$(cat "$p")" = ok; rm "$p"' _ "$cache_dir"

config_dir="$(dirname "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).config_path' "$TEST_ROOT/config.json")")"
if run_srt bash -c 'printf denied >"$1/.sandbox-write-test"' _ "$config_dir" 2>/dev/null; then
    echo "sandbox unexpectedly wrote to the deployed Ketch config directory" >&2
    exit 1
fi
if run_srt bash -c 'printf denied >"$HOME/.dotfiles/ketch/.sandbox-write-test"' 2>/dev/null; then
    echo "sandbox unexpectedly wrote to the canonical Ketch config directory" >&2
    exit 1
fi

# Routine search intentionally omits --backend; federated search tolerates an
# absent localhost SearXNG when keyless remote backends succeed. Run these
# before diagnostics so the doctor probe cannot consume DDG's rate-limit budget.
if ! retry_json_results routine search 'Pi coding agent GitHub' --limit 2 --json; then
    if [[ "$EXPECTED_BACKEND" != "ddg" ]] || ! grep -Eq 'ddg (rate limited|returned status 403)' "$TEST_ROOT/routine.err"; then
        exit 1
    fi
    if [[ "${KETCH_REQUIRE_DDG_LIVE:-0}" == 1 ]]; then
        echo "strict routine search check failed because DuckDuckGo is rate limited" >&2
        exit 1
    fi
    echo "routine search reached the configured DDG backend, but DDG is temporarily rate limited" >&2
fi
retry_json_results federated search 'Pi coding agent GitHub' --multi=all --limit 2 --json
retry_json_results code code SandboxManager --backend grepapp --limit 2 --json

# Diagnostics may report optional no-key/unreachable services (including DDG
# rate limiting after the successful routine probe), but a keyless search
# backend and the cache must work and no surface may show the macOS x509 error.
set +e
run_srt ketch doctor --json >"$TEST_ROOT/doctor.json" 2>"$TEST_ROOT/doctor.err"
doctor_status=$?
set -e
node -e '
    const fs = require("node:fs");
    const checks = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const find = (surface, backend) => checks.find((c) => c.surface === surface && c.backend === backend);
    const keyless = ["ddg", "exa", "keenable"]
        .map((backend) => find("search", backend))
        .filter(Boolean);
    if (!keyless.some((check) => check.status === "ok")) {
        throw new Error("no keyless search diagnostic is healthy");
    }
    if (find("cache", "bbolt")?.status !== "ok") throw new Error("cache diagnostic is not healthy");
    const badOptional = checks.filter((c) =>
        !["ok", "no_key", "unreachable", "skipped"].includes(c.status));
    if (badOptional.length) throw new Error(`unexpected diagnostics: ${JSON.stringify(badOptional)}`);
' "$TEST_ROOT/doctor.json"
assert_no_x509 "$TEST_ROOT/doctor.json" "$TEST_ROOT/doctor.err"
if [[ "$doctor_status" -ne 0 && "$doctor_status" -ne 5 ]]; then
    echo "unexpected ketch doctor exit status: $doctor_status" >&2
    exit 1
fi

# A fresh, uncached request to a host that is absent from the legacy allowlist
# succeeds because the filesystem sandbox no longer installs a network boundary.
run_srt ketch scrape "https://example.com/?ketch-unrestricted=$$" \
    --no-cache --no-llms-txt --max-chars 400 --json \
    >"$TEST_ROOT/unrestricted.json" 2>"$TEST_ROOT/unrestricted.err"
assert_no_x509 "$TEST_ROOT/unrestricted.json" "$TEST_ROOT/unrestricted.err"

echo "live Ketch sandbox tests passed"
