vim.g.mapleader = " "
vim.g.maplocalleader = " "

local opt = vim.opt

-- Line numbers
opt.number = true
opt.relativenumber = true

-- Indentation
opt.tabstop = 4
opt.shiftwidth = 4
opt.expandtab = true
opt.smartindent = true

-- Search
opt.ignorecase = true
opt.smartcase = true
opt.hlsearch = true
opt.incsearch = true

-- Appearance
opt.termguicolors = true
opt.signcolumn = "yes"
opt.cursorline = true
opt.scrolloff = 8
opt.sidescrolloff = 8

-- Splits
opt.splitright = true
opt.splitbelow = true

-- Persistence
opt.undofile = true
opt.swapfile = false

-- Misc
-- Keep the unnamed register separate from the system clipboard so yanks/deletes
-- don't clobber it. Use "+y / "+p (or the leader maps below) for the clipboard.
opt.clipboard = ""
opt.mouse = "a"
opt.updatetime = 250
opt.timeoutlen = 300
opt.completeopt = "menu,menuone,noselect"
opt.wildmode = "longest:full,full"
opt.wrap = false
