" vim: set fdm=marker expandtab ts=2 sw=2 foldnestmax=2:
"
" Vim configuration file - Daniel Suess
"-----------------------------------------------------------------------------

" INITIAL SETUP {{{1

"" Disable compatibility to vi mode
set nocompatible
"" Needs to be unset for Vundle, remember to reset after all packages are loaded
filetype off

"" Load plugin manager
call plug#begin('~/.vim/plugged')

"" Disable <c-s> for locking screen
nnoremap <c-s> <nop>
vnoremap <c-s> <nop>
inoremap <c-s> <nop>

"" Enable (secure) local configuration
set secure
set exrc


" KEY SETTINGS {{{1
" vim-repeat -- repeat commands in tpope plugins{{{2
Plug 'tpope/vim-repeat'


" vim-unimpaired -- pairs commands using bracket mappings {{{2
Plug 'tpope/vim-unimpaired'

" SuperTab -- share the tab key {{{2
Plug 'ervandew/supertab'

"" Sync with YouCompleteMe
let g:SuperTabDefaultCompletionType = '<S-TAB>'

"2}}}

"" remap leader key for German layout
let mapleader = ' '

"" Fix the yank-inconsistency (Y yanks to end of line)
nnoremap Y y$
"" show yank registers
nnoremap <silent> <LEADER>sr :reg<CR>

"" time between consecutive key presses noted as string
set ttimeoutlen=50

"" easy acces to external commands
nnoremap ! :!

"" enable/disable virtualedit
nnoremap [ov :set virtualedit=all<CR>
nnoremap ]ov :set virtualedit=block<CR>

"" switch between tabs
nnoremap <leader>tp :tabprevious<CR>
nnoremap <leader>tn :tabnext<CR>
nnoremap <leader>tN :tabnew<CR>

"" Quickly open the command window
nnoremap ; :
vnoremap ; :
nnoremap q; q:
vnoremap q; q:

" APPERANCE & BEHAVIOR {{{1

" vim-airline -- pure vimscript replacement for powerline {{{2
Plug 'vim-airline/vim-airline'
Plug 'vim-airline/vim-airline-themes'

"" Theme is set below together with colorscheme
"" Use powerline fonts
let g:airline_powerline_fonts = 0
"" Disable python-virtualenv plugin
let g:airline#extensions#virtualenv#enabled = 0
"" Hide lineending type info
let g:airline_section_y = ''

nnoremap coa :AirlineToggle<CR>

" vim-colors-solarized -- solarized color scheme {{{2
Plug 'altercation/vim-colors-solarized'


"" Set colorscheme depending on terminal/gui-vim
if &t_Co >= 256
  "" 256-color terminal
  "let g:airline_theme="powerlineish"
  colorscheme apprentice
  let g:airline_theme = 'zenburn'
endif
if has('gui_running')
  colorscheme solarized
  set background=light
  set guifont=Anonymous\ Pro\ for\ Powerline\ 11
endif

"" show cursorline
set cursorline

"" relative line numbering with absolute numbering of current line
set relativenumber
set number
"" Hide all line numbers for quickfix, taglist, etc.
au FileType qf,taglist, set norelativenumber|set nonumber

"" always show status line
set laststatus=2

"" Dont show status there, we have airline
set noshowmode

"" use syntax highlighting
syntax on

"" Better performance
set nottyfast
set lazyredraw

"" dont beep, please
set novisualbell

" MOUSE & GUI {{{1

"" Show a shell in gvim (since c-z suspends in terminal session)
if has('gui_running')
  " for gvim
  nnoremap <silent> <c-z> :shell<CR>
endif

"" autoselect in visual mode, use simple dialogs, icon, grey menus
set guioptions=acig

"" Scrolling with mouse wheel, even in tmux
set mouse=a
"" And open a menu on right click in gvim
set mousemodel=popup
"" hide cursor when typing
set mousehide


" WINDOW & BUFFER MANAGMENT {{{1

" bclose -- close current buffer, open empty file if it's the last {{{2
Plug 'rbgrouleff/bclose.vim'

" Close active window buffer file
nnoremap <silent> <LEADER>bc :Bclose<CR>


" vim-bufferline -- Display bufferlist in statusline {{{2
"Plug 'bling/vim-bufferline'
"" Dont print messages in statusline
let g:bufferline_echo = 0


" show & hide quickfix/location list {{{2
function! GetBufferList()
  redir =>buflist
  silent! ls
  redir END
  return buflist
endfunction

function! ToggleList(bufname, pfx)
  let buflist = GetBufferList()
  for bufnum in map(filter(split(buflist, '\n'), 'v:val =~ "'.a:bufname.'"'), 'str2nr(matchstr(v:val, "\\d\\+"))')
    if bufwinnr(bufnum) != -1
      exec(a:pfx.'close')
      return
    endif
  endfor
  if a:pfx == 'l' && len(getloclist(0)) == 0
    echohl ErrorMsg
    echo "Location List is Empty."
    return
  endif
  let winnr = winnr()
  exec(a:pfx.'open')
  if winnr() != winnr
    wincmd p
  endif
endfunction

function! OpenList(pfx)
  let winnr = winnr()
  exec(a:pfx.'open')
  if winnr() != winnr
    wincmd p
  endif
endfunction

function! CloseList(bufname, pfx)
  let buflist = GetBufferList()
  for bufnum in map(filter(split(buflist, '\n'), 'v:val =~ "'.a:bufname.'"'), 'str2nr(matchstr(v:val, "\\d\\+"))')
    if bufwinnr(bufnum) != -1
      exec(a:pfx.'close')
      return
    endif
  endfor
endfunction

nnoremap <silent> coo :call ToggleList("Location List", 'l')<CR>
nnoremap <silent> [oo :call OpenList('l')<CR>
nnoremap <silent> ]oo :call CloseList("Location List", 'l')<CR>
nnoremap <silent> coq :call ToggleList("Quickfix List", 'c')<CR>
nnoremap <silent> [oq :call OpenList('c')<CR>
nnoremap <silent> ]oq :call CloseList("Quickfix List", 'c')<CR>


" set the height of the preview windows {{{2
function! PreviewHeightWorkAround(previewheight)
  if &previewwindow
    exec 'setlocal winheight='.a:previewheight
  endif
endfunction

au BufEnter ?* call PreviewHeightWorkAround(5)

" control size and lication of quickfix/location list {{{2
"" https://gist.github.com/juanpabloaj/5845848
function! AdjustWindowHeight(minheight, maxheight)
  let l = 1
  let n_lines = 0
  let w_width = winwidth(0)
  while l <= line('$')
    " number to float for division
    let l_len = strlen(getline(l)) + 0.0
    let line_width = l_len/w_width
    let n_lines += float2nr(ceil(line_width))
    let l += 1
  endw
  exe max([min([n_lines, a:maxheight]), a:minheight]) . "wincmd _"
endfunction

"" Set quickfixwindow height to fit the number of errors, but 15 max, 3 min
autocmd FileType qf call AdjustWindowHeight(3, 15)
"" ..and open on bottom of screen
autocmd FileType qf wincmd J


" vim-accordion -- manage vsplits {{{2
Plug 'mattboehm/vim-accordion'

" {{{2
Plug 'christoomey/vim-tmux-navigator'

"2}}}

"" Scroll through windows with hjkl
nnoremap <c-h> <c-w>h
nnoremap <c-j> <c-w>j
nnoremap <c-k> <c-w>k
nnoremap <c-l> <c-w>l

"" close all but active window
nnoremap <silent> <leader>q :only<CR>

"" close current buffer
nnoremap <C-q> :q<CR>

set splitbelow
set splitright

" TEXT EDITING {{{1

" EasyAlign -- align text in neat tables {{{2
Plug 'junegunn/vim-easy-align'
" Start interactive EasyAlign in visual mode (e.g. vip<Enter>)
vmap <Enter> <Plug>(EasyAlign)
" Start interactive EasyAlign for a motion/text object (e.g. <Leader>aip)
nmap <Leader>a <Plug>(EasyAlign)

let g:easy_align_delimiters = {
\ '/': {
\     'pattern':         '//\+\|/\*\|\*/',
\     'delimiter_align': 'l',
\     'ignore_groups':   ['!Comment'] }
\ }


" fill lines with certain character {{{2
function! FillLine()
  "" grap the correct fill char
  if exists('b:fillchar')
    let fillchar = b:fillchar
  elseif exists('g:fillchar')
    let fillchar = g:fillchar
  else
    return
  endif

  "" set tw to the desired total length
  let tw = &textwidth
  if tw==0 | let tw = 80 | endif
  "" strip trailing spaces first
  "".s/[[:space:]]*$//
  "" calculate total number of 'str's to insert
  let reps = (tw - col("$") + 1) / len(fillchar)
  "" insert them, if there's room, removing trailing spaces (though forcing
  "" there to be one)
  if reps > 0
    .s/$/\=(''.repeat(fillchar, reps))/
  endif
endfunction

let g:fillchar = '-'
nnoremap <silent> <leader>cf :call FillLine()<CR>


" GUNDO -- graphical representation of undo tree {{{2
Plug 'sjl/gundo.vim'

nnoremap cog :GundoToggle<CR>
nnoremap [og :GundoShow<CR>
nnoremap ]og :GundoHide<CR>
command! Gundo GundoToggle

" Mark--Karkat -- mark text, words with colors {{{2
"" Dont use github, since we disabled all default mappings
set rtp+=~/.vim/sbundle/Mark--Karkat/

"" mark with §, clear with <leader>§
if !hasmapto('<Plug>MarkSet', 'n')
  nmap <unique> <silent> § <Plug>MarkSet
endif
if !hasmapto('<Plug>MarkSet', 'v')
  vmap <unique> <silent> § <Plug>MarkSet
endif
nnoremap <silent> <leader>§ :MarkClear<CR>


" nerd-comment -- insert/delete/modify comments {{{2
Plug 'scrooloose/nerdcommenter'

"" Always add a space in front of text when commented
let NERDSpaceDelims = 1

" remove trailing whitspaces on save {{{2
fun! <SID>StripTrailingWhitespaces()
  let l = line(".")
  let c = col(".")
  %s/\s\+$//e
  call cursor(l, c)
endfun

autocmd BufWritePre * :call <SID>StripTrailingWhitespaces()


" synastic -- on-the-fly code checking {{{2
Plug 'scrooloose/syntastic'

"" Always show errors on save
let g:syntastic_always_populate_loc_list=1

"" Syntastics for python, only use flake8
let g:syntastic_python_checkers=['flake8', 'python']
"" Ignore certain errors and check complexity
let g:syntastic_python_flake8_post_args='--ignore=E127,E128,E226 --max-complexity 10'
"" E127, E128 -- continuation line is over indented
"" E226 -- white space around operator (since x**2 looks way better then x ** 2)

let g:syntastic_tex_chktex_post_args='--nowarn 1'
"" 1 -- Command terminated with space

" vim-multiple-cursor -- many cursors, may good {{{2
Plug 'terryma/vim-multiple-cursors'


" vim-surround -- handling quotes, parentheses, tags, ... {{{2
Plug 'tpope/vim-surround'

"" Reindent after insertion
let g:surround_indent = 1
"" Since I never use select, remap to surround
nmap S ys
nmap SS yss

" Matching pairs
set matchpairs=(:),[:],{:}

" persistent undo files after closing
if exists('+undofile')
  set undofile
  set undodir=$HOME/.vim/undo
  if !isdirectory($HOME.'/.vim/undo')
    call mkdir($HOME.'/.vim/undo', "p")
  endif
endif


" text indenation and breaking {{{2
"" indenting uses spaces
set smarttab
set expandtab
"" indent automatically
set autoindent
"" indent newline
set copyindent


"" set default indention to 3 spaces
set tabstop=3
set shiftwidth=3
set softtabstop=3


"" Break only whole words
set linebreak
set formatoptions=croq
"" Use soft linebreaks
set wrap
"au FileType qf, set wrap
"" linewraping respects indentation (requires breakindent patch)
set showbreak=

"" use 79 colum textwidth and display "forbidden column"
set textwidth=79
set colorcolumn=80

"2}}}


"" Sane backspace key
set backspace=indent,eol,start
"" with ctrl-bs deleting the last word
inoremap <C-BS> <C-W>

"" cursor may be placed anywhere in block selection mode
set virtualedit=block

"" always show some lines/columns arround cursor
set scrolloff=1
set sidescrolloff=0
set display+=lastline

"" show hidden characters, but hide on default
set nolist

"" use Q for formatting selection/paragraph
nnoremap Q gqap
vnoremap Q gq

"" keep selection when indeting in visual mode
vnoremap < <gv
vnoremap > >gv
"" uniindent by s-tab
"inoremap <S-TAB> <C-O><<

"" toggle paste mode
set pastetoggle=<F12>

"" case toggling is an operator
set tildeop

"" Merge lines
nnoremap L J
vnoremap L J

" INPUT HELPS {{{1

" delimitMate -- insert pairs (like brackets) automatically {{{2
Plug 'Raimondi/delimitMate'

" rainbox_parentheses -- nice coloring for parentheses {{{2
Plug 'kien/rainbow_parentheses.vim'

"" Enable/Disable
nnoremap com :DelimitMateSwitch<CR>


" omnicomplete navigation using j/k {{{2
function! OmniPopup(action)
  if pumvisible()
    if a:action == 'j'
      return "\<C-N>"
    elseif a:action == 'k'
      return "\<C-P>"
    endif
  else
    if a:action == 'j'
      return "\<C-J>"
    elseif a:action == 'k'
      return "\<C-K>"
    endif
  endif
  return a:action
endfunction


inoremap <silent><C-j> <C-R>=OmniPopup('j')<CR>
inoremap <silent><C-k> <C-R>=OmniPopup('k')<CR>


set completeopt=menuone,longest

"" File name completion
inoremap <C-f> <C-x><C-f>

"" Move digraphs out of the way of autocompletion
inoremap <C-D> <C-K>

"" Use shortened list of spell suggestions
set spellsuggest=fast,9
"" Quickly correct spelling mistakes by using first suggestion
imap <c-s> <c-g>u<Esc>[s1z=<c-o>a
nmap <c-s> [s1z=<c-o>

" MOTIONS {{{1

" matchit -- extended % matching {{{2
Plug 'tmhedberg/matchit'

" vim-easymotion -- even faster vim-motions {{{2
Plug 'Lokaltog/vim-easymotion'
"" Use , as its leader key
let g:EasyMotion_leader_key = ','


" Extened Text Motions (i$, i/,...) {{{2
"" http://connermcd.com/blog/2012/10/01/extending-vim%27s-text-objects/
let pairs = { "$" : "$",
      \ ",": ",",
      \ "/": "/"}

for [key, value] in items(pairs)
  exe "nnoremap ci".key." T".key."ct".value
  exe "nnoremap ca".key." F".key."cf".value
  exe "nnoremap vi".key." T".key."vt".value
  exe "nnoremap va".key." F".key."vf".value
  exe "nnoremap di".key." T".key."dt".value
  exe "nnoremap da".key." F".key."df".value
  exe "nnoremap yi".key." T".key."yt".value
  exe "nnoremap ya".key." F".key."yf".value
endfor

" vim-signature -- manage and display marks {{{2
Plug 'kshenoy/vim-signature'

"2}}}

"" Simulate US keyboard layout for brackets
map ü [
map + ]

"" And for jump-key
map # '

"" Scroll through paragraphs with J/K
noremap K {
noremap J }

"" Goto Tag
noremap gt <c-]>
"" Forward/back one jump
noremap [j <c-O>
noremap ]j <c-I>

"" Define "inside <space>" motion
onoremap i<space> iW
vnoremap i<space> iW
onoremap a<space> aW
vnoremap a<space> aW

"" Goto first quickfix/location list entry
nnoremap <leader>p :cc<CR>
nnoremap <leader>P :ll<CR>

"" Escape from autocompleted brackets/quotes/etc
inoremap <c-l> <Right>

" FOLDING {{{1

" improved-paragraph-motion -- pargraph motions work well with folding {{{2
"" Dont use github repository since files contain windows-newlines
set rtp+=~/.vim/sbundle/Improved-paragraph-motion/

"" Skip all folded paragraphs
let g:ip_skipfold = 1

"2}}}

"" Use marker-folding on default
set foldmethod=marker
set foldnestmax=1

"" Folding/Unfolding using space
nnoremap <leader><space> za
vnoremap <leader><space> zf

"" opening folds on occasion
set foldopen=block,insert,jump,mark,percent,quickfix,search,tag,undo


" FILES & COMMANDS {{{1

"" Use bash instead of default shell
set shell=bash
" set shellcmdflag=-ic

"" show the keyboard command entered
set showcmd

"" sane tab completion in command mode
set wildmode=longest,list
set wildmenu

"" Sync working dir to current file
set autochdir
"" Save and open modified files automatically when necessary
set autowrite
set autoread
"" Allow switching buffers without saving
set hidden


"" No backup and swap files
set nobackup
set nowritebackup
set noswapfile


"" Save & Load view automatically
au BufWinLeave * silent! mkview
au BufWinEnter * silent! loadview
set viewoptions=cursor,folds
"" Location where these view-files are saved
set viewdir=~/.vim/.view


"" Save file using s
nnoremap <silent> s :w<CR>
"" enter sudo mode by w!!
cmap w!! w !sudo tee % > /dev/null

"" Quick access and reloading of .vimrc and snippets
nnoremap <silent> <leader>sv :e $MYVIMRC<CR>
nnoremap <silent> <leader><F12> :so $MYVIMRC<CR>


" NAVIGATION & SEARCHING {{{1

" ag.vim -- advanced searching inside files {{{2
Plug 'rking/ag.vim'

nnoremap <leader>a :Ag |" Dont strip space!

" ctrlp.vim -- file navigation, searching and much more {{{2
Plug 'kien/ctrlp.vim'

"" Key Settings
let g:ctrlp_map = '<LEADER>e'
nnoremap <LEADER>v :CtrlPBuffer<CR>
nnoremap <LEADER>E :CtrlPMRUFiles<CR>
nnoremap <LEADER>f :CtrlPBufTag<CR>
nnoremap <LEADER>F :CtrlPBufTagAll<CR>
nnoremap <LEADER>. :CtrlPChange<CR>
nnoremap <LEADER>tt :CtrlPTag<CR>
nnoremap <LEADER>bm :CtrlPBookmarkDir<CR>
nnoremap <LEADER>u :CtrlPUndo<CR>
nnoremap <LEADER>BQ :CtrlPQuickfix<CR>
nnoremap <LEADER>g :CtrlPLine<CR>
nnoremap <LEADER>~ :CtrlPRoot<CR>

"" Disply window on bottom
let g:ctrlp_match_window_bottom = 1
let g:ctrlp_match_window_reversed = 1
"" Ignore certain filetypes
let g:ctrlp_custom_ignore = '\v\~$|\.(o|swp|pyc|wav|mp3|ogg|blend|idb|so|mod|aux|fls|blg|bbl)$|(^|[/\\])\.(hg|git|bzr)($|[/\\])|__init__\.py'
"" Directory to start searching for files
let g:ctrlp_working_path_mode = 'ra'
"" Dont show hidden files
let g:ctrlp_show_hidden = 0
"" Jump to file if it is already open
let g:ctrlp_switch_buffer = 'E'
"" Speed up operations by caching
let g:ctrlp_use_caching = 0
let g:ctrlp_cache_dir = $HOME . '/.vim/.ctrlp/'
let g:ctrlp_clear_cache_on_exit = 1

"" list LaTeX tags correctly
let tlist_tex_settings = 'latex;l:labels;s:sections;t:subsections;u:subsubsections'

"" Define additional file types
let g:ctrlp_buftag_types = {
      \ 'cython': '--language-force=python'
      \ }
if executable('lushtags')
  call extend(g:ctrlp_buftag_types, { 'haskell': { 'args': '--ignore-parse-error', 'bin': 'lushtags' } })
end


" SearchComplete -- Tab completion for searching {{{2
Plug 'vim-scripts/SearchComplete'

" " vim-signify -- show changes in gutter {{{2
" Plug 'mhinz/vim-signify'

" let g:signify_vcs_list = ['git']
" let g:signify_mapping_next_hunk = ']h'
" let g:signify_mapping_prev_hunk = '[h'
" let g:signify_mapping_toggle = 'coS'
" let g:signify_mapping_toggle_highlight = '<space>h'

" let g:signify_sign_add               = '+'
" let g:signify_sign_change            = '~'
" let g:signify_sign_delete            = '_'
" let g:signify_sign_delete_first_line = '‾'

" let g:signify_cursorhold_normal = 0
" let g:signify_cursorhold_insert = 0

" vim-gitgutter -- show changes in gutter {{{2
Plug 'airblade/vim-gitgutter'

"2}}}

"" Goto first search hit while typing
set incsearch
"" caseinsensetive search, when searchphrase is lowercase
set smartcase
"" Highlight search result and clear with <leader>/
set hlsearch
nnoremap <silent> <leader>/ :nohlsearch<CR>

"" Always center search results (and force fold opening)
nnoremap n nzzzO
nnoremap N NzzzO

" PROJECTS & TAGS {{{1

" vim-easytags -- create tag files {{{2
"Plug 'xolox/vim-misc'
"Plug 'xolox/vim-easytags'

""" location of global file
"let g:easytags_file = '~/.vim/tags'
""" write into local .vimtags (if exists), otherwise global
"let g:easytags_dynamic_files = 1
""" dont update updatetime yourself
"let g:easytags_updatetime_autodisable = 0
""" create tags
"nnoremap <leader>ct :UpdateTags<CR>


" tagbar -- show tag structure in side bar {{{2
Plug 'majutsushi/tagbar'

"" open/close similar to vim-unimpaired
nnoremap <silent> cot :TagbarToggle<CR>
nnoremap <silent> [ot :TagbarOpen<CR>
nnoremap <silent> ]ot :TagbarClose<CR>


" TagmaTasks -- TODO list manager (disabled) {{{2
"" replacement for vim-tasklist
Plug 'LStinson/TagmaTasks'

nmap <silent> coT <Plug>TagmaTasks


" vim-fugitive -- git interface {{{2
Plug 'tpope/vim-fugitive'

nnoremap <leader>GS :Gstatus<CR>
nnoremap <leader>GW :Gwrite<CR>
nnoremap <leader>GL :Glog<CR>
nnoremap <leader>GC :Gcommit<CR>

"" automatically delete fugitive buffers on close
autocmd BufReadPost fugitive://* set bufhidden=delete

"2}}}

"" location of tag files (use first existend one)
set tags=
" set tags=.vimtags,/home/dsuess/.vim/tags
nnoremap gT :exe "ptjump " . expand("<cword>")<CR>

"" Goto tag using enter
autocmd filetype help nnoremap <buffer> <cr> <C-]>

" BUILDING & LANGUAGE SPECIFICS {{{1


" vim-dispatch -- asynchroneous building {{{2
Plug 'tpope/vim-dispatch'

"" start a shell in a new window
nnoremap <leader>ds :Dispatch zsh<CR>
nnoremap <leader>dd :Dispatch<CR>
nnoremap <leader>dm :Make!<CR>
nnoremap <leader>DD :Dispatch!<CR>

"" shortcut to build with dispatch
map <silent> <LEADER>m :Make<CR>
map <silent> <LEADER>M :Dispatch make<CR>


" vim-markup -- syntax and matching for markdown {{{2
Plug 'plasticboy/vim-markdown'

"set a custom make target {{{2
function! SetMake()
  let mkprg = input('? ')
  execute 'setlocal makeprg=' . substitute(mkprg, ' ', '\\ ', 'g')
endfunction

nnoremap <leader>sm :call SetMake()<CR>


" FILETYPES {{{1

" edit the ftplugin file {{{2
function! OpenFiletypeFile()
  let path_to_file = '~/.vim/after/ftplugin/' .  &filetype . '.vim'
  exe "edit " . path_to_file
endfunction
command! EditFiletype call OpenFiletypeFile()

" and reload the thing
function! ReloadFiletypeFile()
  let path_to_file = '~/.vim/after/ftplugin/' .  &filetype . '.vim'
  exe "source " . path_to_file
endfunction
command! ReloadFiletype call ReloadFiletypeFile()

" custom filetypes {{{2
"" pyx -- cython source file
autocmd BufRead,BufNewFile *.pyx,*.pxd set filetype=cython
"" pyf -- f2py interface file
autocmd BufRead,BufNewFile *.pyf setf fortran
"" tikz -- drawing pictures with latex
autocmd BufRead,BufNewFile *.tikz setf tex
"" xmds -- markup file for xmds2 pde-integrator
autocmd BufRead,BufNewFile *.xmds setf xml
autocmd BufRead,BufNewFile *.xmds compiler xmds2
"" SCONS build files
autocmd BufRead,BufNewFile SConstruct set filetype=python
autocmd BufRead,BufNewFile SConscript set filetype=python
"" jl -- Julia source files
autocmd BufRead,BufNewFile *.jl set filetype=julia
"" md -- Markdown
autocmd BufRead,BufNewFile *.md set filetype=markdown

"2}}}

"" enable filetype detection
filetype plugin indent on

call plug#end()
