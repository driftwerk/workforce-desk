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
#     or answers with a server error, and only once that time is up does
#     Claude Code ask in its terminal. Any other answer stands (a 404: no such
#     session). An answer, once given, is never asked for again; a request
#     the hub had held a while when it went is reached for afresh. The URL,
#     with its token, goes to curl on a file descriptor, never on its command
#     line, where any user of this computer could read it while it waits.

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
  t0=$(date +%s)
  out=$(printf '%s' "$body" | curl -s --max-time "${1:-10}" -w '\n%{http_code}' -X POST \
    -H 'Content-Type: application/json' --data-binary @- -K /dev/fd/3 3<<EOF
url = "$url"
EOF
)
  r=$?
  code=$(printf '%s' "$out" | tail -n 1)
  out=$(printf '%s' "$out" | sed '$d')
  if [ "$r" -eq 0 ]; then
    case $code in
      2??) printf '%s' "$out"; exit 0 ;;
      5??) ;;
      *) exit 0 ;;
    esac
  else
    # Couldn't connect, an empty reply, a send or receive failure: the hub
    # is down or on its way back up.
    case $r in
      7|52|55|56) ;;
      *) exit 0 ;;
    esac
  fi
  [ $(( $(date +%s) - t0 )) -lt 10 ] || n=0
  n=$((n + 1))
  [ "$n" -le "$tries" ] || exit 0
  sleep 3
done
