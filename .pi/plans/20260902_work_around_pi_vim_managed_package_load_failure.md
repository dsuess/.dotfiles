# Work Around pi-vim Managed-Package Loading Failure

## Context

Pi 0.84.x installs npm extensions with peer dependencies omitted and supplies its core packages through Jiti virtual modules. `pi-vim` 0.14.1 calls native `import.meta.resolve("@earendil-works/pi-coding-agent")` while loading, which cannot see the virtual module and prevents the extension from starting. Upstream issue `lajarre/pi-vim#46` tracks the failure, and pull request `#47` contains a tested fallback for ordinary Node/Homebrew installations. No fixed npm release is available.

The repository currently tracks the unversioned `npm:pi-vim` source. Manual links into Pi's managed npm tree would violate the repository's Stow discipline and could drift from the active Pi version.

## Approach

Replace the npm source with the exact fix commit from the upstream pull request. Keep the fzf wrapper immediately after pi-vim, and make its ordering test recognize both npm and pinned GitHub pi-vim sources so the assertion continues to describe package identity rather than one installation mechanism.

When upstream publishes a fixed npm version, replace the temporary Git source with a pinned fixed npm source and remove this workaround.

## Critical Files

- `pi/agent/settings.json` — pins pi-vim to the reviewed fix commit.
- `pi/agent/extensions/fzf-file-picker/test/fzf-file-picker.test.mjs` — preserves the editor-wrapper ordering invariant across supported pi-vim source forms.

## Verification

- Run the focused fzf-file-picker test and confirm it finds the pinned pi-vim source immediately before the wrapper.
- Load the pinned extension through Pi's Jiti virtual-module setup against the installed Homebrew Pi runtime.
- Run `npm --prefix pi run check` and report any environment-only native gate failure precisely.
- Run `git diff --check` and inspect only the files changed for this workaround.
