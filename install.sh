#!/usr/bin/env bash
set -e

# Remove old symlinks that may conflict with stow
rm -f ~/.zshrc ~/.zsh_profile ~/.bashrc ~/.bash_profile
rm -f ~/.gitconfig ~/.gitignore ~/.tmux.conf
rm -rf ~/.oh-my-zsh ~/.config/nvim ~/.tmux

mkdir -p ~/bin ~/.config

stow zsh -t ~
stow bash -t ~
stow git -t ~
stow tmux -t ~
stow nvim -t ~
stow oh-my-zsh -t ~
stow bin -t ~/bin/


for TGT in "karabiner-elements bettertouchtool 1password 1password-cli iterm2 alfred visual-studio-code google-chrome dash@6 zotero spotify docker monitorcontrol chatgpt obsidian slack arc"
  do
  brew install --cask $TGT
  done

brew update
brew install git zsh neovim uv fzf thefuck just php htop gnupg direnv tmux openssl the_silver_searcher fd stow ripgrep npm bat asitop

