" Ensure correct syntax highlighting and auto-indentation for Fortran free-form
" source code.
let fortran_free_source=1
let fortran_do_enddo=1
setlocal nowrap
let g:fortran_indent_less=1

" Textwidth
setlocal textwidth=80
setlocal colorcolumn=80

" Folding stuff
setlocal foldmethod=marker
setlocal foldnestmax=3

" Setting align command for variables
vnoremap <leader>a.. :Align ::<CR>
vnoremap <leader>a= :Align =<CR>
vnoremap <leader>a-- :Align --<CR>
vnoremap <leader>a- :Align -<CR>
vnoremap <leader>a! :Align !<CR>

" Remove all line continuation characters
nnoremap <leader>d& :s/&//g <CR>
vnoremap <leader>d& :s/&//g <CR>

setlocal omnifunc=fortran

" We use ifort on default
" compiler ifort

" Fill Line up with comments
let b:fillchar = '-'
