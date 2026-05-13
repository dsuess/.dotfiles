#!/bin/sh

brew tap homebrew/cask-versions

for TGT in "karabiner-elements bettertouchtool 1password 1password-cli iterm2 alfred visual-studio-code google-chrome dash@6 zotero spotify docker monitorcontrol chatgpt bat asitop"
  do
  brew install --cask $TGT
  done

brew update
brew install git zsh neovim uv fzf thefuck just php htop gnupg direnv tmux openssl the_silver_searcher fd stow ripgrep


