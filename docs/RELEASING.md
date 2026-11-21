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
   bump them by hand. A stable version is `major.minor.patch` only: a tag
   with a pre-release part (`v0.3.0-rc.1`, a nightly's `v0.2.11-nightly.…`)
   starts no release, and the Release form refuses one, since no Desk on
   Stable would ever take it. Its **dry_run** builds, signs and checks
   everything and publishes nothing; its run's title says "(dry run)", and
   neither waits for nor holds up a real release (nor the nightly).
3. `.github/workflows/release.yml` then:
   - builds the three sidecars for both architectures and joins each pair
     with `lipo` (`scripts/build-sidecars.sh`). vellev embeds with ONNX
     Runtime, which `ort` ships prebuilt for Apple Silicon only. Intel's
     memory store isn't built: it is Desk 0.2.10's, pinned
     (`scripts/intel-memory.sh`; see [ONNX Runtime](#onnx-runtime))
   - builds the app with `tauri build --target universal-apple-darwin`
   - signs inside out with the Developer ID, using the hardened runtime and
     the entitlements in `src-tauri/entitlements/`
   - notarizes and staples the app, then builds, signs, notarizes and staples
     the disk image
   - writes the macOS updater artifact: `Desk.app.tar.gz` and its `.sig`
4. Once the `backend` job (below) has built, the `linux-x86_64` job builds
   the Linux desktop app on Ubuntu 22.04 (glibc 2.35):
   - its three sidecars (`desk-helper`, `desk-agents`, `desk-memory`) are the
     `backend-linux-x86_64` artifact's, built for glibc 2.28; not built again
     here, where ort's own ONNX Runtime (glibc 2.38) and theseus-rs' Postgres
     (glibc 2.36) wouldn't run;
   - `Desk_<version>_amd64.AppImage` with its updater `.sig`, and
     `Desk_<version>_amd64.deb`.
5. The `backend` job (`backend-build.yml`) builds the Linux backend alone,
   for x86_64 (on `ubuntu-24.04`) and aarch64 (on `ubuntu-24.04-arm`), each
   inside manylinux_2_28 (AlmaLinux 8, glibc 2.28), with OpenSSL linked in
   (`scripts/openssl-static.sh`) and Microsoft's ONNX Runtime from NuGet
   (`scripts/onnxruntime.sh`; ort's own needs glibc 2.38), so Desk's own
   programs need only glibc 2.28. That ONNX Runtime is a shared library,
   `libonnxruntime.so.1`: every Linux backend ships it beside
   `desk-memory`, which finds it there (rpath `$ORIGIN`). That covers the
   artifact, the machines' tarball and the WSL copy. The Linux app's
   packages put it in `/usr/lib/Desk`. The AppImage's tooling then moves a
   copy into `usr/lib`, and the release checks that both packages load
   their own copy.
   Every place that ships it checks it against its pin
   (`scripts/onnxruntime.sh check`). Each Desk install refuses a backend
   whose `desk-memory` names the library but which doesn't hold it.
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

Every updater download (the Mac's `Desk.app.tar.gz`, the AppImage, the NSIS
installer) is signed for its version (`tauri signer sign --app-version`, which
`tauri build` does by itself), and the app refuses a feed whose version isn't
the one its download was signed for (`requireSignedVersion` in
`tauri.conf.json`). The `publish` job checks each signature against the key
in `tauri.conf.json`, and the version in it, before anything is published.

Installed copies check `latest.json` on launch and every four hours. They
download the update in the background and offer **Restart to update**. A
`.deb` is updated by the system's package manager instead: Desk says a new
version is out and links to the release.

The first build of a new hub ref takes well over an hour. Later builds
reuse the cargo cache, keyed by the hub and vellev refs. If the runner runs
out of disk, move the job to a larger macOS runner.

## Nightly

`.github/workflows/nightly.yml` builds `main` every night from 01:30 UTC, trying again at 04:30 and 07:30
UTC when GitHub drops or delays the first start,
for the Desks set to **Updates: Nightly** (Settings → Help). Everyone else
stays on Stable and never sees a nightly.

**Switching a Desk to Nightly.** Settings → Help → Updates → **Nightly**. Desk
checks at once and installs the newest nightly the way it installs any update,
once your sessions finish and you've stepped away. On Nightly it reads both
feeds and takes the newer, so a stable release newer than the last nightly
reaches it too. **Stable** switches back: a nightly found but not installed is
let go, and Desk never goes back to an older version, so a nightly build waits
until a stable newer than it is out (`0.2.11` or later for
`0.2.11-nightly.20261120.42`). Help says so. The setting is `updateChannel` in
`settings.json`; anything but `nightly` means Stable. A `.deb` install follows
Stable whatever it says (Help shows Nightly off there): nightlies come as the
AppImage, the NSIS installer and the Mac app only.

**Versions.** A nightly is the next patch after the latest stable release, as
a pre-release: `0.2.11-nightly.<UTC date>.<run number>`, after `0.2.10` and
before `0.2.11` as semver (and the updater) orders them, and each night's
after the one before.

**Feeds.** Stable's is `latest.json` on the latest release, as before. The
nightly's is `latest-nightly.json` on the `nightly` release:

```
https://github.com/<RELEASES_REPO>/releases/download/nightly/latest-nightly.json
```

Desk derives that address from its built-in stable endpoint; it is never in
`plugins.updater.endpoints`, which the updater falls back along. Each nightly
is its own pre-release, `v<version>`, carrying its downloads and the
machines' backends (Desk on a nightly sets machines up from its own
version's release), never marked latest; the `nightly` release holds only
the feed. A nightly is deleted, with its tag, once a stable as new as it is
out (every Desk on it moves to that stable) and 14 newer nightlies have
followed it; until then it stays, for a Desk still on it.

**Why no Desk on Stable can get a nightly.**
- Stable reads `latest.json` only. Nothing on the nightly path writes a
  `latest.json` or marks a release latest; `publish` fails if a nightly
  would carry one, and afterwards checks that the latest release is still a
  stable one.
- On Stable the app takes a version with no pre-release part only, and
  only a newer one; from the nightly feed, a nightly only. It checks again
  before it downloads and before it installs, in case the channel changed.
- Downloads are signed for their versions and the app refuses a mismatch,
  so a feed can't pass a nightly off under a stable's version.
- `release.yml` refuses a stable version with a pre-release part and a
  nightly version that isn't one, and a nightly tag starts no release.

**Each night**, `nightly.yml` (its planning is `.github/scripts/nightly.py`,
tested by `test_nightly.py`):

1. Skips while a **Release** run is going.
2. Reads the last nightly's feed: its version and the Desk commit and hub
   ref it was built from (`desk_commit`, `hub_ref` in the feed).
3. Finds the newest commit on the hub's main whose **PR Check** passed. If
   it is ahead of `hub.ref`, it commits the bump (`Desk ships hub <sha>:
   …`, the hub commits listed) on a branch `nightly/hub-…`, runs Desk's CI
   there, and the Linux backend's smoke test (`backend.yml`), as a person's
   `hub.ref` pull request would (`workflow_dispatch`: a push with the job's
   token starts none), and fast-forwards `main` to it once both pass. If `main`
   moved meanwhile (it does, most days) the bump is made again on the new
   `main`, twice at most; after that it is left for the next night, never the
   night itself. `main`'s ruleset only forbids
   force-pushes and deletion, so the bot can push; if it ever requires pull
   requests, this step fails and the night's issue says so. A bump whose CI
   fails is left out (that night's nightly is built without it, if Desk
   changed) and reported. `vellev.ref` is never touched: the bump's commit is
   refused unless `hub.ref` is all it changes (so the vellev hold below
   stands).
4. Skips when there are no new commits on `main` and no hub bump.
5. Builds only a commit whose Desk CI passed, at that exact commit: `main`'s
   tip, taken afresh once any bump is settled (a tip whose CI a newer push
   cancelled gives way to the newer tip). If the tip's CI is red, it builds
   the newest commit of `main` whose CI passed, when that is newer than the
   last nightly, and says so; else it skips and says why in the run's
   summary and the night's issue.
6. Calls `release.yml` with `channel: nightly`: the same builds, signing and
   notarizing, published as above. Windows gets the NSIS installer only,
   since the MSI takes no pre-release version, and Linux the AppImage only:
   dpkg would order `0.2.11-nightly.…` after `0.2.11`, so the stable after a
   nightly `.deb` would look like a downgrade. The release notes list the
   pull requests merged since the last nightly (before the first, since the
   latest stable) and the hub commits brought in.

A night that fails, skips because Desk's CI is red, cancelled or stuck, or
leaves a hub bump out, opens an issue labelled `nightly` (or comments on the
open one), saying which platforms were published when only part of the build
failed; the next good night closes it. "Nothing changed" and "a release is
running" are quiet skips.

**Dry run.** Run **Nightly** from the Actions tab with **dry_run**: it plans,
gates and builds, signs and notarizes everything as a real night does, and
publishes nothing. It commits nothing to `main` either: a hub bump it would
make is built from the hub commit as it is (`hub_ref`), and printed. What it
would have published, `latest-nightly.json` and the notes, is the run's
`nightly-dry-run` artifact. A run that isn't on `main` must be a dry run.

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

While Intel Macs ship Desk 0.2.10's memory store, `build-sidecars.sh`
refuses to change vellev at all for them (see [ONNX Runtime](#onnx-runtime)).
When it builds the Linux backend, it refuses a vellev whose locked `ort-sys`
is not the one `scripts/onnxruntime.sh` provides ONNX Runtime for. Move that script's pins
to the ONNX Runtime the new `ort-sys` links:
- its version and commit;
- the NuGet package's sha256, and each Linux library's.

Check a new package before pinning it (see below).

## ONNX Runtime

On 2026-11-18, github.com/microsoft/onnxruntime went offline: git, the web
and the API all answer 404. Microsoft took it down, along with
microsoft/agent-framework, hours after a malicious agent-framework release
on PyPI. Until then `scripts/onnxruntime.sh` cloned the v1.28.0 tag from
that repository and built it. No step of Desk's build fetches from it now:

- **Linux backend.** It uses Microsoft's own build from nuget.org,
  Microsoft.ML.OnnxRuntime 1.28.0, pinned by the package's sha256 and by
  each library's. That version was published on 2026-07-25 and can't be
  changed on nuget.org. Before it was pinned, it was checked on 2026-11-19:
  - `dotnet nuget verify --all` accepted Microsoft Corporation's author
    signature and nuget.org's repository countersignature, both
    timestamped 2026-07-25. The author certificate expired on 2026-10-17,
    so the signature stands on its timestamp;
  - its sha512 matched nuget.org's catalog;
  - its `.nuspec` names commit `da9b5e36…`, the v1.28.0 commit Desk built
    from before;
  - its libraries need glibc 2.27 at most.

  To check a package the same way:

  ```sh
  docker run --rm -v "$PWD/x.nupkg:/p/x.nupkg:ro" \
    mcr.microsoft.com/dotnet/sdk@sha256:1b955f179b02df4f0eb5fadedaa898cbe44d620a64aab52eec72c8e91d1355b5 \
    dotnet nuget verify --all -v normal /p/x.nupkg
  ```
- **Intel Macs.** Microsoft publishes no 1.28 build for Intel Macs, on
  NuGet or PyPI, and its source is the repository that is offline. No ONNX
  Runtime library we built survived: the CI caches had expired, and the
  library was never a release asset. But the memory store linked against
  it did, inside Desk 0.2.10's signed, notarized Desk.app. Until the source
  is back, Intel's memory store is that binary's x86_64 slice, taken with
  `lipo -thin x86_64`.
  - The asset was `v0.2.10/Desk.app.tar.gz`, sha256 `16e92f85…3c14`. GitHub's
    digest agrees, and its minisign signature verified with the updater
    key.
  - The app passes `codesign --verify --strict --deep`, and `spctl`
    accepted it as notarized.
  - The slice keeps its own Developer ID signature, team `CHA3FP8ENJ`.
  - It was built by Release run 44073317561 (tag v0.2.10, `64a7e561`) on
    2026-11-17, before the takedown. That run built vellev `c68c9736` with
    ONNX Runtime cloned that day and checked against commit `da9b5e36…`.
  - It is hosted as an asset of the pre-release
    `deps-intel-memory-vellev-c68c9736` on this repository, beside its
    `PROVENANCE.txt`. That pre-release is not a Desk release, is never the
    latest, and its tag doesn't start with `v`, so neither release.yml nor
    the updater looks at it.
  - `scripts/intel-memory.sh` pins it by sha256. It checks a private copy
    again (a single x86_64 program, signed with that team's Developer ID,
    for macOS 13.0) before moving it into place. `build-sidecars.sh` ships it
    as it is and checks it again where it lands. The release checks the
    app's Desk Memory once more before signing it.

  **vellev.ref is held at `c68c9736` while this lasts**, for every platform,
  since one vellev.ref serves them all. Both
  `intel-memory.sh` and therefore `build-sidecars.sh` refuse any other
  vellev before building, and `intel-sidecars.yml` runs whenever
  `vellev.ref` changes. A vellev bump has to wait until ONNX Runtime's
  source is settled: Microsoft's repository is back, or the release owner
  approves another source (not a third-party mirror by default). After
  that, the source build of Intel's ONNX Runtime comes back (see
  `scripts/onnxruntime.sh` before this change, in git).

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
