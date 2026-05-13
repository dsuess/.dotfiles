return {
  servers = {
    basedpyright = {
      settings = {
        basedpyright = {
          analysis = {
            typeCheckingMode = "basic",
            autoImportCompletions = true,
          },
        },
      },
    },
    ruff = {},
  },
  formatters = { "ruff_format", "ruff_organize_imports" },
  linters = {},  -- ruff LSP handles linting
}
