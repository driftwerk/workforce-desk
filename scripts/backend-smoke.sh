#!/bin/bash
# Smoke test of the Linux backend: Desk Helper, the hub and the memory store
# in a throwaway DESK_HOME, as Desk on Linux (and inside WSL) runs them.
#
#   scripts/backend-smoke.sh [--machine] BIN_DIR
#
# BIN_DIR holds desk-helper, desk-agents and desk-memory (desk-hubd, the hub
# at hub.ref and vellev at vellev.ref, under their Linux names), and with
# --machine Desk's claude-plugin folder. Needs curl and jq. Checks that:
#   - the helper says it can run here (--check);
#   - it starts Postgres, the hub and the PTY holder, and pairs Desk with the
#     hub (connection --json has a device token the hub knows);
#   - a terminal opens in a folder and runs a shell, and closes;
#   - --stop stops the hub and Postgres but leaves the holder (its
#     terminals outlive the helper);
#   - --remove-everything ends the holder and deletes the folder.
#
# With --machine it runs the backend as a machine runs it (a Linux box Desk
# drives over SSH): installed as a version under DESK_HOME/bin with
# `current` pointing at it, started as `bin/current/desk-helper --machine`
# with its owner named in DESK_PERSON_NAME and DESK_PERSON_EMAIL, and a
# stand-in `claude` first on PATH. It also checks that:
#   - connection --json says the version installed, and the owner is the
#     person named;
#   - the hub resumes sessions by itself (restore = "auto");
#   - a session the hub starts has Desk's plugin, through `current`, in its
#     environment;
#   - after the helper stops and the holder with its sessions is gone (as
#     when the box restarts), the next helper resumes the session.
set -euo pipefail

machine=
if [ "${1:-}" = --machine ]; then
  machine=1
  shift
fi
bin=$(cd "${1:?usage: $0 [--machine] BIN_DIR}" && pwd)
for name in desk-helper desk-agents desk-memory; do
  [ -x "$bin/$name" ] || { echo "backend-smoke: no $bin/$name" >&2; exit 2; }
done
[ -z "$machine" ] || [ -d "$bin/claude-plugin" ] ||
  { echo "backend-smoke: --machine needs $bin/claude-plugin" >&2; exit 2; }

DESK_HOME=$(mktemp -d)
export DESK_HOME
work=$(mktemp -d)
log="$work/desk-helper.log"
pid=
helper="$bin/desk-helper"
start=("$helper")
if [ -n "$machine" ]; then
  version=0.0.0-smoke+dev.machine
  mkdir -p "$DESK_HOME/bin/$version"
  cp "$bin/desk-helper" "$bin/desk-agents" "$bin/desk-memory" "$DESK_HOME/bin/$version/"
  cp -R "$bin/claude-plugin" "$DESK_HOME/bin/$version/claude-plugin"
  ln -s "$version" "$DESK_HOME/bin/current"
  helper="$DESK_HOME/bin/current/desk-helper"
  start=("$helper" --machine)
  export DESK_PERSON_NAME="Smoke Tester" DESK_PERSON_EMAIL=smoke@example.com
  # A stand-in for Claude Code: says a version when asked, and otherwise
  # logs how it was started and with which plugins, then waits as a session.
  sessions="$work/sessions.log"
  mkdir -p "$work/fake-bin"
  {
    echo '#!/bin/sh'
    echo 'case "$1" in'
    echo "  --session-id | --resume) echo \"\$1 \$2 plugins=\$CLAUDE_CODE_PLUGIN_DIRS\" >>'$sessions'; exec sleep 100000 ;;"
    echo '  *) echo "2.1.0 (Claude Code)" ;;'
    echo 'esac'
  } >"$work/fake-bin/claude"
  chmod +x "$work/fake-bin/claude"
  export PATH="$work/fake-bin:$PATH"
fi
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
"${start[@]}" >"$log" 2>&1 &
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

if [ -n "$machine" ]; then
  say "a machine says its version, and its owner is the person named"
  [ "$(jq -r .version <<<"$conn")" = "$version" ] ||
    fail "connection --json says version $(jq -r .version <<<"$conn")"
  owner=$(sed -n 's/^identity_id = "\(.*\)"$/\1/p' "$DESK_HOME/hub/owner.toml")
  name=$(api "$admin" "/api/identities/$owner" | jq -r .display_name)
  [ "$name" = "Smoke Tester" ] || fail "the owner is called $name"

  say "a machine's hub resumes sessions by itself"
  grep -qx 'restore = "auto"' "$DESK_HOME/hub/workforce.toml" ||
    fail "workforce.toml doesn't say restore = \"auto\""

  say "a session the hub starts has Desk's plugin"
  mkdir -p "$work/acme-api"
  session=$(api "$admin" /api/desk/sessions -X POST -H 'Content-Type: application/json' \
    -d "$(jq -n --arg cwd "$work/acme-api" '{engine: "claude", name: "smoke", cwd: $cwd}')")
  sid=$(jq -r '.id // empty' <<<"$session")
  [ -n "$sid" ] || fail "the session didn't start: $session"
  plugin="$DESK_HOME/bin/current/claude-plugin"
  started() { grep -q -- "--session-id $sid plugins=.*$plugin" "$sessions"; }
  until_ok 30 started || fail "the session didn't start with Desk's plugin: $(cat "$sessions" 2>/dev/null)"

  say "after the box restarts, the session is resumed"
  holder=$(cat "$DESK_HOME/hub/run/pty.pid")
  "$helper" --stop
  wait "$pid" || true
  # The holder and its sessions end, as they do when the box restarts.
  kill "$holder"
  holder_gone() { ! kill -0 "$holder" 2>/dev/null; }
  until_ok 20 holder_gone || fail "the PTY holder didn't stop"
  "${start[@]}" >>"$log" 2>&1 &
  pid=$!
  resumed() { grep -q -- "--resume $sid plugins=.*$plugin" "$sessions"; }
  until_ok 300 resumed || fail "the session wasn't resumed: $(cat "$sessions")"
  until_ok 120 paired || fail "Desk Helper didn't pair again"
  conn=$("$helper" connection --json)
  gateway=$(jq -r .gateway_url <<<"$conn")
fi

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

say "the Linux backend works${machine:+ as a machine}"
