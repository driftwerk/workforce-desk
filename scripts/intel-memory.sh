#!/bin/bash
# The memory store for Intel Macs (vellev for x86_64-apple-darwin), which
# build-sidecars.sh uses in place of building it while ONNX Runtime's source
# is unavailable:
#
#   scripts/intel-memory.sh FILE
#
# Puts the pinned binary at FILE, checked. Fails, saying why, when
# vellev.ref is not the vellev it was built from.
#
# Why: vellev links ONNX Runtime 1.28 statically. Microsoft publishes no
# 1.28 build for Intel Macs, so Desk built it from source, and that source
# was github.com/microsoft/onnxruntime, offline since 2026-11-18 (see
# onnxruntime.sh and docs/RELEASING.md). No ONNX Runtime library of ours
# survived, but the memory store linked against it did: inside the signed,
# notarized Desk.app of Desk 0.2.10.
#
# What it is: the x86_64 slice (lipo -thin x86_64) of
# Desk.app/Contents/MacOS/Desk Memory in Desk 0.2.10.
#   - Release asset v0.2.10/Desk.app.tar.gz: sha256 16e92f85…3c14 (GitHub's
#     asset digest agrees). Its minisign signature verified with the
#     updater key in src-tauri/tauri.conf.json (key 05099F6A3498F3E1).
#   - The app passed codesign --verify --strict --deep, and spctl accepted
#     it ("Notarized Developer ID").
#   - The slice keeps its own signature (Developer ID, team CHA3FP8ENJ,
#     2026-11-17 12:00:06) and targets macOS 13.0.
#   - The Release run that built it is
#     https://github.com/driftwerk/workforce-desk/actions/runs/44073317561
#     (tag v0.2.10 at 64a7e561, on 2026-11-17, before the takedown). It
#     built vellev c68c9736 for x86_64-apple-darwin, linking ONNX Runtime
#     1.28.0, cloned that day and checked against commit da9b5e36… by
#     onnxruntime.sh.
#   - Checked on 2026-11-19, then hosted as an asset of the pre-release
#     deps-intel-memory-vellev-c68c9736 on driftwerk/workforce-desk. That
#     pre-release is not a Desk release, is never the latest, and holds
#     PROVENANCE.txt too.
set -euo pipefail

VELLEV=c68c9736c99e96d5651b1b9d0a3e3d1a940cae6e
URL=https://github.com/driftwerk/workforce-desk/releases/download/deps-intel-memory-vellev-c68c9736/desk-memory-x86_64-apple-darwin
SHA256=b4fdbcbbdbcebf498dc46e043a6c037a770f47e24890241bf2e36da3ea43ffb7
TEAM=CHA3FP8ENJ
MIN_MACOS=13.0

root=$(cd "$(dirname "$0")/.." && pwd)
file=${1:?usage: intel-memory.sh FILE}

say() { printf '\033[1m==> %s\033[0m\n' "$*" >&2; }
die() { echo "intel-memory.sh: $*" >&2; exit 1; }

ref=$(tr -d '[:space:]' < "$root/vellev.ref")
[ "$ref" = "$VELLEV" ] || die "vellev.ref is $ref, but the only Intel Mac memory store Desk can ship is vellev $VELLEV's: \
building another needs ONNX Runtime 1.28's source, unavailable since github.com/microsoft/onnxruntime went offline \
(docs/RELEASING.md, ONNX Runtime). Keep vellev.ref at $VELLEV, or settle where that source comes from first."

cache=$HOME/Library/Caches/desk-build
kept="$cache/desk-memory-x86_64-apple-darwin-$SHA256"
mkdir -p "$cache"
if [ ! -f "$kept" ] || [ "$(shasum -a 256 "$kept" | cut -d' ' -f1)" != "$SHA256" ]; then
  say "fetching the Intel memory store (vellev ${VELLEV:0:8}, from Desk 0.2.10)"
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$kept.partial" "$URL"
  got=$(shasum -a 256 "$kept.partial" | cut -d' ' -f1)
  [ "$got" = "$SHA256" ] || { rm -f "$kept.partial"; die "$URL is not the pinned binary (sha256 $got)"; }
  mv "$kept.partial" "$kept"
fi

# What the pin already says, checked again where the tools are: one x86_64
# program, signed by Desk's Developer ID, for Desk's oldest macOS.
[ "$(lipo -archs "$kept")" = x86_64 ] || die "$kept is not one x86_64 program"
codesign --verify --strict "$kept" || die "$kept's signature doesn't verify"
team=$(codesign -dvv "$kept" 2>&1 | sed -n 's/^TeamIdentifier=//p')
[ "$team" = "$TEAM" ] || die "$kept is signed by team '$team', not $TEAM"
minos=$(otool -l "$kept" | awk '$1 == "minos" { print $2; exit }')
[ "$minos" = "$MIN_MACOS" ] || die "$kept targets macOS $minos, not $MIN_MACOS"

rm -f "$file"
install -m 755 "$kept" "$file"
say "the Intel memory store (vellev ${VELLEV:0:8}, from Desk 0.2.10) in $file"
