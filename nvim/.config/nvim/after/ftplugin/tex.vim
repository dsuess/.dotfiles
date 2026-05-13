" IMPORTANT: grep will sometimes skip displaying the file name if you
" search in a singe file. This will confuse Latex-Suite. Set your grep
" program to always generate a file-name.
setlocal grepprg=grep\ -nH\ $*
"au BufWritePost *.tex,*.bib, silent! !ctags-exuberant -R -f .vimtags &

setlocal sw=2
" TIP: if you write your \label's as \label{fig:something}, then if you
" type in \ref{fig: and press <C-n> you will automatically cycle through
" all the figure labels. Very useful!
setlocal iskeyword+=:

" Disable column marker
setlocal textwidth=0
setlocal colorcolumn=0
setlocal wrap

" Always enable spell checking (english on default)
setlocal spell

" Enable the Buffer Tags for tex files
let g:ctrlp_buftag_types =  {
         \ 'tex' : '',
         \}

" Simply add left/right to brackets
nnoremap <leader>l% i\left<esc>l%i\right<esc>l

" Fill line with comments
let b:fillchar = '%'

" Add some custom surround environments
" see help surround-customizing
" $
let b:surround_36 = "$\r$"
" e
let b:surround_101 = "\\left[ \r \\right]"
" r
let b:surround_114 = "\\[\r\\]"
" c
let b:surround_99 = "\\\1command: \1{\r}"
" q
let b:surround_113 = "\\begin{equation}\r\\label{eq\:\1label: \1}\n\\end{equation}"
" j
let b:surround_106 = "\\left( \r \\right)"
" k
let b:surround_107 = "\\(\r\\)"
" d
let b:surround_100 = "\\left\\\{ \r \\right\\\}"
" f
let b:surround_102 = "\\\{\r\\\}"

" function! LatexForwardSearch()
"    execute "call system(\"/Applications/Skim.app/Contents/SharedSupport/displayline -g "
"         \ . line('.') . " " . LatexBox_GetOutputFile() . "\")"
" endfun
" command! LatexForwardSearch call LatexForwardSearch()

" nnoremap <buffer> <silent> <leader>ls :call LatexForwardSearch()<CR>
nnoremap <buffer> <leader>ll :VimtexCompile<CR>
nnoremap <buffer> <leader>lv :VimtexView<CR>
nnoremap <buffer> <leader>le :VimtexErrors<CR>
nnoremap <buffer> <leader>ls :VimtexCompileSelected<CR>
