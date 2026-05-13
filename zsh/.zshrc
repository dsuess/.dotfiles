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

if [[ "$(uname -s)" == "Darwin" ]]; then
    plugins=(git z brew pip zsh-syntax-highlighting tmux)
else
    plugins=(git z pip tmux)
fi
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
if command -v direnv &>/dev/null; then
    eval "$(direnv hook zsh)"
    if [[ -n "$DIRENV_DIR" ]]; then
      direnv reload
    fi
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
    # fzf key bindings (homebrew)
    source /opt/homebrew/Cellar/fzf/*/shell/key-bindings.zsh
else
    # fzf
    [[ -f ~/.fzf.zsh ]] && source ~/.fzf.zsh
fi

# z + fzf
unalias z 2>/dev/null
z() {
  if [[ $# -eq 0 ]]; then
    cd "$(_z -l 2>&1 | fzf +s --tac | sed 's/^[0-9,.]* *//')"
  else
    _z "$@" 2>&1 || cd "$(_z -l 2>&1 | fzf -q "$*" +s --tac | sed 's/^[0-9,.]* *//')"
  fi
}

# Startup Scripts ──────────────────────────────────────────────────────────────
[[ -e "${HOME}/.iterm2_shell_integration.zsh" ]] && source "${HOME}/.iterm2_shell_integration.zsh"
[[ -f "${HOME}/.dotfiles/tmux_startup.sh" ]] && source "${HOME}/.dotfiles/tmux_startup.sh"

# Aliases ──────────────────────────────────────────────────────────────────────
source ~/.dotfiles/aliases

# Local overrides (machine-specific, not tracked) ─────────────────────────────
[[ -f "${HOME}/.zshrc.local" ]] && source "${HOME}/.zshrc.local"


# >>> opentmux >>>
export OPENCODE_PORT=4096
alias opencode='opentmux'
# <<< opentmux <<<
