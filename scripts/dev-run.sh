#!/bin/sh
# Cargo's runner on macOS (.cargo/config.toml): `cargo run`, and so
# `npm run tauri dev`, runs Desk through this. It signs the app and
# desk-hubd with DESK_DEV_SIGNING_IDENTITY first (see dev-sign.sh), so the
# keychain's "Always Allow" survives a rebuild; anything else, and anything
# when the variable is unset, it just runs.
set -eu
bin=$1
case $(basename "$bin") in
  desk) "$(dirname "$0")/dev-sign.sh" "$bin" xyz.driftwerk.desk.dev ;;
  desk-hubd) "$(dirname "$0")/dev-sign.sh" "$bin" xyz.driftwerk.desk.helper.dev ;;
esac
exec "$@"
