#!/bin/sh
# Passes one Claude Code hook event (JSON on stdin) to the hub that hosts this
# terminal, and prints the hub's answer (an approval's decision) for Claude
# Code to act on. The same events, in the same shape, as the hooks the hub
# gives the sessions Desk starts.
#
# The hub puts where to post in the shells it opens for Desk's grids:
# DESK_HOOK_URL in full, or DESK_HOOK_BASE (its hook listener) to which this
# terminal's DESK_TERMINAL_ID and DESK_HOOK_TOKEN are added. Outside such a
# shell (the plugin loaded anywhere else) this does nothing.
#
# $1: how long to wait for the hub's answer, in seconds.

url="$DESK_HOOK_URL"
if [ -z "$url" ] && [ -n "$DESK_HOOK_BASE" ] && [ -n "$DESK_TERMINAL_ID" ] && [ -n "$DESK_HOOK_TOKEN" ]; then
  url="$DESK_HOOK_BASE/hook/terminal/$DESK_TERMINAL_ID/$DESK_HOOK_TOKEN"
fi
[ -n "$url" ] || exit 0
curl -s --max-time "${1:-10}" -X POST -H 'Content-Type: application/json' --data-binary @- "$url" || exit 0
