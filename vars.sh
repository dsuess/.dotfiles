export PATH=$HOME/bin/:$HOME/.local/bin/:$PATH
export FZF_DEFAULT_COMMAND='fd --type f'

if [[ "$(uname -s)" == "Darwin" ]]; then
    export EDITOR=/opt/homebrew/bin/nvim
    export LC_ALL=en_US.UTF-8
    export LANG=en_US.UTF-8
fi
