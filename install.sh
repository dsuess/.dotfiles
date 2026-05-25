#!/usr/bin/env bash
set -e

PLATFORM="$(uname -s)"

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

    mkdir -p ~/bin ~/pi ~/.config ~/.claude ~/.config/opencode ~/.config/ghostty ~/.config/nvim ~/.config/zed

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
    stow pi -t ~/.pi/

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
        if [[ -d "$OBSIDIAN_DOCS" ]]; then
            for vault in "$OBSIDIAN_DOCS"/*/; do
                obsidian_dir="${vault}.obsidian"
                [[ -d "$obsidian_dir" ]] || continue
                echo "🔗 Stowing obsidian into $obsidian_dir"
                for f in obsidian/*; do
                    rm -rf "$obsidian_dir/$(basename "$f")"
                done
                stow obsidian -t "$obsidian_dir"
            done
        fi
    fi
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
