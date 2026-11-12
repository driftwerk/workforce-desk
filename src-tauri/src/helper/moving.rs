//! "Move it for me": a Mac app opened from its disk image or from
//! Downloads runs from a randomised read-only copy, where Desk Helper's
//! login item would vanish. Desk copies itself to the Applications folder,
//! clears the download mark on the copy (or macOS would move it aside
//! again), puts an older Desk that was there in the Trash, and opens the
//! copy once this one has quit. The steps follow LetsMove's.
//!
//! What decides where things go is here and plain; what runs `ditto`,
//! `xattr` and `open` is the Mac's alone.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// The `.app` bundle the program at `exe` runs from
/// (`…/Desk.app/Contents/MacOS/desk`).
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let named = |p: &Path, name: &str| p.file_name() == Some(OsStr::new(name));
    (named(macos, "MacOS")
        && named(contents, "Contents")
        && bundle.extension() == Some(OsStr::new("app")))
    .then(|| bundle.to_path_buf())
}

/// Where the bundle named `name` goes: the Applications folder when Desk
/// may write there, else the person's own (`~/Applications`).
pub fn destination(
    name: &OsStr,
    system: &Path,
    user: &Path,
    writable: impl Fn(&Path) -> bool,
) -> PathBuf {
    match writable(system) {
        true => system.join(name),
        false => user.join(name),
    }
}

/// A name for `name` in `trash` that nothing there has yet: `Desk.app`,
/// then `Desk 2.app`, `Desk 3.app`, …
pub fn trashed_as(trash: &Path, name: &OsStr, taken: impl Fn(&Path) -> bool) -> PathBuf {
    let first = trash.join(name);
    if !taken(&first) {
        return first;
    }
    let path = Path::new(name);
    let stem = path.file_stem().unwrap_or(name).to_string_lossy();
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    (2..)
        .map(|n| trash.join(format!("{stem} {n}{ext}")))
        .find(|p| !taken(p))
        .expect("an unused name")
}

/// What opens `app` once the process `pid` has quit: run detached by
/// `/bin/sh`, so the new Desk never finds this one still running.
pub fn reopen_script(pid: u32, app: &Path) -> String {
    let app = app.to_string_lossy().replace('\'', r"'\''");
    format!("while kill -0 {pid} 2>/dev/null; do sleep 0.2; done; exec /usr/bin/open '{app}'")
}

/// Whether the app already at the destination may go to the Trash: only
/// a Desk, the same app as the one running (by its bundle identifier).
/// Anything else, or one whose identifier can't be read, is left alone.
pub fn may_replace(there: Option<&str>, ours: Option<&str>) -> bool {
    matches!((there, ours), (Some(a), Some(b)) if a == b)
}

/// Whether Desk may make files in `dir`.
pub fn writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".desk-move-{}", std::process::id()));
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};

    use eyre::{Result, bail, eyre};

    use super::{bundle_of, destination, may_replace, trashed_as, writable};

    /// An app's bundle identifier, from its `Contents/Info.plist`.
    fn bundle_id(app: &Path) -> Option<String> {
        let info: plist::Dictionary = plist::from_file(app.join("Contents/Info.plist")).ok()?;
        info.get("CFBundleIdentifier")?
            .as_string()
            .map(str::to_string)
    }

    /// Copies the running Desk into Applications and answers where it went.
    /// The copy is complete before anything that was there is touched.
    pub fn copy_to_applications(exe: &Path) -> Result<PathBuf> {
        let Some(bundle) = bundle_of(exe) else {
            bail!("Desk isn't running from its app, so there's nothing to move");
        };
        let home = std::env::var_os("HOME")
            .filter(|h| !h.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| {
                eyre!("Desk can't tell where your home folder is, so it moves nothing")
            })?;
        let user_apps = home.join("Applications");
        let name = bundle.file_name().unwrap_or_default().to_owned();
        let dest = destination(&name, Path::new("/Applications"), &user_apps, writable);
        if dest == bundle {
            bail!("Desk is already in your Applications folder");
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Made beside the destination, then put in its place.
        let staged = dest.with_extension(format!("app.desk-move-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&staged);
        let copied = Command::new("/usr/bin/ditto")
            .arg(&bundle)
            .arg(&staged)
            .stdin(Stdio::null())
            .output()?;
        if !copied.status.success() {
            let _ = std::fs::remove_dir_all(&staged);
            tracing::warn!(
                stderr = %String::from_utf8_lossy(&copied.stderr).trim(),
                "could not copy Desk to Applications"
            );
            bail!("Desk couldn't copy itself to your Applications folder");
        }
        // The copy keeps the download mark, and macOS would run it from a
        // randomised copy again.
        let cleared = Command::new("/usr/bin/xattr")
            .args(["-dr", "com.apple.quarantine"])
            .arg(&staged)
            .stdin(Stdio::null())
            .output();
        if !cleared.as_ref().is_ok_and(|o| o.status.success()) {
            let _ = std::fs::remove_dir_all(&staged);
            tracing::warn!(?cleared, "could not clear the download mark on Desk's copy");
            bail!("Desk couldn't finish its copy in your Applications folder");
        }
        let mut trashed = None;
        if dest.exists() {
            let folder = dest.parent().unwrap_or(&dest).display().to_string();
            if !may_replace(bundle_id(&dest).as_deref(), bundle_id(&bundle).as_deref()) {
                let _ = std::fs::remove_dir_all(&staged);
                bail!(
                    "{folder} already has a {} that isn't this Desk, so Desk leaves it. Rename or \
                     move it, then try again",
                    name.to_string_lossy()
                );
            }
            let trash = home.join(".Trash");
            let to = trashed_as(&trash, &name, |p| p.exists());
            if let Err(e) = std::fs::rename(&dest, &to) {
                let _ = std::fs::remove_dir_all(&staged);
                tracing::warn!(error = %e, "could not put the older Desk in the Trash");
                bail!(
                    "Desk couldn't replace the Desk already in your Applications folder: quit \
                     it, put it in the Trash, then try again"
                );
            }
            trashed = Some(to);
        }
        if let Err(e) = std::fs::rename(&staged, &dest) {
            // Put back what was there, and leave no half-made copy.
            if let Some(to) = &trashed {
                let _ = std::fs::rename(to, &dest);
            }
            let _ = std::fs::remove_dir_all(&staged);
            tracing::warn!(error = %e, "could not put Desk's copy in Applications");
            bail!("Desk couldn't put its copy in your Applications folder; nothing was changed");
        }
        Ok(dest)
    }

    /// Opens `app` once this process has quit.
    pub fn reopen_after_exit(app: &Path) -> Result<()> {
        Command::new("/bin/sh")
            .arg("-c")
            .arg(super::reopen_script(std::process::id(), app))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub use mac::{copy_to_applications, reopen_after_exit};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundle_is_the_app_the_program_is_inside() {
        let exe =
            Path::new("/private/var/folders/x/AppTranslocation/ab/d/Desk.app/Contents/MacOS/desk");
        assert_eq!(
            bundle_of(exe),
            Some(PathBuf::from(
                "/private/var/folders/x/AppTranslocation/ab/d/Desk.app"
            ))
        );
        assert_eq!(bundle_of(Path::new("/usr/local/bin/desk")), None);
        assert_eq!(bundle_of(Path::new("/tmp/Desk/Contents/MacOS/desk")), None);
    }

    #[test]
    fn it_goes_to_applications_or_the_persons_own() {
        let name = OsStr::new("Desk.app");
        let system = Path::new("/Applications");
        let user = Path::new("/Users/me/Applications");
        assert_eq!(
            destination(name, system, user, |_| true),
            PathBuf::from("/Applications/Desk.app")
        );
        assert_eq!(
            destination(name, system, user, |_| false),
            PathBuf::from("/Users/me/Applications/Desk.app")
        );
    }

    #[test]
    fn an_older_desk_goes_to_the_trash_under_a_free_name() {
        let trash = Path::new("/Users/me/.Trash");
        let name = OsStr::new("Desk.app");
        assert_eq!(trashed_as(trash, name, |_| false), trash.join("Desk.app"));
        let taken = [trash.join("Desk.app"), trash.join("Desk 2.app")];
        assert_eq!(
            trashed_as(trash, name, |p| taken.iter().any(|t| t == p)),
            trash.join("Desk 3.app")
        );
    }

    #[test]
    fn the_copy_opens_only_after_this_desk_quits() {
        let script = reopen_script(4242, Path::new("/Users/o'neil/Applications/Desk.app"));
        assert!(script.starts_with("while kill -0 4242 "), "{script}");
        assert!(
            script.ends_with(r"exec /usr/bin/open '/Users/o'\''neil/Applications/Desk.app'"),
            "{script}"
        );
    }

    #[test]
    fn only_this_same_desk_is_ever_put_in_the_trash() {
        let ours = Some("xyz.driftwerk.desk");
        assert!(may_replace(Some("xyz.driftwerk.desk"), ours));
        assert!(!may_replace(Some("com.example.other"), ours));
        assert!(!may_replace(None, ours), "unreadable: left alone");
        assert!(!may_replace(Some("xyz.driftwerk.desk"), None));
    }

    #[test]
    fn writable_says_whether_a_file_can_be_made() {
        let dir = tempfile::tempdir().unwrap();
        assert!(writable(dir.path()));
        assert!(!writable(&dir.path().join("missing")));
    }
}
