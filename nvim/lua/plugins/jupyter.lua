-- Requires: pip install pynvim jupyter_client cairosvg pnglatex
return {
  -- Jupyter notebook execution
  {
    "benlubas/molten-nvim",
    version = "^1.0.0",
    build = ":UpdateRemotePlugins",
    ft = "python",
    keys = {
      { "<leader>ji", "<cmd>MoltenInit<CR>", desc = "Molten init" },
      { "<leader>jr", "<cmd>MoltenEvaluateOperator<CR>", desc = "Molten run operator" },
      { "<leader>jl", "<cmd>MoltenEvaluateLine<CR>", desc = "Molten run line" },
      { "<leader>jv", ":<C-u>MoltenEvaluateVisual<CR>", mode = "v", desc = "Molten run selection" },
      { "<leader>jo", "<cmd>MoltenShowOutput<CR>", desc = "Molten show output" },
      { "<leader>jh", "<cmd>MoltenHideOutput<CR>", desc = "Molten hide output" },
    },
    init = function()
      vim.g.molten_output_win_max_height = 20
      vim.g.molten_auto_open_output = false
      vim.g.molten_virt_text_output = true
    end,
  },

  -- Inline image rendering (for plot output)
  {
    "3rd/image.nvim",
    ft = "python",
    opts = {
      backend = "kitty",
      -- Use the ImageMagick CLI (`magick`) instead of the `magick` luarock, so lazy
      -- never has to build a rock via hererocks (which needs a C toolchain to compile
      -- Lua 5.1 — unavailable on the rootless Linux box). Requires ImageMagick on PATH.
      processor = "magick_cli",
      max_height_window_percentage = 50,
      integrations = {
        markdown = { enabled = true },
      },
    },
  },
}
