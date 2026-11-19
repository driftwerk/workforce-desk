#!/bin/bash
# ONNX Runtime 1.28.0 for the Linux backend's memory store (vellev, through
# its `ort` crate), for machines and WSL: ort's own prebuilt libraries are
# built against a glibc (2.38) newer than many servers have.
# build-sidecars.sh links what this leaves in DIR (ORT_LIB_LOCATION).
#
#   scripts/onnxruntime.sh DIR [ARCH]    on Linux, provide it in DIR, for
#                                        ARCH (x86_64 or aarch64; default
#                                        this machine's)
#   scripts/onnxruntime.sh check FILE ARCH
#                                        fail unless FILE is the pinned Linux
#                                        library for ARCH
#
# Nothing here comes from github.com/microsoft/onnxruntime. Microsoft took
# that repository offline on 2026-11-18, hours after a malicious release of
# microsoft/agent-framework on PyPI, and until then this script cloned the
# v1.28.0 tag from it and built it, for Linux and Intel Macs. What it does
# now is use Microsoft's own build, from its NuGet package
# Microsoft.ML.OnnxRuntime 1.28.0 on nuget.org, pinned by sha256 below.
#   - nuget.org never lets a published version change.
#   - The package carries Microsoft Corporation's author signature and
#     nuget.org's repository countersignature. `dotnet nuget verify --all`
#     accepted both on 2026-11-19. The author certificate expired on
#     2026-10-17, so the signature stands on its timestamp, 2026-07-25.
#   - Its sha512 matched nuget.org's catalog.
#   - Its .nuspec names the commit we used to build from source, COMMIT
#     in onnxruntime.pin.
#   - It was published on 2026-07-25, four months before the incident.
#   - Its libonnxruntime.so needs glibc 2.27 at most, so the backend still
#     needs only manylinux_2_28's 2.28.
#   - It is a shared library, not the static one the source build made. The
#     memory store links it dynamically, finds it beside itself
#     (rpath $ORIGIN), and every Linux backend ships it as
#     libonnxruntime.so.1, its SONAME. Each place that ships it checks it
#     again (`check`).
# DIR gets libonnxruntime.so.1, and libonnxruntime.so naming it for the
# linker.
#
# Intel Macs, which Microsoft publishes no 1.28 build for, can't have one
# built while its source is offline: their memory store is Desk 0.2.10's,
# pinned (scripts/intel-memory.sh).
#
# The version must be the one the locked ort-sys of vellev's Cargo.lock
# links: build-sidecars.sh checks that, and says so if a vellev bump moved
# it.
set -euo pipefail

# VERSION and COMMIT.
. "$(dirname "$0")/onnxruntime.pin"

NUGET_URL=https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/$VERSION/microsoft.ml.onnxruntime.$VERSION.nupkg
NUGET_SHA256=769d1d3ea8ab6cd69f737c9dd4d4462aa4ad0ccfa106eaf506efc40d7bead5db
# runtimes/linux-<arch>/native/libonnxruntime.so inside it.
LIB_SHA256_x86_64=1461ef7cc3d9e49982591721683cc3e3a55580aeca9a5254e7aac47b75ee4bab
LIB_SHA256_aarch64=f1ec1a08eb99bd6e5401340f0a2b101381bf4694415480291dc13bcaa30f9ec7

say() { printf '\033[1m==> %s\033[0m\n' "$*" >&2; }
die() { echo "onnxruntime.sh: $*" >&2; exit 1; }
sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}
work=
trap '[ -z "$work" ] || rm -rf "$work"' EXIT

pinned_sha() {
  case "$1" in
    x86_64) echo "$LIB_SHA256_x86_64" ;;
    aarch64) echo "$LIB_SHA256_aarch64" ;;
    *) die "Microsoft's NuGet package has no Linux build for $1" ;;
  esac
}

check() {
  local file=$1 arch=$2 got
  [ -f "$file" ] || die "no $file"
  got=$(sha256 "$file")
  [ "$got" = "$(pinned_sha "$arch")" ] ||
    die "$file is not the pinned ONNX Runtime $VERSION for $arch (sha256 $got)"
}

linux() {
  local arch=$1 nuget_arch want cache nupkg got
  want=$(pinned_sha "$arch")
  case "$arch" in x86_64) nuget_arch=x64 ;; aarch64) nuget_arch=arm64 ;; esac
  if [ -f "$dir/.nuget-$NUGET_SHA256" ] && [ -f "$dir/libonnxruntime.so.1" ] &&
    [ "$(sha256 "$dir/libonnxruntime.so.1")" = "$want" ] &&
    [ "$(readlink "$dir/libonnxruntime.so")" = libonnxruntime.so.1 ]; then
    say "ONNX Runtime $VERSION for $arch already in $dir"
    return
  fi
  rm -rf "$dir"
  mkdir -p "$dir"

  # The package is kept between runs, and checked again each time.
  cache=${XDG_CACHE_HOME:-$HOME/.cache}/desk-build
  nupkg="$cache/microsoft.ml.onnxruntime.$VERSION.nupkg"
  mkdir -p "$cache"
  if [ ! -f "$nupkg" ] || [ "$(sha256 "$nupkg")" != "$NUGET_SHA256" ]; then
    say "fetching Microsoft.ML.OnnxRuntime $VERSION from nuget.org"
    curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$nupkg.partial" "$NUGET_URL"
    got=$(sha256 "$nupkg.partial")
    [ "$got" = "$NUGET_SHA256" ] || {
      rm -f "$nupkg.partial"
      die "$NUGET_URL is not the pinned package (sha256 $got, pinned $NUGET_SHA256)"
    }
    mv "$nupkg.partial" "$nupkg"
  fi

  # Only the library, by its exact name in the package.
  work=$(mktemp -d)
  unzip -q -d "$work" "$nupkg" "runtimes/linux-$nuget_arch/native/libonnxruntime.so"
  check "$work/runtimes/linux-$nuget_arch/native/libonnxruntime.so" "$arch"
  install -m 644 "$work/runtimes/linux-$nuget_arch/native/libonnxruntime.so" "$dir/libonnxruntime.so.1"
  ln -s libonnxruntime.so.1 "$dir/libonnxruntime.so"
  touch "$dir/.nuget-$NUGET_SHA256"
  say "ONNX Runtime $VERSION for $arch (Microsoft's NuGet build) in $dir"
}

if [ "${1:-}" = check ]; then
  [ $# -eq 3 ] || die "usage: onnxruntime.sh check FILE ARCH"
  check "$2" "$3"
  exit 0
fi
dir=${1:?usage: onnxruntime.sh DIR [ARCH] | check FILE ARCH}
case "$(uname -s)" in
  Linux) linux "${2:-$(uname -m)}" ;;
  *) die "no ONNX Runtime build for $(uname -s)" ;;
esac
