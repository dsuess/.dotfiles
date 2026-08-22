#!/usr/bin/env bash
set -euo pipefail

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

if ! command -v ketch >/dev/null 2>&1; then
    echo "skipping live Ketch tests: ketch is not installed" >&2
    exit 0
fi

run_ketch() {
    XDG_CACHE_HOME="$HOME/.cache/pi-gondolin/host" "$@"
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
        if run_ketch ketch "$@" >"$output" 2>"$error" && assert_nonempty_json_result "$output"; then
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

# The audited host adapter uses native Ketch config and a host-only cache.
run_ketch ketch config --json >"$TEST_ROOT/config.json"
run_ketch ketch cache --json >"$TEST_ROOT/cache.json"
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
        : `${home}/.cache/pi-gondolin/host/ketch/`;
    if (config.backend !== process.argv[3]) throw new Error(`unexpected backend: ${config.backend}`);
    if (config.config_path !== expectedConfig) throw new Error(`unexpected config path: ${config.config_path}`);
    if (!cache.path.startsWith(expectedCachePrefix)) throw new Error(`unexpected cache path: ${cache.path}`);
    if (cache.locked) throw new Error("Ketch cache is locked");
' "$TEST_ROOT/config.json" "$TEST_ROOT/cache.json" "$EXPECTED_BACKEND"

cache_db="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).path' "$TEST_ROOT/cache.json")"
cache_dir="$(dirname "$cache_db")"
run_ketch bash -c 'set -e; p="$1/.sandbox-write-test"; printf ok >"$p"; test "$(cat "$p")" = ok; rm "$p"' _ "$cache_dir"

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
retry_json_results code code RealFSProvider --backend grepapp --limit 2 --json

# Diagnostics may report optional no-key/unreachable services (including DDG
# rate limiting after the successful routine probe), but a keyless search
# backend and the cache must work and no surface may show the macOS x509 error.
set +e
run_ketch ketch doctor --json >"$TEST_ROOT/doctor.json" 2>"$TEST_ROOT/doctor.err"
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
        !["ok", "no_key", "unreachable", "skipped"].includes(c.status) &&
        !(c.surface === "browser" && c.status === "misconfigured"));
    if (badOptional.length) throw new Error(`unexpected diagnostics: ${JSON.stringify(badOptional)}`);
' "$TEST_ROOT/doctor.json"
assert_no_x509 "$TEST_ROOT/doctor.json" "$TEST_ROOT/doctor.err"
if [[ "$doctor_status" -ne 0 && "$doctor_status" -ne 5 ]]; then
    echo "unexpected ketch doctor exit status: $doctor_status" >&2
    exit 1
fi

# Ketch intentionally retains host networking as an audited adapter.
run_ketch ketch scrape "https://example.com/?ketch-host-adapter=$$" \
    --no-cache --no-llms-txt --max-chars 400 --json \
    >"$TEST_ROOT/unrestricted.json" 2>"$TEST_ROOT/unrestricted.err"
assert_no_x509 "$TEST_ROOT/unrestricted.json" "$TEST_ROOT/unrestricted.err"

echo "live Ketch host-adapter tests passed"
