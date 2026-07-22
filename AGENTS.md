# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

Personal dotfiles managed with [GNU Stow](https://www.gnu.org/software/stow/). Each top-level directory is a stow package that gets symlinked into `$HOME` (or another target via `-t`).

## Core Rule: Always Use Stow

**Never manually create symlinks or copy files into target directories.** All symlinks must be created through stow, invoked via `./install.sh config`. To deploy a new file: add it to the appropriate package directory, then run `./install.sh config`.

**Exception — `obsidian/`:** this one package is deployed by *copying* real files (not stow symlinks), because its iCloud vaults sync to iOS/iPadOS, which cannot follow symlinks. See the Obsidian section below.

## Installation

```bash
# Install all software + stow all configs
./install.sh

# Only stow configs (no package manager installs)
./install.sh config

# Only install software packages
./install.sh software
```

## Linux Bootstrap (no package manager / no root)

On macOS the toolchain comes from Homebrew and **none of this runs** — every bootstrap
function returns early on `Darwin`, so the macOS install path is unchanged. On Linux, where
there may be no package manager or root, `install.sh` provisions the tools it needs itself,
into `~/.local/bin` (already on `PATH` via `vars.sh`). Prerequisites the bootstrap does *not*
provide and that must exist first: `perl`, `curl`, `tar`, and a sha256 tool (`sha256sum` or
`shasum`). `git`/`zsh`/`tmux` are also out of scope — install those via the distro.

Three mechanisms, all in `install.sh`:

- **`stow` — vendored, not downloaded.** GNU Stow is a Perl program, so there is no static
  binary. The unmodified GNU Stow 2.4.1 Perl files live in `vendor/stow/` and run under the
  system `perl`. `ensure_stow()` (called by `cmd_config`) symlinks `vendor/stow/bin/stow` into
  `~/.local/bin` only when no `stow` is already on `PATH`. The one upstream machine-specific
  line (`use lib "/opt/homebrew/…"`) was replaced with a relocatable `FindBin`-based lookup so
  the copy works through the symlink.

- **Other tools — downloaded, pinned, checksum-verified.** `ensure_static_bins()` fetches
  prebuilt static binaries for `herdr`, `fzf`, `ripgrep`, `fd`, `bat`, `direnv` from pinned
  GitHub releases. Each asset is verified against a **hardcoded SHA256 before install** (a
  mismatch aborts — an unverified binary is never installed). Tools already on `PATH` are
  skipped. Arch is auto-detected (`x86_64` / `aarch64`).

- **neovim — downloaded AppImage, extracted (not mounted).** `ensure_neovim()` fetches the
  pinned neovim AppImage, verifies it against a hardcoded SHA256, then *extracts* it with
  `--appimage-extract` rather than running it mounted — extraction uses the AppImage's own
  embedded runtime and needs **no FUSE** (installing FUSE would need root). The extracted tree
  lands in `~/.local/lib/nvim` and `~/.local/bin/nvim` symlinks its `AppRun` launcher. Skipped
  if `nvim` is already on `PATH`; arch auto-detected.

### Refreshing / bumping versions

- **Vendored stow:** re-copy the three files from an upstream install
  (`bin/stow` → `vendor/stow/bin/stow`; `Stow.pm` and `Stow/Util.pm` →
  `vendor/stow/lib/perl5/…`), re-apply the `use lib` → `FindBin` edit, and update
  `vendor/stow/VERSION`.
- **Downloaded tools:** edit the `TOOLS` table inside `ensure_static_bins()`. Each row is
  `name|type|member|url_x86|sha_x86|url_arm|sha_arm`. To bump a version, replace **both** the
  URL and the SHA256 for each arch. Authoritative checksums are the per-asset `digest` field
  from the GitHub API, e.g.
  `curl -s https://api.github.com/repos/<owner>/<repo>/releases/tags/<tag>` → each asset's
  `"digest": "sha256:…"`. `type` is `raw` (bare binary) or `targz` (tarball; `member` is the
  binary's basename inside it).
- **neovim:** edit the `NVIM_VERSION`, `NVIM_URL_X86`/`NVIM_SHA_X86`, and
  `NVIM_URL_ARM`/`NVIM_SHA_ARM` constants above `ensure_neovim()`. Replace the version, **both**
  URLs, and **both** SHA256s. Checksums come from the same per-asset `digest` field of the
  GitHub release API (assets `nvim-linux-x86_64.appimage` / `nvim-linux-arm64.appimage`).

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
| `uv/`        | `~/.config/uv/`       | uv global config (managed-Python preference)           |
| `herdr/`     | `~/.config/herdr/`    | herdr workspace manager (tmux-mirrored keys + theme)   |
| `ghostty/`   | `~/.config/`          | Ghostty terminal config                                |

## Neovim Config (`nvim/`)

Lua-based config using lazy.nvim. Stowed to `~/.config/nvim` (not `~`), so files live directly under `nvim/` (no `.config/nvim/` nesting).

- `lua/core/` — options, keymaps, autocmds
- `lua/plugins/` — one file per plugin group, auto-discovered by lazy.nvim `import`
- `lua/lang/` — per-language LSP/tool config (returns tables consumed by plugins)
- `after/ftplugin/` — buffer-local settings only

To add a new language: create `lua/lang/<name>.lua` and add it to the `lang_modules` list in `lua/plugins/lsp.lua`.

## Obsidian Config (`obsidian/`)

Target: each vault's `.obsidian/` directory (e.g. `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/notes/.obsidian`). Unlike every other package, obsidian is **copied as real files**, not stowed as symlinks — iCloud Drive does not sync symlinks to iOS/iPadOS, so symlinked config never reaches the iPad. The copy logic lives in `sync_obsidian()` in `install.sh`.

`./install.sh config` performs a safe round-trip for obsidian:

1. Requires `obsidian/` to have no uncommitted git changes (clean baseline).
2. Pulls the canonical vault's tracked config back into the repo (`OBSIDIAN_VAULT`, default `notes`).
3. If that pull changed anything, it **errors** — the device changed config that isn't committed. Run `git diff obsidian/`, then commit (or `git checkout obsidian/` to discard) and re-run.
4. Otherwise it copies the repo config as real files into every vault's `.obsidian/`.

So config edited in Obsidian on any device (iCloud brings it down to the Mac's `notes` vault) is captured back into the repo for review/commit before it deploys — never silently overwritten.

Key files:

- `appearance.json` — theme, ribbon, and **`enabledCssSnippets`** (list of snippet filenames without `.css`)
- `snippets/` — CSS snippet files; each `.css` file here is available in Obsidian's Appearance settings

**To add a new CSS snippet:**

1. Create `obsidian/snippets/<name>.css`
2. Add `"<name>"` to the `enabledCssSnippets` array in `obsidian/appearance.json`
3. Run `./install.sh config` (deploys the new file into all vaults as real files)
4. Reload Obsidian (command palette → "Reload app without saving") to pick up changes

## Machine-Specific Overrides

Files intentionally not tracked in git, sourced by the stowed configs:

- `~/.zshrc.local` — Machine-specific shell config
- `~/.gitconfig.local` — Machine-specific git identity/signing key
