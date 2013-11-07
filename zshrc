# Proper color support for vim
if [ "$TERM" = "xterm" ]; then
       export TERM=xterm-256color
fi

export PATH=/home/dsuess/bin:/home/dsuess/local/librsb/bin/:$PATH
source /opt/intel/bin/compilervars.sh ia32


## OH-MY-ZSH SPECIFIC STUFF ###################################################
ZSH=$HOME/.oh-my-zsh
ZSH_THEME="robbyrussell"

# Uncomment following line if you want to disable command autocorrection
# DISABLE_CORRECTION="true"

# Uncomment following line if you want red dots to be displayed while waiting for completion
COMPLETION_WAITING_DOTS="true"

# Case sensetive completion
CASE_SENSETIVE="true"

# Load the oh-my-zsh plugins and settings
plugins=(command-not-found pass)
source $ZSH/oh-my-zsh.sh


## Final customization of zsh #################################################

# Write history of multiple zsh-sessions chronologicaly ordered
setopt inc_append_history

# Share history over multiple sessions
setopt share_history

# Disable the anoying autocorrect
unsetopt correct

# Hit escape twice to clear the current input line 
bindkey "" vi-change-whole-line


## Personal aliases ###########################################################

# Programming
alias vi="vi -u ~/.virc"
alias svi="sudo vi -u ~/.virc"
alias latexmk="latexmk -pdf"
alias cleanlatex="sh -c 'rm --force *.aux *.fdb_latexmk *.fls *.log *.synctex.gz *.out *.toc *.bib.bak *.end *.bbl *.blg *.toc *.auxlock'"
alias py="python2.7"
alias conf="vim ~/.zshrc"

# Network stuff
#alias ssh="ssh -Y"
alias chromium-proxified="chromium-browser --proxy-server=\"socket5://localhost:8080\""
alias mount-remote-home="sshfs -C dsuess@tqo11:/home/dsuess /media/rhome/"
alias ssh-keychain="eval $(keychain --eval --agents ssh -Q --quiet id_rsa)"

# Science stuff
alias qtconsole="ipython qtconsole --pylab inline"
alias notebook="ipython notebook --browser=\"/usr/bin/firefox\" --pylab inline "

# Admin/Sudo-Stuff
alias apt-get='sudo apt-get'
alias l.='ls -d .* --color=auto'    # Display hidden files
alias tardir='tar -zcvf'
alias untar='tar -zxvf'
alias mkdir='mkdir -pv'             # Create parent dirs on demand
alias ports='netstat -tulanp'
alias reboot='sudo reboot'
alias shutdown='sudo shutdown -h now'

# Div. Application shortcuts
alias hamster='hamster-cli'

# confirmation #
alias mv='mv -i'
alias cp='cp -i'
alias ln='ln -i'
 
# Parenting changing perms on / #
alias chown='chown --preserve-root'
alias chmod='chmod --preserve-root'
alias chgrp='chgrp --preserve-root'
