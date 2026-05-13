# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

Personal dotfiles managed with [GNU Stow](https://www.gnu.org/software/stow/). Each top-level directory is a stow package that gets symlinked into `$HOME` (or another target via `-t`).

## Installation

```bash
# Install all software + stow all configs
./install.sh

# Only stow configs (no package manager installs)
./install.sh config

# Only install software packages
./install.sh software
```

## Stow Package Layout

Each package mirrors the target directory tree. Running `stow <pkg> -t ~` creates symlinks from `~` into the package. Key packages:

| Package    | Stow target       | What it configures              |
|------------|-------------------|---------------------------------|
| `zsh/`     | `~`               | `.zshrc`, `.zsh_profile`        |
| `bash/`    | `~`               | `.bashrc`, `.bash_profile`      |
| `git/`     | `~`               | `.gitconfig`, `.gitignore`      |
| `tmux/`    | `~`               | `.tmux.conf`, `.tmux/`          |
| `nvim/`    | `~/.config/nvim`  | Neovim config (lazy.nvim, LSP, treesitter) |
| `oh-my-zsh/` | `~`             | `.oh-my-zsh/` (custom fork)     |
| `my-zsh/`  | `~`               | Custom Oh-My-Zsh plugins/themes in `.dotfiles/my-zsh/` |
| `bin/`     | `~/bin/`          | Personal scripts                |
| `claude/`  | `~/.claude/`      | Claude Code settings, hooks, CLAUDE.md |
| `opencode/`| `~/.config/opencode/` | OpenCode AI config          |
| `ghostty/` | `~/.config/`          | Ghostty terminal config         |


## Neovim Config (`nvim/`)

Lua-based config using lazy.nvim. Stowed to `~/.config/nvim` (not `~`), so files live directly under `nvim/` (no `.config/nvim/` nesting).

- `lua/core/` — options, keymaps, autocmds
- `lua/plugins/` — one file per plugin group, auto-discovered by lazy.nvim `import`
- `lua/lang/` — per-language LSP/tool config (returns tables consumed by plugins)
- `after/ftplugin/` — buffer-local settings only

To add a new language: create `lua/lang/<name>.lua` and add it to the `lang_modules` list in `lua/plugins/lsp.lua`.

## Machine-Specific Overrides

Files intentionally not tracked in git, sourced by the stowed configs:
- `~/.zshrc.local` — Machine-specific shell config
- `~/.gitconfig.local` — Machine-specific git identity/signing key

