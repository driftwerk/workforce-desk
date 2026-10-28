#!/bin/sh
# Development sidecars: builds desk-hubd and the hub for this Mac and puts
# them where Tauri expects them, src-tauri/binaries/<name>-<target triple>,
# under the names the app bundle uses ("Desk Helper", "Desk Agents").
# Release builds use scripts/build-sidecars.sh instead.
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

target=${CARGO_TARGET_DIR:-$root/target}
mkdir -p "$root/src-tauri/binaries"
cp "$target/$profile/desk-hubd" "$root/src-tauri/binaries/Desk Helper-$triple"
cp "$repo/target/$profile/workforce" "$root/src-tauri/binaries/Desk Agents-$triple"
