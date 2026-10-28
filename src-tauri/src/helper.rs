//! Desk Helper — `desk-hubd`, which keeps the local hub and every session it
//! hosts running from login, independent of this window — as a login item
//! the way macOS wants one: its plist ships inside the bundle at
//! `Contents/Library/LaunchAgents`, and `SMAppService` registers it. It shows
//! in System Settings → Login Items as Desk, and leaves with the app.
//!
//! A development run (`DESK_HOME` set, or not running from a bundle)
//! registers nothing: it talks to a supervisor started by hand.
//! `DESK_REGISTER_HELPER=1` registers the bundled helper anyway, for testing
//! a build against a throwaway `DESK_HOME`.

use std::path::{Path, PathBuf};
use std::process::Command;

use desk_core::{LAUNCH_AGENT_LABEL, LEGACY_LAUNCH_AGENT_LABEL, Paths};
use eyre::Result;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum Status {
    /// Registered and allowed: launchd runs it from login.
    Running,
    /// Registered, but the person turned Desk off in Login Items (or hasn't
    /// allowed it yet).
    NeedsApproval,
    NotRegistered,
    /// Running from the disk image or Downloads (macOS runs such apps from a
    /// randomised read-only copy): a login item there would vanish.
    MoveToApplications,
    /// A development run: the supervisor is started by hand.
    Development,
    Failed {
        message: String,
    },
}

impl Status {
    /// Why the helper can't run, in the person's words, when it can't.
    pub fn blocked(&self) -> Option<String> {
        match self {
            Status::MoveToApplications => Some(
                "Move Desk to your Applications folder, then open it from there.".into(),
            ),
            Status::NeedsApproval => Some(
                "Desk Helper is turned off. Turn Desk on in System Settings → General → Login Items, then open Desk again.".into(),
            ),
            Status::Failed { message } => Some(format!("Desk Helper couldn't start: {message}")),
            Status::Running | Status::NotRegistered | Status::Development => None,
        }
    }
}

fn plist_name() -> String {
    format!("{LAUNCH_AGENT_LABEL}.plist")
}

/// The bundled agent plist, when this executable runs from Desk.app.
pub fn bundled_plist(exe: &Path) -> Option<PathBuf> {
    let contents = exe.parent()?.parent()?;
    let plist = contents.join("Library/LaunchAgents").join(plist_name());
    plist.is_file().then_some(plist)
}

/// Gatekeeper's randomised copy of an app opened where it was downloaded,
/// or the app still on its disk image.
pub fn translocated(exe: &Path) -> bool {
    let s = exe.to_string_lossy();
    s.contains("/AppTranslocation/") || s.starts_with("/Volumes/")
}

/// Whether this run manages the login item at all.
fn managed(exe: &Path) -> bool {
    let dev = std::env::var_os("DESK_HOME").is_some()
        && std::env::var("DESK_REGISTER_HELPER").as_deref() != Ok("1");
    !dev && bundled_plist(exe).is_some()
}

fn launchctl(args: &[&str]) -> std::io::Result<std::process::Output> {
    Command::new("launchctl").args(args).output()
}

fn uid() -> String {
    Command::new("id")
        .arg("-u")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// Moves off the LaunchAgent earlier builds wrote by hand: unloads it and
/// removes its plist, once. `bootout` is told the job, whatever it ran.
pub fn migrate_legacy(home: &Path, bootout: impl Fn(&str)) -> Result<bool> {
    let old = home
        .join("Library/LaunchAgents")
        .join(format!("{LEGACY_LAUNCH_AGENT_LABEL}.plist"));
    if !old.exists() {
        return Ok(false);
    }
    bootout(LEGACY_LAUNCH_AGENT_LABEL);
    std::fs::remove_file(&old)?;
    Ok(true)
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Registers the helper when it isn't, re-registers it when an update
/// changed its plist, and says where it stands.
pub fn ensure(paths: &Paths) -> Status {
    let Ok(exe) = std::env::current_exe() else {
        return Status::Development;
    };
    if !managed(&exe) {
        return Status::Development;
    }
    if translocated(&exe) {
        return Status::MoveToApplications;
    }
    if let Some(home) = home() {
        let uid = uid();
        match migrate_legacy(&home, |label| {
            let _ = launchctl(&["bootout", &format!("gui/{uid}/{label}")]);
        }) {
            Ok(true) => tracing::info!("moved the old hand-written LaunchAgent to a login item"),
            Ok(false) => {}
            Err(e) => tracing::warn!(error = %e, "could not remove the old LaunchAgent"),
        }
    }
    let plist = bundled_plist(&exe).and_then(|p| std::fs::read(p).ok());
    let seen = paths.root.join("helper.plist");
    let changed = plist.is_some() && std::fs::read(&seen).ok() != plist;
    let result = (|| -> Result<Status> {
        let mut status = sm::status()?;
        let registered = matches!(status, Status::Running | Status::NeedsApproval);
        if changed && registered {
            tracing::info!("Desk Helper's definition changed; registering it again");
            sm::unregister()?;
            status = Status::NotRegistered;
        }
        if status == Status::NotRegistered {
            sm::register()?;
            status = sm::status()?;
        }
        if let Some(p) = &plist {
            std::fs::create_dir_all(&paths.root)?;
            std::fs::write(&seen, p)?;
        }
        Ok(status)
    })();
    result.unwrap_or_else(|e| {
        tracing::error!(error = %e, "could not register Desk Helper");
        Status::Failed {
            message: e.to_string(),
        }
    })
}

/// Where the helper stands, without changing anything.
pub fn status() -> Status {
    let Ok(exe) = std::env::current_exe() else {
        return Status::Development;
    };
    if !managed(&exe) {
        return Status::Development;
    }
    if translocated(&exe) {
        return Status::MoveToApplications;
    }
    sm::status().unwrap_or_else(|e| Status::Failed {
        message: e.to_string(),
    })
}

/// Stops the helper (launchd ends it, and with it the hub and Postgres) and
/// takes it out of Login Items. In a development run, nothing to do.
pub fn unregister(paths: &Paths) -> Result<()> {
    let exe = std::env::current_exe()?;
    if !managed(&exe) {
        return Ok(());
    }
    if matches!(sm::status()?, Status::Running | Status::NeedsApproval) {
        sm::unregister()?;
    }
    let _ = std::fs::remove_file(paths.root.join("helper.plist"));
    Ok(())
}

pub fn open_login_items() {
    sm::open_login_items();
}

#[cfg(target_os = "macos")]
mod sm {
    use objc2_foundation::NSString;
    use objc2_service_management::{SMAppService, SMAppServiceStatus};

    use super::{Status, plist_name};

    fn service() -> objc2::rc::Retained<SMAppService> {
        let name = NSString::from_str(&plist_name());
        // SAFETY: a plain constructor taking an NSString.
        unsafe { SMAppService::agentServiceWithPlistName(&name) }
    }

    fn error(e: &objc2_foundation::NSError) -> eyre::Report {
        eyre::eyre!("{}", e.localizedDescription())
    }

    pub fn status() -> eyre::Result<Status> {
        // SAFETY: reads the service's status.
        let s = unsafe { service().status() };
        Ok(match s {
            SMAppServiceStatus::Enabled => Status::Running,
            SMAppServiceStatus::RequiresApproval => Status::NeedsApproval,
            // `NotFound` until the first registration as well as when the
            // plist is missing; registering says which.
            _ => Status::NotRegistered,
        })
    }

    pub fn register() -> eyre::Result<()> {
        // SAFETY: registers the bundled agent; errors come back as NSError.
        unsafe { service().registerAndReturnError() }.map_err(|e| error(&e))
    }

    pub fn unregister() -> eyre::Result<()> {
        // SAFETY: as above.
        unsafe { service().unregisterAndReturnError() }.map_err(|e| error(&e))
    }

    pub fn open_login_items() {
        // SAFETY: opens System Settings.
        unsafe { SMAppService::openSystemSettingsLoginItems() }
    }
}

#[cfg(not(target_os = "macos"))]
mod sm {
    use super::Status;

    pub fn status() -> eyre::Result<Status> {
        Ok(Status::Development)
    }
    pub fn register() -> eyre::Result<()> {
        Ok(())
    }
    pub fn unregister() -> eyre::Result<()> {
        Ok(())
    }
    pub fn open_login_items() {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn the_old_launch_agent_is_unloaded_and_removed_once() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("Library/LaunchAgents");
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join(format!("{LEGACY_LAUNCH_AGENT_LABEL}.plist"));
        std::fs::write(&old, "<plist/>").unwrap();
        let other = dir.join("com.example.other.plist");
        std::fs::write(&other, "<plist/>").unwrap();
        let booted = RefCell::new(Vec::new());
        let bootout = |l: &str| booted.borrow_mut().push(l.to_string());
        assert!(migrate_legacy(home.path(), bootout).unwrap());
        assert_eq!(*booted.borrow(), vec![LEGACY_LAUNCH_AGENT_LABEL]);
        assert!(!old.exists());
        assert!(other.exists());
        assert!(!migrate_legacy(home.path(), bootout).unwrap());
        assert_eq!(booted.borrow().len(), 1);
    }

    #[test]
    fn the_plist_is_found_inside_the_bundle_only() {
        let root = tempfile::tempdir().unwrap();
        let contents = root.path().join("Desk.app/Contents");
        let exe = contents.join("MacOS/desk");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        assert_eq!(bundled_plist(&exe), None);
        let agents = contents.join("Library/LaunchAgents");
        std::fs::create_dir_all(&agents).unwrap();
        std::fs::write(agents.join(plist_name()), "<plist/>").unwrap();
        assert_eq!(bundled_plist(&exe), Some(agents.join(plist_name())));
    }

    #[test]
    fn an_app_run_from_its_disk_image_or_downloads_is_told_to_move() {
        assert!(translocated(Path::new(
            "/private/var/folders/x/AppTranslocation/ABC/d/Desk.app/Contents/MacOS/desk"
        )));
        assert!(translocated(Path::new(
            "/Volumes/Desk/Desk.app/Contents/MacOS/desk"
        )));
        assert!(!translocated(Path::new(
            "/Applications/Desk.app/Contents/MacOS/desk"
        )));
    }

    #[test]
    fn only_a_helper_that_cannot_run_stops_the_wait_for_the_hub() {
        assert!(Status::Running.blocked().is_none());
        assert!(Status::Development.blocked().is_none());
        assert!(Status::NotRegistered.blocked().is_none());
        let why = Status::MoveToApplications.blocked().unwrap();
        assert!(why.contains("Applications"));
        assert!(
            Status::NeedsApproval
                .blocked()
                .unwrap()
                .contains("Login Items")
        );
        for s in [Status::MoveToApplications, Status::NeedsApproval] {
            assert!(!s.blocked().unwrap().to_lowercase().contains("workforce"));
        }
    }

    #[test]
    fn the_bundled_plist_runs_the_helper_from_the_bundle() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("LaunchAgents")
            .join(plist_name());
        let v = plist::Value::from_file(&path).unwrap();
        let d = v.as_dictionary().unwrap();
        assert_eq!(d["Label"].as_string(), Some(LAUNCH_AGENT_LABEL));
        assert_eq!(
            d["BundleProgram"].as_string(),
            Some(format!("Contents/MacOS/{}", desk_core::HELPER_EXECUTABLE).as_str())
        );
        assert_eq!(d["KeepAlive"].as_boolean(), Some(true));
        let ids = d["AssociatedBundleIdentifiers"].as_array().unwrap();
        assert_eq!(ids[0].as_string(), Some(desk_core::BUNDLE_ID));
    }
}
