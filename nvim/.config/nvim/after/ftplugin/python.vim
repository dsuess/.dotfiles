" Set style conventions
setlocal expandtab
setlocal textwidth=79
setlocal tabstop=4
setlocal softtabstop=4
setlocal shiftwidth=4

" Fold method
setlocal foldmethod=marker
" Set correct commentstring
setlocal commentstring=#%s

" Setting align command for variables
vnoremap <leader>a= :Align =<CR>
vnoremap <leader>a-- :Align --<CR>
vnoremap <leader>a- :Align -<CR>

" Setup the python interpreter + errorformat
" setlocal makeprg=python\ '%'
"setlocal errorformat=\ \ File\ \"%f\"\\,\ line\ %l\\,\ %m
"setlocal errorformat=%C\ %.%#,%A\ \ File\ \"%f\"\\,\ line\ %l%.%#,%Z%[%^\ ]%\\@=%m
setlocal errorformat=%E\ \ File\ \"%f\"\\,\ line\ %l%.%#,%Z%m

" vim-ipython for connecting to ipython
" Disable default mappings
let g:ipy_perform_mappings = 0
" Connect to the kernel using <F2>
nnoremap <F2> :IPython<CR>
vnoremap <F2> :IPython<CR>
inoremap <F2> <esc>:IPython<CR>a
" Sending using <leader>is
" nnoremap <buffer> <silent> <leader>ic :py if update_subchannel_msgs(force=True): echo("vim-ipython shell updated",'Operator')<CR>
nnoremap <buffer> <silent> <leader>is :python dedent_run_this_line()<CR>
vnoremap <buffer> <silent> <leader>is :python dedent_run_these_lines()<CR>
nnoremap <buffer> <silent> <leader>ii :python run_this_file()<CR>
nnoremap <buffer> <silent> <leader>ic :python run_this_cell()<CR>
nnoremap <buffer> <silent> <leader>ya :Pydocstring<CR>


nnoremap <buffer> <leader>ri :Dispatch ipython -i %<CR>

nnoremap <buffer> <leader>df :FocusDispatch py %<CR>

" Dont let ipython do the completion
let g:ipy_completefunc = 'none'

" Fill Line up with comments
let b:fillchar = '#'

" Dont unindent line starting with #
inoremap # X#

" Run current file with dispatch by default
let b:dispatch = 'python %'

" Surround with block (i.e. if:, else:, ...)
let b:surround_98 = "\1block: \1:\n\r"
