local map = vim.keymap.set

-- Quick command mode (old: ; → :)
map({ "n", "v" }, ";", ":")
map({ "n", "v" }, "q;", "q:")

-- Save / quit
map("n", "s", "<cmd>w<CR>")                             -- old: nnoremap s :w
map("n", "<C-q>", "<cmd>q<CR>")                         -- old: nnoremap <C-q> :q
map("n", "<leader>q", "<cmd>only<CR>", { desc = "Close other windows" })
vim.cmd([[cmap w!! w !sudo tee % > /dev/null]])          -- old: cmap w!! ...

-- Clear search highlight
map("n", "<leader>/", "<cmd>nohlsearch<CR>", { desc = "Clear search" })

-- Window navigation
map("n", "<C-h>", "<C-w>h")
map("n", "<C-j>", "<C-w>j")
map("n", "<C-k>", "<C-w>k")
map("n", "<C-l>", "<C-w>l")
-- Also from terminal mode
map("t", "<C-h>", [[<C-\><C-n><C-w>h]])
map("t", "<C-j>", [[<C-\><C-n><C-w>j]])
map("t", "<C-k>", [[<C-\><C-n><C-w>k]])
map("t", "<C-l>", [[<C-\><C-n><C-w>l]])

-- Tab navigation
map("n", "<C-Tab>", "<cmd>tabprevious<CR>")
map("n", "<C-S-Tab>", "<cmd>tabnext<CR>")

-- Window resize
map("n", "<C-Up>", "<cmd>resize +2<CR>")
map("n", "<C-Down>", "<cmd>resize -2<CR>")
map("n", "<C-Left>", "<cmd>vertical resize -2<CR>")
map("n", "<C-Right>", "<cmd>vertical resize +2<CR>")

-- Buffer navigation
map("n", "<S-l>", "<cmd>bnext<CR>")
map("n", "<S-h>", "<cmd>bprevious<CR>")
map("n", "<leader>bc", "<cmd>bdelete<CR>", { desc = "Close buffer" })

-- Paragraph motions (old: noremap K { / noremap J })
map("n", "K", "{")
map("n", "J", "}")
map("n", "L", "J")   -- old: nnoremap L J  (merge lines, since J is repurposed)

-- Move lines in visual mode (keep v-J/K for moving)
map("v", "J", ":m '>+1<CR>gv=gv")
map("v", "K", ":m '<-2<CR>gv=gv")

-- Keep cursor centered on search
map("n", "n", "nzzzv")
map("n", "N", "Nzzzv")
map("n", "<C-d>", "<C-d>zz")
map("n", "<C-u>", "<C-u>zz")

-- Fix yank inconsistency
map("n", "Y", "y$")

-- Better paste (don't yank replaced text)
map("x", "<leader>p", [["_dP]], { desc = "Paste without yank" })

-- Keep selection when indenting in visual mode (old: vnoremap < <gv / > >gv)
map("v", "<", "<gv")
map("v", ">", ">gv")

-- Format paragraph
map("n", "Q", "gqap")
map("v", "Q", "gq")

-- Jump list (old: [j / ]j)
map("n", "[j", "<C-o>", { desc = "Jump back" })
map("n", "]j", "<C-i>", { desc = "Jump forward" })

-- Tag jump
map("n", "gt", "<C-]>")

-- Insert mode navigation (old: <C-f>/<C-b>)
map("i", "<C-f>", "<Right>")
map("i", "<C-b>", "<Left>")
map("i", "<C-BS>", "<C-W>")   -- delete word

-- Show registers
map("n", "<leader>sr", "<cmd>reg<CR>", { desc = "Show registers" })

-- Edit init.lua (old: <leader>sv → edit vimrc)
map("n", "<leader>sv", "<cmd>e $MYVIMRC<CR>", { desc = "Edit init.lua" })

-- Diagnostic navigation
map("n", "[d", vim.diagnostic.goto_prev, { desc = "Previous diagnostic" })
map("n", "]d", vim.diagnostic.goto_next, { desc = "Next diagnostic" })
map("n", "<leader>d", vim.diagnostic.open_float, { desc = "Show diagnostic" })

-- Auto-enter insert mode in terminal buffers
vim.api.nvim_create_autocmd({ "BufWinEnter", "WinEnter" }, {
  pattern = "term://*",
  command = "startinsert",
})
