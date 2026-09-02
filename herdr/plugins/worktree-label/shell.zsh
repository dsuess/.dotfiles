# Report the focused Herdr pane's CWD without setting a sticky workspace name.
[[ ${HERDR_ENV:-} == 1 && -n ${HERDR_WORKSPACE_ID:-} && -n ${HERDR_PANE_ID:-} ]] || return 0

_DOTFILES_HERDR_LABEL_REPORTER=${${(%):-%x}:A:h}/index.js
typeset -g _DOTFILES_HERDR_LABEL_CWD=""
function _dotfiles_herdr_report_cwd() {
  [[ $PWD == $_DOTFILES_HERDR_LABEL_CWD ]] && return
  node "$_DOTFILES_HERDR_LABEL_REPORTER" && _DOTFILES_HERDR_LABEL_CWD=$PWD
}
autoload -Uz add-zsh-hook
add-zsh-hook chpwd _dotfiles_herdr_report_cwd
add-zsh-hook precmd _dotfiles_herdr_report_cwd
