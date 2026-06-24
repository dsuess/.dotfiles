export PATH=$HOME/bin/:$HOME/.local/bin/:$PATH
export FZF_DEFAULT_COMMAND='fd --type f'

# Rust toolchain (rustup). Homebrew's rustup keeps cargo/rustc proxies in its own
# opt dir (not linked onto PATH); the rustup.rs installer writes ~/.cargo/env instead.
if [[ -d /opt/homebrew/opt/rustup/bin ]]; then
    export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
    # Homebrew's rustup proxies don't cover ~/.cargo/bin, where `cargo install`
    # drops crate binaries (cargo-audit, etc.); ~/.cargo/env would add this, but
    # Homebrew rustup never writes it, so add it ourselves.
    [[ -d "$HOME/.cargo/bin" ]] && export PATH="$HOME/.cargo/bin:$PATH"
elif [[ -f "$HOME/.cargo/env" ]]; then
    source "$HOME/.cargo/env"
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
    export EDITOR=/opt/homebrew/bin/nvim
    # LANG only — deliberately NOT LC_ALL. LC_ALL overrides every locale
    # category and gets forwarded over SSH (SendEnv LC_*), breaking logins on
    # hosts that lack en_US.UTF-8. LANG is the polite default a remote can
    # override; per-host needs go in ~/.ssh/config (SetEnv).
    export LANG=en_US.UTF-8
fi
