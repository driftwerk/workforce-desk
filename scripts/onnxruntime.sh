#!/bin/bash
# ONNX Runtime 1.28.0 for the memory store (vellev, through its `ort` crate)
# where ort's own prebuilt libraries won't do:
#   - the Linux backend for machines and WSL: ort's are built against a
#     glibc (2.38) newer than many servers have;
#   - Intel Macs: ort's cover Apple Silicon but no longer Intel.
# build-sidecars.sh links what this leaves in DIR (ORT_LIB_LOCATION).
#
#   scripts/onnxruntime.sh DIR
#
# Nothing here comes from github.com/microsoft/onnxruntime. Microsoft took
# that repository offline on 2026-11-18, hours after a malicious release of
# microsoft/agent-framework on PyPI, and until then this script cloned the
# v1.28.0 tag from it and built it. What it does instead:
#
# Linux: Microsoft's own build, from its NuGet package
# Microsoft.ML.OnnxRuntime 1.28.0 on nuget.org, pinned by sha256 below.
#   - nuget.org never lets a published version change.
#   - The package carries Microsoft Corporation's author signature and
#     nuget.org's repository countersignature. `dotnet nuget verify --all`
#     accepted both on 2026-11-19, and the sha512 matched nuget.org's catalog.
#   - Its .nuspec names the commit we used to build from source, COMMIT
#     below.
#   - It was published on 2026-07-25, four months before the incident.
#   - Its libonnxruntime.so needs glibc 2.27 at most, so the backend still
#     needs only manylinux_2_28's 2.28.
#   - It is a shared library, not the static one the source build made. The
#     memory store links it dynamically, finds it beside itself
#     (rpath $ORIGIN), and every Linux backend ships it as
#     libonnxruntime.so.1, its SONAME.
# DIR gets libonnxruntime.so.1, and libonnxruntime.so naming it for the
# linker.
#
# macOS (x86_64): Microsoft publishes no 1.28 build for Intel Macs, so this
# still builds from source. That source must now be a checkout of v1.28.0
# that ORT_SOURCE names. It is used only if it is exactly COMMIT, whole
# (git fsck) and unchanged. Where it can come from while Microsoft's
# repository is offline is the release owner's decision (docs/RELEASING.md).
# DIR/Release is what ORT_LIB_LOCATION names (about 30 to 60 minutes; CI
# caches DIR by this file's hash).
#
# The version must be the one the locked ort-sys of vellev's Cargo.lock
# links: build-sidecars.sh checks that, and says so if a vellev bump moved
# it.
set -euo pipefail

VERSION=1.28.0
# v1.28.0, as cloned when the source build was added, and as the NuGet
# package's .nuspec names it (<repository commit=...>).
COMMIT=da9b5e364c465de65c49d91e696cd6485270757f

NUGET_URL=https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/$VERSION/microsoft.ml.onnxruntime.$VERSION.nupkg
NUGET_SHA256=769d1d3ea8ab6cd69f737c9dd4d4462aa4ad0ccfa106eaf506efc40d7bead5db
# runtimes/linux-<arch>/native/libonnxruntime.so inside it.
LIB_SHA256_x86_64=1461ef7cc3d9e49982591721683cc3e3a55580aeca9a5254e7aac47b75ee4bab
LIB_SHA256_aarch64=f1ec1a08eb99bd6e5401340f0a2b101381bf4694415480291dc13bcaa30f9ec7

dir=${1:?usage: onnxruntime.sh DIR}

say() { printf '\033[1m==> %s\033[0m\n' "$*" >&2; }
die() { echo "onnxruntime.sh: $*" >&2; exit 1; }
sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

linux() {
  local arch nuget_arch want cache nupkg built tmp
  arch=$(uname -m)
  case "$arch" in
    x86_64) nuget_arch=x64 want=$LIB_SHA256_x86_64 ;;
    aarch64) nuget_arch=arm64 want=$LIB_SHA256_aarch64 ;;
    *) die "Microsoft's NuGet package has no Linux build for $arch" ;;
  esac
  built="$dir/.nuget-$NUGET_SHA256"
  if [ -f "$built" ] && [ "$(sha256 "$dir/libonnxruntime.so.1")" = "$want" ]; then
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
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN
  unzip -q -d "$tmp" "$nupkg" "runtimes/linux-$nuget_arch/native/libonnxruntime.so"
  got=$(sha256 "$tmp/runtimes/linux-$nuget_arch/native/libonnxruntime.so")
  [ "$got" = "$want" ] || die "the package's linux-$nuget_arch library is not the pinned one (sha256 $got)"
  install -m 644 "$tmp/runtimes/linux-$nuget_arch/native/libonnxruntime.so" "$dir/libonnxruntime.so.1"
  ln -s libonnxruntime.so.1 "$dir/libonnxruntime.so"
  touch "$built"
  say "ONNX Runtime $VERSION for $arch (Microsoft's NuGet build) in $dir"
}

macos() {
  local src built tools
  # The oldest macOS Desk runs on (tauri.macos.conf.json). build.py passes
  # --apple_deploy_target to CMake only for framework builds, so CMake gets
  # it too; without it everything targets the SDK's macOS.
  export MACOSX_DEPLOYMENT_TARGET=13.0
  local platform=(--osx_arch x86_64 --apple_deploy_target "$MACOSX_DEPLOYMENT_TARGET"
    --cmake_extra_defines "CMAKE_OSX_DEPLOYMENT_TARGET=$MACOSX_DEPLOYMENT_TARGET")

  # A build for another macOS is built again.
  built="$dir/.built-$COMMIT-macos$MACOSX_DEPLOYMENT_TARGET"
  if [ -f "$built" ]; then
    say "ONNX Runtime $VERSION for x86_64 already built in $dir"
    return
  fi

  src=${ORT_SOURCE:-}
  [ -n "$src" ] || die "Microsoft publishes no ONNX Runtime $VERSION for Intel Macs, so it is built from source, \
and github.com/microsoft/onnxruntime, where that source came from, has been offline since 2026-11-18. \
Set ORT_SOURCE to a checkout of v$VERSION ($COMMIT) whose origin the release owner has approved; \
it is checked against that commit (docs/RELEASING.md)."
  [ -d "$src/.git" ] || die "ORT_SOURCE ($src) is not a git checkout"
  [ "$(git -C "$src" rev-parse HEAD)" = "$COMMIT" ] || die "ORT_SOURCE ($src) is not v$VERSION ($COMMIT)"
  git -C "$src" fsck --full --no-dangling --no-progress ||
    die "ORT_SOURCE ($src) fails git fsck: its objects may not be the ones $COMMIT names"
  [ -z "$(git -C "$src" status --porcelain --untracked-files=all --ignore-submodules=all)" ] ||
    die "ORT_SOURCE ($src) has changes beside $COMMIT"

  # A build that didn't finish names tools that are gone (its CMake cache
  # holds the throwaway venv's ninja): it starts again from nothing.
  if [ -d "$dir" ]; then
    say "starting again: $dir holds a build that didn't finish"
    rm -rf "$dir"
  fi
  # Each submodule at the commit v$VERSION's tree pins, from its own project.
  git -C "$src" submodule update --quiet --init --recursive --depth 1

  # ONNX Runtime wants a newer CMake than macOS runners may have, and older
  # than 4.
  tools=$(mktemp -d)
  trap 'rm -rf "$tools"' RETURN
  python3 -m venv "$tools/venv"
  "$tools/venv/bin/pip" install --quiet "cmake>=3.28,<4" ninja

  say "building ONNX Runtime $VERSION for x86_64 (static, no tests)"
  PATH="$tools/venv/bin:$PATH" python3 "$src/tools/ci_build/build.py" \
    --build_dir "$dir" --config Release --update --build \
    --parallel --skip_tests --skip_submodule_sync --compile_no_warning_as_error \
    "${platform[@]}" --cmake_generator Ninja \
    --cmake_extra_defines onnxruntime_BUILD_UNIT_TESTS=OFF
  # ort links re2 too, which ONNX Runtime's own targets don't always build.
  PATH="$tools/venv/bin:$PATH" cmake --build "$dir/Release" --target re2
  touch "$built"
  say "ONNX Runtime $VERSION for x86_64 in $dir"
}

case "$(uname -s)" in
  Linux) linux ;;
  Darwin) macos ;;
  *) die "no ONNX Runtime build for $(uname -s)" ;;
esac
