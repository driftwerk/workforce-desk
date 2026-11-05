#!/bin/bash
# The Linux backend as a release asset for machines (Linux boxes Desk drives
# over SSH): a tarball of one backend folder, signed with the updater key.
#
#   scripts/backend-tarball.sh DIR ARCH VERSION OUT
#
# DIR holds desk-helper, desk-agents, desk-memory and claude-plugin/ (a
# backend-linux-ARCH artifact). Writes OUT/desk-backend-linux-ARCH-VERSION.tar.gz
# with those four at its top and no folder around them, which is how a
# machine unpacks it, and, when TAURI_SIGNING_PRIVATE_KEY is set, its .sig
# from `tauri signer sign` (TAURI_SIGNING_PRIVATE_KEY_PASSWORD too), which
# Desk checks against plugins.updater.pubkey before anything leaves the Mac.
# TAURI names the Tauri CLI to sign with (default: the version in
# package-lock.json, through npx).
set -euo pipefail

dir=$(cd "${1:?usage: $0 DIR ARCH VERSION OUT}" && pwd)
arch=${2:?usage: $0 DIR ARCH VERSION OUT}
version=${3:?usage: $0 DIR ARCH VERSION OUT}
out=${4:?usage: $0 DIR ARCH VERSION OUT}
root=$(cd "$(dirname "$0")/.." && pwd)

die() { printf 'backend-tarball: %s\n' "$*" >&2; exit 1; }
case "$arch" in x86_64 | aarch64) ;; *) die "no backend for $arch" ;; esac
case "$version" in *[!0-9A-Za-z.+-]* | "" | .* | *..*) die "$version isn't a version" ;; esac

# Each program, for its architecture (an ELF's e_machine: 62 x86_64, 183 aarch64).
want=$([ "$arch" = x86_64 ] && echo 62 || echo 183)
for name in desk-helper desk-agents desk-memory; do
  [ -f "$dir/$name" ] || die "$dir has no $name"
  machine=$(od -An -tu2 -j18 -N2 "$dir/$name" | tr -d ' ')
  [ "$machine" = "$want" ] || die "$dir/$name isn't built for $arch"
  chmod 755 "$dir/$name"
done
[ -d "$dir/claude-plugin" ] || die "$dir has no claude-plugin"

mkdir -p "$out"
tarball="$out/desk-backend-linux-$arch-$version.tar.gz"
tar -czf "$tarball" --owner=0 --group=0 --numeric-owner -C "$dir" \
  desk-helper desk-agents desk-memory claude-plugin
echo "$tarball"

if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  if [ -z "${TAURI:-}" ]; then
    cli=$(sed -n '/"node_modules\/@tauri-apps\/cli"/,/"version"/s/.*"version": "\(.*\)".*/\1/p' \
      "$root/package-lock.json")
    [ -n "$cli" ] || die "no @tauri-apps/cli version in package-lock.json"
    TAURI="npx --yes @tauri-apps/cli@$cli"
  fi
  $TAURI signer sign "$tarball" >/dev/null
  [ -s "$tarball.sig" ] || die "signing $tarball wrote no signature"
  echo "$tarball.sig"
fi
