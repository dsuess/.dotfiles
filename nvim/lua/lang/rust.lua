return {
  servers = {
    rust_analyzer = {
      settings = {
        ["rust-analyzer"] = {
          -- Run clippy (not just `cargo check`) for diagnostics, surfaced via LSP.
          check = { command = "clippy" },
        },
      },
    },
  },
}
