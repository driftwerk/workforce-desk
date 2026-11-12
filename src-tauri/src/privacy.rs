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
    // explorer.exe answers 1 even when it opened the page: started is enough.
    std::process::Command::new("explorer.exe")
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
        Pane::FullDiskAccess => full_disk_access(),
        Pane::FilesAndFolders | Pane::LoginItems => Access::Unknown,
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

/// Full Disk Access, by whether Desk can open the one file macOS keeps from
/// every app without it.
#[cfg(target_os = "macos")]
fn full_disk_access() -> Access {
    let Some(home) = std::env::var_os("HOME") else {
        return Access::Unknown;
    };
    let tcc = std::path::Path::new(&home).join("Library/Application Support/com.apple.TCC/TCC.db");
    access_of(std::fs::File::open(tcc).map(|_| ()))
}

#[cfg(not(target_os = "macos"))]
fn full_disk_access() -> Access {
    Access::Unknown
}

/// What reading a protected file says of the permission.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn access_of(read: std::io::Result<()>) -> Access {
    match read {
        Ok(()) => Access::Granted,
        Err(e) if denied(&e) => Access::Denied,
        Err(_) => Access::Unknown,
    }
}

/// Whether `e` is the system keeping Desk out (macOS's privacy protection
/// says EPERM, "Operation not permitted"; a file's own mode EACCES).
pub fn denied(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::PermissionDenied
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
    fn being_kept_out_of_a_protected_file_is_a_denial_and_anything_else_unknown() {
        use std::io::{Error, ErrorKind};
        // EPERM, as macOS's privacy protection says it.
        #[cfg(unix)]
        assert_eq!(access_of(Err(Error::from_raw_os_error(1))), Access::Denied);
        assert_eq!(
            access_of(Err(Error::from(ErrorKind::PermissionDenied))),
            Access::Denied
        );
        assert_eq!(
            access_of(Err(Error::from(ErrorKind::NotFound))),
            Access::Unknown
        );
        assert_eq!(access_of(Ok(())), Access::Granted);
    }
}
