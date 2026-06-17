return {
  {
    "christoomey/vim-tmux-navigator",
    cmd = {
      "TmuxNavigateLeft",
      "TmuxNavigateDown",
      "TmuxNavigateUp",
      "TmuxNavigateRight",
      "TmuxNavigatePrevious",
    },
    keys = {
      { "<C-h>", "<cmd>TmuxNavigateLeft<cr>", desc = "Window/pane left" },
      { "<C-j>", "<cmd>TmuxNavigateDown<cr>", desc = "Window/pane down" },
      { "<C-k>", "<cmd>TmuxNavigateUp<cr>", desc = "Window/pane up" },
      { "<C-l>", "<cmd>TmuxNavigateRight<cr>", desc = "Window/pane right" },
      { "<C-\\>", "<cmd>TmuxNavigatePrevious<cr>", desc = "Window/pane previous" },
    },
  },
}
