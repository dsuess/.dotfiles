" Compiler: cython
" Maintainer: D Suess <daniel.suess@web.de>
" Version: 0.1
" Last Change: 2014-06-06
" License: Same as Vim

if exists('current_compiler')
   finish
endif
let current_compiler = 'cython'
let s:keepcpo= &cpo
set cpo&vim

if exists(":CompilerSet") != 2		" older Vim always used :setlocal
   command -nargs=* CompilerSet setlocal <args>
endif

CompilerSet errorformat=
         \%f:%l:%c:\ %m

let &cpo = s:keepcpo
unlet s:keepcpo
