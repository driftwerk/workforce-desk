#!/bin/sh
# Puts desk-hubd and the workforce hub where Tauri expects its sidecars:
# src-tauri/binaries/<name>-<target triple>.
#   WORKFORCE_REPO  workforce-public checkout to build the hub from
#   PROFILE         debug (default) or release
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
profile=${PROFILE:-debug}
flag=$([ "$profile" = release ] && echo --release || true)
triple=$(rustc -vV | sed -n 's/^host: //p')
repo=${WORKFORCE_REPO:?set WORKFORCE_REPO to a workforce-public checkout}

cargo build $flag -p desk-hubd --manifest-path "$root/Cargo.toml"
cargo build $flag -p workforce-cli --bin workforce --manifest-path "$repo/Cargo.toml"

mkdir -p "$root/src-tauri/binaries"
cp "$root/target/$profile/desk-hubd" "$root/src-tauri/binaries/desk-hubd-$triple"
cp "$repo/target/$profile/workforce" "$root/src-tauri/binaries/workforce-$triple"
