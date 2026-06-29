return {
  -- In-buffer markdown rendering (headings, checkboxes, code blocks)
  {
    "MeanderingProgrammer/render-markdown.nvim",
    ft = "markdown",
    dependencies = {
      "nvim-treesitter/nvim-treesitter",
      "nvim-tree/nvim-web-devicons",
    },
    opts = {
      render_modes = true,
      anti_conceal = { enabled = false },
    },
  },

  -- Browser preview
  {
    "iamcco/markdown-preview.nvim",
    ft = "markdown",
    build = "cd app && npm install",
    keys = {
      { "<leader>mp", "<cmd>MarkdownPreviewToggle<CR>", desc = "Markdown preview" },
    },
    init = function()
      vim.g.mkdp_filetypes = { "markdown" }
    end,
  },
}
