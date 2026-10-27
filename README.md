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
- **`desk-tuple`** follows Tuple calls; **`desk-voice`** does wake-by-name,
  speech-to-text and text-to-speech.
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

## Checks

```sh
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
npx tsc --noEmit && npx vitest run && npx vite build
```
