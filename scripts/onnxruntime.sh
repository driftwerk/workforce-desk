#!/bin/bash
# ONNX Runtime built from source, which the memory store (vellev) links
# statically through its `ort` crate where ort's own prebuilt libraries
# won't do:
#   - Intel Macs: ort's cover Apple Silicon but no longer Intel, and
#     Microsoft's last Intel build (1.23) is older than the version `ort`
#     needs;
#   - the Linux backend for machines and WSL: ort's are built against a
#     glibc (2.38) newer than many servers have, so the backend builds its
#     own against the glibc it is built on (manylinux_2_28's 2.28).
# build-sidecars.sh links this build instead (ORT_LIB_LOCATION).
#
#   scripts/onnxruntime.sh DIR
#
# Builds the pinned release for this machine (on macOS, for x86_64) into DIR
# (about 30 to 60 minutes; CI caches DIR by the pin). DIR/Release is then
# what ORT_LIB_LOCATION names. The version must be the one the locked
# ort-sys of vellev's Cargo.lock downloads: build-sidecars.sh checks that and
# says so if a vellev bump moved it.
set -euo pipefail

VERSION=1.28.0
COMMIT=da9b5e364c465de65c49d91e696cd6485270757f

dir=${1:?usage: onnxruntime.sh DIR}
case "$(uname -s)" in
  Darwin)
    arch=x86_64
    platform=(--osx_arch x86_64 --apple_deploy_target 13.0)
    cache=$HOME/Library/Caches/desk-build
    ;;
  *)
    arch=$(uname -m)
    platform=()
    cache=${XDG_CACHE_HOME:-$HOME/.cache}/desk-build
    ;;
esac
src=${ORT_SOURCE_CACHE:-$cache/onnxruntime-$VERSION}
# A build container (the release's backend job) runs as root.
[ "$(id -u)" != 0 ] || platform+=(--allow_running_as_root)

say() { printf '\033[1m==> %s\033[0m\n' "$*" >&2; }

if [ -f "$dir/.built-$COMMIT" ]; then
  say "ONNX Runtime $VERSION for $arch already built in $dir"
  exit 0
fi

if [ ! -d "$src/.git" ]; then
  say "fetching ONNX Runtime $VERSION"
  mkdir -p "$(dirname "$src")"
  git clone --quiet --depth 1 --branch "v$VERSION" https://github.com/microsoft/onnxruntime.git "$src"
fi
[ "$(git -C "$src" rev-parse HEAD)" = "$COMMIT" ] ||
  { echo "onnxruntime.sh: $src is not v$VERSION ($COMMIT)" >&2; exit 1; }
git -C "$src" submodule update --quiet --init --recursive --depth 1

# ONNX Runtime wants a newer CMake than macOS runners may have, and older
# than 4.
tools=$(mktemp -d)
trap 'rm -rf "$tools"' EXIT
python3 -m venv "$tools/venv"
"$tools/venv/bin/pip" install --quiet "cmake>=3.28,<4" ninja

say "building ONNX Runtime $VERSION for $arch (static, no tests)"
PATH="$tools/venv/bin:$PATH" python3 "$src/tools/ci_build/build.py" \
  --build_dir "$dir" --config Release --update --build \
  --parallel --skip_tests --skip_submodule_sync --compile_no_warning_as_error \
  "${platform[@]}" --cmake_generator Ninja \
  --cmake_extra_defines onnxruntime_BUILD_UNIT_TESTS=OFF
# ort links re2 too, which ONNX Runtime's own targets don't always build.
PATH="$tools/venv/bin:$PATH" cmake --build "$dir/Release" --target re2
touch "$dir/.built-$COMMIT"
say "ONNX Runtime $VERSION for $arch in $dir"
