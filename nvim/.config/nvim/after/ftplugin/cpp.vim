let b:fswitchlocs='reg:/src/src'

" CINDENT
set cindent
"" dont indent private/public keywords
" set cinoptions+=g0
"" Indent additional function parameters to "("
" set cino+=(0

" Add highlighting for function definition in C++
function! EnhanceCppSyntax()
  syn match cppFuncDef "::\~\?\zs\h\w*\ze([^)]*\()\s*\(const\)\?\)\?$"
  hi def link cppFuncDef Special
endfunction
autocmd Syntax cpp call EnhanceCppSyntax()

set number
set relativenumber

compiler clang

setlocal softtabstop=2
setlocal shiftwidth=2
