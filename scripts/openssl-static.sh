#!/bin/bash
# OpenSSL, built as static libraries for the Linux backend, so the hub links
# it in (OPENSSL_STATIC=1 OPENSSL_DIR=DIR) and needs no libssl of the
# distribution it runs on: their versions differ (1.1 on RHEL 8, 3 on the
# rest), the backend is one build for all of them. Certificates are still
# the system's: native-tls finds them where each distribution keeps them.
#
#   scripts/openssl-static.sh DIR
#
# Builds into DIR once (DIR/lib/libssl.a); does nothing when it is there.
set -euo pipefail

version=3.5.9
sha256=603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a

dir=${1:?usage: $0 DIR}
[ -f "$dir/lib/libssl.a" ] && [ -f "$dir/.version-$version" ] && exit 0
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
archive="$work/openssl-$version.tar.gz"
curl -fsSL -o "$archive" "https://github.com/openssl/openssl/releases/download/openssl-$version/openssl-$version.tar.gz"
echo "$sha256  $archive" | sha256sum -c -
tar -xzf "$archive" -C "$work"
(
  cd "$work/openssl-$version"
  ./Configure --prefix="$dir" --libdir=lib no-shared no-tests no-docs -fPIC >/dev/null
  make -j"$(nproc)" >/dev/null
  make install_sw >/dev/null
)
touch "$dir/.version-$version"
echo "OpenSSL $version in $dir"
