#!/bin/sh
# Passes one Claude Code hook event (JSON on stdin) to the hub that hosts this
# terminal, and prints the hub's answer (an approval's decision) for Claude
# Code to act on. The same events, in the same shape, as the hooks the hub
# gives the sessions Desk starts.
#
# The hub sets DESK_HOOK_URL in the shells it opens for Desk's grids. Outside
# one (the plugin loaded anywhere else) this does nothing.
#
# $1: how long to wait for the hub's answer, in seconds.

[ -n "$DESK_HOOK_URL" ] || exit 0
curl -s --max-time "${1:-10}" -X POST -H 'Content-Type: application/json' --data-binary @- "$DESK_HOOK_URL" || exit 0
