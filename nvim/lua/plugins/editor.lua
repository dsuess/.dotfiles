return {
  -- Treesitter
  {
    "nvim-treesitter/nvim-treesitter",
    build = ":TSUpdate",
    event = { "BufReadPre", "BufNewFile" },
    dependencies = { "nvim-treesitter/nvim-treesitter-textobjects" },
    opts = {
      ensure_installed = {
        "python",
        "lua",
        "vim",
        "vimdoc",
        "markdown",
        "markdown_inline",
        "bash",
        "json",
        "yaml",
        "toml",
        "gitcommit",
        "diff",
        "zig",
        "dart",
      },
      highlight = { enable = true },
      indent = { enable = true },
      textobjects = {
        select = {
          enable = true,
          lookahead = true,
          keymaps = {
            ["af"] = "@function.outer",
            ["if"] = "@function.inner",
            ["ac"] = "@class.outer",
            ["ic"] = "@class.inner",
            ["aa"] = "@parameter.outer",
            ["ia"] = "@parameter.inner",
          },
        },
        move = {
          enable = true,
          set_jumps = true,
          goto_next_start = {
            ["]f"] = "@function.outer",
            ["]c"] = "@class.outer",
          },
          goto_previous_start = {
            ["[f"] = "@function.outer",
            ["[c"] = "@class.outer",
          },
        },
      },
    },
    config = function(_, opts)
      require("nvim-treesitter").setup(opts)
    end,
  },

  -- Telescope (fuzzy finder — keys match old FZF layout)
  {
    "nvim-telescope/telescope.nvim",
    branch = "0.1.x",
    dependencies = {
      "nvim-lua/plenary.nvim",
      { "nvim-telescope/telescope-fzf-native.nvim", build = "make" },
      "nvim-tree/nvim-web-devicons",
    },
    keys = {
      -- Old FZF mappings
      { "<leader>e",  "<cmd>Telescope find_files<CR>",            desc = "Find files" },
      { "<leader>E",  "<cmd>Telescope oldfiles<CR>",              desc = "Recent files" },
      { "<leader>v",  "<cmd>Telescope buffers<CR>",               desc = "Buffers" },
      { "<leader>g",  "<cmd>Telescope live_grep<CR>",             desc = "Live grep" },
      { "<leader>G",  "<cmd>Telescope grep_string<CR>",           desc = "Grep word" },
      { "<leader>M",  "<cmd>Telescope marks<CR>",                 desc = "Marks" },
      { "<leader>H",  "<cmd>Telescope help_tags<CR>",             desc = "Help tags" },
      -- Extra telescope keys
      { "<leader>fd", "<cmd>Telescope diagnostics<CR>",           desc = "Diagnostics" },
      { "<leader>fs", "<cmd>Telescope lsp_document_symbols<CR>",  desc = "Symbols" },
      { "<leader><leader>", "<cmd>Telescope buffers<CR>",         desc = "Switch buffer" },
    },
    config = function()
      local telescope = require("telescope")
      telescope.setup({
        defaults = {
          file_ignore_patterns = { "node_modules", ".git/", "__pycache__" },
          layout_config = { prompt_position = "top" },
          sorting_strategy = "ascending",
          preview = { treesitter = false },
          mappings = {
            i = {
              ["<C-j>"] = "move_selection_next",
              ["<C-k>"] = "move_selection_previous",
            },
          },
        },
      })
      telescope.load_extension("fzf")
    end,
  },

  -- Which-key (keybinding hints)
  {
    "folke/which-key.nvim",
    event = "VeryLazy",
    opts = {
      spec = {
        { "<leader>f", group = "find/format" },
        { "<leader>F", group = "flutter" },
        { "<leader>g", group = "git/grep" },
        { "<leader>l", group = "lsp" },
        { "<leader>b", group = "buffer" },
        { "<leader>j", group = "jupyter" },
        { "<leader>s", group = "show" },
        { "<leader>x", group = "diagnostics" },
      },
    },
  },

  -- Multiple cursors (Ctrl+D like VS Code)
  {
    "mg979/vim-visual-multi",
    branch = "master",
    event = "VeryLazy",
    init = function()
      vim.g.VM_maps = {
        ["Find Under"] = "<C-d>",
        ["Find Subword Under"] = "<C-d>",
      }
    end,
  },

  -- Surround (old: tpope/vim-surround with nmap S ys / nmap SS yss)
  {
    "kylechui/nvim-surround",
    version = "*",
    event = "VeryLazy",
    config = function()
      require("nvim-surround").setup()
      -- Old: nmap S ys  →  nvim-surround uses `ys` by default, remap S as alias
      vim.keymap.set("n", "S", "ys", { remap = true })
      vim.keymap.set("n", "SS", "yss", { remap = true })
    end,
  },
}
