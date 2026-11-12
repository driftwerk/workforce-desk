//! The system's privacy settings, natively: the exact pane where the person
//! lets Desk use the microphone, read their files, and so on, and whether
//! it may already. The page's opener only opens web links, so a
//! `x-apple.systempreferences:` or `ms-settings:` link from it does nothing.

use serde::{Deserialize, Serialize};

/// A permission the system asks the person for, by its pane.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Pane {
    FullDiskAccess,
    Microphone,
    Accessibility,
    FilesAndFolders,
    LoginItems,
}

/// Whether Desk has a permission, as far as the system tells.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Access {
    Granted,
    Denied,
    /// Not asked yet: the system asks the first time Desk uses it.
    NotAsked,
    /// The system doesn't say (or has no such permission).
    Unknown,
}

/// Where `pane` is on `os` (`std::env::consts::OS`); none where that
/// system has no such setting.
pub fn address(pane: Pane, os: &str) -> Option<&'static str> {
    match os {
        "macos" => Some(match pane {
            Pane::FullDiskAccess => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
            }
            Pane::Microphone => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            }
            Pane::Accessibility => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
            Pane::FilesAndFolders => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"
            }
            Pane::LoginItems => "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
        }),
        // Windows has no Full Disk Access nor Accessibility permission:
        // its broad file system access and Accessibility settings are the
        // nearest.
        "windows" => Some(match pane {
            Pane::FullDiskAccess | Pane::FilesAndFolders => {
                "ms-settings:privacy-broadfilesystemaccess"
            }
            Pane::Microphone => "ms-settings:privacy-microphone",
            Pane::Accessibility => "ms-settings:easeofaccess",
            Pane::LoginItems => "ms-settings:startupapps",
        }),
        _ => None,
    }
}

/// What the person calls `pane`'s settings on `os`, for a refusal.
fn named(pane: Pane) -> &'static str {
    match pane {
        Pane::FullDiskAccess => "Full Disk Access",
        Pane::Microphone => "microphone",
        Pane::Accessibility => "Accessibility",
        Pane::FilesAndFolders => "Files and Folders",
        Pane::LoginItems => "Login Items",
    }
}

/// Opens `pane` in the system's settings.
#[tauri::command]
pub async fn privacy_open(pane: Pane) -> Result<(), String> {
    let os = std::env::consts::OS;
    let Some(to) = address(pane, os) else {
        return Err(format!(
            "This computer has no {} setting to open.",
            named(pane)
        ));
    };
    tauri::async_runtime::spawn_blocking(move || open(to))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| {
            tracing::warn!(?pane, error = %e, "couldn't open the system's privacy settings");
            format!(
                "Desk couldn't open the {} settings. Open System Settings → Privacy & Security yourself.",
                named(pane)
            )
        })
}

#[cfg(target_os = "macos")]
fn open(to: &str) -> std::io::Result<()> {
    let status = std::process::Command::new("/usr/bin/open")
        .arg(to)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(format!("open said {status}")))
    }
}

#[cfg(windows)]
fn open(to: &str) -> std::io::Result<()> {
    // By its full path, never one found on PATH. explorer.exe answers 1 even
    // when it opened the page: started is enough.
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    std::process::Command::new(std::path::Path::new(&root).join("explorer.exe"))
        .arg(to)
        .spawn()
        .map(|_| ())
}

#[cfg(not(any(target_os = "macos", windows)))]
fn open(_: &str) -> std::io::Result<()> {
    Err(std::io::Error::other("no privacy settings here"))
}

/// Whether Desk has `pane`'s permission now: asked again when Desk comes
/// back to the front, so a problem clears once the person allowed it.
#[tauri::command]
pub async fn privacy_check(pane: Pane) -> Access {
    tauri::async_runtime::spawn_blocking(move || check(pane))
        .await
        .unwrap_or(Access::Unknown)
}

fn check(pane: Pane) -> Access {
    match pane {
        Pane::Microphone => match desk_voice::audio::mic_access() {
            desk_voice::audio::MicAccess::Granted => Access::Granted,
            desk_voice::audio::MicAccess::Denied => Access::Denied,
            desk_voice::audio::MicAccess::NotAsked => Access::NotAsked,
            desk_voice::audio::MicAccess::Unknown => Access::Unknown,
        },
        Pane::Accessibility => accessibility(),
        // What needs Full Disk Access is Desk's helper, which runs the
        // agents: the hub reads its access (`/api/desk/computer/disk-access`).
        // Files and Folders and Login Items say nothing to ask.
        Pane::FullDiskAccess | Pane::FilesAndFolders | Pane::LoginItems => Access::Unknown,
    }
}

#[cfg(target_os = "macos")]
fn accessibility() -> Access {
    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> u8;
    }
    // SAFETY: takes nothing and reads whether this process is trusted.
    if unsafe { AXIsProcessTrusted() } != 0 {
        Access::Granted
    } else {
        Access::Denied
    }
}

#[cfg(not(target_os = "macos"))]
fn accessibility() -> Access {
    Access::Unknown
}

/// Whether `e` is macOS's privacy protection keeping Desk out: EPERM
/// ("Operation not permitted"), which a setting of Desk's changes. A file's
/// own mode or owner says EACCES instead, which no setting changes.
pub fn kept_by_privacy(e: &std::io::Error) -> bool {
    cfg!(target_os = "macos") && is_eperm(e)
}

fn is_eperm(e: &std::io::Error) -> bool {
    // EPERM is 1 on every Unix.
    cfg!(unix) && e.raw_os_error() == Some(1)
}

/// Whether `e` is the file itself not letting Desk read it (its mode, its
/// owner, Windows' access list), as opposed to a privacy setting.
pub fn not_permitted(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::PermissionDenied && !kept_by_privacy(e)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_pane_opens_where_its_system_keeps_it() {
        for (pane, mac, windows) in [
            (
                Pane::FullDiskAccess,
                "Privacy_AllFiles",
                "privacy-broadfilesystemaccess",
            ),
            (Pane::Microphone, "Privacy_Microphone", "privacy-microphone"),
            (Pane::Accessibility, "Privacy_Accessibility", "easeofaccess"),
            (
                Pane::FilesAndFolders,
                "Privacy_FilesAndFolders",
                "privacy-broadfilesystemaccess",
            ),
            (Pane::LoginItems, "LoginItems-Settings", "startupapps"),
        ] {
            let m = address(pane, "macos").unwrap();
            assert!(
                m.starts_with("x-apple.systempreferences:") && m.contains(mac),
                "{m}"
            );
            let w = address(pane, "windows").unwrap();
            assert!(w.starts_with("ms-settings:") && w.contains(windows), "{w}");
            assert_eq!(address(pane, "linux"), None);
        }
    }

    #[test]
    fn a_pane_is_named_by_the_page_as_the_command_takes_it() {
        let pane: Pane = serde_json::from_str("\"fullDiskAccess\"").unwrap();
        assert_eq!(pane, Pane::FullDiskAccess);
        let pane: Pane = serde_json::from_str("\"filesAndFolders\"").unwrap();
        assert_eq!(pane, Pane::FilesAndFolders);
        assert_eq!(
            serde_json::to_string(&Access::NotAsked).unwrap(),
            "\"notAsked\""
        );
    }

    #[test]
    fn only_eperm_on_macos_is_a_privacy_setting_and_a_files_own_mode_is_not() {
        use std::io::{Error, ErrorKind};
        let not_found = Error::from(ErrorKind::NotFound);
        assert!(!kept_by_privacy(&not_found) && !not_permitted(&not_found));
        #[cfg(unix)]
        {
            let eperm = Error::from_raw_os_error(1);
            let eacces = Error::from_raw_os_error(13);
            assert_eq!(kept_by_privacy(&eperm), cfg!(target_os = "macos"));
            assert!(!kept_by_privacy(&eacces));
            assert!(not_permitted(&eacces));
            assert_eq!(not_permitted(&eperm), !cfg!(target_os = "macos"));
        }
    }
}
