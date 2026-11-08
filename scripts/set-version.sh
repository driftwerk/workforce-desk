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
# jq where there is one; else Python, which the release's Linux build
# containers (manylinux) carry under /opt/python while having no jq.
python=$(command -v python3 || ls /opt/python/cp3*/bin/python3 2>/dev/null | tail -1 || true)
for file in src-tauri/tauri.conf.json package.json; do
  if command -v jq >/dev/null; then
    jq --arg v "$version" '.version = $v' "$file" > "$file.tmp"
  elif [[ -n $python ]]; then
    "$python" - "$file" "$version" > "$file.tmp" <<'PY'
import json, sys
path, version = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
data["version"] = version
json.dump(data, sys.stdout, indent=2, ensure_ascii=False)
sys.stdout.write("\n")
PY
  else
    echo "set-version: needs jq or python3 to write $file" >&2
    exit 1
  fi
  mv "$file.tmp" "$file"
done
sed -i.bak "/^\[workspace.package\]/,/^\[/ s/^version = \".*\"/version = \"$version\"/" Cargo.toml
rm Cargo.toml.bak
grep -A2 '^\[workspace.package\]' Cargo.toml
cargo update --workspace
