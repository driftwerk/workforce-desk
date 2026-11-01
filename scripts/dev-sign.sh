#!/bin/sh
# Signs a development build of one of Desk's binaries with the identity in
# DESK_DEV_SIGNING_IDENTITY (a code-signing certificate in your keychain:
# `security find-identity -v -p codesigning` lists them), under a fixed
# identifier. The keychain remembers "Always Allow" by the binary's
# signature: an unsigned build's (the linker's ad-hoc one) changes with every
# rebuild, so each rebuild would ask again; one signed by the same identity
# under the same identifier doesn't. Does nothing when the variable is unset
# or off macOS. Release builds are signed by the release pipeline instead.
#   dev-sign.sh <binary> <identifier>
set -eu
bin=$1
id=$2
[ "$(uname -s)" = Darwin ] || exit 0
[ -n "${DESK_DEV_SIGNING_IDENTITY:-}" ] || exit 0
codesign --force --timestamp=none --sign "$DESK_DEV_SIGNING_IDENTITY" --identifier "$id" "$bin" ||
  { echo "dev-sign.sh: couldn't sign $bin with \"$DESK_DEV_SIGNING_IDENTITY\"" >&2; exit 1; }
