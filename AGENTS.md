# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

Personal dotfiles managed with [GNU Stow](https://www.gnu.org/software/stow/). Each top-level directory is a stow package that gets symlinked into `$HOME` (or another target via `-t`).

## Core Rule: Always Use Stow

**Never manually create symlinks or copy files into target directories.** All symlinks must be created through stow, invoked via `./install.sh config`. To deploy a new file: add it to the appropriate package directory, then run `./install.sh config`.

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

| Package      | Stow target           | What it configures                                     |
| ------------ | --------------------- | ------------------------------------------------------ |
| `zsh/`       | `~`                   | `.zshrc`, `.zsh_profile`                               |
| `bash/`      | `~`                   | `.bashrc`, `.bash_profile`                             |
| `git/`       | `~`                   | `.gitconfig`, `.gitignore`                             |
| `tmux/`      | `~`                   | `.tmux.conf`, `.tmux/`                                 |
| `nvim/`      | `~/.config/nvim`      | Neovim config (lazy.nvim, LSP, treesitter)             |
| `oh-my-zsh/` | `~`                   | `.oh-my-zsh/` (custom fork)                            |
| `my-zsh/`    | `~`                   | Custom Oh-My-Zsh plugins/themes in `.dotfiles/my-zsh/` |
| `bin/`       | `~/bin/`              | Personal scripts                                       |
| `claude/`    | `~/.claude/`          | Claude Code settings, hooks, CLAUDE.md                 |
| `opencode/`  | `~/.config/opencode/` | OpenCode AI config                                     |
| `ghostty/`   | `~/.config/`          | Ghostty terminal config                                |

## Neovim Config (`nvim/`)

Lua-based config using lazy.nvim. Stowed to `~/.config/nvim` (not `~`), so files live directly under `nvim/` (no `.config/nvim/` nesting).

- `lua/core/` — options, keymaps, autocmds
- `lua/plugins/` — one file per plugin group, auto-discovered by lazy.nvim `import`
- `lua/lang/` — per-language LSP/tool config (returns tables consumed by plugins)
- `after/ftplugin/` — buffer-local settings only

To add a new language: create `lua/lang/<name>.lua` and add it to the `lang_modules` list in `lua/plugins/lsp.lua`.

## Obsidian Config (`obsidian/`)

Stow target: each vault's `.obsidian/` directory (e.g. `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/work/.obsidian`). The `install.sh config` command iterates over all vaults and runs `stow obsidian -t "$vault/.obsidian"` for each.

Key files:

- `appearance.json` — theme, ribbon, and **`enabledCssSnippets`** (list of snippet filenames without `.css`)
- `snippets/` — CSS snippet files; each `.css` file here is available in Obsidian's Appearance settings

**To add a new CSS snippet:**

1. Create `obsidian/snippets/<name>.css`
2. Add `"<name>"` to the `enabledCssSnippets` array in `obsidian/appearance.json`
3. Run `./install.sh config` to re-stow (deploys the new file into all vaults)
4. Reload Obsidian (command palette → "Reload app without saving") to pick up changes

## Machine-Specific Overrides

Files intentionally not tracked in git, sourced by the stowed configs:

- `~/.zshrc.local` — Machine-specific shell config
- `~/.gitconfig.local` — Machine-specific git identity/signing key
