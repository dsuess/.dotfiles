return {
  {
    "chipsenkbeil/distant.nvim",
    branch = "v0.3",
    cmd = { "DistantLaunch", "DistantOpen", "DistantConnect" },
    config = function()
      require("distant"):setup()
    end,
  },
}
