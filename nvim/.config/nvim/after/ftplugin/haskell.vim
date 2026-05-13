" Completion function
setlocal omnifunc=necoghc#omnifunc

" Tab settings
setlocal expandtab
setlocal tabstop=4
setlocal softtabstop=4
setlocal shiftwidth=4

" Use all conceal features in all modes
set conceallevel=0
set concealcursor=nvc

" Dispatch = load current file in ghci
let b:dispatch = 'source ~/.dotfiles/zsh/cabal.zsh;ghci %'

" Adapt to vim2hs standard
setlocal colorcolumn=76
