zstyle ':completion::complete:*' use-cache 1
ZSH_DISABLE_COMPFIX="true"

source ~/.dotfiles/vars.sh

# Oh-My-Zsh Configuration ─────────────────────────────────────────────────────
ZSH="$HOME/.oh-my-zsh"
ZSH_CUSTOM="$HOME/.dotfiles/my-zsh"
ZSH_THEME="customrobby"

DISABLE_CORRECTION="false"
COMPLETION_WAITING_DOTS="true"
CASE_SENSITIVE="false"

plugins=(git z brew pip zsh-syntax-highlighting tmux)
source "$ZSH/oh-my-zsh.sh"

# Zsh Options ──────────────────────────────────────────────────────────────────
setopt inc_append_history
setopt share_history
unsetopt correct

# Terminal Settings ────────────────────────────────────────────────────────────
stty stop undef
stty start undef

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

# direnv
eval "$(direnv hook zsh)"
if [[ -n "$DIRENV_DIR" ]]; then
  direnv reload
fi

# thefuck
alias fuck="unalias fuck; eval \$(thefuck --alias); fuck"

# z + fzf
unalias z
z() {
  if [[ $# -eq 0 ]]; then
    cd "$(_z -l 2>&1 | fzf +s --tac | sed 's/^[0-9,.]* *//')"
  else
    _z "$@" 2>&1 || cd "$(_z -l 2>&1 | fzf -q "$*" +s --tac | sed 's/^[0-9,.]* *//')"
  fi
}

# fzf key bindings
source /opt/homebrew/Cellar/fzf/*/shell/key-bindings.zsh

# Startup Scripts ──────────────────────────────────────────────────────────────
[[ -e "${HOME}/.iterm2_shell_integration.zsh" ]] && source "${HOME}/.iterm2_shell_integration.zsh"
[[ -f "${HOME}/.dotfiles/tmux_startup.sh" ]] && source "${HOME}/.dotfiles/tmux_startup.sh"
[[ -f "${HOME}/.zshrc.local" ]] && source "${HOME}/.zshrc.local"

# Aliases ──────────────────────────────────────────────────────────────────────

# Editor
alias vim="nvim"
alias vmi="nvim"

# Git
alias gs="git status -s"
alias gss="git --no-pager status"
alias ga="git add"
alias gl="git --no-pager lv -50 --no-merges"
alias gll="git lg"
alias gd="git difftool"
alias gf="git fetch"
alias gv="git difftool ...FETCH_HEAD"
alias gr="git rm"
alias gcd='cd $(git rev-parse --show-cdup)'

# Tools
alias bd="bat --diff"
alias xargs="gxargs"
alias claude="EDITOR= claude --dangerously-skip-permissions"
alias opencode="opentmux"
export OPENCODE_PORT=4096

# Files & Navigation
alias mkdir="mkdir -pv"
alias du="du -h"
alias df="df -h"
alias fzf="fzf-tmux"
alias f="fzf-tmux -m"
alias scp="noglob scp"
alias ff="open -a Finder ./"

# Safety — confirm before overwriting
alias mv="mv -i"
alias cp="cp -i"
alias ln="ln -i"
alias chown="chown --preserve-root"
alias chgrp="chgrp --preserve-root"
