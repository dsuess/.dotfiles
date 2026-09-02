# Load direnv's current-dir state BEFORE the p10k instant prompt block so its
# "loading .envrc" / "export ..." stderr is emitted during the I/O-allowed
# preamble. The hook itself is installed further down; by the time it fires
# at precmd, the env is already current and direnv stays silent.
if command -v direnv &>/dev/null; then
  eval "$(direnv export zsh)"
fi

# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
# Initialization code that may require console input (password prompts, [y/n]
# confirmations, etc.) must go above this block; everything else may go below.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

zstyle ':completion::complete:*' use-cache 1
ZSH_DISABLE_COMPFIX="true"

source ~/.dotfiles/vars.sh

# Oh-My-Zsh Configuration ─────────────────────────────────────────────────────
ZSH="$HOME/.oh-my-zsh"
ZSH_CUSTOM="$HOME/.dotfiles/my-zsh"
source $ZSH_CUSTOM/themes/powerlevel10k/powerlevel10k.zsh-theme

DISABLE_CORRECTION="false"
COMPLETION_WAITING_DOTS="true"
CASE_SENSITIVE="false"

if [[ "$(uname -s)" == "Darwin" ]]; then
    plugins=(git z zsh-vi-mode brew zsh-syntax-highlighting)
else
    plugins=(git z zsh-vi-mode zsh-syntax-highlighting)
fi
source "$ZSH/oh-my-zsh.sh"

# Zsh Options ──────────────────────────────────────────────────────────────────
setopt inc_append_history
setopt share_history
unsetopt correct

# Terminal Settings ────────────────────────────────────────────────────────────
[[ -t 0 ]] && stty stop undef
[[ -t 0 ]] && stty start undef

# SSH Completion ───────────────────────────────────────────────────────────────
hosts=()
if [[ -r ~/.ssh/config ]]; then
  hosts=($hosts ${${${(@M)${(f)"$(cat ~/.ssh/config)"}:#Host *}#Host }:#*[*?]*})
fi
if [[ -r ~/.ssh/known_hosts ]]; then
  hosts=($hosts ${${${(f)"$(cat ~/.ssh/known_hosts{,2} || true)"}%%\ *}%%,*}) 2>/dev/null
fi
if [[ $#hosts -gt 0 ]]; then
  zstyle ':completion:*:ssh:*' hosts $hosts
  zstyle ':completion:*:scp:*' hosts $hosts
  zstyle ':completion:*:slogin:*' hosts $hosts
fi

# Tool Integration ─────────────────────────────────────────────────────────────
# Theme: catppuccin-mocha
export FZF_DEFAULT_OPTS="$FZF_DEFAULT_OPTS --color=bg+:#313244,bg:#1e1e2e,spinner:#f5e0dc,hl:#f38ba8 --color=fg:#cdd6f4,header:#f38ba8,info:#cba6f7,pointer:#f5e0dc --color=marker:#f5e0dc,fg+:#cdd6f4,prompt:#cba6f7,hl+:#f38ba8"
if command -v direnv &>/dev/null; then
    eval "$(direnv hook zsh)"
fi

# Keep Herdr's Space label in sync with shell directory changes.
source "$HOME/.dotfiles/herdr/plugins/worktree-label/shell.zsh"

# Use zsh's native last-argument widget for both forms of Esc-. that
# zsh-vi-mode can produce: one viins Meta sequence, or `.` after Esc has
# already entered normal mode. In normal mode, resume insertion after the
# cursor before adding the argument.
function _dotfiles_insert_last_word() {
  if [[ $ZVM_MODE == $ZVM_MODE_NORMAL ]]; then
    (( CURSOR < $#BUFFER )) && (( CURSOR++ ))
    zvm_select_vi_mode $ZVM_MODE_INSERT
  fi
  zle .insert-last-word
}
zle -N _dotfiles_insert_last_word

# zsh-vi-mode overwrites the viins keymap when it initializes on the first
# precmd (after this file has already sourced fzf's key bindings below),
# which clobbers fzf's Ctrl+R binding in insert mode. Restore both bindings
# once its own initialization finishes.
function zvm_after_init() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    source /opt/homebrew/Cellar/fzf/*/shell/key-bindings.zsh
  else
    [[ -f ~/.fzf.zsh ]] && source ~/.fzf.zsh
  fi
  bindkey -M viins '\e.' _dotfiles_insert_last_word
}

# Normal-mode bindings are installed lazily on the first Esc, after the main
# initialization hook, so replace `.` only once that delayed setup is complete.
function zvm_after_lazy_keybindings() {
  bindkey -M vicmd '.' _dotfiles_insert_last_word
}

zvm_after_init

# Ctrl+O: fzf file picker rooted at $HOME (sibling to Ctrl+T, which uses $PWD).
# ^O defaults to accept-line-and-down-history, which we don't use interactively.
# Uses fd with --hidden (so dotfiles are pickable) and --follow (so stowed
# symlinks resolve to their files), minus heavy machine-managed trees: macOS
# system/app data, media libraries, dev build output, and hidden tool caches.
fzf-home-file-widget() {
  local file
  file=$(cd "$HOME" && fd --type f --hidden --follow 2>/dev/null \
    --exclude Library --exclude Applications \
    --exclude Pictures --exclude Movies --exclude Music --exclude '*.photoslibrary' \
    --exclude node_modules --exclude .git --exclude .venv \
    --exclude target --exclude build --exclude dist --exclude __pycache__ \
    --exclude .cache --exclude .Trash --exclude .npm --exclude .cargo \
    --exclude .rustup --exclude .gradle --exclude .m2 --exclude .cocoapods \
    | fzf --height 40% --reverse --prompt '~/ > ') || { zle redisplay; return }
  [[ -z $file ]] && { zle redisplay; return }
  local full="$HOME/${file#./}"
  LBUFFER+="${(q)full} "
  zle redisplay
}
zle -N fzf-home-file-widget
bindkey '^O' fzf-home-file-widget

# z + fzf
unalias z 2>/dev/null
z() {
  if [[ $# -eq 0 ]]; then
    cd "$(zshz -l 2>&1 | fzf +s --tac | sed 's/^[0-9,.]* *//')"
  else
    zshz "$@" 2>&1 || cd "$(zshz -l 2>&1 | fzf -q "$*" +s --tac | sed 's/^[0-9,.]* *//')"
  fi
}

# Startup Scripts ──────────────────────────────────────────────────────────────
[[ -e "${HOME}/.iterm2_shell_integration.zsh" ]] && source "${HOME}/.iterm2_shell_integration.zsh"
[[ -f "${HOME}/.dotfiles/tmux_startup.sh" ]] && source "${HOME}/.dotfiles/tmux_startup.sh"

# Aliases ──────────────────────────────────────────────────────────────────────
source ~/.dotfiles/aliases

# Local overrides (machine-specific, not tracked) ─────────────────────────────
[[ -f "${HOME}/.zshrc.local" ]] && source "${HOME}/.zshrc.local"

# To customize prompt, run `p10k configure` or edit ~/.p10k.zsh.
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh
