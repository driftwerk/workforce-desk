//! Desk Helper — `desk-hubd`, which keeps the local hub and every session it
//! hosts running from login, independent of this window — started at login
//! the way each system wants: a login item on macOS, a systemd user service
//! (or an autostart entry) on Linux, and on Windows `Desk Helper.exe` from
//! the Run key, which runs it inside WSL.
//!
//! A development run (`DESK_HOME` set, or not an installed Desk) registers
//! nothing: it talks to a supervisor started by hand.
//! `DESK_REGISTER_HELPER=1` registers the installed helper anyway, for
//! testing a build against a throwaway `DESK_HOME`.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod mac;
#[cfg(windows)]
mod windows;

use desk_core::backend::Backend;
use eyre::Result;
use serde::Serialize;

#[cfg(target_os = "linux")]
use linux::Helper;
#[cfg(target_os = "linux")]
pub use linux::run_bundled;
#[cfg(target_os = "macos")]
use mac::Helper;
#[cfg(windows)]
use windows::Helper;
#[cfg(windows)]
pub use windows::{launcher, start_launcher};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum Status {
    /// Registered and allowed: the system runs it from login.
    Running,
    /// Registered, but the person turned it off where the system lists what
    /// starts at login (or, on macOS, hasn't allowed it yet).
    NeedsApproval,
    NotRegistered,
    /// Running from the disk image or Downloads (macOS runs such apps from a
    /// randomised read-only copy), where a login item would vanish.
    #[cfg(target_os = "macos")]
    MoveToApplications,
    /// A development run: the supervisor is started by hand.
    Development,
    /// The distro setup chose can't run Desk any more (removed, or back on
    /// WSL 1).
    #[cfg(windows)]
    NoWsl {
        problem: desk_wsl::WslProblem,
    },
    /// Started, and the hub isn't answering yet.
    Starting,
    /// The hub answers inside WSL, but WSL doesn't pass its port to Windows.
    #[cfg(windows)]
    PortUnreachable,
    Failed {
        message: String,
    },
}

/// Where the person turns Desk Helper back on.
pub const STARTUP_SETTINGS: &str = if cfg!(target_os = "macos") {
    "System Settings → General → Login Items"
} else if cfg!(windows) {
    "Settings → Apps → Startup"
} else {
    "your session's autostart settings"
};

impl Status {
    /// Why the helper can't run, in the person's words, when it can't.
    pub fn blocked(&self) -> Option<String> {
        match self {
            #[cfg(target_os = "macos")]
            Status::MoveToApplications => {
                Some("Move Desk to your Applications folder, then open it from there.".into())
            }
            Status::NeedsApproval => Some(format!(
                "Desk Helper is turned off. Turn Desk on in {STARTUP_SETTINGS}, then open Desk again."
            )),
            #[cfg(windows)]
            Status::NoWsl { problem } => Some(format!(
                "{problem}. Settings → Help → Where Desk runs sets Desk up again."
            )),
            #[cfg(windows)]
            Status::PortUnreachable => Some(
                "Windows can't reach Desk inside WSL. Settings → Help shows how to fix it.".into(),
            ),
            Status::Failed { message } => Some(format!("Desk Helper couldn't start: {message}")),
            Status::Running | Status::NotRegistered | Status::Development | Status::Starting => {
                None
            }
        }
    }
}

/// How the system starts Desk Helper at login.
pub trait Login {
    /// Where it stands, without changing anything.
    fn status(&self) -> Status;
    /// Registers it when it isn't, registers it again when an update changed
    /// how, and says where it stands.
    fn ensure(&self) -> Status;
    /// Stops it (and with it the hub and Postgres) and takes it out of what
    /// starts at login. In a development run, nothing to do.
    fn unregister(&self) -> Result<()>;
    /// Opens where the system lists what starts at login.
    fn open_settings(&self);
}

/// Desk Helper as this system starts it, for `backend`.
pub fn login(backend: &Backend) -> impl Login {
    Helper::new(backend.clone())
}

/// A development run, which manages nothing: `DESK_HOME` set, unless
/// `DESK_REGISTER_HELPER=1`.
#[cfg(unix)]
fn development() -> bool {
    std::env::var_os("DESK_HOME").is_some()
        && std::env::var("DESK_REGISTER_HELPER").as_deref() != Ok("1")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_helper_that_cannot_run_stops_the_wait_for_the_hub() {
        assert!(Status::Running.blocked().is_none());
        assert!(Status::Development.blocked().is_none());
        assert!(Status::NotRegistered.blocked().is_none());
        assert!(Status::Starting.blocked().is_none());
        assert!(
            Status::NeedsApproval
                .blocked()
                .unwrap()
                .contains(STARTUP_SETTINGS)
        );
        assert!(
            !Status::NeedsApproval
                .blocked()
                .unwrap()
                .to_lowercase()
                .contains("workforce")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_mac_app_run_from_its_disk_image_is_told_to_move() {
        let why = Status::MoveToApplications.blocked().unwrap();
        assert!(why.contains("Applications") && !why.to_lowercase().contains("workforce"));
    }

    #[cfg(windows)]
    #[test]
    fn a_wsl_problem_says_where_to_set_desk_up_again() {
        assert!(
            Status::PortUnreachable
                .blocked()
                .unwrap()
                .contains("can't reach")
        );
        let gone = Status::NoWsl {
            problem: desk_wsl::WslProblem::NoDistro,
        };
        assert!(gone.blocked().unwrap().contains("Where Desk runs"));
    }
}
