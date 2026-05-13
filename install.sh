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
        for TGT in karabiner-elements bettertouchtool 1password 1password-cli iterm2 ghostty alfred visual-studio-code google-chrome zotero spotify docker monitorcontrol chatgpt obsidian slack arc; do
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

    mkdir -p ~/bin ~/.config ~/.claude ~/.config/opencode ~/.config/ghostty

    echo "🔗 Stowing configs..."
    stow zsh -t ~
    stow bash -t ~
    stow git -t ~
    stow tmux -t ~
    stow nvim -t ~
    stow oh-my-zsh -t ~
    stow bin -t ~/bin/
    stow claude -t ~/.claude/
    stow opencode -t ~/.config/opencode/
    stow ghostty -t ~/.config/ghostty
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
