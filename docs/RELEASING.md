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
     (`scripts/onnxruntime.sh`, cached by its pin)
   - builds the app with `tauri build --target universal-apple-darwin`
   - signs inside out with the Developer ID, using the hardened runtime and
     the entitlements in `src-tauri/entitlements/`
   - notarizes and staples the app, then builds, signs, notarizes and staples
     the disk image
   - writes the macOS updater artifact: `Desk.app.tar.gz` and its `.sig`
4. After the `backend` job (step 5), the `linux-x86_64` job builds the Linux
   desktop app on Ubuntu 22.04 (glibc 2.35):
   - the three sidecars under their Linux names (`desk-helper`,
     `desk-agents`, `desk-memory`) are the `backend-linux-x86_64`
     artifact's, not built again: ort's own ONNX Runtime, which a build on
     22.04 would link, needs glibc 2.38 and fails to link there;
   - `Desk_<version>_amd64.AppImage` with its updater `.sig`, and
     `Desk_<version>_amd64.deb`.
5. The `backend` job (`backend-build.yml`) builds the Linux backend alone,
   for x86_64 (on `ubuntu-24.04`) and aarch64 (on `ubuntu-24.04-arm`), each
   inside manylinux_2_28 (AlmaLinux 8, glibc 2.28), with OpenSSL linked in
   (`scripts/openssl-static.sh`) and ONNX Runtime built there
   (`scripts/onnxruntime.sh`; ort's own needs glibc 2.38), so Desk's own
   programs need only glibc 2.28.
   - The Postgres Desk Helper embeds is built there too, from source
     (`scripts/postgres-linux.sh`): theseus-rs' builds, which
     `postgresql_embedded` downloads otherwise, are made on Debian 12 and
     need glibc 2.36. The script builds the version `.cargo/config.toml`
     pins from the release tarball (its checksum pinned), with nothing that
     needs a library beyond the C library (no ICU, OpenSSL, zlib or
     readline), and fails if any of its programs or libraries needs a glibc
     newer than `MIN_GLIBC` (`crates/desk-core/src/backend.rs`, 2.34) or
     links another library. The archive is reproducible (same source and
     image, same bytes); the job's summary records its sha256, and the
     `postgres-linux-<arch>` workflow artifact keeps it with its `.sha256`.
     It is cached by the script's and `.cargo/config.toml`'s hash, and
     checked again when restored. `build-sidecars.sh` (`POSTGRES_ARCHIVE`)
     puts it at `~/.theseus/postgresql/postgresql-<version>-<target>.tar.gz`,
     where `postgresql_embedded` takes it instead of downloading, rebuilds
     `postgresql_embedded` and fails unless desk-hubd embedded that archive.
   - So the backend runs on glibc 2.34 and newer: Ubuntu 22.04, Debian 12,
     RHEL/Rocky/Alma 9, Amazon Linux 2023, Fedora. Desk Helper's `--check`
     (what Desk runs inside WSL and on machines) refuses older ones.
   - It then runs `scripts/backend-smoke.sh` (Postgres, the hub, a terminal)
     on Ubuntu 22.04 and 24.04, Debian 12, Rocky 9, Amazon Linux 2023 and
     Fedora, for each architecture. A pull request that changes how it is
     built runs the same workflow, publishing nothing.
   - the `backend-linux-x86_64` and `backend-linux-aarch64` workflow
     artifacts (the three programs and the Claude Code plugin). Desk on
     Windows installs the x86_64 one inside WSL.
6. The `windows` job builds on Windows, once the backend job is done:
   - `Desk Helper.exe` (`crates/desk-wsl`), which keeps the backend running
     inside the person's WSL distro from sign-in;
   - the per-user NSIS installer with its updater `.sig`, and an `.msi` for
     managed installs. Both carry the `backend-linux-x86_64` artifact, which
     Desk installs into WSL on first run and after each update.

   Windows builds are unsigned unless the `WINDOWS_SIGNING` variable is
   `true`: SmartScreen then warns on first run. With it on, Azure Trusted
   Signing signs the app, `Desk Helper.exe` and the installers.
7. The `publish` job writes one `latest.json` (`darwin-aarch64`,
   `darwin-x86_64`, `linux-x86_64` and `windows-x86_64`), packs each backend
   artifact as `desk-backend-linux-<arch>-<version>.tar.gz` with its `.sig`,
   signed with the updater key (`scripts/backend-tarball.sh`), and publishes
   everything to a GitHub release.

The backend tarballs are what Desk installs on machines (Linux boxes it
drives over SSH). Desk downloads the one for its own version and the
machine's architecture beside `latest.json`, checks its signature against
`plugins.updater.pubkey` (and that it was signed under that file name), and
keeps it per version in `~/Library/Application Support/Desk/machines/backend`.
Nothing unsigned leaves the Mac, apart from a development build's
`DESK_MACHINE_BACKEND=<folder>`: an unpacked `backend-linux-<arch>` artifact,
installed as `<version>+dev.<hash of the folder>` and said aloud. Release
builds ignore that variable.

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
| `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` | *(only with `WINDOWS_SIGNING`)* the Azure app that may sign with Trusted Signing |

| Variable | What |
| --- | --- |
| `RELEASES_REPO` | *(optional)* `owner/name` to publish releases to. Defaults to this repo. |
| `WINDOWS_SIGNING` | *(optional)* `true` to sign Windows builds with Azure Trusted Signing. Off by default. |
| `TRUSTED_SIGNING_ENDPOINT`, `TRUSTED_SIGNING_ACCOUNT`, `TRUSTED_SIGNING_PROFILE` | *(only with `WINDOWS_SIGNING`)* the Trusted Signing account and certificate profile |

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
locked `ort-sys` is not the one `scripts/onnxruntime.sh` builds ONNX
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
--workforce <hub>`), built with `cargo build -p desk-hubd --features
dev-overrides`: only that feature lets `--workforce` and `--memory` choose the
programs it starts (a local release-style install that needs them: `cargo
build --release -p desk-hubd --features dev-overrides`). Release builds
(`build-sidecars.sh`, `release.yml`, `backend-build.yml`) never enable it, and
`build-sidecars.sh` checks the release helper refuses `--workforce`. `scripts/stage-sidecars.sh` builds the development
sidecars under their bundle names (`Desk Helper-<triple>`,
`Desk Agents-<triple>`, `Desk Memory-<triple>` on macOS, `desk-helper-<triple>`
and so on on Linux). Without a `vellev` beside
`desk-hubd`, on `PATH` or given with `--memory <path>`, the development hub
keeps memories in SQLite.
