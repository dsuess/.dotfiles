setlocal expandtab
setlocal textwidth=79
setlocal tabstop=2
setlocal softtabstop=2
setlocal shiftwidth=2

nnoremap <leader>cf :call FillLine('-')<CR>
inoremap <C-T> <C-R>=GetCloseTag()<CR>
map <C-T> a<C-_><ESC>
let b:closetag_html_style = 0

setlocal matchpairs=(:),[:],{:},<:>
