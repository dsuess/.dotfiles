#!/usr/bin/env bash
set -e

PLATFORM="$(uname -s)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OBSIDIAN_VAULT="work"   # canonical vault for the drift check; match the real folder name

LOCAL_BIN="$HOME/.local/bin"   # where the Linux bootstrap drops vendored/downloaded tools

# ── Linux bootstrap ────────────────────────────────────────────────────────────
# On Linux there may be no package manager / no root, so make the tools install.sh
# relies on available without one. All of this is a no-op on macOS (Homebrew owns
# the toolchain there) — these functions return early on Darwin.

# stow is a Perl script, not a compiled binary, so we vendor GNU Stow's Perl files
# (vendor/stow/) and run them with the system perl. If no stow is on PATH, symlink
# the vendored copy into ~/.local/bin and put that on PATH for the rest of this run.
ensure_stow() {
    [[ "$PLATFORM" == "Darwin" ]] && return 0
    command -v stow >/dev/null 2>&1 && return 0

    if ! command -v perl >/dev/null 2>&1; then
        echo "❌ Neither stow nor perl found. Install perl (present on ~every Linux) and re-run." >&2
        exit 1
    fi

    echo "📦 No system stow — using vendored GNU Stow (vendor/stow) via system perl"
    mkdir -p "$LOCAL_BIN"
    ln -sf "$SCRIPT_DIR/vendor/stow/bin/stow" "$LOCAL_BIN/stow"
    case ":$PATH:" in
        *":$LOCAL_BIN:"*) ;;
        *) export PATH="$LOCAL_BIN:$PATH" ;;
    esac
}

# Verify a file against a hardcoded SHA256; abort on mismatch (never install
# an unverified binary). Uses sha256sum, falling back to shasum -a 256.
verify_sha256() {
    local file="$1" expected="$2" actual
    if command -v sha256sum >/dev/null 2>&1; then
        actual="$(sha256sum "$file" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then
        actual="$(shasum -a 256 "$file" | awk '{print $1}')"
    else
        echo "❌ No sha256 tool (sha256sum/shasum) found; cannot verify downloads." >&2
        exit 1
    fi
    if [[ "$actual" != "$expected" ]]; then
        echo "❌ Checksum mismatch for $(basename "$file")" >&2
        echo "   expected: $expected" >&2
        echo "   actual:   $actual" >&2
        exit 1
    fi
}

# Download pinned static binaries into ~/.local/bin, verifying each against a
# hardcoded SHA256 before install. Skips any tool already on PATH. Linux-only.
#
# Table columns (| separated): name|type|member|url_x86|sha_x86|url_arm|sha_arm
#   name   = command name (also the installed filename)
#   type   = raw (bare binary) | targz (tarball, extract `member`)
#   member = basename of the binary inside the tarball (ignored for raw)
# Checksums are GitHub's own published per-asset digests. To bump a version,
# replace both the URL and the SHA for each arch (see AGENTS.md).
ensure_static_bins() {
    [[ "$PLATFORM" == "Darwin" ]] && return 0

    local slot
    case "$(uname -m)" in
        x86_64|amd64)  slot=x86 ;;
        aarch64|arm64) slot=arm ;;
        *) echo "⚠️  Unsupported arch '$(uname -m)'; skipping static binary downloads." >&2; return 0 ;;
    esac

    local req
    for req in curl tar; do
        command -v "$req" >/dev/null 2>&1 || { echo "❌ '$req' is required for the Linux bootstrap." >&2; exit 1; }
    done

    mkdir -p "$LOCAL_BIN"
    case ":$PATH:" in *":$LOCAL_BIN:"*) ;; *) export PATH="$LOCAL_BIN:$PATH" ;; esac

    local name type member url_x86 sha_x86 url_arm sha_arm url sha tmp dl bin
    while IFS='|' read -r name type member url_x86 sha_x86 url_arm sha_arm; do
        [[ -z "$name" || "$name" == \#* ]] && continue
        if command -v "$name" >/dev/null 2>&1; then
            echo "✓ $name already available ($(command -v "$name"))"
            continue
        fi
        if [[ "$slot" == x86 ]]; then url="$url_x86"; sha="$sha_x86"; else url="$url_arm"; sha="$sha_arm"; fi

        echo "⬇️  $name ($url)"
        tmp="$(mktemp -d)"
        dl="$tmp/download"
        if ! curl -fsSL "$url" -o "$dl"; then
            echo "❌ Download failed: $url" >&2; rm -rf "$tmp"; exit 1
        fi
        verify_sha256 "$dl" "$sha"

        if [[ "$type" == raw ]]; then
            install -m 0755 "$dl" "$LOCAL_BIN/$name"
        else
            tar -xzf "$dl" -C "$tmp"
            bin="$(find "$tmp" -type f -name "$member" | head -n1)"
            if [[ -z "$bin" ]]; then
                echo "❌ '$member' not found in archive for $name" >&2; rm -rf "$tmp"; exit 1
            fi
            install -m 0755 "$bin" "$LOCAL_BIN/$name"
        fi
        rm -rf "$tmp"
        echo "✅ installed $name → $LOCAL_BIN/$name"
    done <<'TOOLS'
herdr|raw||https://github.com/ogulcancelik/herdr/releases/download/v0.7.1/herdr-linux-x86_64|b965acaffc2c22f54b6e6c64af7cf8e98a3f4ac2622630a0599c67a4b9d8a654|https://github.com/ogulcancelik/herdr/releases/download/v0.7.1/herdr-linux-aarch64|3d757ac30c631e79dc45038c3ecc6423fe13a89f9cffa0f415aedd2c27f1576c
rg|targz|rg|https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz|33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c|https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-aarch64-unknown-linux-musl.tar.gz|800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915
fd|targz|fd|https://github.com/sharkdp/fd/releases/download/v10.4.2/fd-v10.4.2-x86_64-unknown-linux-musl.tar.gz|e3257d48e29a6be965187dbd24ce9af564e0fe67b3e73c9bdcd180f4ec11bdde|https://github.com/sharkdp/fd/releases/download/v10.4.2/fd-v10.4.2-aarch64-unknown-linux-musl.tar.gz|f32d3657473fba74e2600babc8db0b93420d51169223b7e8143b2ed55d8fd9e8
bat|targz|bat|https://github.com/sharkdp/bat/releases/download/v0.26.1/bat-v0.26.1-x86_64-unknown-linux-musl.tar.gz|0dcd8ac79732c0d5b136f11f4ee00e581440e16a44eab5b3105b611bbf2cf191|https://github.com/sharkdp/bat/releases/download/v0.26.1/bat-v0.26.1-aarch64-unknown-linux-musl.tar.gz|6369242c584065f195fb20cb36fbd7cb63ae690605bbe89868a7596b596c2c23
fzf|targz|fzf|https://github.com/junegunn/fzf/releases/download/v0.74.1/fzf-0.74.1-linux_amd64.tar.gz|df53438be5f51e151bb4044d78fda72bdfe209e3ecd2baecae48e8dea370c81b|https://github.com/junegunn/fzf/releases/download/v0.74.1/fzf-0.74.1-linux_arm64.tar.gz|f22204dd1a091d43e102268d062fd53b47133c8d8581671ee5eb225b75e31183
direnv|raw||https://github.com/direnv/direnv/releases/download/v2.37.1/direnv.linux-amd64|1f1b93dd6f38523fde26dfac96151ef9d31a374e3005cd3345fb93555ae0c9b5|https://github.com/direnv/direnv/releases/download/v2.37.1/direnv.linux-arm64|2a9cef8d73521d6a3ec3f2871c4b747b8c4cc038628c1b57a7efa42b393a2d82
TOOLS
}

# neovim ships as an AppImage, which normally needs FUSE at runtime — and installing
# FUSE needs root, which this bootstrap can't assume. So rather than run the AppImage
# mounted, we download the pinned asset, verify it, and *extract* it: `--appimage-extract`
# uses the AppImage's own embedded runtime and needs no FUSE. The extracted tree lives in
# ~/.local/lib/nvim and ~/.local/bin/nvim symlinks its AppRun launcher. Skips if nvim is
# already on PATH. Linux-only. To bump the version, replace NVIM_VERSION, both URLs, and
# both SHA256s (authoritative source: each asset's `digest` from the GitHub release API).
NVIM_VERSION="v0.12.4"
NVIM_URL_X86="https://github.com/neovim/neovim/releases/download/v0.12.4/nvim-linux-x86_64.appimage"
NVIM_SHA_X86="cdbd8b533b500e272021e1021eafcfe28a77fc4d769465a8f1a48a34002383a7"
NVIM_URL_ARM="https://github.com/neovim/neovim/releases/download/v0.12.4/nvim-linux-arm64.appimage"
NVIM_SHA_ARM="3b819841c975b9c206eff5676b5827921cc09867059452615e2e02d9c0a665af"

ensure_neovim() {
    [[ "$PLATFORM" == "Darwin" ]] && return 0
    # Keep an existing nvim only if it's recent enough (our config needs >= 0.12);
    # an older or unparseable one falls through to the pinned AppImage. `nvim --version`
    # prints "NVIM v0.12.4" on line 1; empty fields compare as 0 inside [[ -ge ]].
    if command -v nvim >/dev/null 2>&1; then
        local cur major minor
        cur="$(nvim --version 2>/dev/null | sed -n '1s/^NVIM v//p')"
        major="${cur%%.*}"; minor="${cur#*.}"; minor="${minor%%.*}"
        if [[ "$major" -gt 0 || ( "$major" -eq 0 && "$minor" -ge 12 ) ]]; then
            echo "✓ nvim ${cur:-?} already available ($(command -v nvim))"
            return 0
        fi
        echo "↻ nvim ${cur:-<unknown>} is older than 0.12 — installing pinned AppImage"
    fi

    local url sha
    case "$(uname -m)" in
        x86_64|amd64)  url="$NVIM_URL_X86"; sha="$NVIM_SHA_X86" ;;
        aarch64|arm64) url="$NVIM_URL_ARM"; sha="$NVIM_SHA_ARM" ;;
        *) echo "⚠️  Unsupported arch '$(uname -m)'; skipping neovim." >&2; return 0 ;;
    esac

    command -v curl >/dev/null 2>&1 || { echo "❌ 'curl' is required to install neovim." >&2; exit 1; }

    mkdir -p "$LOCAL_BIN"
    case ":$PATH:" in *":$LOCAL_BIN:"*) ;; *) export PATH="$LOCAL_BIN:$PATH" ;; esac

    local dest="$HOME/.local/lib/nvim" tmp
    echo "⬇️  neovim $NVIM_VERSION ($url)"
    tmp="$(mktemp -d)"
    if ! curl -fsSL "$url" -o "$tmp/nvim.appimage"; then
        echo "❌ Download failed: $url" >&2; rm -rf "$tmp"; exit 1
    fi
    verify_sha256 "$tmp/nvim.appimage" "$sha"

    # Extract (no FUSE) rather than mount. Runs from $tmp so squashfs-root lands there.
    chmod +x "$tmp/nvim.appimage"
    if ! ( cd "$tmp" && ./nvim.appimage --appimage-extract >/dev/null ); then
        echo "❌ Failed to extract neovim AppImage" >&2; rm -rf "$tmp"; exit 1
    fi

    rm -rf "$dest"
    mkdir -p "$(dirname "$dest")"
    mv "$tmp/squashfs-root" "$dest"
    ln -sf "$dest/AppRun" "$LOCAL_BIN/nvim"
    rm -rf "$tmp"
    echo "✅ installed neovim → $LOCAL_BIN/nvim (extracted to $dest)"
}

# ── Commands ─────────────────────────────────────────────────────────────────

cmd_software() {
    if [[ "$PLATFORM" == "Darwin" ]]; then
        echo "🍺 Updating Homebrew..."
        brew update

        echo "🔧 Installing CLI tools..."
        brew install git zsh neovim uv fzf thefuck just php htop gnupg direnv tmux openssl the_silver_searcher fd stow ripgrep npm bat asitop findutils imagemagick

        echo "🖥️  Installing GUI apps..."
        for TGT in karabiner-elements bettertouchtool 1password 1password-cli ghostty alfred google-chrome zotero spotify docker monitorcontrol chatgpt obsidian slack arc zed fluidvoice; do
            brew install --cask "$TGT"
        done
        echo "✅ Packages installed"
    else
        echo "🐧 Linux detected — bootstrapping tools without a package manager..."
        echo ""
        ensure_stow          # vendored GNU Stow (via system perl) if none present
        ensure_static_bins   # pinned, checksum-verified static binaries → ~/.local/bin
        ensure_neovim        # pinned neovim AppImage, extracted (no FUSE) → ~/.local/bin
        echo ""
        echo "✅ Bootstrap done. Tools live in $LOCAL_BIN (added to PATH by the shell configs)."
        echo ""
        echo "   ℹ️  Not bootstrapped here — install via your package manager if needed:"
        echo "      git zsh tmux npm  (plus optional: thefuck htop uv)"
        echo ""
    fi
}

cmd_config() {
    ensure_stow   # Linux: make `stow` available (vendored); no-op on macOS

    echo "🧹 Removing old symlinks..."
    rm -f ~/.zshrc ~/.zsh_profile ~/.bashrc ~/.bash_profile
    rm -f ~/.gitconfig ~/.gitignore ~/.tmux.conf
    rm -rf ~/.oh-my-zsh ~/.config/nvim ~/.tmux

    mkdir -p ~/bin ~/pi ~/.config ~/.claude ~/.config/opencode ~/.config/ghostty ~/.config/nvim ~/.config/zed ~/.codex ~/.config/uv ~/.config/herdr ~/.pi

    echo "🔗 Stowing configs..."
    stow zsh -t ~
    stow bash -t ~
    stow git -t ~
    stow tmux -t ~
    stow nvim -t ~/.config/nvim
    stow oh-my-zsh -t ~
    stow bin -t ~/bin/
    stow claude -t ~/.claude/
    stow opencode -t ~/.config/opencode/
    stow codex -t ~/.codex/
    stow pi -t ~/.pi/
    stow uv -t ~/.config/uv
    stow herdr -t ~/.config/herdr

    # Install npm dependencies for pi extensions that need them (skip if no npm)
    if command -v node >/dev/null 2>&1; then
        for pkg in ~/.pi/agent/extensions/*/package.json; do
            if [[ -f "$pkg" ]]; then
                dir="$(dirname "$pkg")"
                echo "📦 Installing npm deps in $dir"
                (cd "$dir" && npm install --omit=dev)
            fi
        done
    else
        echo "⚠️  npm not found — skipping pi extension npm deps."
    fi
    if [[ "$PLATFORM" == "Darwin" ]]; then
        stow ghostty -t ~/.config/ghostty
        stow zed -t ~/.config/zed
        stow "Alfred Workflows" -t ~/.config/Alfred.alfredpreferences/workflows/

        OBSIDIAN_DOCS="$HOME/Documents"
        [[ -d "$OBSIDIAN_DOCS" ]] && sync_obsidian "$OBSIDIAN_DOCS"
    fi
}

# Deploy obsidian config as real files (iCloud can't sync symlinks to iPadOS),
# with a safe round-trip: pull the canonical vault's config back into the repo
# first and refuse to deploy if it drifted from the committed state.
sync_obsidian() {
    local docs="$1"
    local canonical="$docs/$OBSIDIAN_VAULT/.obsidian"

    # 1. Clean baseline so drift is detectable.
    if [[ -n "$(git status --porcelain obsidian)" ]]; then
        echo "❌ obsidian/ has uncommitted changes — commit or stash first." >&2
        exit 1
    fi

    # 2. Pull the canonical vault's tracked config back into the repo.
    #    Stage via a dereferencing copy (-L) so legacy stow symlinks that point
    #    back into the repo resolve to real content instead of self-referencing
    #    (or destroying) the repo file. `-e` skips broken/dangling links.
    if [[ -d "$canonical" ]]; then
        local stage; stage="$(mktemp -d)"
        for f in obsidian/*; do
            base="$(basename "$f")"
            [[ -e "$canonical/$base" ]] || continue
            cp -RL "$canonical/$base" "$stage/$base"
            rm -rf "$f"
            cp -R "$stage/$base" obsidian/
        done
        rm -rf "$stage"

        # 3. Any change means the device drifted — stop and let the user commit.
        if [[ -n "$(git status --porcelain obsidian)" ]]; then
            echo "❌ The '$OBSIDIAN_VAULT' vault has config changes not in the repo." >&2
            echo "   Review: git diff obsidian/  — commit (or 'git checkout obsidian/' to discard), then re-run." >&2
            exit 1
        fi
    else
        echo "⚠️  Vault '$OBSIDIAN_VAULT' config not found; skipping drift check." >&2
    fi

    # 4. Deploy repo → all vaults as real files.
    for vault in "$docs"/*/; do
        obsidian_dir="${vault}.obsidian"
        [[ -d "$obsidian_dir" ]] || continue
        echo "📋 Copying obsidian config into $obsidian_dir"
        for f in obsidian/*; do
            rm -rf "$obsidian_dir/$(basename "$f")"
            cp -R "$f" "$obsidian_dir/"
        done
    done
}

# ── Main ─────────────────────────────────────────────────────────────────────

echo ""
echo "🚀 dotfiles installer"
echo "━━━━━━━━━━━━━━━━━━━━━"
echo "📦 Platform: $PLATFORM"
echo ""

COMMAND="${1:-all}"

case "$COMMAND" in
    software)
        cmd_software
        ;;
    config)
        cmd_config
        ;;
    all)
        cmd_software
        cmd_config
        ;;
    *)
        echo "Usage: $0 [software|config|all]"
        exit 1
        ;;
esac

echo ""
echo "✨ All done! Restart your shell or run: source ~/.zshrc"
echo ""
