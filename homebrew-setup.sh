#!/bin/sh

brew tap homebrew/cask-versions

for TGT in "karabiner-elements bettertouchtool 1password iterm2 alfred visual-studio-code-insiders google-chrome dash"
  do
  brew install --cask $TGT
  done

brew update
brew install git zsh neovim fzf thefuck just php htop gnupg direnv tmux openssl pyenv


