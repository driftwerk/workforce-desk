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
