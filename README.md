# Desk

Every agent you work with in one window: your Claude Code and Codex sessions
(real terminals, tracked and restored after a restart), local Workforce agents,
and agents on any paired hub — in rooms, DMs, by voice, or from a Tuple call.

Design: `workforce-public/docs/DESK_DESIGN.md`.

## How it fits together

- **`desk-hubd`** (`crates/desk-hubd`) runs at login as a LaunchAgent. It starts a
  local Postgres, writes the local hub's config (loopback only, every store in
  Postgres, `[desk]` on), keeps `workforce serve` running, and holds the hub's
  secrets in the keychain. Sessions live in the hub, so they outlive the window.
- **The app** (`src-tauri`, `src`) is a client of that hub and of every paired
  remote hub. Terminals stream over the hub's `/api/desk` websocket; chat uses
  each hub's `/ws` on the `desk` channel.
- **`desk-core`** is what both share: paths under
  `~/Library/Application Support/Desk` (`DESK_HOME` overrides) and the keychain.
- **`desk-tuple`** follows Tuple calls; **`desk-voice`** does wake-by-name (or
  listens for the one DM holding the microphone), speech-to-text and
  text-to-speech.
- **`@workforce/rich`** (from `workforce-public/packages/rich`) renders agents'
  tables, charts, forms, maps, diagrams and images.

## Develop

```sh
npm install
(cd ../workforce-public-desk/packages/rich && npm ci && npm run build)
WORKFORCE_REPO=../workforce-public-desk ./scripts/stage-sidecars.sh
npm run tauri dev
```

`stage-sidecars.sh` builds `desk-hubd` and the hub and puts them where Tauri
bundles them. To run the hub supervisor on its own against a scratch folder:

```sh
DESK_HOME=/tmp/desk ./target/debug/desk-hubd --workforce ../workforce-public-desk/target/debug/workforce
```

### The keychain in development

On macOS Desk keeps its secrets in the keychain as two items under `xyz.driftwerk.desk`.
`desk-helper-secrets` holds the local hub's secrets and is written only by desk-hubd.
`desk-app-secrets` holds remote workspaces' device tokens and is written only by the app.
Secrets an older Desk kept one item each are moved into these items the first
time they're read, and the old items are kept in step for older versions.
Credential Manager and the Secret Service keep one item per secret, as before.
Everywhere, each process reads each secret once, so reloading the page reads
nothing, and the app reads desk-hubd's again only after desk-hubd changes them
(it writes a new random value to `secrets.rev` beside them, no secret in it).

The keychain remembers "Always Allow" by a binary's signature. A development
build only has the linker's ad-hoc signature, which changes with every
rebuild, so the first run after each rebuild asks once per item. To make
"Always Allow" stick, sign development builds with a code-signing identity of
your own:

```sh
security find-identity -v -p codesigning   # e.g. "Apple Development: …"
export DESK_DEV_SIGNING_IDENTITY="Apple Development: Your Name (TEAMID)"
npm run tauri dev
```

Through Cargo's runner (`scripts/dev-run.sh`), `cargo run` signs `desk` as
`xyz.driftwerk.desk.dev`, and `stage-sidecars.sh` signs desk-hubd as
`xyz.driftwerk.desk.helper.dev`. Click "Always Allow" once for each item, and
later rebuilds don't ask. An ad-hoc identity (`-`) doesn't help, because it
changes with the build. With `DESK_HOME` set, secrets go to a file instead.
Signed releases don't ask again after the first "Always Allow".

## Checks

```sh
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
npx tsc --noEmit && npx vitest run && npx vite build
```

## Licence

Copyright (c) 2026 Kingsley Hendrickse. Desk is source-available under the
[PolyForm Shield License 1.0.0](LICENSE): free to use, change and share, but
not to sell or to offer as a competing product or service. See the
[licence FAQ](LICENSE-FAQ.md) and [NOTICE](NOTICE).
