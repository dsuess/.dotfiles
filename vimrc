" vim: set fdm=marker expandtab ts=2 sw=2 foldnestmax=2:
"
" Vim configuration file - Daniel Suess
" Last modified: 2013-09-20
"-----------------------------------------------------------------------------

"" Posible combinations: (ycm, ultisnips), (neocomplete, ultisnips),
""                       (neocomplete, neosnippet)
if has('gui_running')
  "" use neocomplete for prose writing
  let completer = 'neocomplete'
else
  "" for real coding use youcompleteme
  "let completer = 'ycm'
  let completer = 'neocomplete'
endif

let completer = 'ycm'
let snipper = 'ultisnips'

" INITIAL SETUP {{{1

"" Disable compatibility to vi mode
set nocompatible
"" Needs to be unset for Vundle, remember to reset after all packages are loaded
filetype off

"" Load Vundle
set rtp+=~/.vim/bundle/vundle/
call vundle#rc()
Bundle 'gmarik/vundle'


" KEY SETTINGS {{{1
" vim-repeat -- repeat commands in tpope plugins{{{2
Bundle 'tpope/vim-repeat'


" vim-unimpaired -- pairs commands using bracket mappings {{{2
Bundle 'tpope/vim-unimpaired'

" SuperTab -- share the tab key {{{2
if snipper ==? 'ultisnips'
  Bundle 'ervandew/supertab'

  "" Sync with YouCompleteMe
  let g:SuperTabDefaultCompletionType = '<S-TAB>'
endif

"2}}}

"" remap leader key for German layout
let mapleader = ' '

"" Set marks using Ü, since m is used by vim-seek
noremap Ü m

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

" APPERANCE & BEHAVIOR {{{1

" vim-airline -- pure vimscript replacement for powerline {{{2
Bundle 'bling/vim-airline'

"" Theme is set below together with colorscheme
"" Use powerline fonts
let g:airline_powerline_fonts = 1
"" Disable python-virtualenv plugin
let g:airline#extensions#virtualenv#enabled = 0


" vim-colors-solarized -- solarized color scheme {{{2
Bundle 'altercation/vim-colors-solarized'

" vim-startify -- startup screen {{{2
Bundle 'mhinz/vim-startify'

let g:startify_custom_header = [
      \' _    ___                                          __   _____  _____',
      \'| |  / (_)___ ___  ____  _________ _   _____  ____/ /  /__  / |__  /',
      \'| | / / / __ `__ \/ __ \/ ___/ __ \ | / / _ \/ __  /     / /   /_ < ',
      \'| |/ / / / / / / / /_/ / /  / /_/ / |/ /  __/ /_/ /     / /_ ___/ / ',
      \'|___/_/_/ /_/ /_/ .___/_/   \____/|___/\___/\__,_/     /_/(_)____/  ',
      \'                     /_/                                            '
      \ ]

"" session options -- dont save option
set ssop-=options
"2}}}

"" Set colorscheme depending on terminal/gui-vim
if &t_Co >= 256
  "" 256-color terminal
  "let g:airline_theme="powerlineish"
  colorscheme Tomorrow-Night
endif
if has('gui_running')
  colorscheme solarized
  set background=light
  set guifont=Anonymous\ Pro\ for\ Powerline\ 11
endif

"" show cursorline
set cursorline

"" relative line numbering (disabled for quickfix,...)
set relativenumber
au FileType qf,taglist, set norelativenumber

"" always show status line
set laststatus=2

"" Dont show status there, we have airline
set noshowmode

"" use syntax highlighting
syntax on

"" fast terminal connection is natural
set ttyfast
set nolazyredraw

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
Bundle 'rbgrouleff/bclose.vim'

" Close active window buffer file
nnoremap <silent> <LEADER>bc :Bclose<CR>


" vim-bufferline -- Display bufferlist in statusline {{{2
"Bundle 'bling/vim-bufferline'
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
nmap <silent> <leader>bl :call ToggleList("Location List", 'l')<CR>
nmap <silent> <leader>bq :call ToggleList("Quickfix List", 'c')<CR>


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

"" Set quickfixwindow height to fit the number of errors, but 10 max, 3 min
autocmd FileType qf call AdjustWindowHeight(3, 10)
"" ..and open on bottom of screen
autocmd FileType qf wincmd J
"2}}}


"" Scroll through windows with hjkl
nnoremap <c-h> <c-w>h
nnoremap <c-j> <c-w>j
nnoremap <c-k> <c-w>k
nnoremap <c-l> <c-w>l

"" close all but active window
nnoremap <silent> <leader>q :only<CR>

"" Next/Prev buffer
"noremap <leader>j :bn<CR>
"noremap <leader>k :bp<CR>

" TEXT EDITING {{{1

" Align -- align text in neat tables {{{2
set rtp+=~/.vim/sbundle/Align


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
Bundle 'scrooloose/nerdcommenter'

" remove trailing whitspaces on save {{{2
fun! <SID>StripTrailingWhitespaces()
  let l = line(".")
  let c = col(".")
  %s/\s\+$//e
  call cursor(l, c)
endfun

autocmd FileType c,cpp,java,php,ruby,python,tex,fortran autocmd BufWritePre * :call <SID>StripTrailingWhitespaces()


" synastic -- on-the-fly code checking {{{2
Bundle 'scrooloose/syntastic'

"" Always show errors on save
let g:syntastic_always_populate_loc_list=1

"" Syntastics for python, only use flake8
let g:syntastic_python_checkers=['flake8']
"" Ignore certain errors and check complexity
let g:syntastic_python_flake8_post_args='--ignore=E111,E121,E127,E128,E226 --max-complexity 10'
"" E111 -- identation is not a multiple of 4 (I love 3)
"" E121 -- continuation line is not multiple of 4
"" E127, E128 -- continuation line is over indented
"" E226 -- white space around operator (since x**2 looks way better then x ** 2)


" UnconditionalPaste -- Paste registers linewise/characterwise {{{2
"Bundle 'mutewinter/UnconditionalPaste'

" vim-multiple-cursor -- many cursors, may good {{{2
Bundle 'terryma/vim-multiple-cursors'


" vim-surround -- handling quotes, parentheses, tags, ... {{{2
Bundle 'tpope/vim-surround'

"" Reindent after insertion
let g:surround_indent = 1
"" Since I never use select, remap to surround
nmap S ys
nmap SS yss


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
set breakindent

"" use 79 colum textwidth and display "forbidden column"
set textwidth=79
set colorcolumn=80

"2}}}


"" Sane backspace key
set backspace=indent,eol,start
"" with ctrl-bs deleting the last word
imap <C-BS> <C-W>

"" cursor may be placed anywhere in block selection mode
set virtualedit=block

"" always show some lines/columns arround cursor
set scrolloff=1
set sidescrolloff=0
set display+=lastline

"" show hidden characters, but hide on default
set listchars=trail:⋅,eol:¬,tab:▸\
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


" INPUT HELPS {{{1

" delimitMate -- insert pairs (like brackets) automatically {{{2
Bundle 'Raimondi/delimitMate'

"" Enable/Disable
nnoremap com :DelimitMateSwitch<CR>


" jedi.vim -- python completion and more {{{2
Bundle 'davidhalter/jedi-vim'

"" Better use the tags-based goto
let g:jedi#goto_assignments_command = "<leader>rg"
"" ... since get_definition works alot better
let g:jedi#goto_definitions_command = "<leader>rd"
"" Show the documentation
let g:jedi#documentation_command = "<leader>rh"

"" Show everything in the same tab using windows
let g:jedi#use_tabs_not_buffers = 0

"" Neocomplete does all the hard lifting!
let g:jedi#popup_on_dot = 0
let g:jedi#popup_select_first = 0

"" Simple refactoring
let g:jedi#rename_command = "<leader>rn"
"" Show similar commands
let g:jedi#usages_command = "<leader>rs"

"" Dont show the information in the preview window
let g:jedi#show_call_signatures = "0"

"" Automatically setup vim-jedi
let g:jedi#auto_initialization = 1
let g:jedi#auto_vim_configuration = 0


" neocomplete.vim -- completion framework {{{2
if completer ==? 'neocomplete'
  "" Requires compilation
  Bundle 'Shougo/vimproc.vim'
  "" Requires lua support!
  Bundle 'Shougo/neocomplete.vim'
  "" English dictionary for neocomplete
  Bundle 'ujihisa/neco-look'

  "" enable/disable
  nnoremap coC :NeoCompleteToggle<CR>
  nnoremap [oC :NeoCompleteLock<CR>
  nnoremap ]oC :NeoCompleteUnlock<CR>

  "" launches neocomplete automatically on vim startup
  let g:neocomplete#enable_at_startup = 1
  "" neo case sensivity as long as complete-phrase is lowercase
  let g:neocomplete#enable_smart_case = 1
  "" use underscore completion
  let g:neocomplete#enable_underbar_completion = 1
  "" sets minimum char length of syntax keyword.
  let g:neocomplete#sources#syntax#min_keyword_length = 3
  let g:neocomplete#lock_buffer_name_pattern = '\*ku\*'
  "" make caching asyc using vimproc
  let g:neocomplete#use_vimproc = 1

  "" define keywords
  if !exists('g:neocomplete#keyword_patterns')
    let g:neocomplete#keyword_patterns = {}
  endif
  let g:neocomplete#keyword_patterns['default'] = '\h\w*'

  "" setup omnifunctions
  let g:neocomplete#force_overwrite_completefunc = 1
  if !exists('g:neocomplete#omni_functions')
    let g:neocomplete#omni_functions = {}
  endif
  if !exists('g:neocomplete#force_omni_patterns')
    let g:neocomplete#force_omni_patterns = {}
  endif
  let g:neocomplete#force_omni_patterns.python = '[^. \t]\.\w*'
  set omnifunc=syntaxcomplete#Complete

  "" dont complete on enter
  inoremap <silent> <CR> <C-r>=<SID>my_cr_function()<CR>
  function! s:my_cr_function()
    return neocomplete#smart_close_popup() . "\<CR>"
  endfunction

  if snipper ==? 'ultisnips'
    inoremap <expr><S-TAB>  pumvisible() ? "\<C-n>" : "\<TAB>"
  endif
endif

" neosnippet.vim -- snippets {{{2
if snipper ==? 'neosnippet'
  Bundle 'Shougo/neosnippet.vim'

  "" change snippet directory
  let g:neosnippet#snippets_directory='~/.vim/snippets'
  "" conceal jump markers
  ""if has('conceal')
  ""  set conceallevel=2 concealcursor=i
  ""endif

  "" SuperTab like snippets behavior
  imap <expr><TAB> neosnippet#expandable_or_jumpable() ? "\<Plug>(neosnippet_expand_or_jump)" : pumvisible() ? "\<C-n>" : "\<TAB>"
  smap <expr><TAB> neosnippet#expandable_or_jumpable() ? "\<Plug>(neosnippet_expand_or_jump)" : "\<TAB>"

  "" Expand or complete with tab, jump with <c-f>
  "imap <expr><TAB> neosnippet#expandable() ? "\<Plug>(neosnippet_expand)" : pumvisible() ? "\<C-n>" : "\<TAB>"
  "smap <expr><TAB> neosnippet#expandable() ? "\<Plug>(neosnippet_expand)" : "\<TAB>"
  "imap <C-F> <Plug>(neosnippet_jump)
endif

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

" YouCompleteMe -- autocompletion {{{2
if completer ==? 'ycm'
  Bundle 'Valloric/YouCompleteMe'

  "" Tab completion is run through SuperTab
  let g:ycm_key_list_select_completion = ['<S-TAB>', '<Down>']
  let g:ycm_key_list_previous_completion = ['<UP>']

  "" Also use tag file entries
  let g:ycm_collect_identifiers_from_tags_files = 1

  "" Enable autocompletion in comments
  let g:ycm_complete_in_comments = 1
  "" Keep YCM from mapping to <CR>
  inoremap <expr><CR>  pumvisible() ? "\<CR>" : "\<CR>"

  "" use global clang config file
  let g:ycm_global_ycm_extra_conf = '/home/dsuess/.vim/.ycm_extra_conf.py'
  "" always ask if it's save to run
  let g:ycm_confirm_extra_conf = 1

endif

" UltiSnips -- snippets {{{2
if snipper ==? 'ultisnips'
  Bundle 'SirVer/ultisnips'

  "" Next/Last snippet
   let g:UltiSnipsExpandTrigger="<tab>"
   let g:UltiSnipsJumpForwardTrigger="<tab>"
   let g:UltiSnipsJumpBackwardTrigger="<C-B>"

   "" set directories
   let g:UltiSnipsSnippetDirectories = ["snippets"]

   "" from ftdetect/UltiSnips.vim
   autocmd FileType * call UltiSnips_FileTypeChanged()
   autocmd BufNewFile,BufRead *.snippets setf snippets
endif
"2}}}

set completeopt=menuone,longest

"" Move digraphs out of the way of autocompletion
inoremap <C-D> <C-K>

" MOTIONS {{{1

" matchit -- extended % matching {{{2
Bundle 'tmhedberg/matchit'

" vim-easymotion -- even faster vim-motions {{{2
Bundle 'Lokaltog/vim-easymotion'
"" Use , as its leader key
let g:EasyMotion_leader_key = ','

" vim-seek -- two-character motions in one line {{{2
Bundle 'goldfeld/vim-seek'
"" m/M for forward/backward search
let g:SeekKey = 'm'
let g:SeekBackKey = 'M'

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

"2}}}

"" Simulate US keyboard layout for brackets
map ü [
map + ]

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
nnoremap <leader><leader>p :ll<CR>

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
Bundle 'rking/ag.vim'

" ctrlp.vim -- file navigation, searching and much more {{{2
Bundle 'kien/ctrlp.vim'

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

"" list LaTeX tags correctly
let tlist_tex_settings = 'latex;l:labels;s:sections;t:subsections;u:subsubsections'

" SearchComplete -- Tab completion for searching {{{2
Bundle 'vim-scripts/SearchComplete'

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
"Bundle 'xolox/vim-misc'
"Bundle 'xolox/vim-easytags'

""" location of global file
"let g:easytags_file = '~/.vim/tags'
""" write into local .vimtags (if exists), otherwise global
"let g:easytags_dynamic_files = 1
""" dont update updatetime yourself
"let g:easytags_updatetime_autodisable = 0
""" create tags
"nnoremap <leader>ct :UpdateTags<CR>


" tagbar -- show tag structure in side bar {{{2
Bundle 'majutsushi/tagbar'

"" open/close similar to vim-unimpaired
nnoremap <silent> cot :TagbarToggle<CR>
nnoremap <silent> [ot :TagbarOpen<CR>
nnoremap <silent> ]ot :TagbarClose<CR>


" TagmaTasks -- TODO list manager (disabled) {{{2
"" replacement for vim-tasklist
Bundle 'LStinson/TagmaTasks'

nmap <silent> <Leader>tl <Plug>TagmaTasks


" vim-fugitive -- git interface {{{2
Bundle 'tpope/vim-fugitive'

nnoremap <leader>GS :Gstatus<CR>
nnoremap <leader>GW :Gwrite<CR>
nnoremap <leader>GL :Glog<CR>
nnoremap <leader>GC :Gcommit<CR>

"" automatically delete fugitive buffers on close
autocmd BufReadPost fugitive://* set bufhidden=delete

"2}}}

"" location of tag files (use first existend one)
set tags=.vimtags,/home/dsuess/.vim/tags
nnoremap gT :exe "ptjump " . expand("<cword>")<CR>

"" In help files navigate using enter
autocmd filetype help nnoremap <buffer> <cr> <C-]>

" BUILDING & LANGUAGE SPECIFICS {{{1
" set a custom make target {{{2
function! SetMake()
  "let mpath = input('? ')
  "execute 'setlocal makeprg=' . mpath
  let mpath = input('?make ')
  execute 'set makeprg=make\ ' . mpath
endfunction

nnoremap <leader>sm :call SetMake()<CR>


" closetag.vim -- close xml tags {{{2
Bundle 'closetag.vim'

" vim-dispatch -- asynchroneous building {{{2
Bundle 'tpope/vim-dispatch'

"" start a shell in a new window
nnoremap <leader>ds :Dispatch zsh<CR>
nnoremap <leader>dd :Dispatch<CR>
nnoremap <leader>dm :Make!<CR>
nnoremap <leader>DD :Dispatch!<CR>

"" shortcut to build with dispatch
map <silent> <LEADER>m :Make<CR>


" vim-fswitch -- Easily switch between header and cpp file
Bundle 'derekwyatt/vim-fswitch'

"" Switch to the file and load it into the current window >
nmap <silent> <Leader>oo :FSHere<cr>
"" Switch to the file and load it into the window on the right >
nmap <silent> <Leader>ol :FSRight<cr>
"" Switch to the file and load it into a new window split on the right >
nmap <silent> <Leader>oL :FSSplitRight<cr>
"" Switch to the file and load it into the window on the left >
nmap <silent> <Leader>oh :FSLeft<cr>
"" Switch to the file and load it into a new window split on the left >
nmap <silent> <Leader>oH :FSSplitLeft<cr>
"" Switch to the file and load it into the window above >
nmap <silent> <Leader>ok :FSAbove<cr>
"" Switch to the file and load it into a new window split above >
nmap <silent> <Leader>oK :FSSplitAbove<cr>
"" Switch to the file and load it into the window below >
nmap <silent> <Leader>oj :FSBelow<cr>
"" Switch to the file and load it into a new window split below >
nmap <silent> <Leader>oJ :FSSplitBelow<cr>

" vim-latex -- LaTeX suite {{{2
"" using local file, since its modified to disable imap, ...
set rtp+=~/.vim/sbundle/vim-latex/

"" disable all input mappings
let g:Imap_FreezeImap=1
let g:Tex_SmartKeyBS=0
let g:Tex_SmartKeyQuote=0
let g:Tex_SmartKeyDot=0

"" dont place any placeholders
let g:Imap_UsePlaceHolders = 0

"" ???
set complete+=k

"" Recognizing eq:... as one label when jumping to label
"" Also recognize words with german special characters as one word
"nnoremap <leader>ü :tjump /<c-r>=expand('<cword>')<cr><cr>"

"" No folding please
let g:tex_fold_enabled = 0
let Tex_FoldedSections=""
let Tex_FoldedEnvironments=""
let Tex_FoldedMisc=""

"" Compile Options
let g:Tex_MultipleCompileFormats='pdf'
let g:Tex_DefaultTargetFormat = 'pdf'
let g:tex_flavor='latex'
let g:Tex_ViewRule_pdf = 'okular'
let g:Tex_CompileRule_pdf = 'pdflatex -shell-escape -synctex=1 -file-line-error -interaction=nonstopmode'
"" shell-escape -- allow for externalized tikz
"" synctex -- forward/backward search
"" file-line-error -- parsable error format for quickfix
"" interaction=nonstopmode -- dont halt pdflatex on error, just report!
" Since all errors are nicely presented in the quickview dont change
" anything when an error is encountered!

"" dont change view when there are errors
let g:Tex_ShowErrorContext = 0
let g:Tex_GotoError = 0

"" Ignore certain warnings
let g:Tex_IgnoredWarnings =
      \"Underfull\n".
      \"Overfull\n".
      \"specifier changed to\n".
      \"You have requested\n".
      \"Missing number, treated as zero.\n".
      \"There were undefined references\n".
      \"Citation %.%# undefined\n".
      \"LaTeX Warning:"
let g:Tex_IgnoreLevel = 8

"" conceal greek letters as \alpha
let g:tex_conceal="adgm"
"" but disable for now in all modes
set concealcursor=


" vim-ipython -- integration with ipython kernels {{{2
Bundle 'ivanov/vim-ipython'

"" shortcut config in ftplugin/python.vim

" vim-sparkup -- zen coding with html/xml {{{2
Bundle 'tristen/vim-sparkup'

" vim-markup -- syntax and matching for markdown {{{2
Bundle 'plasticboy/vim-markdown'

"2}}}


"" set commands for project building/running
map <silent> <LEADER>M :make!<CR>

"" Build ctags in current dir
map <silent> <leader>cT !ctags-exuberant -R -f .vimtags & <CR>

" FILETYPES {{{1

"" enable filetype detection
filetype plugin indent on

"" custom filetypes {{{2
"" pyf -- f2py interface file
autocmd BufRead,BufNewFile *.pyf setf fortran
"" tikz -- drawing pictures with latex
autocmd BufRead,BufNewFile *.tikz setf tex
"" xmds -- markup file for xmds2 pde-integrator
autocmd BufRead,BufNewFile *.xmds setf xml
autocmd BufRead,BufNewFile *.xmds compiler xmds2

"2}}}
