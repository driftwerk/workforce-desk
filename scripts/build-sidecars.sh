#!/bin/bash
# Release sidecars for Desk: desk-hubd (Desk Helper), the hub and its
# memory store, vellev, built in release mode for each target, stripped, and
# put where Tauri looks for them under each system's names. On macOS
# ("Desk Helper", "Desk Agents", "Desk Memory") they are also joined into
# universal binaries:
#
#   src-tauri/binaries/Desk Helper-universal-apple-darwin   (the bundler)
#   src-tauri/binaries/Desk Helper-<arch>-apple-darwin      (tauri-build, per arch)
#
# On Linux (desk-helper, desk-agents, desk-memory) there is one target:
#
#   src-tauri/binaries/desk-helper-x86_64-unknown-linux-gnu
#
# The hub is built from the commit in hub.ref and vellev from the one in
# vellev.ref, so Desk ships with the hub and store it was tested with.
#
#   HUB_SOURCE      a checkout of driftwerk/workforce to build as it is (CI
#                   checks hub.ref out here; in development, your own clone).
#                   Its HEAD must be hub.ref unless HUB_ANY_REF=1.
#   HUB_REPO        where to fetch hub.ref from when HUB_SOURCE is unset
#                   (default git@github.com:driftwerk/workforce.git; a local
#                   clone works too and shares its objects)
#   HUB_CACHE       where that checkout lives (default <cache>/desk-build/hub, the
#                   cache being ~/Library/Caches on macOS, $XDG_CACHE_HOME or
#                   ~/.cache on Linux)
#   HUB_TARGET_DIR  the hub's cargo target dir (default <hub>/target)
#   VELLEV_SOURCE, VELLEV_ANY_REF, VELLEV_REPO, VELLEV_CACHE, VELLEV_TARGET_DIR
#                   the same for vellev and vellev.ref (VELLEV_REPO defaults
#                   to https://github.com/driftwerk/vellev.git)
#   ORT_X86_64      ONNX Runtime built for Intel Macs by
#                   scripts/onnxruntime.sh (its DIR), which vellev links for
#                   x86_64-apple-darwin; built there when unset
#   ORT_FROM_SOURCE on Linux, 1 links ONNX Runtime built here by
#                   scripts/onnxruntime.sh (in ORT_DIR, default
#                   <cache>/onnxruntime-<arch>) instead of ort's own, which
#                   needs glibc 2.38: the backend for machines and WSL
#   POSTGRES_ARCHIVE on Linux, the Postgres scripts/postgres-linux.sh built
#                   (its .tar.gz), for desk-hubd to embed instead of
#                   theseus-rs' build, which needs glibc 2.36: the backend
#                   for machines and WSL. It replaces the download
#                   postgresql_embedded keeps in ~/.theseus/postgresql.
#   TARGETS         targets (default "aarch64-apple-darwin x86_64-apple-darwin" on
#                   macOS, this machine's elsewhere); one target skips the
#                   universal binary
#   MIN_FREE_GB     refuse to start with less free disk than this (default 30)
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
bin="$root/src-tauri/binaries"
ref=$(tr -d '[:space:]' < "$root/hub.ref")
vellev_ref=$(tr -d '[:space:]' < "$root/vellev.ref")
case "$(uname -s)" in
  Darwin)
    targets=${TARGETS:-aarch64-apple-darwin x86_64-apple-darwin}
    cache=$HOME/Library/Caches/desk-build
    names=("Desk Helper" "Desk Agents" "Desk Memory")
    ;;
  Linux)
    targets=${TARGETS:-$(rustc -vV | sed -n 's/^host: //p')}
    cache=${XDG_CACHE_HOME:-$HOME/.cache}/desk-build
    names=(desk-helper desk-agents desk-memory)
    ;;
  *) printf 'build-sidecars: builds on macOS and Linux (Windows ships the Linux backend)\n' >&2; exit 1 ;;
esac
min_free=${MIN_FREE_GB:-30}

say() { printf '\033[1m==> %s\033[0m\n' "$*" >&2; }
die() { printf 'build-sidecars: %s\n' "$*" >&2; exit 1; }

# Free gigabytes, read the same way from BSD and GNU df.
free_gb() { df -Pk "$1" | awk 'NR == 2 { print int($4 / 1048576) }'; }

# ── Sources at their refs ────────────────────────────────────────────────
# checkout NAME REF SOURCE ANY_REF REPO CACHE: prints the checkout's path.
checkout() {
  local name=$1 want=$2 source=$3 any=$4 repo=$5 cache=$6 dir head
  if [ -n "$source" ]; then
    dir=$(cd "$source" && pwd)
    head=$(git -C "$dir" rev-parse HEAD)
    if [ "$head" != "$want" ] && [ "$any" != 1 ]; then
      die "$dir is at $head, $name.ref says $want ($(echo "$name" | tr a-z A-Z)_ANY_REF=1 builds it anyway)"
    fi
  else
    dir=$cache
    if [ ! -d "$dir/.git" ]; then
      say "cloning $name into $dir"
      mkdir -p "$(dirname "$dir")"
      if [ -d "$repo" ]; then
        git clone --quiet --shared --no-checkout "$repo" "$dir"
      else
        git clone --quiet --filter=blob:none --no-checkout "$repo" "$dir"
      fi
    fi
    if ! git -C "$dir" cat-file -e "$want^{commit}" 2>/dev/null; then
      say "fetching $name $want"
      git -C "$dir" fetch --quiet "$repo" "$want"
    fi
    git -C "$dir" -c advice.detachedHead=false checkout --quiet --force --detach "$want"
    git -C "$dir" clean --quiet -fd -e target
  fi
  echo "$dir"
}
hub=$(checkout hub "$ref" "${HUB_SOURCE:-}" "${HUB_ANY_REF:-}" \
  "${HUB_REPO:-git@github.com:driftwerk/workforce.git}" "${HUB_CACHE:-$cache/hub}")
vellev=$(checkout vellev "$vellev_ref" "${VELLEV_SOURCE:-}" "${VELLEV_ANY_REF:-}" \
  "${VELLEV_REPO:-https://github.com/driftwerk/vellev.git}" "${VELLEV_CACHE:-$cache/vellev}")
hub_target=${HUB_TARGET_DIR:-$hub/target}
vellev_target=${VELLEV_TARGET_DIR:-$vellev/target}

# vellev's ort links ONNX Runtime 1.28's static library: ort's own build
# for Apple Silicon, and ours for Intel (it has none) and, with
# ORT_FROM_SOURCE, for Linux. A vellev.ref whose ort wants another version
# needs onnxruntime.sh's pin moved too.
case " $targets ${ORT_FROM_SOURCE:+from-source} " in
  *" x86_64-apple-darwin "* | *" from-source "*)
    ort_sys=$(awk '/^name = "ort-sys"$/ { getline; print $3 }' "$vellev/Cargo.lock" | tr -d '"')
    [ "$ort_sys" = "2.0.0-rc.13" ] ||
      die "vellev.ref locks ort-sys $ort_sys; onnxruntime.sh builds the ONNX Runtime 2.0.0-rc.13 links (1.28.0): move its pin"
    ;;
esac

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
  if [ -n "${POSTGRES_ARCHIVE:-}" ]; then
    # postgresql_embedded bundles the archive it finds there for the pinned
    # version, and keeps the one it bundled last until its build runs again.
    pg_version=$(sed -n 's/^POSTGRESQL_VERSION = "=\(.*\)"$/\1/p' "$root/.cargo/config.toml")
    pg_cached="$HOME/.theseus/postgresql/postgresql-$pg_version-$t.tar.gz"
    [ "$(basename "$POSTGRES_ARCHIVE")" = "$(basename "$pg_cached")" ] ||
      die "POSTGRES_ARCHIVE is $POSTGRES_ARCHIVE; desk-hubd for $t embeds $(basename "$pg_cached")"
    mkdir -p "$(dirname "$pg_cached")"
    cp "$POSTGRES_ARCHIVE" "$pg_cached"
    cargo clean --release --quiet -p postgresql_embedded --target "$t" --manifest-path "$root/Cargo.toml"
  fi
  cargo build --release --locked -p desk-hubd --target "$t" --manifest-path "$root/Cargo.toml"
  if [ -n "${POSTGRES_ARCHIVE:-}" ]; then
    bundled=("$desk_target/$t/release/build"/postgresql_embedded-*/out/postgresql.tar.gz)
    [ -f "${bundled[0]}" ] || die "desk-hubd for $t bundled no Postgres"
    for f in "${bundled[@]}"; do
      cmp -s "$f" "$POSTGRES_ARCHIVE" || die "desk-hubd for $t bundled $f, not $POSTGRES_ARCHIVE"
    done
    say "desk-hubd for $t embeds $(basename "$POSTGRES_ARCHIVE")"
  fi
  say "hub $ref for $t"
  CARGO_TARGET_DIR="$hub_target" cargo build --release --locked -p workforce-cli --bin workforce \
    --target "$t" --manifest-path "$hub/Cargo.toml"
  say "vellev $vellev_ref for $t"
  # From its own folder, so its rust-toolchain.toml is the toolchain.
  (
    cd "$vellev"
    rustup target add "$t" >/dev/null
    if [ "$t" = x86_64-apple-darwin ]; then
      ort=${ORT_X86_64:-$cache/onnxruntime-x86_64}
      "$root/scripts/onnxruntime.sh" "$ort"
      export ORT_LIB_LOCATION="$ort/Release" ORT_SKIP_DOWNLOAD=1
    elif [ "${ORT_FROM_SOURCE:-}" = 1 ]; then
      ort=${ORT_DIR:-$cache/onnxruntime-${t%%-*}}
      "$root/scripts/onnxruntime.sh" "$ort"
      export ORT_LIB_LOCATION="$ort/Release" ORT_SKIP_DOWNLOAD=1
      # ONNX Runtime 1.28's model packages are a library of their own, which
      # this ort doesn't link.
      export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=$ort/Release/model_package/libmodel_package.a"
    fi
    CARGO_TARGET_DIR="$vellev_target" cargo build --release --locked -p vellev --target "$t"
  )
  for pair in "desk-hubd:$desk_target:${names[0]}" "workforce:$hub_target:${names[1]}" \
    "vellev:$vellev_target:${names[2]}"; do
    IFS=: read -r name dir shipped <<<"$pair"
    out="$bin/$shipped-$t"
    rm -f "$out"
    cp "$dir/$t/release/$name" "$out"
    strip "$out"
  done
done

# ── Universal (macOS) ────────────────────────────────────────────────────
set -- $targets
if [ $# -gt 1 ]; then
  for shipped in "${names[@]}"; do
    inputs=()
    for t in $targets; do inputs+=("$bin/$shipped-$t"); done
    rm -f "$bin/$shipped-universal-apple-darwin"
    lipo -create -output "$bin/$shipped-universal-apple-darwin" "${inputs[@]}"
    say "$(lipo -info "$bin/$shipped-universal-apple-darwin")"
  done
fi
echo "$ref" > "$bin/hub.ref"
echo "$vellev_ref" > "$bin/vellev.ref"
say "sidecars ready in $bin (hub $ref, vellev $vellev_ref)"
