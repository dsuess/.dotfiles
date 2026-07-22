-- Bootstrap lazy.nvim
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.loop.fs_stat(lazypath) then
  vim.fn.system({
    "git",
    "clone",
    "--filter=blob:none",
    "https://github.com/folke/lazy.nvim.git",
    "--branch=stable",
    lazypath,
  })
end
vim.opt.rtp:prepend(lazypath)

-- Load core configuration
require("core.options")
require("core.keymaps")
require("core.autocmds")

-- Load plugins (auto-discovers all files in lua/plugins/)
require("lazy").setup({ import = "plugins" }, {
  checker = { enabled = true, notify = false },
  change_detection = { notify = false },
  -- No plugin here needs luarocks (image.nvim uses the ImageMagick CLI, not the rock).
  -- Disabling it stops lazy trying to build rocks via hererocks, which fails on hosts
  -- without a C toolchain to compile Lua 5.1.
  rocks = { enabled = false },
})
