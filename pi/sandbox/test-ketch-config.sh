#!/usr/bin/env bash
set -euo pipefail

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "$HERE/../.." && pwd)"
readonly TEST_ROOT="$(mktemp -d)"
readonly ORIGINAL_HOME="$HOME"

cleanup() {
    rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

# install.sh is sourceable so this test exercises the production deployment
# function without running the rest of the dotfiles installer.
source "$REPO_ROOT/install.sh"
cd "$REPO_ROOT"

node -e '
    const fs = require("node:fs");
    const settings = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!settings.packages.includes("npm:pi-ketch@0.1.6")) throw new Error("pinned upstream pi-ketch package is not enabled");
    for (const path of process.argv.slice(2)) {
        if (!fs.existsSync(path)) throw new Error(`missing Gondolin resource: ${path}`);
    }
' \
    "$REPO_ROOT/pi/agent/settings.json" \
    "$REPO_ROOT/pi/sandbox/client.mjs" \
    "$REPO_ROOT/pi/sandbox/controller.mjs" \
    "$REPO_ROOT/pi/agent/extensions/gondolin-sandbox/index.ts"
grep -F 'ketch|targz|ketch|https://github.com/1broseidon/ketch/releases/download/v0.13.0/' "$REPO_ROOT/install.sh" >/dev/null

readonly EXPECTED_BACKEND="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).backend' "$REPO_ROOT/ketch/config.json")"

assert_repo_config() {
    node -e '
        const fs = require("node:fs");
        const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        if (config.backend !== process.argv[2]) throw new Error(`unexpected backend: ${config.backend}`);
    ' "$1" "$EXPECTED_BACKEND"
}

# Linux keeps the XDG-style configuration placement.
HOME="$TEST_ROOT/linux-home"
PLATFORM="Linux"
mkdir -p "$HOME"
deploy_ketch_config
linux_config="$HOME/.config/ketch/config.json"
[[ -L "$linux_config" ]]
assert_repo_config "$linux_config"
[[ ! -e "$HOME/Library/Application Support/ketch/config.json" ]]

# A macOS deployment migrates an obsolete Stow-managed XDG placement through
# Stow and remains stable when repeated.
HOME="$TEST_ROOT/macos-home"
PLATFORM="Linux"
mkdir -p "$HOME"
deploy_ketch_config
legacy_config="$HOME/.config/ketch/config.json"
[[ -L "$legacy_config" ]]

PLATFORM="Darwin"
deploy_ketch_config
macos_config="$HOME/Library/Application Support/ketch/config.json"
[[ ! -e "$legacy_config" ]]
[[ -L "$macos_config" ]]
assert_repo_config "$macos_config"
first_target="$(readlink "$macos_config")"

deploy_ketch_config
[[ ! -e "$legacy_config" ]]
[[ "$(readlink "$macos_config")" == "$first_target" ]]
assert_repo_config "$macos_config"

if [[ "$OSTYPE" == darwin* ]] && command -v ketch >/dev/null 2>&1; then
    effective="$(HOME="$HOME" ketch config --json)"
    node -e '
        const config = JSON.parse(process.argv[1]);
        const expectedPath = process.argv[2];
        const expectedBackend = process.argv[3];
        if (config.backend !== expectedBackend) throw new Error(`unexpected effective backend: ${config.backend}`);
        if (config.config_path !== expectedPath) {
            throw new Error(`unexpected config path: ${config.config_path}`);
        }
    ' "$effective" "$macos_config" "$EXPECTED_BACKEND"
fi

# The Pi package is Stow-managed and idempotent. Never create target links
# manually; the npm pi-ketch package remains managed by Pi itself.
HOME="$TEST_ROOT/pi-home"
mkdir -p "$HOME/.pi"
stow pi -t "$HOME/.pi"
[[ -e "$HOME/.pi/sandbox/client.mjs" ]]
[[ -e "$HOME/.pi/sandbox/controller.mjs" ]]
[[ -e "$HOME/.pi/agent/extensions/gondolin-sandbox/index.ts" ]]
[[ ! -e "$HOME/.pi/sandbox/ketch-broker.mjs" ]]
stow pi -t "$HOME/.pi"
[[ -e "$HOME/.pi/agent/settings.json" ]]

HOME="$ORIGINAL_HOME"
echo "Ketch config and Stow deployment tests passed"
