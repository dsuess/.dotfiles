zstyle ':completion::complete:*' use-cache 1
ZSH_DISABLE_COMPFIX="true"

source ~/.dotfiles/vars.sh
## OH-MY-ZSH SPECIFIC STUFF ###################################################
ZSH=$HOME/.oh-my-zsh
ZSH_CUSTOM=$HOME/.dotfiles/my-zsh
ZSH_THEME="customrobby"

DISABLE_CORRECTION="false"
COMPLETION_WAITING_DOTS="true"
CASE_SENSETIVE="false"

# Load the oh-my-zsh plugins and settings
plugins=(git z brew pip zsh-syntax-highlighting tmux)
source $ZSH/oh-my-zsh.sh

# since option doesnt seem to work
bindkey "^I" expand-or-complete-with-dots

## Final customization of zsh #################################################
# Write history of multiple zsh-sessions chronologicaly ordered
setopt inc_append_history

# Share history over multiple sessions
setopt share_history

# Disable the anoying autocorrect
unsetopt correct

# Hit escape twice to clear the current input line
bindkey "" vi-change-whole-line

# Disable <c-s> for stopping terminal
stty stop undef
stty start undef

export ZSH_TMUX_AUTOCONNECT=false


# setup ssh completion in the right order
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


# Full command completion
function list_commands() {
    result=$(echo "${(k)aliases} ${(k)builtnis} ${(k)commands}" | tr " " "\n" | fzf)
    if [ $? -ne 0 ]; then
        result=""
    fi

    zle reset-prompt
    BUFFER+="$result "
    zle end-of-line
}

# bind ESC-TAB
zle -N list_commands
bindkey "^[\t" list_commands

# activate direnv
eval "$(direnv hook zsh)"

alias fuck="unalias fuck; eval $(thefuck --alias); fuck"


## Personal aliases ###########################################################

source ~/.dotfiles/commands.sh
# eval "$(hub alias -s)"

# Programming
alias vi="/usr/local/bin/vim -u ~/.virc"
alias vim=nvim
# alias vim="nvim_tmuxed"
# alias nvim="nvim_tmuxed"
alias vmi="vim"
alias vimr="vimr --cur-env"
alias svi="sudo vi -u ~/.virc"
alias cleanlatex="sh -c 'rm *.aux *.fdb_latexmk *.fls *.log *.synctex.gz *.out *.toc *.bib.bak *.end *.bbl *.blg *.toc *.auxlock *.table *.gnuplot'"
alias conf="vim ~/.zshrc"
alias chrome="/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome"
# gem install terminal-share
alias share=terminal-share
alias ccat='pygmentize -O style=monokai -f console256 -g'

alias nb="tmux new -d -s tasks; tmux new-window -t tasks '/Users/dsuess/Library/Conda/bin/jupyter notebook'"
alias pip-upgrade="pip install --upgrade"
alias pip-upgrade-all="pip freeze --local | grep -v '^\-e' | cut -d = -f 1  | xargs -n1 pip install -U"
alias ci="conda install"
alias ca="conda activate"
alias pdb="python -m pdb"
alias ipy="ptipython"
alias ghc="stack ghc"
alias sa="source activate"
alias da="source deactivate"

# Git aliases
alias gs="git status -s"
alias gss="git --no-pager status"
alias ga="git add"
alias gl="git --no-pager lv -50 --no-merges"
alias gll="git lg"
alias gd="git difftool"
alias gf="git fetch"
alias gv="git difftool ...FETCH_HEAD"
alias gr="git rm"
alias gcd="cd \$(git rev-parse --show-cdup)"

# Science stuff
alias qtconsole="ipython qtconsole --pylab inline"
alias nb-kernels="tmux new -s ipython -d; tmux new-window -t ipython 'ipcluster start'"
alias evalnb="jupyter nbconvert --to html --ExecutePreprocessor.enabled=True"

# Admin/Sudo-Stuff
alias tardir='tar -zcvf'
alias untar='tar -zxvf'
alias mkdir='mkdir -pv'             # Create parent dirs on demand
alias ports='netstat -tulanp'
alias du="du -h"
alias df="df -h"
alias fzf="fzf-tmux"
alias f="fzf-tmux -m"
alias ssh="TERM=xterm-256color ssh -i ~/.ssh/id_rsa"
alias scp="noglob scp"
alias brew='TERM=xterm-256color brew'
alias ff='open -a Finder ./'
alias dcd='cd "$DUCK"'

# confirmation #
alias mv='mv -i'
alias cp='cp -i'
alias ln='ln -i'

# Parenting changing perms on / #
alias chown='chown --reserve-root'
# alias chmod='chmod --preserve-root'
alias chgrp='chgrp --preserve-root'

# Printing
alias print-ls='lpstat -p -d'
alias clipboard='pbcopy'

# Utils
alias sync-bookmarks="cp ~/Library/Application\ Support/BraveSoftware/Brave-Browser/Default/Bookmarks ~/Library/Application\ Support/Google/Chrome/Default/Bookmarks"

##############################
#  Load the more extensions  #
##############################
source /usr/local/Cellar/fzf/0.32.1/shell/key-bindings.zsh
test -e "${HOME}/.iterm2_shell_integration.zsh" && source "${HOME}/.iterm2_shell_integration.zsh"
if [ -f /Users/dsuess/.dotfiles/tmux_startup.sh ]; then
    source /Users/dsuess/.dotfiles/tmux_startup.sh
fi

if [[ ! -z "$DIRENV_DIR" ]]; then
   direnv reload
fi

if [ -f "/Users/dsuess/.zshrc.local" ]; then
    source /Users/dsuess/.zshrc.local
fi
