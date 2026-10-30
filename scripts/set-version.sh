#!/bin/bash
# Sets Desk's version everywhere it is written: tauri.conf.json, package.json
# and the workspace version every crate inherits. Then refreshes the
# workspace's own entries in Cargo.lock, so --locked builds still pin every
# dependency. Runs with BSD or GNU sed.
#
#   scripts/set-version.sh VERSION
set -euo pipefail

version=${1:?usage: $0 VERSION}
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
for file in src-tauri/tauri.conf.json package.json; do
  jq --arg v "$version" '.version = $v' "$file" > "$file.tmp"
  mv "$file.tmp" "$file"
done
sed -i.bak "/^\[workspace.package\]/,/^\[/ s/^version = \".*\"/version = \"$version\"/" Cargo.toml
rm Cargo.toml.bak
grep -A2 '^\[workspace.package\]' Cargo.toml
cargo update --workspace
