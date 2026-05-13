
" Vim Compiler File
" Compiler:	GHC
" Maintainer:	Claus Reinke <claus.reinke@talk21.com>
" Last Change:	22/01/2011
"
" part of haskell plugins: http://projects.haskell.org/haskellmode-vim

" ------------------------------ paths & quickfix settings first
"

if exists("current_compiler") && current_compiler == "ghc"
  finish
endif
let current_compiler = "ghc"
let s:scriptname = "ghc.vim"

" quickfix mode:
" fetch file/line-info from error message
" TODO: how to distinguish multiline errors from warnings?
"       (both have the same header, and errors have no common id-tag)
"       how to get rid of first empty message in result list?
setlocal errorformat=
                    \%-Z\ %#,
                    \%W%f:%l:%c:\ Warning:\ %m,
                    \%E%f:%l:%c:\ %m,
                    \%E%>%f:%l:%c:,
                    \%+C\ \ %#%m,
                    \%W%>%f:%l:%c:,
                    \%+C\ \ %#%tarning:\ %m,

" oh, wouldn't you guess it - ghc reports (partially) to stderr..
setlocal shellpipe=2>
