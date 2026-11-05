#!/bin/bash
# Postgres for the Linux backend, built from source on this machine, so it
# needs no glibc newer than this machine's: the release builds it inside
# manylinux_2_28 (glibc 2.28). theseus-rs' builds, which postgresql_embedded
# downloads otherwise, are made on Debian 12 and need glibc 2.36.
#
#   scripts/postgres-linux.sh DIR
#
# Writes DIR/postgresql-<version>-<arch>-unknown-linux-gnu.tar.gz, laid out as
# theseus' archives are, and its .sha256; does nothing but check them when
# they are there. <version> is the one .cargo/config.toml pins
# (POSTGRESQL_VERSION, theseus' numbering: Postgres 18.6, their build 1).
# Placed at ~/.theseus/postgresql/ before desk-hubd builds (build-sidecars.sh
# with POSTGRES_ARCHIVE), postgresql_embedded bundles it instead of
# downloading one.
#
# Only what the hub uses: the server, initdb, pg_ctl and the client tools,
# and the contrib extensions that need no other library. No ICU (Desk's
# databases use the C library's collations, initdb's default), no OpenSSL
# (the hub connects over loopback), no zlib, readline, libxml or Python, so
# it needs nothing beyond the C library. Timezones are its own, not the
# system's, which minimal images leave out.
#
# Checks that nothing in it needs a glibc newer than the backend's floor
# (MIN_GLIBC in crates/desk-core/src/backend.rs) or a library other than the
# C library's own.
#
# The same source in the same image makes the same archive: the source is
# pinned by its checksum, and the archive's file order, times (the source's
# own) and owners are fixed. Needs a C compiler, make, bison, flex, perl,
# patchelf, curl and binutils.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
dir=${1:?usage: $0 DIR}

package=$(sed -n 's/^POSTGRESQL_VERSION = "=\(.*\)"$/\1/p' "$root/.cargo/config.toml")
version=18.6
sha256=555610c24d53e4316da5b7d3fc25c279d96856d5e0e23ee308c328c5fa881d9f
[ "${package%.*}" = "$version" ] ||
  { echo "postgres-linux: .cargo/config.toml pins $package; this builds $version: move its pin" >&2; exit 1; }

floor=$(sed -n 's/^pub const MIN_GLIBC: (u32, u32) = (\([0-9]*\), \([0-9]*\));$/\1.\2/p' \
  "$root/crates/desk-core/src/backend.rs")
[ -n "$floor" ] || { echo "postgres-linux: no MIN_GLIBC in backend.rs" >&2; exit 1; }

target="$(uname -m)-unknown-linux-gnu"
name="postgresql-$package-$target"
archive="$dir/$name.tar.gz"

# check: every program and library in the archive needs glibc $floor at most
# and links nothing but the C library's own libraries and the archive's.
check() {
  local work newest needed bad=0 f elves=()
  work=$(mktemp -d)
  tar -xzf "$archive" -C "$work"
  [ -x "$work/$name/bin/postgres" ] && [ -x "$work/$name/bin/initdb" ] &&
    [ -x "$work/$name/bin/pg_ctl" ] && [ -f "$work/$name/share/postgres.bki" ] &&
    [ -f "$work/$name/lib/plpgsql.so" ] ||
    { echo "postgres-linux: $archive isn't laid out as theseus' archives are" >&2; rm -rf "$work"; return 1; }
  while IFS= read -r f; do
    [ "$(head -c 4 "$f" | od -An -tx1 | tr -d ' \n')" = 7f454c46 ] && elves+=("$f")
  done < <(find "$work/$name/bin" "$work/$name/lib" -type f)
  for f in "${elves[@]}"; do
    if ! objdump -T "$f" >"$work/symbols"; then
      echo "postgres-linux: can't read ${f#"$work/"}'s symbols" >&2
      bad=1
      continue
    fi
    newest=$({ grep -o 'GLIBC_[0-9.]*' "$work/symbols" || true; } | sort -uV | tail -1)
    if [ -n "$newest" ] && [ "$(printf '%s\n' "$newest" "GLIBC_$floor" | sort -V | tail -1)" != "GLIBC_$floor" ]; then
      echo "postgres-linux: ${f#"$work/"} needs $newest, newer than $floor" >&2
      bad=1
    fi
    for needed in $(objdump -p "$f" | awk '$1 == "NEEDED" { print $2 }'); do
      case $needed in
        libc.so.6 | libm.so.6 | libdl.so.2 | libpthread.so.0 | librt.so.1 | libresolv.so.2 | libutil.so.1 | ld-linux*.so.*) ;;
        *) [ -e "$work/$name/lib/$needed" ] ||
             { echo "postgres-linux: ${f#"$work/"} links $needed, which isn't the C library's" >&2; bad=1; } ;;
      esac
    done
  done
  echo "postgres-linux: ${#elves[@]} programs and libraries, needing $(objdump -T "${elves[@]}" |
    grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1) at most"
  rm -rf "$work"
  return "$bad"
}

if [ -f "$archive" ] && [ -f "$archive.sha256" ]; then
  (cd "$dir" && sha256sum -c "$name.tar.gz.sha256" >/dev/null) ||
    { echo "postgres-linux: $archive doesn't match its .sha256" >&2; exit 1; }
  check
  cat "$archive.sha256"
  exit 0
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/postgresql-$version.tar.bz2" \
  "https://ftp.postgresql.org/pub/source/v$version/postgresql-$version.tar.bz2"
echo "$sha256  $work/postgresql-$version.tar.bz2" | sha256sum -c -
tar -xjf "$work/postgresql-$version.tar.bz2" -C "$work"
SOURCE_DATE_EPOCH=$(stat -c %Y "$work/postgresql-$version/configure")
export SOURCE_DATE_EPOCH
# A prefix with "postgres" in it keeps share/ and lib/ flat, as theseus'.
prefix=/opt/postgresql
(
  cd "$work/postgresql-$version"
  # What's on by default and needs a library: ICU, readline and zlib. The
  # rest (OpenSSL, LDAP, GSSAPI, libxml, lz4, zstd, the PLs) is off unless
  # asked for. No built-in runpath: patchelf sets one below.
  ./configure --prefix="$prefix" --enable-option-checking=fatal --disable-rpath \
    --without-icu --without-readline --without-zlib CFLAGS="-O2" >"$work/configure.log" ||
    { tail -n 40 config.log >&2; exit 1; }
  make -j"$(nproc)" -s world-bin >/dev/null
  make -s DESTDIR="$work/stage" install-world-bin >/dev/null
)
stage="$work/stage$prefix"
# What postgresql_embedded runs and loads, without what's only for building
# extensions against it.
rm -rf "$stage/include" "$stage/lib/pgxs" "$stage/lib/pkgconfig"
find "$stage/lib" -name '*.a' -delete
# Postgres finds share/ and lib/ relative to its programs wherever the
# archive is unpacked; the programs find libpq through the runpath.
for f in "$stage"/bin/* "$stage"/lib/*; do
  [ -f "$f" ] && [ ! -L "$f" ] && readelf -h "$f" >/dev/null 2>&1 || continue
  strip --strip-unneeded "$f"
done
for f in "$stage"/bin/*; do
  patchelf --set-rpath '$ORIGIN/../lib' "$f"
done
cp "$work/postgresql-$version/COPYRIGHT" "$stage/LICENSE"
cat >"$stage/build-manifest.json" <<EOF
{
  "version": "$package",
  "target": "$target",
  "source": {
    "url": "https://ftp.postgresql.org/pub/source/v$version/postgresql-$version.tar.bz2",
    "sha256": "$sha256"
  },
  "built_by": "workforce-desk scripts/postgres-linux.sh",
  "glibc": "$(ldd --version | head -1 | awk '{ print $NF }')"
}
EOF
mkdir -p "$work/out"
mv "$stage" "$work/out/$name"
mkdir -p "$dir"
tar --sort=name --mtime="@$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner \
  -C "$work/out" -cf - "$name" | gzip -n -9 >"$work/$name.tar.gz"
mv "$work/$name.tar.gz" "$archive"
if ! check; then
  rm -f "$archive"
  exit 1
fi
(cd "$dir" && sha256sum "$name.tar.gz" >"$name.tar.gz.sha256")
cat "$archive.sha256"
