#!/bin/bash
# Release sidecars for Desk.app: desk-hubd ("Desk Helper") and the hub
# ("Desk Agents"), built in release mode for each macOS architecture,
# stripped, and joined into universal binaries where Tauri looks for them:
#
#   src-tauri/binaries/Desk Helper-universal-apple-darwin   (the bundler)
#   src-tauri/binaries/Desk Helper-<arch>-apple-darwin      (tauri-build, per arch)
#   ...and the same for "Desk Agents".
#
# The hub is built from the commit in hub.ref, so Desk and its hub always
# ship as a matched pair.
#
#   HUB_SOURCE      a checkout of driftwerk/workforce to build as it is (CI
#                   checks hub.ref out here; in development, your own clone).
#                   Its HEAD must be hub.ref unless HUB_ANY_REF=1.
#   HUB_REPO        where to fetch hub.ref from when HUB_SOURCE is unset
#                   (default git@github.com:driftwerk/workforce.git; a local
#                   clone works too and shares its objects)
#   HUB_CACHE       where that checkout lives (default ~/Library/Caches/desk-build/hub)
#   HUB_TARGET_DIR  the hub's cargo target dir (default <hub>/target)
#   TARGETS         architectures (default "aarch64-apple-darwin x86_64-apple-darwin");
#                   one target skips the universal binary
#   MIN_FREE_GB     refuse to start with less free disk than this (default 30)
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
bin="$root/src-tauri/binaries"
ref=$(tr -d '[:space:]' < "$root/hub.ref")
targets=${TARGETS:-aarch64-apple-darwin x86_64-apple-darwin}
min_free=${MIN_FREE_GB:-30}

say() { printf '\033[1m==> %s\033[0m\n' "$*" >&2; }
die() { printf 'build-sidecars: %s\n' "$*" >&2; exit 1; }

free_gb() { df -g "$1" | awk 'NR == 2 { print $4 }'; }

# ── The hub's source at hub.ref ──────────────────────────────────────────
if [ -n "${HUB_SOURCE:-}" ]; then
  hub=$(cd "$HUB_SOURCE" && pwd)
  head=$(git -C "$hub" rev-parse HEAD)
  if [ "$head" != "$ref" ] && [ "${HUB_ANY_REF:-}" != 1 ]; then
    die "$hub is at $head, hub.ref says $ref (HUB_ANY_REF=1 builds it anyway)"
  fi
else
  hub=${HUB_CACHE:-$HOME/Library/Caches/desk-build/hub}
  repo=${HUB_REPO:-git@github.com:driftwerk/workforce.git}
  if [ ! -d "$hub/.git" ]; then
    say "cloning the hub into $hub"
    mkdir -p "$(dirname "$hub")"
    if [ -d "$repo" ]; then
      git clone --quiet --shared --no-checkout "$repo" "$hub"
    else
      git clone --quiet --filter=blob:none --no-checkout "$repo" "$hub"
    fi
  fi
  if ! git -C "$hub" cat-file -e "$ref^{commit}" 2>/dev/null; then
    say "fetching hub $ref"
    git -C "$hub" fetch --quiet "$repo" "$ref"
  fi
  git -C "$hub" -c advice.detachedHead=false checkout --quiet --force --detach "$ref"
  git -C "$hub" clean --quiet -fd -e target
fi
hub_target=${HUB_TARGET_DIR:-$hub/target}

[ "$(free_gb "$root")" -ge "$min_free" ] ||
  die "only $(free_gb "$root") GB free; a release build needs about $min_free GB (MIN_FREE_GB overrides)"

# ── Build, per architecture ──────────────────────────────────────────────
export CARGO_INCREMENTAL=0
export CARGO_PROFILE_RELEASE_DEBUG=0
desk_target=${CARGO_TARGET_DIR:-$root/target}
mkdir -p "$bin"
for t in $targets; do
  rustup target add "$t" >/dev/null
  say "desk-hubd for $t"
  cargo build --release --locked -p desk-hubd --target "$t" --manifest-path "$root/Cargo.toml"
  say "hub $ref for $t"
  CARGO_TARGET_DIR="$hub_target" cargo build --release --locked -p workforce-cli --bin workforce \
    --target "$t" --manifest-path "$hub/Cargo.toml"
  for pair in "desk-hubd:$desk_target:Desk Helper" "workforce:$hub_target:Desk Agents"; do
    IFS=: read -r name dir shipped <<<"$pair"
    out="$bin/$shipped-$t"
    rm -f "$out"
    cp "$dir/$t/release/$name" "$out"
    strip "$out"
  done
done

# ── Universal ────────────────────────────────────────────────────────────
set -- $targets
if [ $# -gt 1 ]; then
  for shipped in "Desk Helper" "Desk Agents"; do
    inputs=()
    for t in $targets; do inputs+=("$bin/$shipped-$t"); done
    rm -f "$bin/$shipped-universal-apple-darwin"
    lipo -create -output "$bin/$shipped-universal-apple-darwin" "${inputs[@]}"
    say "$(lipo -info "$bin/$shipped-universal-apple-darwin")"
  done
fi
echo "$ref" > "$bin/hub.ref"
say "sidecars ready in $bin (hub $ref)"
