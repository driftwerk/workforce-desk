#!/usr/bin/env bash
# Runs desk-machine's real-sshd test (crates/desk-machine/tests/real_sshd.rs):
# sshds in Docker (password, keyboard-interactive, keys only, and one behind
# a jump host that asks for its own password), an SSH config for them, and
# the system's ssh pointed at it. Linux with Docker; nothing outside a
# temporary folder and the containers it starts (removed after).
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
dir=$(mktemp -d)
net=desk-real-sshd-$$
cleanup() { docker rm -f "$net-pw" "$net-kbd" "$net-keys" "$net-jump" "$net-inner" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; rm -rf "$dir"; }
trap cleanup EXIT

image=desk-real-sshd:1
if ! docker image inspect "$image" >/dev/null 2>&1; then
  docker build -q -t "$image" - <<'DOCKER' >/dev/null
FROM ubuntu:24.04
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server sudo >/dev/null \
 && mkdir -p /run/sshd \
 && useradd -m -s /bin/bash dev && echo 'dev:pw-target' | chpasswd \
 && useradd -m -s /bin/bash jumper && echo 'jumper:pw-jump' | chpasswd
CMD ["/usr/sbin/sshd", "-D", "-e"]
DOCKER
fi
docker network create "$net" >/dev/null
start() { # name, port, sshd options…
  local name=$1 port=$2; shift 2
  docker run -d --name "$net-$name" --network "$net" --network-alias "$name" -p "127.0.0.1:$port:22" "$image" /usr/sbin/sshd -D -e "$@" >/dev/null
}
start pw 0 -o PasswordAuthentication=yes -o KbdInteractiveAuthentication=no -o UsePAM=no
start kbd 0 -o PasswordAuthentication=no -o KbdInteractiveAuthentication=yes -o UsePAM=yes
start keys 0 -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no
start jump 0 -o PasswordAuthentication=yes -o KbdInteractiveAuthentication=no -o UsePAM=no -o AllowTcpForwarding=yes
start inner 0 -o PasswordAuthentication=yes -o KbdInteractiveAuthentication=no -o UsePAM=no
port() { docker port "$net-$1" 22/tcp | head -n 1 | sed 's/.*://'; }
sleep 2
known="$dir/known_hosts"
for n in pw kbd keys jump; do ssh-keyscan -t ed25519 -p "$(port "$n")" 127.0.0.1 2>/dev/null | sed "s/^\[127.0.0.1\]:[0-9]*/[127.0.0.1]:$(port "$n")/" >> "$known"; done
# The machine behind the jump host, as the jump host sees it.
inner_key=$(docker exec "$net-inner" cat /etc/ssh/ssh_host_ed25519_key.pub | cut -d' ' -f1,2)
echo "inner $inner_key" >> "$known"
# The aliased machine is the pw one, known by its alias.
pw_key=$(docker exec "$net-pw" cat /etc/ssh/ssh_host_ed25519_key.pub | cut -d' ' -f1,2)
echo "pw-alias $pw_key" >> "$known"
cat > "$dir/config" <<CFG
Host *
  UserKnownHostsFile $known
  IdentitiesOnly yes
  IdentityFile /dev/null
Host pw
  HostName 127.0.0.1
  Port $(port pw)
  User dev
Host kbd
  HostName 127.0.0.1
  Port $(port kbd)
  User dev
Host keys
  HostName 127.0.0.1
  Port $(port keys)
  User dev
Host alias
  HostName 127.0.0.1
  Port $(port pw)
  User dev
  HostKeyAlias pw-alias
Host jumphost
  HostName 127.0.0.1
  Port $(port jump)
  User jumper
Host behind
  HostName inner
  User dev
  ProxyJump jumphost
CFG
printf '#!/bin/sh\nexec /usr/bin/ssh -F %s "$@"\n' "$dir/config" > "$dir/ssh"
chmod +x "$dir/ssh"
# A ProxyJump's own ssh is run as "ssh" from PATH, with the config too.
mkdir -p "$dir/bin" && ln -s "$dir/ssh" "$dir/bin/ssh"
cd "$here"
PATH="$dir/bin:$PATH" DESK_REAL_SSHD="$dir" cargo test -p desk-machine --test real_sshd -- --ignored --nocapture
