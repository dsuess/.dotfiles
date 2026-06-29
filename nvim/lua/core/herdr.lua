-- Seamless Ctrl+h/j/k/l navigation between Neovim splits and herdr panes.
-- The herdr counterpart of vim-tmux-navigator (lua/plugins/tmux.lua): try to
-- move within Neovim; if already at the edge, hand focus to the adjacent herdr
-- pane via the `herdr pane focus` socket API. Only active inside a herdr pane
-- (HERDR_PANE_ID is exported by herdr); a no-op otherwise.

local M = {}

local wincmd = { left = "h", down = "j", up = "k", right = "l" }

function M.nav(dir)
  local before = vim.api.nvim_get_current_win()
  vim.cmd("wincmd " .. wincmd[dir])
  if vim.api.nvim_get_current_win() == before then
    -- No Neovim split in that direction: cross into the herdr pane.
    vim.fn.system({ "herdr", "pane", "focus", "--direction", dir, "--current" })
  end
end

function M.setup()
  if not vim.env.HERDR_PANE_ID then
    return
  end
  for key, dir in pairs({ ["<C-h>"] = "left", ["<C-j>"] = "down", ["<C-k>"] = "up", ["<C-l>"] = "right" }) do
    vim.keymap.set("n", key, function() M.nav(dir) end, { desc = "Window/herdr-pane " .. dir })
    vim.keymap.set("t", key, ([[<C-\><C-n><cmd>lua require("core.herdr").nav("%s")<CR>]]):format(dir),
      { desc = "Window/herdr-pane " .. dir })
  end
end

return M
