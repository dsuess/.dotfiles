[ -f ~/.dotfiles/vars.sh ] && source ~/.dotfiles/vars.sh
[ -f ~/.dotfiles/aliases ] && source ~/.dotfiles/aliases
[ -f ~/.fzf.bash ] && source ~/.fzf.bash

# Color prompt for Linux
if [[ "$(uname -s)" != "Darwin" ]]; then
    case "$TERM" in
        xterm-color|*-256color) color_prompt=yes;;
    esac

    if [ "$color_prompt" = yes ]; then
        PS1='${debian_chroot:+($debian_chroot)}\[\033[38;2;163;227;161m\]\u@\h\[\033[00m\]:\[\033[38;2;137;180;250m\]\w\[\033[00m\]\$ '
    else
        PS1='${debian_chroot:+($debian_chroot)}\u@\h:\w\$ '
    fi
    unset color_prompt

    # Color support for ls/grep
    if [ -x /usr/bin/dircolors ]; then
        test -r ~/.dircolors && eval "$(dircolors -b ~/.dircolors)" || eval "$(dircolors -b)"
        alias ls='ls --color=auto'
        alias grep='grep --color=auto'
        alias fgrep='fgrep --color=auto'
        alias egrep='egrep --color=auto'
    fi
fi

# Local overrides (machine-specific, not tracked)
[ -f ~/.bashrc.local ] && source ~/.bashrc.local
