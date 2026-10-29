#!/bin/bash
# ONNX Runtime for Intel Macs, built from source: the memory store (vellev)
# embeds on this Mac with ONNX Runtime, which its `ort` crate links
# statically. ort's own prebuilt libraries cover Apple Silicon but no
# longer Intel, and Microsoft's last Intel build (1.23) is older than the
# version `ort` needs, so build-sidecars.sh links this build instead
# (ORT_LIB_LOCATION) for x86_64-apple-darwin.
#
#   scripts/onnxruntime-x86_64.sh DIR
#
# Builds the pinned release into DIR (about 30 to 60 minutes; CI caches DIR
# by the pin). DIR is then what ORT_LIB_LOCATION names. The version must be
# the one the locked ort-sys of vellev's Cargo.lock downloads for Apple
# Silicon: build-sidecars.sh checks that and says so if a vellev bump moved it.
set -euo pipefail

VERSION=1.28.0
COMMIT=da9b5e364c465de65c49d91e696cd6485270757f

dir=${1:?usage: onnxruntime-x86_64.sh DIR}
src=${ORT_SOURCE_CACHE:-$HOME/Library/Caches/desk-build/onnxruntime-$VERSION}

say() { printf '\033[1m==> %s\033[0m\n' "$*" >&2; }

if [ -f "$dir/.built-$COMMIT" ]; then
  say "ONNX Runtime $VERSION for x86_64 already built in $dir"
  exit 0
fi

if [ ! -d "$src/.git" ]; then
  say "fetching ONNX Runtime $VERSION"
  mkdir -p "$(dirname "$src")"
  git clone --quiet --depth 1 --branch "v$VERSION" https://github.com/microsoft/onnxruntime.git "$src"
fi
[ "$(git -C "$src" rev-parse HEAD)" = "$COMMIT" ] ||
  { echo "onnxruntime-x86_64.sh: $src is not v$VERSION ($COMMIT)" >&2; exit 1; }
git -C "$src" submodule update --quiet --init --recursive --depth 1

# ONNX Runtime wants a newer CMake than macOS runners may have.
tools=$(mktemp -d)
trap 'rm -rf "$tools"' EXIT
python3 -m venv "$tools/venv"
"$tools/venv/bin/pip" install --quiet "cmake>=3.28,<4" ninja

say "building ONNX Runtime $VERSION for x86_64 (static, no tests)"
PATH="$tools/venv/bin:$PATH" python3 "$src/tools/ci_build/build.py" \
  --build_dir "$dir" --config Release --update --build \
  --parallel --skip_tests --skip_submodule_sync --compile_no_warning_as_error \
  --osx_arch x86_64 --apple_deploy_target 13.0 --cmake_generator Ninja \
  --cmake_extra_defines onnxruntime_BUILD_UNIT_TESTS=OFF
touch "$dir/.built-$COMMIT"
say "ONNX Runtime $VERSION for x86_64 in $dir"
