return {
  -- Flutter/Dart tooling. Configures the `dartls` LSP itself (which ships with
  -- the Flutter/Dart SDK, not mason), so it lives outside the lang/ + lsp.lua
  -- pattern. Shared LSP keybindings still apply via the LspAttach autocmd in lsp.lua.
  {
    "akinsho/flutter-tools.nvim",
    ft = { "dart" },
    cmd = { "FlutterRun", "FlutterDevices", "FlutterEmulators", "FlutterReload", "FlutterRestart" },
    dependencies = {
      "nvim-lua/plenary.nvim",
      "hrsh7th/cmp-nvim-lsp",
      "nvim-telescope/telescope.nvim",
    },
    keys = {
      { "<leader>Fc", "<cmd>Telescope flutter commands<CR>", desc = "Flutter commands" },
      { "<leader>Fr", "<cmd>FlutterRun<CR>",                 desc = "Flutter run" },
      { "<leader>FR", "<cmd>FlutterRestart<CR>",             desc = "Flutter restart" },
      { "<leader>Fq", "<cmd>FlutterQuit<CR>",                desc = "Flutter quit" },
      { "<leader>Fd", "<cmd>FlutterDevices<CR>",             desc = "Flutter devices" },
      { "<leader>Fe", "<cmd>FlutterEmulators<CR>",           desc = "Flutter emulators" },
      { "<leader>Fo", "<cmd>FlutterOutlineToggle<CR>",       desc = "Flutter outline" },
    },
    config = function()
      require("flutter-tools").setup({
        lsp = {
          capabilities = require("cmp_nvim_lsp").default_capabilities(),
          settings = {
            showTodos = true,
            completeFunctionCalls = true,
          },
        },
      })
      require("telescope").load_extension("flutter")
    end,
  },
}
