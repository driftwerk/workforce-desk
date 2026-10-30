//! How this Desk Helper was installed, which says what an update replaces
//! under it, so it can stop and let the new one start.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use desk_core::Paths;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Install {
    /// In `Desk.app/Contents/MacOS`, replaced whole by an update.
    MacBundle,
    /// Run from a mounted AppImage; an update replaces the file at `path`.
    AppImage { path: PathBuf },
    /// Installed by the system's package manager, which replaces the
    /// programs in place.
    Package,
    /// One of the versions Desk on Windows installs inside WSL, under
    /// `bin`: an update installs another and flips `bin/current` to it.
    Wsl { bin: PathBuf },
    /// A development build, left running whatever is rebuilt.
    Development,
}

impl Install {
    pub fn of(exe: &Path, env: &BTreeMap<String, String>, paths: &Paths) -> Install {
        if exe.to_string_lossy().contains(".app/Contents/MacOS/") {
            Install::MacBundle
        } else if let Some(path) = env.get("APPIMAGE") {
            Install::AppImage { path: path.into() }
        } else if exe.starts_with(paths.bin()) {
            Install::Wsl { bin: paths.bin() }
        } else if exe.starts_with("/usr/") || exe.starts_with("/opt/") {
            Install::Package
        } else {
            Install::Development
        }
    }

    /// The files whose replacement means an update: given the programs this
    /// helper runs (itself, the hub, the memory store).
    pub fn watched(&self, programs: &[PathBuf]) -> Vec<PathBuf> {
        match self {
            Install::MacBundle | Install::Package => programs.to_vec(),
            Install::AppImage { path } => vec![path.clone()],
            // Through `current`: the flip points it at the new version's
            // files, and their metadata (read through the link) changes.
            Install::Wsl { bin } => programs
                .iter()
                .filter_map(|p| p.file_name())
                .map(|name| bin.join("current").join(name))
                .collect(),
            Install::Development => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths() -> Paths {
        Paths::at("/home/sarah/.local/share/Desk")
    }

    fn of(exe: &str, env: &[(&str, &str)]) -> Install {
        let env = env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Install::of(Path::new(exe), &env, &paths())
    }

    #[test]
    fn each_kind_of_install_is_recognised() {
        assert_eq!(
            of("/Applications/Desk.app/Contents/MacOS/Desk Helper", &[]),
            Install::MacBundle
        );
        assert_eq!(
            of(
                "/tmp/.mount_DeskAb12/usr/bin/desk-helper",
                &[("APPIMAGE", "/home/sarah/Apps/Desk.AppImage")]
            ),
            Install::AppImage {
                path: "/home/sarah/Apps/Desk.AppImage".into()
            }
        );
        assert_eq!(of("/usr/bin/desk-helper", &[]), Install::Package);
        assert_eq!(
            of("/home/sarah/.local/share/Desk/bin/0.3.0/desk-helper", &[]),
            Install::Wsl {
                bin: "/home/sarah/.local/share/Desk/bin".into()
            }
        );
        assert_eq!(
            of("/home/sarah/src/desk/target/debug/desk-hubd", &[]),
            Install::Development
        );
    }

    #[test]
    fn each_install_watches_what_its_update_replaces() {
        let programs = [
            PathBuf::from("/usr/bin/desk-helper"),
            PathBuf::from("/usr/bin/desk-agents"),
        ];
        assert_eq!(Install::Package.watched(&programs), programs);
        assert_eq!(Install::MacBundle.watched(&programs), programs);
        assert_eq!(
            Install::AppImage {
                path: "/home/sarah/Desk.AppImage".into()
            }
            .watched(&programs),
            [PathBuf::from("/home/sarah/Desk.AppImage")]
        );
        let wsl = [
            PathBuf::from("/home/sarah/.local/share/Desk/bin/0.3.0/desk-helper"),
            PathBuf::from("/home/sarah/.local/share/Desk/bin/0.3.0/desk-memory"),
        ];
        assert_eq!(
            Install::Wsl {
                bin: "/home/sarah/.local/share/Desk/bin".into()
            }
            .watched(&wsl),
            [
                PathBuf::from("/home/sarah/.local/share/Desk/bin/current/desk-helper"),
                PathBuf::from("/home/sarah/.local/share/Desk/bin/current/desk-memory"),
            ]
        );
        assert!(Install::Development.watched(&programs).is_empty());
    }
}
