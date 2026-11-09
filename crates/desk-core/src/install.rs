//! How Desk was installed: which says what an update replaces under Desk
//! Helper (so it stops and lets the new one start), how the system starts
//! the helper at login, and whether the app updates itself.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::Paths;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Install {
    /// In `Desk.app/Contents/MacOS`, replaced whole by an update.
    MacBundle,
    /// Run from a mounted AppImage; an update replaces the file at `path`.
    AppImage { path: PathBuf },
    /// Installed by the system's package manager, which replaces the
    /// programs in place.
    Package,
    /// One of the versions Desk installs under `bin` — inside WSL from
    /// Windows, on a machine from the Mac: an update installs another and
    /// flips `bin/current` to it.
    Versioned { bin: PathBuf },
    /// A development build, left running whatever is rebuilt.
    Development,
}

/// A path with its links resolved, where it can be (a home reached through
/// a symlink, `/home` → `/data/home`); as given where it can't.
fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

impl Install {
    pub fn of(exe: &Path, env: &BTreeMap<String, String>, paths: &Paths) -> Install {
        if exe.to_string_lossy().contains(".app/Contents/MacOS/") {
            Install::MacBundle
        } else if let Some(path) = env.get("APPIMAGE") {
            Install::AppImage { path: path.into() }
        } else if canonical(exe).starts_with(canonical(&paths.bin())) {
            Install::Versioned { bin: paths.bin() }
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
            Install::Versioned { bin } => programs
                .iter()
                .filter_map(|p| p.file_name())
                .map(|name| bin.join("current").join(name))
                .collect(),
            Install::Development => Vec::new(),
        }
    }
}

/// Whether `exe` is the program of a macOS app bundle,
/// `<Name>.app/Contents/MacOS/<program>`: the only shape an update may
/// replace on macOS. The updater takes whatever two folders up from the
/// program's folder as the bundle, so anything else (a development build
/// in `target/debug`) would have that folder's contents replaced.
pub fn in_mac_bundle(exe: &Path) -> bool {
    let mut up = exe.ancestors().skip(1);
    let (Some(macos), Some(contents), Some(app)) = (up.next(), up.next(), up.next()) else {
        return false;
    };
    macos.file_name().is_some_and(|n| n == "MacOS")
        && contents.file_name().is_some_and(|n| n == "Contents")
        && app.extension().is_some_and(|e| e == "app")
        && app.file_stem().is_some_and(|n| !n.is_empty())
}

/// Whether `exe` runs straight from a build's output folder
/// (`target/debug`, `target/release`, `target/<triple>/debug`): a build,
/// never an install.
pub fn in_build_folder(exe: &Path) -> bool {
    let Some(dir) = exe.parent() else {
        return false;
    };
    if !dir
        .file_name()
        .is_some_and(|n| n == "debug" || n == "release")
    {
        return false;
    }
    dir.ancestors()
        .skip(1)
        .take(2)
        .any(|a| a.file_name().is_some_and(|n| n == "target"))
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
            Install::Versioned {
                bin: "/home/sarah/.local/share/Desk/bin".into()
            }
        );
        assert_eq!(
            of("/home/sarah/src/desk/target/debug/desk-hubd", &[]),
            Install::Development
        );
    }

    /// The running program's path has its links resolved; Desk's folder may
    /// be named through one (a home on another disk).
    #[cfg(unix)]
    #[test]
    fn a_version_is_recognised_through_a_linked_home() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("data/home/ana");
        std::fs::create_dir_all(real.join(".local/share/Desk/bin/0.3.0")).unwrap();
        std::fs::write(real.join(".local/share/Desk/bin/0.3.0/desk-helper"), "").unwrap();
        std::os::unix::fs::symlink(dir.path().join("data/home"), dir.path().join("home")).unwrap();
        let paths = Paths::at(dir.path().join("home/ana/.local/share/Desk"));
        let exe = real
            .join(".local/share/Desk/bin/0.3.0/desk-helper")
            .canonicalize()
            .unwrap();
        assert_eq!(
            Install::of(&exe, &BTreeMap::new(), &paths),
            Install::Versioned { bin: paths.bin() }
        );
    }

    #[test]
    fn only_a_program_inside_an_app_bundle_is_in_one() {
        for exe in [
            "/Applications/Desk.app/Contents/MacOS/desk",
            "/Users/ana/Applications/Desk.app/Contents/MacOS/desk",
            "/Users/ana/src/desk/target/release/bundle/macos/Desk.app/Contents/MacOS/desk",
        ] {
            assert!(in_mac_bundle(Path::new(exe)), "{exe}");
        }
        for exe in [
            // A development build: what an update emptied on 11/09.
            "/Users/ana/src/desk/target/debug/desk",
            "/Users/ana/src/desk/target/release/desk",
            // A bundle's other programs, and look-alikes.
            "/Applications/Desk.app/Contents/Resources/desk",
            "/Applications/Desk.app/Contents/MacOS/helpers/desk",
            "/Applications/Desk/Contents/MacOS/desk",
            "/Applications/.app/Contents/MacOS/desk",
            "/tmp/x.app/Contents/MacOS.bak/desk",
            "Contents/MacOS/desk",
            "desk",
            "",
        ] {
            assert!(!in_mac_bundle(Path::new(exe)), "{exe}");
        }
    }

    #[test]
    fn a_program_in_a_build_folder_is_a_build() {
        for exe in [
            "/Users/ana/src/desk/target/debug/desk",
            "/Users/ana/src/desk/target/release/desk",
            "/home/ana/src/desk/target/x86_64-unknown-linux-gnu/release/desk",
            "C:/src/desk/target/debug/desk.exe",
        ] {
            assert!(in_build_folder(Path::new(exe)), "{exe}");
        }
        for exe in [
            "/Applications/Desk.app/Contents/MacOS/desk",
            "/usr/bin/desk",
            "/home/ana/release/desk",
            "/home/ana/target/desk",
            "C:/Program Files/Desk/desk.exe",
            "desk",
        ] {
            assert!(!in_build_folder(Path::new(exe)), "{exe}");
        }
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
            Install::Versioned {
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
