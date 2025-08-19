# add shell variables to this file

if [[ ! ":$PATH:" == *"$HOME/.linuxbrew/bin:"* ]]; then
    export PATH=$HOME/.linuxbrew/bin:$PATH
fi

unset LC_ALL
