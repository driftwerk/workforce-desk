//! Updates: whether this install updates itself, and the sessions to resume
//! after Desk restarts into an update (written just before the restart, read
//! once by the new version when it connects).

use desk_core::Paths;
use desk_core::install::Install;
use eyre::Result;
use serde::Serialize;

/// How this install of Desk gets a new version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Updating {
    /// Whether the app downloads and installs it itself; a package from the
    /// system's package manager is updated by that instead.
    pub by_itself: bool,
    /// Where a new version can be downloaded by hand.
    pub download: Option<String>,
}

/// The releases page an updater endpoint
/// (`…/releases/latest/download/latest.json`) belongs to.
pub fn download_page(endpoint: &str) -> Option<String> {
    endpoint
        .strip_suffix("/download/latest.json")
        .map(str::to_string)
}

pub fn updating(install: &Install, endpoint: Option<&str>) -> Updating {
    Updating {
        by_itself: !matches!(install, Install::Package),
        download: endpoint.and_then(download_page),
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

    #[test]
    fn a_package_is_updated_by_its_package_manager() {
        let endpoint =
            "https://github.com/driftwerk/workforce-desk/releases/latest/download/latest.json";
        assert_eq!(
            updating(&Install::Package, Some(endpoint)),
            Updating {
                by_itself: false,
                download: Some(
                    "https://github.com/driftwerk/workforce-desk/releases/latest".into()
                ),
            }
        );
        assert!(
            updating(
                &Install::AppImage {
                    path: "/home/sarah/Desk.AppImage".into()
                },
                Some(endpoint)
            )
            .by_itself
        );
        assert!(updating(&Install::MacBundle, None).by_itself);
        assert_eq!(download_page("https://example.com/feed.json"), None);
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
