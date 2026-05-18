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
    plugins=(git z tmux brew zsh-syntax-highlighting)
else
    plugins=(git z tmux)
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

# To customize prompt, run `p10k configure` or edit ~/.p10k.zsh.
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh
