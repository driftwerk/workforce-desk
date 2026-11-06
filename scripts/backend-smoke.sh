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
#   - --remove-everything ends the holder and deletes the folder;
#   - this computer's hub has its Desk agent, the overseer.
#
# With --machine it runs the backend as a machine runs it (a Linux box Desk
# drives over SSH): installed as a version under DESK_HOME/bin with
# `current` pointing at it, started as `bin/current/desk-helper --machine`
# with its owner named in DESK_PERSON_NAME and DESK_PERSON_EMAIL, and a
# stand-in `claude` first on PATH. It also checks that:
#   - its hub serves no agents: the Desk agent an earlier version left is
#     removed, none is listed, and none oversees its sessions;
#   - it runs no memory store and fetches no model, and what an earlier
#     version kept for the store is removed;
#   - on its next start the hub forgets the chat sessions and Floor rows
#     the earlier Desk agent left in Postgres, never another agent's or
#     Desk's own sessions, and lets go every session that boss ran;
#   - connection --json says the version installed, and the owner is the
#     person named;
#   - the hub resumes sessions by itself (restore = "auto");
#   - a session the hub starts has Desk's plugin, through `current`, in its
#     environment;
#   - with Claude Code never logged in there, after this Mac's accounts are
#     copied to it (as "Use this Mac's accounts" posts them), a Claude
#     session it starts is signed in by the first of them, never left at a
#     login prompt;
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
# Installed as Desk installs it: a release helper runs only from there.
if [ -n "$machine" ]; then version=0.0.0-smoke+dev.machine; else version=0.0.0-smoke+dev.desktop; fi
mkdir -p "$DESK_HOME/bin/$version"
cp "$bin/desk-helper" "$bin/desk-agents" "$bin/desk-memory" "$DESK_HOME/bin/$version/"
ln -s "$version" "$DESK_HOME/bin/current"
helper="$DESK_HOME/bin/current/desk-helper"
start=("$helper")
if [ -n "$machine" ]; then
  cp -R "$bin/claude-plugin" "$DESK_HOME/bin/$version/claude-plugin"
  start=("$helper" --machine)
  # The Desk agent an earlier version made on a machine, as an upgrade
  # finds it.
  mkdir -p "$DESK_HOME/hub/data/agents/desk/memory"
  printf '[oversight]\nenabled = true\nlevel = "watch"\n' >"$DESK_HOME/hub/data/agents/desk/config.toml"
  # And what it kept for the memory store.
  mkdir -p "$DESK_HOME/hub/memory/models/bge" "$DESK_HOME/hub/memory/store"
  echo '{"state":"ready"}' >"$DESK_HOME/hub/memory/model.json"
  export DESK_PERSON_NAME="Smoke Tester" DESK_PERSON_EMAIL=smoke@example.com
  # A stand-in for Claude Code, never logged in here: says a version when
  # asked; signed in only by a smoke account's token on descriptor 3 (as
  # the hub hands an account's sign-in over); and otherwise logs how it
  # was started, with which plugins and on which account (the token's name
  # part, never more), then waits as a session.
  sessions="$work/sessions.log"
  mkdir -p "$work/fake-bin"
  cat >"$work/fake-bin/claude" <<EOF
#!/bin/sh
case "\$1" in
  --session-id | --resume)
    t=
    [ -n "\$CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR" ] && read -r t <&3
    on=\$(printf '%s' "\$t" | sed -n 's/^sk-ant-oat01-smoke-\([a-z]*\)-.*/\1/p')
    echo "\$1 \$2 plugins=\$CLAUDE_CODE_PLUGIN_DIRS account=\${on:-none}" >>'$sessions'
    exec sleep 100000 ;;
  auth)
    t=\$({ cat <&3; } 2>/dev/null)
    case "\$t" in
      sk-ant-oat01-smoke-*) echo '{"loggedIn":true,"authMethod":"oauth_token"}' ;;
      *) echo '{"loggedIn":false}' ;;
    esac ;;
  *) echo "2.1.0 (Claude Code)" ;;
esac
EOF
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
# Paired is written before the hub's gateway is listening.
until_ok 60 api "$device" /api/me || fail "the hub's gateway didn't answer at $gateway"
me=$(api "$device" /api/me)
[ -n "$(jq -r '.id // empty' <<<"$me")" ] || fail "/api/me answered $me"

say "the hub settles on its memories"
# The memory store's model arrives in the background, and once it does the
# hub restarts on the store: waited for here, so nothing below races that
# restart. A model that can't be fetched in time leaves the hub on SQLite.
# A machine runs no store, so there is nothing to wait for.
if [ -n "$machine" ]; then
  [ ! -e "$DESK_HOME/hub/memory" ] || fail "a machine kept memory store data: $(ls -R "$DESK_HOME/hub/memory")"
  ! pgrep -f "$DESK_HOME/bin/.*/desk-memory" >/dev/null || fail "a machine runs the memory store"
  ! grep -q '^\[vellev\]' "$DESK_HOME/hub/workforce.toml" || fail "a machine's hub is given a memory store"
elif until_ok 180 jq -e '.state == "ready"' "$DESK_HOME/hub/memory/model.json"; then
  until_ok 120 test -s "$DESK_HOME/hub/memory/moved.json" || fail "memories never moved into the memory store"
  until_ok 60 api "$device" /api/me || fail "the hub didn't come back on the memory store"
fi

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
  say "a machine's hub serves no agents, and the Desk agent left from before is removed"
  [ ! -e "$DESK_HOME/hub/data/agents/desk" ] || fail "the Desk agent's folder is still there"
  grep -qx 'agents = false' "$DESK_HOME/hub/workforce.toml" || fail "workforce.toml doesn't say agents = false"
  ! grep -q '^\[\[agents\]\]' "$DESK_HOME/hub/workforce.toml" || fail "workforce.toml names an agent"
  agents=$(api "$admin" /api/agents)
  [ "$(jq '.agents | length' <<<"$agents")" = 0 ] || fail "the hub lists agents: $agents"
  manager=$(api "$admin" /api/desk/manager)
  [ "$(jq -r '.agentId' <<<"$manager")" = null ] || fail "a machine's sessions have an overseer: $manager"
  added=$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $admin" -X POST \
    -H 'Content-Type: application/json' -d '{"id":"scout"}' "$gateway/api/agents")
  [ "$added" = 409 ] || fail "adding an agent answered $added, not 409"

  say "a machine says its version, and its owner is the person named"
  [ "$(jq -r .version <<<"$conn")" = "$version" ] ||
    fail "connection --json says version $(jq -r .version <<<"$conn")"
  owner=$(sed -n 's/^identity_id = "\(.*\)"$/\1/p' "$DESK_HOME/hub/owner.toml")
  name=$(api "$admin" "/api/identities/$owner" | jq -r .display_name)
  [ "$name" = "Smoke Tester" ] || fail "the owner is called $name"

  say "a machine keeps its secrets in Desk's private file"
  [ -f "$DESK_HOME/machine" ] || fail "Desk's folder isn't marked a machine's"
  [ -f "$DESK_HOME/secrets.toml" ] || fail "the secrets aren't in Desk's private file"

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

  say "after this Mac's accounts are copied, a Claude session there is signed in"
  json() { api "$admin" "$1" -X "$2" -H 'Content-Type: application/json' -d "$3"; }
  signed_out() {
    api "$admin" /api/desk/engines | jq -e 'any(.[]; .engine == "claude" and .signIn.state == "out")'
  }
  until_ok 60 signed_out || fail "the hub doesn't read Claude Code as signed out: $(api "$admin" /api/desk/engines)"
  # As copying posted them before Desk made one the default: neither is.
  for name in work personal; do
    json /api/desk/accounts POST "$(jq -n --arg name "$name" \
      --arg token "sk-ant-oat01-smoke-$name-0123456789abcdefghijklmnopqrstuvwxyz" \
      '{engine: "claude", name: $name, token: $token, makeDefault: false}')" >/dev/null ||
      fail "the machine's hub didn't take the $name account"
  done
  accounts=$(api "$admin" /api/desk/accounts)
  [ "$(jq '[.accounts[] | select(.signedIn)] | length' <<<"$accounts")" = 2 ] ||
    fail "the copied accounts aren't signed in: $(jq -c '[.accounts[] | {name, signedIn, isDefault}]' <<<"$accounts")"
  work_id=$(jq -r '.accounts[] | select(.name == "work") | .id' <<<"$accounts")
  # on SESSION_BODY: starts a session, and prints the account it signed in by.
  on() {
    local s sid
    s=$(json /api/desk/sessions POST "$1") || return 1
    sid=$(jq -r '.id // empty' <<<"$s")
    [ -n "$sid" ] || fail "the session didn't start: $s"
    for _ in $(seq 30); do
      if grep -q -- "--session-id $sid " "$sessions"; then
        grep -- "--session-id $sid " "$sessions" | sed 's/.* account=//'
        return 0
      fi
      sleep 1
    done
    fail "session $sid never started: $(cat "$sessions")"
  }
  body() { jq -n --arg cwd "$work/acme-api" "{engine: \"claude\", name: \"smoke\", cwd: \$cwd $1}"; }
  # The new session dialog as it was (this computer's sign-in) and with no
  # account named: the first account, by the hub alone.
  [ "$(on "$(body ', account: null')")" = work ] || fail "a session on this computer's sign-in wasn't signed in by work: $(cat "$sessions")"
  [ "$(on "$(body '')")" = work ] || fail "a session on no account wasn't signed in by work: $(cat "$sessions")"
  # As Desk copies now: the first is the machine's default, and the dialog
  # starts on it.
  json "/api/desk/accounts/$work_id" PATCH '{"isDefault": true}' >/dev/null || fail "work couldn't be made the default"
  [ "$(on "$(body ", account: \"$work_id\"")")" = work ] || fail "a session on work wasn't signed in by it: $(cat "$sessions")"
  [ "$(on "$(body '')")" = work ] || fail "a session on the default wasn't signed in by it: $(cat "$sessions")"

  say "an earlier agent's chat sessions are planted in Postgres"
  psql=$(ls "$DESK_HOME"/hub/postgres-install/*/bin/psql | head -n 1)
  pgpw=$(sed -n 's/^hub-postgres-password = "\(.*\)"$/\1/p' "$DESK_HOME/secrets.toml")
  pgport=$(sed -n 's/^postgres = //p' "$DESK_HOME/hub/state.toml")
  sql() { PGPASSWORD="$pgpw" "$psql" -h 127.0.0.1 -p "$pgport" -U postgres -d workforce -tAX -c "$1"; }
  old=$(cat /proc/sys/kernel/random/uuid)
  sql "INSERT INTO sessions.sessions (id, agent_id, channel, owner, kind, created_at, updated_at)
       VALUES ('$old', 'desk', 'desk', 'smoke', 'main', now(), now())" >/dev/null ||
    fail "couldn't plant an old agent's session"
  sql "INSERT INTO sessions.session_archive (session_id, message_id, role, content, ts)
       VALUES ('$old', 'm1', 'user', 'what is running?', now())" >/dev/null
  sql "INSERT INTO sessions.desk_reads (owner, agent_id, channel, at, updated_at)
       VALUES ('smoke', 'desk', 'desk', now(), now())" >/dev/null
  [ "$(sql "SELECT count(*) FROM desk.sessions WHERE id = '$sid'")" = 1 ] ||
    fail "Desk doesn't keep its session $sid in its own table"
  other=$(cat /proc/sys/kernel/random/uuid)
  sql "INSERT INTO sessions.sessions (id, agent_id, channel, owner, kind, created_at, updated_at)
       VALUES ('$other', 'scout', 'desk', 'smoke', 'main', now(), now())" >/dev/null
  sql "INSERT INTO floor.gists (owner, subject, now_text, now_at, turn, by_model)
       VALUES (NULL, 'agent:desk', 'watching', now(), gen_random_uuid(), false)" >/dev/null ||
    fail "couldn't plant the earlier agent's Floor gist"
  # The first start forgot the Desk agent once (nothing of it was there) and
  # noted so; as an upgrade from an earlier version finds things, no note.
  [ -e "$DESK_HOME/hub/data/host/forgotten-agent-desk" ] || fail "the hub didn't note it forgot the Desk agent"
  rm "$DESK_HOME/hub/data/host/forgotten-agent-desk"
  # The earlier boss ran Desk's session.
  sql "INSERT INTO desk.charges (session, boss, how, since, updated_at)
       VALUES ('$sid', 'desk', 'handed', now(), now())" >/dev/null ||
    fail "couldn't plant the earlier boss's charge"

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

  say "the hub forgot the earlier agent's chat sessions, and kept Desk's own"
  pgport=$(sed -n 's/^postgres = //p' "$DESK_HOME/hub/state.toml")
  forgot() { [ "$(sql "SELECT count(*) FROM sessions.sessions WHERE agent_id = 'desk'")" = 0 ]; }
  until_ok 60 forgot || fail "the earlier agent's sessions are still there"
  [ "$(sql "SELECT count(*) FROM sessions.session_archive WHERE session_id = '$old'")" = 0 ] ||
    fail "the earlier agent's archive is still there"
  [ "$(sql "SELECT count(*) FROM sessions.desk_reads WHERE agent_id = 'desk'")" = 0 ] ||
    fail "the earlier agent's read points are still there"
  [ "$(sql "SELECT count(*) FROM desk.sessions WHERE id = '$sid'")" = 1 ] ||
    fail "Desk's own session record went with them"
  [ "$(sql "SELECT count(*) FROM sessions.sessions WHERE id = '$other'")" = 1 ] ||
    fail "another agent's session went with them"
  [ "$(sql "SELECT count(*) FROM floor.gists WHERE subject = 'agent:desk'")" = 0 ] ||
    fail "the earlier agent's Floor gist is still there"
  released() { [ "$(sql "SELECT count(*) FROM desk.charges WHERE session = '$sid' AND released_at IS NOT NULL")" = 1 ]; }
  until_ok 60 released || fail "the earlier boss still runs session $sid"
  [ -e "$DESK_HOME/hub/data/host/forgotten-agent-desk" ] || fail "the hub didn't note it forgot the Desk agent again"
  [ ! -e "$DESK_HOME/hub/memory" ] || fail "the restart made memory store data"
fi

if [ -z "$machine" ]; then
  say "this computer's hub has its Desk agent, the overseer"
  agents=$(api "$admin" /api/agents)
  jq -e 'any(.agents[]; .id == "desk")' >/dev/null <<<"$agents" || fail "the Desk agent isn't listed: $agents"
  [ -d "$DESK_HOME/hub/data/agents/desk" ] || fail "the Desk agent has no folder"
  manager=$(api "$admin" /api/desk/manager)
  [ "$(jq -r '.agentId' <<<"$manager")" = desk ] || fail "the Desk agent doesn't oversee: $manager"
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
