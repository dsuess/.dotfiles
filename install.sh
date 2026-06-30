#!/usr/bin/env bash
set -e

PLATFORM="$(uname -s)"

OBSIDIAN_VAULT="notes"   # canonical vault for the drift check; match the real folder name

# ── Commands ─────────────────────────────────────────────────────────────────

cmd_software() {
    if [[ "$PLATFORM" == "Darwin" ]]; then
        echo "🍺 Updating Homebrew..."
        brew update

        echo "🔧 Installing CLI tools..."
        brew install git zsh neovim uv fzf thefuck just php htop gnupg direnv tmux openssl the_silver_searcher fd stow ripgrep npm bat asitop

        echo "🖥️  Installing GUI apps..."
        for TGT in karabiner-elements bettertouchtool 1password 1password-cli iterm2 ghostty alfred visual-studio-code google-chrome zotero spotify docker monitorcontrol chatgpt obsidian slack arc zed rectangle-pro; do
            brew install --cask "$TGT"
        done
        echo "✅ Packages installed"
    else
        echo "🐧 Linux detected — install these packages manually:"
        echo ""
        echo "   📋 Required: git zsh stow tmux neovim fzf fd-find ripgrep direnv bat"
        echo "   📎 Optional: thefuck htop npm uv"
        echo ""
        echo "   Debian/Ubuntu:"
        echo "     sudo apt install git zsh stow tmux neovim fzf fd-find ripgrep direnv bat htop npm"
        echo ""
    fi
}

cmd_config() {
    echo "🧹 Removing old symlinks..."
    rm -f ~/.zshrc ~/.zsh_profile ~/.bashrc ~/.bash_profile
    rm -f ~/.gitconfig ~/.gitignore ~/.tmux.conf
    rm -rf ~/.oh-my-zsh ~/.config/nvim ~/.tmux

    mkdir -p ~/bin ~/pi ~/.config ~/.claude ~/.config/opencode ~/.config/ghostty ~/.config/nvim ~/.config/zed ~/.codex ~/.config/uv ~/.config/herdr

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

    # Install npm dependencies for pi extensions that need them
    for pkg in ~/.pi/agent/extensions/*/package.json; do
        if [[ -f "$pkg" ]]; then
            dir="$(dirname "$pkg")"
            echo "📦 Installing npm deps in $dir"
            (cd "$dir" && npm install --omit=dev)
        fi
    done
    if [[ "$PLATFORM" == "Darwin" ]]; then
        stow ghostty -t ~/.config/ghostty
        stow zed -t ~/.config/zed
        stow "Alfred Workflows" -t ~/.config/Alfred.alfredpreferences/workflows/

        OBSIDIAN_DOCS="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents"
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
