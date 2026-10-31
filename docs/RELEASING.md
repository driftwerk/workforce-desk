# Releasing Desk

A release is one universal `Desk.app` (Apple Silicon and Intel) on a signed,
notarized disk image, and for Linux (x86_64) an AppImage and a `.deb`, which
carry the same three programs under Linux names (`desk-helper`,
`desk-agents`, `desk-memory`) beside the app. Inside `Desk.app`, beside the
app:

| In `Contents/MacOS` | What it is |
| --- | --- |
| `Desk` | the app |
| `Desk Helper` | `desk-hubd`: Postgres, the memory store, the hub's config and secrets, restarts |
| `Desk Agents` | the hub (`workforce`), built from the commit in `hub.ref` |
| `Desk Memory` | the hub's memory store (`vellev`), built from the commit in `vellev.ref` |

`Contents/Library/LaunchAgents/xyz.driftwerk.desk.helper.plist` is Desk
Helper's login item. The app registers it with `SMAppService` the first time it
opens from Applications. It appears in System Settings → General → Login Items
as Desk. Postgres 18.6.1 is compiled into Desk Helper (pinned in
`.cargo/config.toml`), so a first launch needs no network. The memory
store's embedding model (bge-base, about 436 MB) is not in the bundle: Desk
Helper downloads it on first launch, in the background, into
`~/Library/Application Support/Desk/hub/memory/models`. Until it is there the
hub keeps memories in SQLite; then it moves them into the store, once.

## Cutting a release

1. Make sure `hub.ref` is the hub commit this release should ship (see below)
   and that the commit is pushed to `driftwerk/workforce`; the same for
   `vellev.ref` and `driftwerk/vellev`.
2. Tag and push:

   ```sh
   git tag v0.2.0 && git push origin v0.2.0
   ```

   You can also run **Release** from the Actions tab with a version
   (`workflow_dispatch`). The workflow writes that version into
   `tauri.conf.json`, `package.json` and the workspace `Cargo.toml`. You don't
   bump them by hand.
3. `.github/workflows/release.yml` then:
   - builds the three sidecars for both architectures and joins each pair
     with `lipo` (`scripts/build-sidecars.sh`). vellev embeds with ONNX
     Runtime, which `ort` ships prebuilt for Apple Silicon only: for Intel
     the job builds ONNX Runtime 1.28 from source
     (`scripts/onnxruntime-x86_64.sh`, cached by its pin)
   - builds the app with `tauri build --target universal-apple-darwin`
   - signs inside out with the Developer ID, using the hardened runtime and
     the entitlements in `src-tauri/entitlements/`
   - notarizes and staples the app, then builds, signs, notarizes and staples
     the disk image
   - writes the macOS updater artifact: `Desk.app.tar.gz` and its `.sig`
4. Beside it, the `linux-x86_64` job builds on Ubuntu 22.04 (glibc 2.35, the
   oldest Desk supports):
   - the three sidecars under their Linux names (`desk-helper`,
     `desk-agents`, `desk-memory`), with ort's own ONNX Runtime;
   - `Desk_<version>_amd64.AppImage` with its updater `.sig`, and
     `Desk_<version>_amd64.deb`;
   - the `backend-linux-x86_64` workflow artifact (the three programs and
     the Claude Code plugin), which Desk on Windows installs inside WSL.
5. The `publish` job writes one `latest.json` (`darwin-aarch64`,
   `darwin-x86_64` and `linux-x86_64`) and publishes everything to a GitHub
   release.

Installed copies check `latest.json` on launch and every four hours. They
download the update in the background and offer **Restart to update**. A
`.deb` is updated by the system's package manager instead: Desk says a new
version is out and links to the release.

The first build of a new hub ref takes well over an hour, and the first
Intel ONNX Runtime build adds 30 to 60 minutes. Later builds reuse the cargo
cache, keyed by the hub and vellev refs, and the ONNX Runtime build, keyed by
its pin. If the runner runs out of disk, move the
job to a larger macOS runner.

## Secrets and variables

The Apple secret names are the same ones the Unison editor's release uses, so
you can add the same values here.

| Secret | What |
| --- | --- |
| `APPLE_CERTIFICATE` | the Developer ID Application certificate and key as a base64 `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12`'s password |
| `APPLE_ID` | the Apple ID that notarizes |
| `APPLE_PASSWORD` | an app-specific password for that Apple ID |
| `APPLE_TEAM_ID` | your Apple Developer Team ID |
| `TAURI_SIGNING_PRIVATE_KEY` | the contents of `~/.tauri/desk-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the contents of `~/.tauri/desk-updater.key.password` |
| `HUB_REPO_TOKEN` | optional: only if `driftwerk/workforce` is ever private — a token that can read it (fine-grained, Contents: read) |
| `RELEASES_TOKEN` | *(optional)* a token that can write releases to `RELEASES_REPO` when it isn't this repo |

| Variable | What |
| --- | --- |
| `RELEASES_REPO` | *(optional)* `owner/name` to publish releases to. Defaults to this repo. |

The updater and the download link fetch release assets without logging in, so
releases must live in a repository people can read. While this repo is private,
set `RELEASES_REPO` to a public releases-only repo and give `RELEASES_TOKEN`
write access to it. The workflow builds the app's update address from
`RELEASES_REPO`.

The updater key pair is not in the repo. The private key and its password are
in `~/.tauri/` on the machine that generated them. Only the public key is in
`src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). If you lose the private
key, installed copies can no longer verify new updates and people must download
the next version by hand.

## Bumping the hub

`hub.ref` holds one full commit SHA of `driftwerk/workforce`. To ship a newer
hub:

```sh
git -C ../workforce-public-desk log -1 --format=%H   # the commit you want; push it first
echo <sha> > hub.ref
TARGETS=aarch64-apple-darwin HUB_SOURCE=../workforce-public-desk scripts/build-sidecars.sh   # optional local check
git commit -m "Desk ships hub <short sha>: <why>" hub.ref
```

`build-sidecars.sh` refuses a `HUB_SOURCE` whose HEAD isn't `hub.ref`
(`HUB_ANY_REF=1` overrides this for experiments). Without `HUB_SOURCE` it
clones `HUB_REPO` (default `git@github.com:driftwerk/workforce.git`) into
`~/Library/Caches/desk-build/hub` (`~/.cache/desk-build/hub` on Linux) and
checks the ref out there. A local clone
works as `HUB_REPO` too.

## Bumping vellev

`vellev.ref` holds one full commit SHA of `driftwerk/vellev`, and works as
`hub.ref` does: `VELLEV_SOURCE`, `VELLEV_ANY_REF`, `VELLEV_REPO` (default
`https://github.com/driftwerk/vellev.git`) and `VELLEV_CACHE`
(`~/Library/Caches/desk-build/vellev`).

```sh
git -C ../vellev log -1 --format=%H origin/main   # the commit you want
echo <sha> > vellev.ref
git commit -m "Desk ships vellev <short sha>: <why>" vellev.ref
```

When it builds for Intel Macs, `build-sidecars.sh` refuses a vellev whose
locked `ort-sys` is not the one `scripts/onnxruntime-x86_64.sh` builds ONNX
Runtime for; move that script's pin (version and commit) to the ONNX Runtime
the new `ort-sys` links.

## Building locally

```sh
TARGETS=aarch64-apple-darwin HUB_REPO=../workforce-public-desk scripts/build-sidecars.sh
npx tauri build --target aarch64-apple-darwin --bundles app
```

Drop `TARGETS` and use `--target universal-apple-darwin` for both
architectures. Plan on roughly 30 GB of free disk for that. The script checks
first; `MIN_FREE_GB` overrides the limit. A local build is unsigned unless you
sign it. Ad-hoc signing (`codesign --force --deep --sign -`) is enough to run
it on this Mac.

To try a build without touching your real Desk data, give the bundled plist a
throwaway home before signing and run the app with the same home:

```sh
plutil -insert EnvironmentVariables -json '{"DESK_HOME":"/tmp/desk-try"}' \
  "Desk.app/Contents/Library/LaunchAgents/xyz.driftwerk.desk.helper.plist"
codesign --force --deep --sign - Desk.app
DESK_HOME=/tmp/desk-try DESK_REGISTER_HELPER=1 Desk.app/Contents/MacOS/desk
```

With `DESK_HOME` set, secrets go to a file in that folder, not the keychain.
`DESK_REGISTER_HELPER=1` registers the bundled helper anyway. Afterwards, stop
and unregister it from the same copy:

```sh
DESK_HOME=/tmp/desk-try DESK_REGISTER_HELPER=1 Desk.app/Contents/MacOS/desk --unregister-helper
sfltool dumpbtm | grep -i -A3 "xyz.driftwerk.desk.helper"   # read-only check: nothing left
```

On Linux, build the sidecars (one target, this machine's) and then the
AppImage and the `.deb`; `createUpdaterArtifacts` signs the AppImage, so
without the updater key turn it off:

```sh
HUB_REPO=../workforce-public-desk scripts/build-sidecars.sh
npx tauri build --bundles appimage,deb --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

`Desk --unregister-helper` (no `DESK_HOME`) is also how an uninstall script
removes the installed helper: the login item on macOS, the systemd user
service or the autostart entry on Linux. Settings → Help → **Remove Desk's data…** does
the same and can delete the data.

## Development

A development run (`npm run tauri dev` with `DESK_HOME` set) registers
nothing. It talks to a `desk-hubd` you start yourself (`target/debug/desk-hubd
--workforce <hub>`). `scripts/stage-sidecars.sh` builds the development
sidecars under their bundle names (`Desk Helper-<triple>`,
`Desk Agents-<triple>`, `Desk Memory-<triple>` on macOS, `desk-helper-<triple>`
and so on on Linux). Without a `vellev` beside
`desk-hubd`, on `PATH` or given with `--memory <path>`, the development hub
keeps memories in SQLite.
