-- Gather server configs from lang/ modules
local function collect_servers()
  local servers = {}
  local lang_modules = { "lang.python", "lang.zig", "lang.rust" }
  for _, mod in ipairs(lang_modules) do
    local lang = require(mod)
    if lang.servers then
      for name, config in pairs(lang.servers) do
        servers[name] = config
      end
    end
  end
  -- Always include lua_ls for editing nvim config
  servers.lua_ls = {
    settings = {
      Lua = {
        workspace = { checkThirdParty = false },
        telemetry = { enable = false },
      },
    },
  }
  return servers
end

return {
  {
    "mason-org/mason-lspconfig.nvim",
    event = { "BufReadPre", "BufNewFile" },
    dependencies = {
      { "mason-org/mason.nvim", opts = {} },
      "neovim/nvim-lspconfig",
      "hrsh7th/cmp-nvim-lsp",
    },
    config = function()
      local servers = collect_servers()
      local capabilities = require("cmp_nvim_lsp").default_capabilities()

      -- Configure each server via the new nvim 0.11 API
      for server, config in pairs(servers) do
        config.capabilities = capabilities
        vim.lsp.config(server, config)
      end

      -- Servers managed outside Mason (e.g. rust-analyzer via rustup). Mason's
      -- copies are unmaintained and conflict, so exclude them from auto-install
      -- and enable explicitly — automatic_enable only covers Mason-installed servers.
      local externally_managed = { rust_analyzer = true }
      local ensure_installed = vim.tbl_filter(
        function(name) return not externally_managed[name] end,
        vim.tbl_keys(servers)
      )

      -- mason-lspconfig installs Mason-managed servers and auto-enables them.
      require("mason-lspconfig").setup({
        ensure_installed = ensure_installed,
        automatic_enable = true,
      })

      -- Externally managed servers were configured above but skipped by
      -- automatic_enable, so enable them explicitly.
      for name in pairs(externally_managed) do
        if servers[name] then vim.lsp.enable(name) end
      end

      -- LSP keybindings on attach
      vim.api.nvim_create_autocmd("LspAttach", {
        group = vim.api.nvim_create_augroup("lsp_attach", { clear = true }),
        callback = function(event)
          vim.lsp.inlay_hint.enable(true, { bufnr = event.buf })
          local map = function(keys, func, desc)
            vim.keymap.set("n", keys, func, { buffer = event.buf, desc = "LSP: " .. desc })
          end
          map("gd", vim.lsp.buf.definition, "Go to definition")
          map("gr", vim.lsp.buf.references, "References")
          map("gI", vim.lsp.buf.implementation, "Go to implementation")
          map("gy", vim.lsp.buf.type_definition, "Type definition")
          map("<leader>lh", vim.lsp.buf.hover, "Hover")
          map("<leader>la", vim.lsp.buf.code_action, "Code action")
          map("<leader>lr", vim.lsp.buf.rename, "Rename")
          map("<leader>ls", vim.lsp.buf.signature_help, "Signature help")
        end,
      })
    end,
  },
}
