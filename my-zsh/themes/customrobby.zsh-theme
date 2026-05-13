local ret_status="%(?:%{%B%F{#a6e3a1}%}➜ :%{%B%F{#f38ba8}%}➜ %s)"

if [[ -n "$SSH_CLIENT" ]]; then
   PROMPT=' %{%F{#f9e2af}%}${USER}@${HOST} %{%F{#94e2d5}%}%c %{%B%F{#89b4fa}%}$(git_prompt_info)%{%b%F{#89b4fa}%} % %{%f%b%}'
else
   PROMPT=' %{%F{#94e2d5}%}%c %{%B%F{#89b4fa}%}$(git_prompt_info)%{%b%F{#89b4fa}%} % %{%f%b%}'
fi

ZSH_THEME_GIT_PROMPT_PREFIX="git:(%{%F{#f38ba8}%}"
ZSH_THEME_GIT_PROMPT_SUFFIX="%{%f%b%}"
ZSH_THEME_GIT_PROMPT_DIRTY="%{%F{#89b4fa}%}) %{%F{#fab387}%}✗%{%f%b%}"
ZSH_THEME_GIT_PROMPT_CLEAN="%{%F{#89b4fa}%})"
