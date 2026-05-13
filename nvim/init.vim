" vim: set fdm=marker expandtab ts=2 sw=2 foldnestmax=2:
"
" Vim configuration file - Daniel Suess
"-----------------------------------------------------------------------------

" INITIAL SETUP {{{1

"" Disable compatibility to vi mode
set nocompatible

"" Load plugin manager
call plug#begin('~/.config/nvim/plugged')


"" Disable <c-s> for locking screen
nnoremap <c-s> <nop>
vnoremap <c-s> <nop>
inoremap <c-s> <nop>

"" Enable (secure) local configuration
set secure
set exrc
set nomodeline

let g:python3_host_prog='/opt/homebrew/bin/python3'


" KEY SETTINGS {{{1
" vim-repeat -- repeat commands in tpope plugins{{{2
Plug 'tpope/vim-repeat'


" vim-unimpaired -- pairs commands using bracket mappings {{{2
Plug 'tpope/vim-unimpaired'

" SuperTab -- share the tab key {{{2
" Plug 'ervandew/supertab'

"" Sync with YouCompleteMe
" let g:SuperTabDefaultCompletionType = '<S-TAB>'

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
nnoremap <C-TAB> :tabprevious<CR>
nnoremap <C-S-TAB> :tabnext<CR>

"" Quickly open the command window
nnoremap ; :
vnoremap ; :
nnoremap q; q:
vnoremap q; q:

"" terminal specific binding
tnoremap <C-h> <C-\><C-n><C-w>h
tnoremap <C-j> <C-\><C-n><C-w>j
tnoremap <C-k> <C-\><C-n><C-w>k
tnoremap <C-l> <C-\><C-n><C-w>l

"" Since VSCode doesn't use the tmux-navigator
if exists('g:vscode')
    nnoremap <C-h> <C-w>h
    nnoremap <C-j> <C-w>j
    nnoremap <C-k> <C-w>k
    nnoremap <C-l> <C-w>l
endif

autocmd BufWinEnter,WinEnter term://* startinsert


" APPERANCE & BEHAVIOR {{{1

" vim-airline -- pure vimscript replacement for powerline {{{2
Plug 'vim-airline/vim-airline' | Plug 'vim-airline/vim-airline-themes'

"" Theme is set below together with colorscheme
"" Use powerline fonts
let g:airline_powerline_fonts = 1
"" Disable python-virtualenv plugin
let g:airline#extensions#virtualenv#enabled = 0
"" Hide lineending type info
let g:airline_section_y = ''

nnoremap coa :AirlineToggle<CR>

" vim-colors-solarized -- solarized color scheme {{{2
" Plug 'altercation/vim-colors-solarized'
Plug 'iCyMind/NeoSolarized'

set termguicolors

let g:neosolarized_contrast = "normal"
let g:neosolarized_visibility = "normal"
let g:neosolarized_vertSplitBgTrans = 1
let g:neosolarized_bold = 1
let g:neosolarized_underline = 0
let g:neosolarized_italic = 1

" tender colorscheme {{{2
Plug 'jacoborus/tender.vim'

" onedark.vim -- another colorscheme {{{2
" Plug 'joshdick/onedark.vim'

let g:onedark_terminal_italics = 1

" vim-startify -- startup screen {{{2
Plug 'mhinz/vim-startify'

let g:startify_custom_header =
  \ map(split(system('fortune | cowsay'), '\n'), '"   ". v:val') + ['','']

let g:startify_skiplist = [
           \ 'COMMIT_EDITMSG',
           \ ]
"" session options -- dont save option
set ssop-=options
"2}}}

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
set lazyredraw

"" dont beep, please
set novisualbell

" MOUSE & GUI {{{1

"" Scrolling with mouse wheel, even in tmux
set mouse=a
"" And open a menu on right click in gvim
set mousemodel=popup
"" hide cursor when typing
set mousehide


" WINDOW & BUFFER MANAGMENT {{{1

" bclose -- close current buffer, open empty file if it's the last {{{2
Plug 'rbgrouleff/bclose.vim', { 'on': 'Bclose' }

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
"autocmd FileType qf set nowrap nolinebreak colorcolumn=0
"" ..and open on bottom of screen
autocmd FileType qf wincmd J


" vim-accordion -- manage vsplits {{{2
Plug 'mattboehm/vim-accordion', { 'on': 'Accordion' }

" vim-tmux-navigator -- seamless integration of tmux and vim {{{2
Plug 'christoomey/vim-tmux-navigator'

"2}}}

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
set rtp+=$HOME/.config/nvim/sbundle/Mark--Karkat/

"" mark with §, clear with <leader>±
if !hasmapto('<Plug>MarkSet', 'n')
  nmap <unique> <silent> <leader>± <Plug>MarkSet
endif
if !hasmapto('<Plug>MarkSet', 'v')
  vmap <unique> <silent> <leader>± <Plug>MarkSet
endif
" nnoremap <silent> <leader>± :MarkClear<CR>


" nerd-comment -- insert/delete/modify comments {{{2
Plug 'scrooloose/nerdcommenter'

"" Always add a space in front of text when commented
let NERDSpaceDelims = 1

" remove trailing whitspaces on save {{{2
fun! <SID>StripTrailingWhitespaces()
  if g:strip_trailing_whitespaces
    let l = line(".")
    let c = col(".")
    %s/\s\+$//e
    call cursor(l, c)
  endif
endfun

if !exists("g:strip_trailing_whitespaces")
  let g:strip_trailing_whitespaces = 1
endif
autocmd BufWritePre * :call <SID>StripTrailingWhitespaces()


" ale -- on-the-fly code checking {{{2
if ! exists('g:vscode')
    Plug 'w0rp/ale'
endif

" let g:ale_python_mypy_options = '--ignore-missing-imports'

"" Support for airline
let g:airline#extensions#ale#enabled = 1

"" Disable continious linting to save some battery
let g:ale_lint_on_text_changed = 'never'
let g:ale_lint_on_enter = 0
let g:ale_lint_on_save = 1
let g:ale_fix_on_save = 1

"" Syntastics for python, only use flake8
let g:ale_linters = {
      \ 'python':  ['pylint', 'mypy', 'pyflakes'],
      \ 'haskell': ['hlint', 'stack-ghc-mod', 'stack-ghc'],
      \ 'c':     [],
      \ 'cpp':     ['clangcheck', 'clangtidy', 'flawfinder'],
      \ 'tex':     ['chktex', 'proselint', 'write-good'],
      \ 'rust':    ['rls', 'cargo'],
      \ 'javascript': ['eslint', 'flow']
      \}

let g:ale_fixers = {
      \ 'python':  ['black', 'isort'],
      \ 'go':  ['gofmt'],
      \}

let g:ale_python_black_executable = $CONDA_PREFIX . '/bin/black'
let g:ale_python_black_change_directory = 0
let g:ale_python_isort_executable = $CONDA_PREFIX . '/bin/isort'
let g:ale_python_mypy_executable = $CONDA_PREFIX . '/bin/mypy'
let g:ale_python_pylint_executable = $CONDA_PREFIX . '/bin/pylint'

let g:ale_c_build_dir_names = ['build']


" vim-multiple-cursor -- many cursors, may good {{{2
Plug 'terryma/vim-multiple-cursors'

" far.vim -- Find and replace {{{2
Plug 'brooth/far.vim', { 'on': 'Far' }

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
set undofile
set undodir=$HOME/.config/nvim/undo
if !isdirectory($HOME.'/.config/nvim/undo')
  call mkdir($HOME.'/.config/nvim/undo', "p")
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
set tabstop=4
set shiftwidth=4
set softtabstop=4


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
inoremap <C-BS> <C-W>

"" cursor may be placed anywhere in block selection mode
set virtualedit=block

"" always show some lines/columns arround cursor
set scrolloff=1
set sidescrolloff=0
set display+=lastline

"" show hidden characters, but hide on default
" set listchars=trail:⋅,eol:¬,tab:▸\
set showbreak=↪\
set listchars=tab:▸\ ,eol:¬,nbsp:␣,trail:·,extends:⟩,precedes:⟨
set nolist

"" use Q for formatting selection/paragraph
nnoremap Q gqap
vnoremap Q gq

"" keep selection when indeting in visual mode
vnoremap < <gv
vnoremap > >gv
"" uniindent by s-tab
"inoremap <S-TAB> <C-O><<

"" case toggling is an operator
set tildeop

"" Merge lines
nnoremap L J
vnoremap L J

" INPUT HELPS {{{1

" delimitMate -- insert pairs (like brackets) automatically {{{2
Plug 'jiangmiao/auto-pairs'

" rainbox_parentheses -- nice coloring for parentheses {{{2
Plug 'kien/rainbow_parentheses.vim'

" goyo -- distraction free writing {{{2
Plug 'junegunn/goyo.vim'


" completion menu navigation using j/k {{{2
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

" dash.vim -- Dash integration {{{2
Plug 'rizzatti/dash.vim'

nmap <silent> <leader>yH <Plug>DashSearch
let g:dash_activate = 0

let g:dash_map = {
  \ 'python': ['py', 'numpy', 'scipy', 'pandas', 'matplotlib', 'seaborn', 'tf', 'pytorch']
  \}


" UltiSnips -- snippets {{{2
" Plug 'SirVer/ultisnips'

" "" Next/Last snippet
 " let g:UltiSnipsExpandTrigger="<tab>"
 " let g:UltiSnipsJumpForwardTrigger="<tab>"
 " let g:UltiSnipsJumpBackwardTrigger="<C-B>"

 " "" set directories
 " let g:UltiSnipsSnippetDirectories = ["ultisnippets"]
 " let g:UltiSnipsSnippetsDir = "/Users/dsuess/.config/nvim/ultisnippets/"

" let g:ultisnips_python_style = "google"
" let g:UltiSnipsUsePythonVersion = 3

 " "" from ftdetect/UltiSnips.vim
 " " autocmd FileType * call UltiSnips#FileTypeChanged()
 " autocmd BufNewFile,BufRead *.snippets setf snippets

" " vim-slime -- interact with tmux {{{2
" if exists('$TMUX')
"   Plug 'jpalardy/vim-slime'

"   let g:slime_target = "tmux"
"   let g:slime_default_config = {"socket_name": split($TMUX, ",")[0], "target_pane": ":.2"}
" endif


"2}}}
set completeopt=menuone,longest

"" Move digraphs out of the way of autocompletion
inoremap <C-D> <C-K>

"" Use shortened list of spell suggestions
set spellsuggest=fast,9
"" Quickly correct spelling mistakes by using first suggestion
imap <c-s> <c-g>u<Esc>[s1z=<c-o>a
nmap <c-s> [s1z=<c-o>

"" select the last changed block
nnoremap <expr> gp '`[' . strpart(getregtype(), 0, 1) . '`]'

" MOTIONS {{{1

" matchit -- extended % matching {{{2
Plug 'tmhedberg/matchit'

" vim-easymotion -- even faster vim-motions {{{2
Plug 'Lokaltog/vim-easymotion'
"" Use , as its leader key
let g:EasyMotion_leader_key = '<leader><leader>'


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


"" Scroll through paragraphs with J/K
noremap K {
noremap J }

"" Goto Tag
noremap gt <c-]>
"" Forward/back one jump
noremap [j <c-O>
noremap ]j <c-I>

"" Alternate file
nnoremap ± <c-^>

"" Define "inside <space>" motion
onoremap i<space> iW
vnoremap i<space> iW
onoremap a<space> aW
vnoremap a<space> aW

"" Goto first quickfix/location list entry
nnoremap <leader>p :cc<CR>
nnoremap <leader>P :ll<CR>

"" Escape from autocompleted brackets/quotes/etc
inoremap <c-f> <Right>
inoremap <c-b> <Left>



" FOLDING {{{1

" improved-paragraph-motion -- pargraph motions work well with folding {{{2
"" Dont use github repository since files contain windows-newlines
set rtp+=~/.config/nvim/sbundle/Improved-paragraph-motion/

"" Skip all folded paragraphs
let g:ip_skipfold = 1

"2}}}

"" Use marker-folding on default
set foldmethod=marker
set foldnestmax=1

"" Folding/Unfolding using return
" nnoremap <return> za<return>
vnoremap <leader><space> zf<return>

"" opening folds on occasion
set foldopen=block,insert,jump,mark,percent,quickfix,search,tag,undo


" FILES & COMMANDS {{{1

" Nerdtree -- A tree explorer plugin for vim {{{2
Plug 'scrooloose/nerdtree', { 'on': ['NERDTree', 'NERDTreeToggle'] }
Plug 'Xuyuanp/nerdtree-git-plugin', { 'on': ['NERDTree', 'NERDTreeToggle'] }
"" set wildignore from gitignore (e.g. to exlude ignored files from NERD tree)
" Plug 'octref/RootIgnore'

let NERDTreeRespectWildIgnore = 1

"" open/close similar to vim-unimpaired
nnoremap <silent> cof :NERDTreeToggle<CR>
nnoremap <silent> [of :NERDTree<CR>
nnoremap <silent> ]of :NERDTreeClose<CR>

"" Use bash instead of default shell
set shell=zsh
if ! has('nvim')
  set shellcmdflag=-ic
  set shell=bash
endif

"" show the keyboard command entered
set showcmd

"" sane tab completion in command mode
set wildmode=list:longest,full
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
set backupdir=$HOME/.config/nvim/backup


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

" nnoremap <leader>a :Ag |" Dont strip space!

" ctrlp.vim -- file navigation, searching and much more {{{2
Plug 'junegunn/fzf', { 'dir': '~/.config/fzf', 'do': './install --bin' }
Plug 'junegunn/fzf.vim'

" NOTE: Ignoring all files listed in .gitignore by using `fd` as default
" command:
" export FZF_DEFAULT_COMMAND='fd --type f'

"" Key Settings
nnoremap <LEADER>e :Files<CR>
nnoremap <LEADER>E :History<CR>
nnoremap <LEADER>M :Marks<CR>
nnoremap <LEADER>v :Buffers<CR>
nnoremap <LEADER>f :BTags<CR>
nnoremap <LEADER>F :Tags<CR>
nnoremap <LEADER>g :BLines<CR>
nnoremap <LEADER>G :Lines<CR>
nnoremap <LEADER>H :Helptags<CR>
nnoremap <LEADER>~ :Files ~<CR>

"" Disply window on bottom
let g:fzf_layout = { 'down': '~30%' }
let g:fzf_buffers_jump = 1


" "" list LaTeX tags correctly
" let tlist_tex_settings = 'latex;l:labels;s:sections;t:subsections;u:subsubsections'

" "" Define additional file types
" let g:ctrlp_buftag_types = {
"       \ 'cython': '--language-force=python'
"       \ }
" if executable('lushtags')
"   call extend(g:ctrlp_buftag_types, { 'haskell': { 'args': '--ignore-parse-error', 'bin': 'lushtags' } })
" end

" highlightedyank -- Highlight yanked region briefly {{{2
Plug 'machakann/vim-highlightedyank'

" vim-gitgutter -- show changes in gutter {{{2
" Plug 'airblade/vim-gitgutter'

"2}}}

"" Goto first search hit while typing
set incsearch
"" caseinsensetive search, when searchphrase is lowercase
set smartcase
"" Highlight search result and clear with <leader>/
set hlsearch
nnoremap <silent> <leader>/ :nohlsearch<CR>
set inccommand=nosplit

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
Plug 'majutsushi/tagbar', { 'on': ['TagbarToggle', 'TagbarOpen'] }

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
nnoremap <leader>GD :Gdiff<CR>

"" automatically delete fugitive buffers on close
autocmd BufReadPost fugitive://* set bufhidden=delete

" linediff -- diff two blocks of text in arbitrary files {{{2
Plug 'AndrewRadev/linediff.vim'

" vim-localvimrc -- load local vimrc files {{{2
Plug 'embear/vim-localvimrc'

let g:localvimrc_persistent = 1
let g:localvimrc_persistence_file = '/Users/dsuess/.config/nvim/localvimrc_persistent'
"2}}}

"" location of tag files (use first existend one)
set tags=
" set tags=.vimtags,/home/dsuess/.vim/tags
nnoremap gT :exe "ptjump " . expand("<cword>")<CR>

"" Goto tag using enter
autocmd filetype help nnoremap <buffer> <cr> <C-]>

" BUILDING & LANGUAGE SPECIFICS {{{1


" LaTeXBox {{{2
Plug 'lervag/vimtex', { 'for': 'tex' }
Plug 'donRaphaco/neotex', { 'for': 'tex' }

let g:vimtex_compiler_latexrun = {
      \ 'options' : [
      \    '--bibtex-cmd biber'
      \  ]
      \}

let g:vimtex_compiler_progname = '/Users/dsuess/bin/nvr_vimr'
let g:vimtex_compiler_method = 'latexrun'
let g:vimtex_view_method = 'skim'
let g:vimtex_quickfix_latexlog = {'default' : 0}
let g:vimtex_quickfix_blgparser  = {'disable': 0}
"
" let g:vimtex_quickfix_latexlog = {
"           \ 'default' : 1,
"           \ 'general' : 1,
"           \ 'references' : 1,
"           \ 'overfull' : 0,
"           \ 'underfull' : 0,
"           \ 'font' : 1,
"           \ 'packages' : {
"           \   'default' : 1,
"           \   'natbib' : 1,
"           \   'biblatex' : 1,
"           \   'babel' : 1,
"           \   'hyperref' : 1,
"           \   'scrreprt' : 1,
"           \   'fixltx2e' : 1,
"           \   'titlesec' : 1,
"           \ },
"           \}

" PYTHON {{{2

" python-mode -- the name says it all
" Plug 'klen/python-mode', { 'for': ['python'] }

"" Disable all unused stuff
let g:pymode_doc = 0
let g:pymode_lint = 0
let g:pymode_folding = 0
let g:pymode_virtualenv = 0
let g:pymode_utils_whitespaces = 0
let g:pymode_indent = 1

"" Run current file
let g:pymode_run = 1
let g:pymode_run_bind = '<leader>rr'

"" Breakpoint support
let g:pymode_breakpoint = 1
let g:pymode_breakpoint_cmd = 'import pdb; pdb.set_trace()  # XXX Breakpoint'
let g:pymode_breakpoint_bind = '<leader>rb'

"" Refactoring stuff
let g:pymode_rope = 0
"" Dont clutter usefull keys -- jedi is better!
let g:pymode_rope_autocomplete_map = '<F4>aztklj'
let g:pymode_rope_autoimport_modules = ["os","shutil","datetime", "numpy", "matplotlib.pyplot"]

"" and motions
let g:pymode_motion = 1

"" Enable pymode's custom syntax highlighting
let g:pymode_syntax = 1
let g:pymode_syntax_all = 1
let g:pymode_syntax_print_as_function = 1
let g:pymode_syntax_indent_errors = g:pymode_syntax_all
let g:pymode_syntax_space_errors = g:pymode_syntax_all
let g:pymode_syntax_string_formatting = g:pymode_syntax_all
let g:pymode_syntax_string_format = g:pymode_syntax_all
let g:pymode_syntax_string_templates = g:pymode_syntax_all
let g:pymode_syntax_doctests = g:pymode_syntax_all
let g:pymode_syntax_builtin_objs = g:pymode_syntax_all
let g:pymode_syntax_builtin_funcs = g:pymode_syntax_all
let g:pymode_syntax_highlight_exceptions = g:pymode_syntax_all
let g:pymode_syntax_highlight_equal_operator = g:pymode_syntax_all
let g:pymode_syntax_highlight_stars_operator = g:pymode_syntax_all
let g:pymode_syntax_highlight_self = g:pymode_syntax_all
let g:pymode_syntax_slow_sync = 0

" vim-pydocstring
Plug 'heavenshell/vim-pydocstring', { 'for': 'python' }
let g:pydocstring_templates_dir = '/Users/dsuess/.config/nvim/pydocstring'
let g:pydocstring_enable_mapping = 0

" python-syntax
Plug 'hdima/python-syntax', { 'for': 'python' }

" pytest-vim-compiler
Plug '5long/pytest-vim-compiler', { 'for': 'python' }

" vim-isort -- sorting imports
Plug 'fisadev/vim-isort', { 'for': 'python' }
let g:vim_isort_map = ''

nnoremap <leader>IS :Isort<CR>

" Plug 'cjrh/vim-conda', { 'for': 'python' }


" HASKELL {{{2
" vim2hs -- Haskell for vim
Plug 'dag/vim2hs', { 'for': 'haskell' }

let g:haskell_conceal = 0
" neco-ghc -- omni completion for Haskell {{{2
"" Requires ghc-mod
Plug 'eagletmt/neco-ghc', { 'for': 'haskell' }
let g:necoghc_enable_detailed_browse = 1

" C-family {{{2
"
" clang-format
Plug 'rhysd/vim-clang-format', { 'for': ['c', 'cpp'] }
let g:clang_format#code_style = 'google'
let g:clang_format#detect_style_file = 1
let g:clang_format#auto_format = 1


" vim-fswitch -- Easily switch between header and cpp file
Plug 'derekwyatt/vim-fswitch', { 'for': ['c', 'cpp'] }

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

autocmd BufRead,BufNewFile *.pxd let b:fswitchdst = 'pyx'
autocmd BufRead,BufNewFile *.pyx let b:fswitchdst = 'pyd'
autocmd BufRead,BufNewFile *.pyx,*.pxd let b:fswitchlocs = 'rel:.'

" RUST {{{2

Plug 'rust-lang/rust.vim', { 'for': 'rust' }
let g:rustfmt_autosave = 1

" MatchTagAlways -- Visual marking of HTML/XML/... tags {{{2
Plug 'Valloric/MatchTagAlways', { 'for': ['html', 'xml'] }

" vim-dispatch -- asynchroneous building {{{2
Plug 'tpope/vim-dispatch'

if has('gui_vimr')
  Plug 'radenling/vim-dispatch-neovim'
endif

let g:dispatch_compilers = {
      \ 'python': 'python',
      \ 'haskell': 'ghc'
      \ }

"" start a shell in a new window
nnoremap <leader>ds :Dispatch zsh<CR>
nnoremap <leader>dd :Dispatch<CR>
nnoremap <leader>dm :Make!<CR>
nnoremap <leader>DD :Dispatch!<CR>

"" shortcut to build with dispatch
map <silent> <LEADER>m :Make<CR>
map <silent> <LEADER>M :Dispatch make<CR>


" neoterm -- better support of neovims terminal {{{2
Plug 'kassio/neoterm'


"" shortcut config in ftplugin/python.vim

" vim-sparkup -- zen coding with html/xml {{{2
Plug 'tristen/vim-sparkup', { 'for': ['xml', 'html'] }

" vim-markup -- syntax and matching for markdown {{{2
Plug 'plasticboy/vim-markdown', {'for': 'markdown'}

"set a custom make target {{{2
function! SetMake()
  let mkprg = input('? ')
  execute 'setlocal makeprg=' . substitute(mkprg, ' ', '\\ ', 'g')
endfunction

nnoremap <leader>sm :call SetMake()<CR>

" vim-unstack -- nice representation of stack-traces{{{2
Plug 'mattboehm/vim-unstack', { 'for': ['python', 'go', 'javascript']}

let g:unstack_mapkey = '<leader>us'

" vim-rooter -- switch pwd smarter {{{2
Plug 'airblade/vim-rooter'

" typescript-vim {{{2
Plug 'leafgarland/typescript-vim', { 'for': 'typescript' }

"2}}}


"" Build ctags in current dir
map <silent> <leader>cT !ctags-exuberant -R -f .vimtags & <CR>

"" Dont hide anything
set concealcursor=

"" Add spell-stuff here
set spellfile=$HOME/.vim/dictionary.add


" FILETYPES {{{1

" edit the ftplugin file {{{2
function! OpenFiletypeFile()
  let path_to_file = '~/.config/nvim/after/ftplugin/' .  &filetype . '.vim'
  exe "edit " . path_to_file
endfunction
command! EditFiletype call OpenFiletypeFile()

" and reload the thing
function! ReloadFiletypeFile()
  let path_to_file = '~/.config/nvim/after/ftplugin/' .  &filetype . '.vim'
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
autocmd BufRead,BufNewFile *.ts set filetype=typescript
autocmd BufRead,BufNewFile *.tex set filetype=tex

"2}}}

"" enable filetype detection
filetype plugin indent on

call plug#end()

"" Set colorscheme depending on terminal/gui-vim
if &t_Co >= 256
  "" 256-color terminal
  "let g:airline_theme="powerlineish"
  if has('nvim')
    set background=dark
    colorscheme NeoSolarized
    let g:airline_theme = 'solarized'
  else
    colorscheme sorcerer
  endif
endif
if has('gui_vimr')
  colorscheme NeoSolarized
  let g:airline_theme = 'solarized'
  set background=dark
endif

