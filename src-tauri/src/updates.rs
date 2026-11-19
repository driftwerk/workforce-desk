//! Updates: whether this install updates itself, and the sessions to resume
//! after Desk restarts into an update (written just before the restart, read
//! once by the new version when it connects).

use std::path::Path;

use desk_core::Paths;
use desk_core::install::{Install, in_build_folder, in_mac_bundle};
use eyre::Result;
use serde::Serialize;

/// How this install of Desk gets a new version, decided here so the page
/// can't be wrong about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum How {
    /// It downloads and installs it itself, and restarts into it.
    Itself,
    /// The system's package manager updates it.
    Package,
    /// It never looks for one, nor installs one, and why: a development
    /// build, or one whose program isn't where an update could replace it.
    Never(&'static str),
}

/// How an install with its program at `exe` updates, for a build made
/// with debug assertions (`debug`) or not, on `os` (`std::env::consts::OS`).
pub fn how(exe: &Path, install: &Install, debug: bool, os: &str) -> How {
    if debug {
        return How::Never("a development build never updates itself");
    }
    if in_build_folder(exe) {
        return How::Never("Desk is running from a build folder, not an install");
    }
    match (os, install) {
        (_, Install::Package) => How::Package,
        ("macos", _) if !in_mac_bundle(exe) => {
            How::Never("Desk's program isn't inside a .app bundle (Desk.app/Contents/MacOS)")
        }
        ("linux", Install::AppImage { .. }) => How::Itself,
        ("linux", _) => How::Never("Desk isn't running from its AppImage"),
        ("macos" | "windows", _) => How::Itself,
        _ => How::Never("Desk doesn't update itself on this system"),
    }
}

/// What the page is told about updating.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Updating {
    /// `itself`, `package` or `never`.
    pub how: &'static str,
    /// Why it never updates, for `never`.
    pub never_because: Option<&'static str>,
    /// Where a new version can be downloaded by hand.
    pub download: Option<String>,
    /// The releases page (`https://github.com/<repo>/releases`): a
    /// nightly's own is `<releases>/tag/v<version>`.
    pub releases: Option<String>,
    /// Whether this computer's sessions are kept by the PTY holder, and so
    /// keep running while Desk restarts.
    pub sessions_kept: bool,
}

/// The releases page an updater endpoint
/// (`…/releases/latest/download/latest.json`) belongs to.
pub fn download_page(endpoint: &str) -> Option<String> {
    endpoint
        .strip_suffix("/download/latest.json")
        .map(str::to_string)
}

/// Which builds this Desk updates to, as `settings.json` keeps it
/// (`updateChannel`). Stable unless it says `nightly`: a missing, older or
/// unreadable setting never moves anyone onto nightlies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    /// The releases everyone gets: `latest.json` of the latest release.
    Stable,
    /// A build of each day's changes as well, `latest-nightly.json` on the
    /// `nightly` release, and Stable's releases when they're newer.
    Nightly,
}

impl Channel {
    pub fn from_setting(setting: &str) -> Self {
        if setting == "nightly" {
            Self::Nightly
        } else {
            Self::Stable
        }
    }

    /// The feeds this channel takes updates from.
    pub fn feeds(self) -> &'static [Feed] {
        match self {
            Self::Stable => &[Feed::Stable],
            Self::Nightly => &[Feed::Stable, Feed::Nightly],
        }
    }
}

/// The channel an install follows: its setting's, but Stable for one its
/// package manager updates, since nightlies come as the AppImage, the NSIS
/// installer and the Mac app only, never as a package.
pub fn channel_for(how: How, setting: Channel) -> Channel {
    match how {
        How::Package => Channel::Stable,
        _ => setting,
    }
}

/// One updater manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Feed {
    /// The endpoint built into the app (`plugins.updater.endpoints`).
    Stable,
    /// [`nightly_endpoint`] of it.
    Nightly,
}

/// The release that holds the nightly feed, and the feed's file there.
pub const NIGHTLY_TAG: &str = "nightly";
pub const NIGHTLY_MANIFEST: &str = "latest-nightly.json";

/// The nightly feed of the repository whose stable feed is `stable`
/// (`https://github.com/<repo>/releases/latest/download/latest.json`):
/// `https://github.com/<repo>/releases/download/nightly/latest-nightly.json`.
/// Derived here, never configured, so the stable endpoints list (which
/// the updater falls back along) can never hold it.
pub fn nightly_endpoint(stable: &str) -> Option<String> {
    let repo = stable
        .strip_prefix("https://github.com/")?
        .strip_suffix("/releases/latest/download/latest.json")?;
    let mut parts = repo.split('/');
    let plain = |p: &str| {
        !p.is_empty()
            && p != "."
            && p != ".."
            && p.chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
    };
    match (parts.next(), parts.next(), parts.next()) {
        (Some(owner), Some(name), None) if plain(owner) && plain(name) => Some(format!(
            "https://github.com/{owner}/{name}/releases/download/{NIGHTLY_TAG}/{NIGHTLY_MANIFEST}"
        )),
        _ => None,
    }
}

/// A nightly build's version: `0.2.11-nightly.20261120.42`.
pub fn is_nightly(version: &semver::Version) -> bool {
    version.pre.as_str().starts_with("nightly.")
}

/// Whether `feed` may offer `remote` to a Desk at `current`: only a newer
/// version, never the same or an older one, and from each feed only its
/// own kind: Stable's a release (no pre-release part at all), Nightly's a
/// nightly. So a nightly reaches no one on Stable even were it put in
/// Stable's feed by mistake.
pub fn takes(feed: Feed, current: &semver::Version, remote: &semver::Version) -> bool {
    remote > current
        && match feed {
            Feed::Stable => remote.pre.is_empty(),
            Feed::Nightly => is_nightly(remote),
        }
}

/// Whether a Desk at `current` on `channel` may install `version`: what
/// its feeds may offer it, checked again as it downloads and installs, in
/// case the channel changed since the check found it.
pub fn allowed(channel: Channel, current: &semver::Version, version: &str) -> bool {
    let Ok(version) = semver::Version::parse(version) else {
        return false;
    };
    channel
        .feeds()
        .iter()
        .any(|feed| takes(*feed, current, &version))
}

/// The newest of what each feed found, `U` being the updater's update.
/// A feed that failed is passed over when another answered (the nightly
/// feed is missing until the first nightly is out); all failing is the
/// first one's error.
pub fn newest<U, E>(
    found: Vec<std::result::Result<Option<(U, semver::Version)>, E>>,
) -> std::result::Result<Option<(U, semver::Version)>, E> {
    let mut first_error = None;
    let mut answered = false;
    let mut best: Option<(U, semver::Version)> = None;
    for f in found {
        match f {
            Ok(update) => {
                answered = true;
                if let Some((u, v)) = update
                    && best.as_ref().is_none_or(|(_, b)| v > *b)
                {
                    best = Some((u, v));
                }
            }
            Err(e) => {
                first_error.get_or_insert(e);
            }
        }
    }
    match first_error {
        Some(e) if !answered => Err(e),
        _ => Ok(best),
    }
}

pub fn updating(how: How, endpoint: Option<&str>, sessions_kept: bool) -> Updating {
    Updating {
        how: match how {
            How::Itself => "itself",
            How::Package => "package",
            How::Never(_) => "never",
        },
        never_because: match how {
            How::Never(why) => Some(why),
            _ => None,
        },
        download: endpoint.and_then(download_page),
        releases: endpoint
            .and_then(download_page)
            .and_then(|p| p.strip_suffix("/latest").map(str::to_string)),
        sessions_kept,
    }
}

/// The newest update found and its download once made, `U` being the
/// updater's update (anything with a version in tests). A newer version
/// found replaces it and drops the bytes of the older, so an install only
/// ever has the newest version's bytes.
#[derive(Debug)]
pub struct Held<U> {
    found: Option<Found<U>>,
}

/// An update found, its version, and its bytes once downloaded.
type Found<U> = (U, String, Option<std::sync::Arc<Vec<u8>>>);

impl<U> Default for Held<U> {
    fn default() -> Self {
        Self { found: None }
    }
}

impl<U: Clone> Held<U> {
    /// What a check found: `None` when there's no newer version. The same
    /// version found again keeps its download.
    pub fn found(&mut self, update: Option<(U, String)>) {
        match update {
            None => self.found = None,
            Some((u, version)) => {
                if self.found.as_ref().is_none_or(|(_, v, _)| *v != version) {
                    self.found = Some((u, version, None));
                }
            }
        }
    }

    /// The update to download, with its version: none when there's none, or
    /// it's downloaded already.
    pub fn to_download(&self) -> Option<(U, String)> {
        match &self.found {
            Some((u, v, None)) => Some((u.clone(), v.clone())),
            _ => None,
        }
    }

    pub fn has(&self) -> bool {
        self.found.is_some()
    }

    /// Keeps the bytes of `version`, unless a newer one was found meanwhile.
    pub fn downloaded(&mut self, version: &str, bytes: Vec<u8>) {
        if let Some((_, v, b)) = self.found.as_mut()
            && v == version
        {
            *b = Some(std::sync::Arc::new(bytes));
        }
    }

    /// The update and its bytes to install for `version`, the one the page
    /// offered: none unless it is the newest found and downloaded.
    pub fn to_install(&self, version: &str) -> Option<(U, std::sync::Arc<Vec<u8>>)> {
        match &self.found {
            Some((u, v, Some(b))) if v == version => Some((u.clone(), b.clone())),
            _ => None,
        }
    }
}

fn path(paths: &Paths) -> std::path::PathBuf {
    paths.root.join("resume-after-update.json")
}

pub fn resume_later(paths: &Paths, ids: &[String]) -> Result<()> {
    desk_core::write_private(&path(paths), &serde_json::to_string(ids)?)
}

/// The ids saved before the restart, forgotten as they are read.
pub fn resume_take(paths: &Paths) -> Result<Vec<String>> {
    let p = path(paths);
    let ids = match std::fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.into()),
    };
    std::fs::remove_file(&p)?;
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUNDLE: &str = "/Applications/Desk.app/Contents/MacOS/desk";

    fn on(os: &str, exe: &str, install: &Install) -> How {
        how(Path::new(exe), install, false, os)
    }

    #[test]
    fn a_development_build_never_updates() {
        // 11/09: `npm run tauri dev` offered, downloaded and installed the
        // release over target/debug.
        let dev = "/Users/ana/src/desk/target/debug/desk";
        assert!(matches!(
            on("macos", dev, &Install::Development),
            How::Never(_)
        ));
        assert!(matches!(
            how(Path::new(BUNDLE), &Install::MacBundle, true, "macos"),
            How::Never(_)
        ));
        assert!(matches!(
            on(
                "windows",
                "C:/src/desk/target/release/desk.exe",
                &Install::Development
            ),
            How::Never(_)
        ));
        let u = updating(on("macos", dev, &Install::Development), None, true);
        assert_eq!(u.how, "never");
        assert!(u.never_because.is_some());
    }

    #[test]
    fn only_an_app_bundle_updates_itself_on_macos() {
        assert_eq!(on("macos", BUNDLE, &Install::MacBundle), How::Itself);
        for exe in [
            "/Users/ana/Desk/desk",
            "/Applications/Desk.app/Contents/Resources/desk",
            "/Applications/Desk.app/Contents/MacOS/x/desk",
        ] {
            assert!(
                matches!(on("macos", exe, &Install::Development), How::Never(_)),
                "{exe}"
            );
        }
    }

    #[test]
    fn each_system_updates_its_own_installs() {
        let appimage = Install::AppImage {
            path: "/home/sarah/Desk.AppImage".into(),
        };
        assert_eq!(
            on("linux", "/tmp/.mount_Desk/usr/bin/desk", &appimage),
            How::Itself
        );
        assert_eq!(
            on("linux", "/usr/bin/desk", &Install::Package),
            How::Package
        );
        assert!(matches!(
            on("linux", "/home/sarah/desk/desk", &Install::Development),
            How::Never(_)
        ));
        // Windows' installs are told from builds by their folder alone.
        assert_eq!(
            on(
                "windows",
                "C:/Program Files/Desk/desk.exe",
                &Install::Development
            ),
            How::Itself
        );
    }

    #[test]
    fn a_package_is_updated_by_its_package_manager() {
        let endpoint =
            "https://github.com/driftwerk/workforce-desk/releases/latest/download/latest.json";
        assert_eq!(
            updating(How::Package, Some(endpoint), false),
            Updating {
                how: "package",
                never_because: None,
                download: Some(
                    "https://github.com/driftwerk/workforce-desk/releases/latest".into()
                ),
                releases: Some("https://github.com/driftwerk/workforce-desk/releases".into()),
                sessions_kept: false,
            }
        );
        assert_eq!(updating(How::Itself, None, true).how, "itself");
        assert_eq!(download_page("https://example.com/feed.json"), None);
    }

    #[test]
    fn only_the_newest_version_found_is_installed() {
        let mut held = Held::<&str>::default();
        held.found(Some(("u1", "0.2.1".into())));
        assert_eq!(held.to_download(), Some(("u1", "0.2.1".into())));
        held.downloaded("0.2.1", vec![1]);
        assert_eq!(held.to_download(), None);
        assert!(held.to_install("0.2.1").is_some());
        // Found again: its download is kept.
        held.found(Some(("u1", "0.2.1".into())));
        assert!(held.to_install("0.2.1").is_some());
        // A newer one drops the older bytes: nothing installs until it is
        // downloaded, and never the older version.
        held.found(Some(("u2", "0.2.2".into())));
        assert!(held.to_install("0.2.1").is_none());
        assert!(held.to_install("0.2.2").is_none());
        // The older download finishing late is dropped.
        held.downloaded("0.2.1", vec![1]);
        assert!(held.to_install("0.2.2").is_none());
        held.downloaded("0.2.2", vec![2]);
        assert_eq!(held.to_install("0.2.2").unwrap().1.as_slice(), &[2]);
        held.found(None);
        assert!(!held.has());
    }

    fn v(s: &str) -> semver::Version {
        semver::Version::parse(s).unwrap()
    }

    #[test]
    fn the_channel_is_stable_unless_it_says_nightly() {
        assert_eq!(Channel::from_setting("nightly"), Channel::Nightly);
        for s in ["", "stable", "Nightly", "beta", "nightly "] {
            assert_eq!(Channel::from_setting(s), Channel::Stable, "{s:?}");
        }
        assert_eq!(Channel::Stable.feeds(), &[Feed::Stable]);
        assert_eq!(Channel::Nightly.feeds(), &[Feed::Stable, Feed::Nightly]);
    }

    #[test]
    fn a_package_follows_stable_whatever_the_setting() {
        assert_eq!(channel_for(How::Package, Channel::Nightly), Channel::Stable);
        assert_eq!(channel_for(How::Itself, Channel::Nightly), Channel::Nightly);
        assert_eq!(channel_for(How::Itself, Channel::Stable), Channel::Stable);
    }

    #[test]
    fn the_nightly_feed_is_beside_the_stable_one() {
        assert_eq!(
            nightly_endpoint(
                "https://github.com/driftwerk/workforce-desk/releases/latest/download/latest.json"
            )
            .as_deref(),
            Some(
                "https://github.com/driftwerk/workforce-desk/releases/download/nightly/latest-nightly.json"
            )
        );
        // The release build's own endpoint has one.
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let endpoints = conf["plugins"]["updater"]["endpoints"].as_array().unwrap();
        assert_eq!(endpoints.len(), 1, "the nightly feed is never a fallback");
        assert!(nightly_endpoint(endpoints[0].as_str().unwrap()).is_some());
        // Signed for the version announced, so a feed can't pass one
        // build off as another.
        assert_eq!(conf["plugins"]["updater"]["requireSignedVersion"], true);
        for odd in [
            "http://github.com/a/b/releases/latest/download/latest.json",
            "https://example.com/a/b/releases/latest/download/latest.json",
            "https://github.com/a/releases/latest/download/latest.json",
            "https://github.com/a/b/c/releases/latest/download/latest.json",
            "https://github.com/../b/releases/latest/download/latest.json",
            "https://github.com/a/b?x/releases/latest/download/latest.json",
            "https://github.com/a/b/releases/download/v1/latest.json",
        ] {
            assert_eq!(nightly_endpoint(odd), None, "{odd}");
        }
    }

    #[test]
    fn nightlies_sort_between_their_stables() {
        let nightly = v("0.2.11-nightly.20261120.42");
        assert!(is_nightly(&nightly));
        assert!(!is_nightly(&v("0.2.11")));
        assert!(!is_nightly(&v("0.2.11-rc.1")));
        assert!(v("0.2.10") < nightly);
        assert!(nightly < v("0.2.11"));
        assert!(nightly < v("0.2.11-nightly.20261121.1"));
        assert!(v("0.2.11-nightly.20261120.9") < v("0.2.11-nightly.20261120.10"));
        assert!(v("0.2.11-nightly.20261231.99") < v("0.2.12-nightly.20260101.1"));
    }

    #[test]
    fn stable_never_offers_a_nightly_nor_anything_older() {
        let stable = v("0.2.10");
        assert!(takes(Feed::Stable, &stable, &v("0.2.11")));
        assert!(!takes(Feed::Stable, &stable, &v("0.2.10")));
        assert!(!takes(Feed::Stable, &stable, &v("0.2.9")));
        // A nightly, or any pre-release, in Stable's feed is passed over.
        assert!(!takes(
            Feed::Stable,
            &stable,
            &v("0.2.11-nightly.20261120.1")
        ));
        assert!(!takes(Feed::Stable, &stable, &v("0.3.0-rc.1")));
        // Nightly's feed offers nightlies only.
        assert!(takes(
            Feed::Nightly,
            &stable,
            &v("0.2.11-nightly.20261120.1")
        ));
        assert!(!takes(Feed::Nightly, &stable, &v("0.2.11")));
        assert!(!takes(Feed::Nightly, &stable, &v("0.3.0-rc.1")));
    }

    #[test]
    fn back_on_stable_a_nightly_waits_for_the_next_newer_stable() {
        let nightly = v("0.2.11-nightly.20261120.42");
        // The stable it was built after is older: never gone back to.
        assert!(!takes(Feed::Stable, &nightly, &v("0.2.10")));
        assert!(!allowed(Channel::Stable, &nightly, "0.2.10"));
        assert!(!allowed(
            Channel::Stable,
            &nightly,
            "0.2.11-nightly.20261121.1"
        ));
        // The release it leads up to, or any later one, is taken.
        assert!(allowed(Channel::Stable, &nightly, "0.2.11"));
        assert!(allowed(Channel::Stable, &nightly, "0.3.0"));
        // On Nightly, the next nightly and a newer stable both are.
        assert!(allowed(
            Channel::Nightly,
            &nightly,
            "0.2.11-nightly.20261121.1"
        ));
        assert!(allowed(Channel::Nightly, &nightly, "0.2.11"));
        assert!(!allowed(
            Channel::Nightly,
            &nightly,
            "0.2.11-nightly.20261119.1"
        ));
        assert!(!allowed(Channel::Nightly, &nightly, "not a version"));
    }

    #[test]
    fn the_newest_of_the_feeds_is_taken() {
        type R = Result<Option<(&'static str, semver::Version)>, &'static str>;
        let stable: R = Ok(Some(("stable", v("0.2.11"))));
        let nightly: R = Ok(Some(("nightly", v("0.2.12-nightly.20261121.3"))));
        assert_eq!(
            newest(vec![stable.clone(), nightly.clone()])
                .unwrap()
                .unwrap()
                .0,
            "nightly"
        );
        // A stable newer than the last nightly wins.
        let older: R = Ok(Some(("nightly", v("0.2.11-nightly.20261120.1"))));
        assert_eq!(
            newest(vec![stable.clone(), older]).unwrap().unwrap().0,
            "stable"
        );
        // No nightly feed yet: what Stable says.
        assert_eq!(
            newest(vec![stable.clone(), Err("404")]).unwrap().unwrap().0,
            "stable"
        );
        assert_eq!(
            newest::<&str, &str>(vec![Ok(None), Err("404")]).unwrap(),
            None
        );
        assert_eq!(
            newest::<&str, &str>(vec![Err("offline"), Err("404")]),
            Err("offline")
        );
        assert_eq!(newest::<&str, &str>(vec![]), Ok(None));
    }

    #[test]
    fn sessions_to_resume_are_read_once() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        assert!(resume_take(&paths).unwrap().is_empty());
        resume_later(&paths, &["a".into(), "b".into()]).unwrap();
        assert_eq!(resume_take(&paths).unwrap(), vec!["a", "b"]);
        assert!(resume_take(&paths).unwrap().is_empty());
    }
}
