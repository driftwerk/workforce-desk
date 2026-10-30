#!/bin/bash
# Smoke test of the Linux backend: Desk Helper, the hub and the memory store
# in a throwaway DESK_HOME, as Desk on Linux (and inside WSL) runs them.
#
#   scripts/backend-smoke.sh BIN_DIR
#
# BIN_DIR holds desk-helper, desk-agents and desk-memory (desk-hubd, the hub
# at hub.ref and vellev at vellev.ref, under their Linux names). Needs curl
# and jq. Checks that:
#   - the helper says it can run here (--check);
#   - it starts Postgres, the hub and the PTY holder, and pairs Desk with the
#     hub (connection --json has a device token the hub knows);
#   - a terminal opens in a folder and runs a shell, and closes;
#   - --stop stops the hub and Postgres but leaves the holder (its
#     terminals outlive the helper);
#   - --remove-everything ends the holder and deletes the folder.
set -euo pipefail

bin=$(cd "${1:?usage: $0 BIN_DIR}" && pwd)
helper="$bin/desk-helper"
for name in desk-helper desk-agents desk-memory; do
  [ -x "$bin/$name" ] || { echo "backend-smoke: no $bin/$name" >&2; exit 2; }
done

DESK_HOME=$(mktemp -d)
export DESK_HOME
work=$(mktemp -d)
log="$work/desk-helper.log"
pid=
say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
fail() {
  printf 'backend-smoke: %s\n' "$*" >&2
  for f in "$log" "$DESK_HOME"/logs/*.log; do
    [ -f "$f" ] && { echo "── $f"; tail -n 60 "$f"; }
  done >&2
  exit 1
}
cleanup() {
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  "$helper" --remove-everything >/dev/null 2>&1 || true
  rm -rf "$work" "$DESK_HOME"
}
trap cleanup EXIT

# until SECONDS COMMAND...: runs COMMAND every second until it succeeds.
until_ok() {
  local within=$1
  shift
  for _ in $(seq "$within"); do
    "$@" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

say "check"
check=$("$helper" --check)
echo "$check"
[ "$(jq -r .ok <<<"$check")" = true ] || fail "the backend says it can't run here: $check"

say "start"
"$helper" >"$log" 2>&1 &
pid=$!

paired() { "$helper" connection --json | jq -e '.device_token != null' >/dev/null; }
until_ok 600 paired || fail "Desk Helper didn't pair Desk with the hub"
conn=$("$helper" connection --json)
gateway=$(jq -r .gateway_url <<<"$conn")
admin=$(jq -r .admin_token <<<"$conn")
device=$(jq -r .device_token <<<"$conn")
api() { curl -fsS -H "Authorization: Bearer $1" "${@:3}" "$gateway$2"; }

say "the hub knows Desk's device"
me=$(api "$device" /api/me)
[ -n "$(jq -r '.id // empty' <<<"$me")" ] || fail "/api/me answered $me"

say "a terminal opens in a folder and runs a shell"
mkdir -p "$work/acme-web"
terminal=$(api "$admin" /api/desk/terminals -X POST -H 'Content-Type: application/json' \
  -d "$(jq -n --arg cwd "$work/acme-web" '{cwd: $cwd, name: "smoke"}')")
id=$(jq -r .id <<<"$terminal")
shell_pid=$(jq -r .pid <<<"$terminal")
[ "$(jq -r .live <<<"$terminal")" = true ] || fail "the terminal isn't live: $terminal"
[ "$(readlink "/proc/$shell_pid/cwd")" = "$work/acme-web" ] || fail "the shell isn't in acme-web: $terminal"
api "$admin" /api/desk/terminals | jq -e --arg id "$id" 'any(.[]; .id == $id)' >/dev/null ||
  fail "the terminal isn't listed"
api "$admin" "/api/desk/terminals/$id" -X DELETE >/dev/null
gone() { ! kill -0 "$shell_pid" 2>/dev/null; }
until_ok 20 gone || fail "the terminal's shell kept running after it closed"

say "--stop stops the hub and Postgres, and leaves the holder"
holder=$(cat "$DESK_HOME/hub/run/pty.pid")
postgres_port=$(sed -n 's/^postgres = //p' "$DESK_HOME/hub/state.toml")
"$helper" --stop
wait "$pid" || true
pid=
listening() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
! listening "$postgres_port" || fail "Postgres is still listening on $postgres_port"
! listening "$(sed -E 's|.*:([0-9]+)$|\1|' <<<"$gateway")" || fail "the hub is still listening"
kill -0 "$holder" 2>/dev/null || fail "the PTY holder stopped with the helper"

say "--remove-everything ends the holder and deletes the folder"
"$helper" --remove-everything
! kill -0 "$holder" 2>/dev/null || fail "the PTY holder is still running"
[ ! -e "$DESK_HOME" ] || fail "$DESK_HOME is still there"

say "the Linux backend works"
