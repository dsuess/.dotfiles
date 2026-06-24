export PATH=$HOME/bin/:$HOME/.local/bin/:$PATH
export FZF_DEFAULT_COMMAND='fd --type f'

# Rust toolchain (rustup). Homebrew's rustup keeps cargo/rustc proxies in its own
# opt dir (not linked onto PATH); the rustup.rs installer writes ~/.cargo/env instead.
if [[ -d /opt/homebrew/opt/rustup/bin ]]; then
    export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
elif [[ -f "$HOME/.cargo/env" ]]; then
    source "$HOME/.cargo/env"
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
    export EDITOR=/opt/homebrew/bin/nvim
    export LC_ALL=en_US.UTF-8
    export LANG=en_US.UTF-8
fi
