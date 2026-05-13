" Execute current line or current selection as Vim EX commands.
nnoremap <leader>r :exe getline(".")<CR>
vnoremap <leader>r :<C-w>exe join(getline("'<","'>"),'<Bar>')<CR>
