#!/usr/bin/env bash
# Claude Code statusline wrapper.
#
# claude-powerline can't render an icon *and* a progress bar in the context
# segment: its bar display styles ("capped", "blocks", ...) drop the leading
# glyph (verified in v1.26.0/v1.27.0 — the bar branch never calls leadingIcon).
# So we run it normally and prepend a Nerd Font icon to the context bar here.
#
# The context segment is emitted before the block segment, and both use the
# "capped" bar, so we tag only the FIRST run of capped-bar glyphs:
#   U+2501 ━   U+2504 ┄   U+2578 ╸
# Matching the first run keeps the icon off the block bar without touching ANSI
# colors. Change ICON_CP to any Nerd Font codepoint present in the terminal
# font (AnonymicePro Nerd Font lacks the newer FontAwesome range, so prefer the
# Material Design codepoints): f0c0b = brain, f035b = memory, f0294 = gauge,
# f1c0 = database, eb70 = window.

ICON_CP='f0c0b' # nf-md-brain — context-window indicator

npx -y @owloops/claude-powerline@v1.26.0 --style=powerline |
  ICON_CP="$ICON_CP" perl -CSAD -pe \
    's/([\x{2501}\x{2504}\x{2578}]+)/chr(hex($ENV{ICON_CP}))." ".$1/e'
