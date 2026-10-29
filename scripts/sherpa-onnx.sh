#!/bin/bash
# The speech libraries desk-voice links (sherpa-onnx), made ready for a CI or
# release build that restores target/ from rust-cache.
#
# sherpa-onnx-sys's build script downloads sherpa-onnx's prebuilt static
# libraries into target/sherpa-onnx-prebuilt and links from there. Local
# builds keep doing just that. rust-cache, though, saves target/ with every
# file outside the profile directories stripped, so a restored target/ has
# that directory's skeleton without its .a files: the build script sees lib/
# there and doesn't download again, and any rebuild of sherpa-onnx-sys fails
# with "could not find native static library `sherpa-onnx-c-api`".
#
# So the workflows keep the archives the build script would download outside
# target/, in SHERPA_ONNX_ARCHIVE_DIR (cached by version), which the build
# script reads instead of the network; and before building, `prepare` removes
# the stripped directory and cleans sherpa-onnx-sys, so its build script runs
# again and unpacks them afresh.
#
#   scripts/sherpa-onnx.sh version
#       the sherpa-onnx-sys version in Cargo.lock (the workflows' cache key)
#   scripts/sherpa-onnx.sh prepare [--release] [TRIPLE...]
#       fetch any archive SHERPA_ONNX_ARCHIVE_DIR lacks for each target
#       (default: this machine's), then clear the stripped libraries and
#       sherpa-onnx-sys's build for those targets in that profile
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)

version() {
  awk '/^name = "sherpa-onnx-sys"$/ { getline; gsub(/^version = "|"$/, ""); print; exit }' "$root/Cargo.lock"
}

# The archive sherpa-onnx-sys's build script asks for when linking statically
# (archive_name() in its build.rs).
archive_for() {
  case "$1" in
    aarch64-apple-darwin) echo "sherpa-onnx-v$2-osx-arm64-static-lib.tar.bz2" ;;
    x86_64-apple-darwin) echo "sherpa-onnx-v$2-osx-x64-static-lib.tar.bz2" ;;
    *) echo "sherpa-onnx.sh: no sherpa-onnx archive known for $1" >&2; return 1 ;;
  esac
}

prepare() {
  # Explicit targets are built with --target (target/<triple>/...), none
  # means this machine's without it (target/debug or target/release).
  local clean=(cargo clean -p sherpa-onnx-sys --manifest-path "$root/Cargo.toml") targets=() t
  for arg; do
    case "$arg" in
      --release) clean+=(--release) ;;
      *) targets+=("$arg"); clean+=(--target "$arg") ;;
    esac
  done
  [ ${#targets[@]} -gt 0 ] || targets=("$(rustc -vV | sed -n 's/^host: //p')")

  local dir=${SHERPA_ONNX_ARCHIVE_DIR:?set SHERPA_ONNX_ARCHIVE_DIR to where the archives are kept}
  local v archive url
  v=$(version)
  [ -n "$v" ] || { echo "sherpa-onnx.sh: sherpa-onnx-sys isn't in Cargo.lock" >&2; exit 1; }
  mkdir -p "$dir"
  for t in "${targets[@]}"; do
    archive=$(archive_for "$t" "$v")
    if [ -f "$dir/$archive" ]; then
      echo "$archive: cached"
      continue
    fi
    url="https://github.com/k2-fsa/sherpa-onnx/releases/download/v$v/$archive"
    echo "$archive: downloading $url"
    curl -fsSL --retry 3 -o "$dir/$archive.part" "$url"
    # A truncated download must not be cached as the archive.
    tar -tjf "$dir/$archive.part" > /dev/null
    mv "$dir/$archive.part" "$dir/$archive"
  done

  local prebuilt="${CARGO_TARGET_DIR:-$root/target}/sherpa-onnx-prebuilt" lib
  if [ -d "$prebuilt" ]; then
    lib=$(find "$prebuilt" -name 'libsherpa-onnx-c-api.a' -print -quit)
    if [ -n "$lib" ]; then
      echo "target/sherpa-onnx-prebuilt: has ${lib#"$prebuilt"/}; unpacking afresh anyway"
    else
      echo "target/sherpa-onnx-prebuilt: restored without libsherpa-onnx-c-api.a; removing it"
    fi
    rm -rf "$prebuilt"
  fi

  "${clean[@]}"
}

case "${1:-}" in
  version) version ;;
  prepare) shift; prepare "$@" ;;
  *) echo "usage: $0 version | prepare [--release] [TRIPLE...]" >&2; exit 2 ;;
esac
