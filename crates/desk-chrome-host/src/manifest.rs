//! Where Chrome looks for Desk's host, and what Desk writes there: Google
//! Chrome only, for this person only.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::{HOST, origin_of};

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct HostManifest {
    pub name: &'static str,
    pub description: &'static str,
    pub path: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub allowed_origins: Vec<String>,
}

/// The manifest for the host at `exe`, serving extensions `ids` and no
/// other.
pub fn manifest(exe: &Path, ids: &[&str]) -> HostManifest {
    HostManifest {
        name: HOST,
        description: "Desk: lets Desk's Chrome extension reach the Desk app on this computer",
        path: exe.to_string_lossy().into_owned(),
        kind: "stdio",
        allowed_origins: ids.iter().map(|id| origin_of(id)).collect(),
    }
}

/// The folder Google Chrome reads hosts from for this person, on macOS and
/// Linux (`home` is theirs). On Windows a registry key names the manifest
/// instead ([`registry_key`]).
pub fn hosts_folder(os: &str, home: &Path) -> Option<PathBuf> {
    match os {
        "macos" => {
            Some(home.join("Library/Application Support/Google/Chrome/NativeMessagingHosts"))
        }
        "linux" => Some(home.join(".config/google-chrome/NativeMessagingHosts")),
        _ => None,
    }
}

/// The key under HKEY_CURRENT_USER whose default value is the manifest's
/// path, on Windows.
pub fn registry_key() -> String {
    format!(r"Software\Google\Chrome\NativeMessagingHosts\{HOST}")
}

/// The manifest's file name.
pub fn file_name() -> String {
    format!("{HOST}.json")
}

/// Writes the manifest into `folder` (made when missing), replacing what
/// was there: Desk does it at every start, so the path follows the
/// installed helper. With no extension to serve, any manifest there is
/// removed instead.
pub fn write(folder: &Path, m: &HostManifest) -> std::io::Result<PathBuf> {
    let file = folder.join(file_name());
    if m.allowed_origins.is_empty() {
        match std::fs::remove_file(&file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
            _ => return Ok(file),
        }
    }
    std::fs::create_dir_all(folder)?;
    let body = serde_json::to_string_pretty(m).map_err(std::io::Error::other)?;
    let tmp = folder.join(format!(".{}.tmp", file_name()));
    std::fs::write(&tmp, body + "\n")?;
    std::fs::rename(&tmp, &file)?;
    Ok(file)
}

/// Points Chrome at the manifest on Windows.
#[cfg(windows)]
pub fn register(file: &Path) -> eyre::Result<()> {
    let key = windows_registry::CURRENT_USER.create(registry_key())?;
    key.set_string("", file.to_string_lossy().as_ref())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_manifest_names_the_helper_and_only_desks_extension() {
        let m = manifest(
            Path::new("/Applications/Desk.app/Contents/MacOS/Desk Helper"),
            &["abcdefghijklmnopabcdefghijklmnop"],
        );
        let json: serde_json::Value = serde_json::to_value(&m).unwrap();
        assert_eq!(json["name"], "xyz.driftwerk.desk");
        assert_eq!(json["type"], "stdio");
        assert_eq!(
            json["path"],
            "/Applications/Desk.app/Contents/MacOS/Desk Helper"
        );
        assert_eq!(
            json["allowed_origins"],
            serde_json::json!(["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"])
        );
        assert!(!json.to_string().contains('*'), "no wildcard");
    }

    #[test]
    fn it_goes_where_google_chrome_reads_it_for_this_person() {
        let home = Path::new("/Users/sarah");
        assert_eq!(
            hosts_folder("macos", home).unwrap(),
            Path::new(
                "/Users/sarah/Library/Application Support/Google/Chrome/NativeMessagingHosts"
            )
        );
        assert_eq!(
            hosts_folder("linux", Path::new("/home/sarah")).unwrap(),
            Path::new("/home/sarah/.config/google-chrome/NativeMessagingHosts")
        );
        assert_eq!(hosts_folder("windows", home), None);
        assert_eq!(
            registry_key(),
            r"Software\Google\Chrome\NativeMessagingHosts\xyz.driftwerk.desk"
        );
    }

    #[test]
    fn it_is_written_whole_and_removed_when_nothing_is_served() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("NativeMessagingHosts");
        let file = write(
            &folder,
            &manifest(
                Path::new("/x/helper"),
                &["abcdefghijklmnopabcdefghijklmnop"],
            ),
        )
        .unwrap();
        let read: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(read["path"], "/x/helper");
        write(&folder, &manifest(Path::new("/x/helper"), &[])).unwrap();
        assert!(!file.exists());
        assert_eq!(
            std::fs::read_dir(&folder).unwrap().count(),
            0,
            "nothing left behind"
        );
    }
}
