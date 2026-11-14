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
# $2: how long to keep trying to reach the hub, in seconds (default 0). A
#     permission request raised while the hub restarts (an install) would
#     otherwise fall to Claude Code's own dialog, which Desk never sees; with
#     it, the request is posted again every 3 s while the hub can't be reached
#     or answers with an error, and only once that time is up does Claude Code
#     ask in its terminal. An answer, once given, is never asked for again.

url="$DESK_HOOK_URL"
if [ -z "$url" ] && [ -n "$DESK_HOOK_BASE" ] && [ -n "$DESK_TERMINAL_ID" ] && [ -n "$DESK_HOOK_TOKEN" ]; then
  url="$DESK_HOOK_BASE/hook/terminal/$DESK_TERMINAL_ID/$DESK_HOOK_TOKEN"
fi
[ -n "$url" ] || exit 0
reach="${2:-0}"
if [ "$reach" -le 0 ]; then
  curl -s --max-time "${1:-10}" -X POST -H 'Content-Type: application/json' --data-binary @- "$url" || exit 0
  exit 0
fi
body=$(cat)
tries=$((reach / 3))
n=0
while :; do
  out=$(printf '%s' "$body" | curl -sf --max-time "${1:-10}" -X POST -H 'Content-Type: application/json' --data-binary @- "$url")
  case $? in
    0) printf '%s' "$out"; exit 0 ;;
    # Couldn't connect, an HTTP error, an empty reply, a send or receive
    # failure: the hub is down or on its way back up.
    7|22|52|55|56) n=$((n + 1)); [ "$n" -le "$tries" ] || exit 0; sleep 3 ;;
    *) exit 0 ;;
  esac
done
