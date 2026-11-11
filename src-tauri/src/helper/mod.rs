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
pub mod moving;
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
            Status::MoveToApplications => Some(
                "Desk needs to be in your Applications folder to keep running. Desk can move \
                 itself there."
                    .into(),
            ),
            // Desk looks again when it comes forward: no reopening.
            Status::NeedsApproval => Some(format!(
                "Desk Helper is turned off. Turn Desk on in {STARTUP_SETTINGS}."
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
    /// Starts it now if it isn't running, the way the system starts it at
    /// login, and says where it stands. Never restarts one that runs. In a
    /// development run, nothing to do: `Development`.
    fn start(&self) -> Status {
        self.ensure()
    }
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

/// Why Desk Helper last stopped, from the tail of `desk-hubd.log`: what its
/// last `exiting:` line (or, failing that, last error) says. None when it
/// started again since, or says nothing.
pub fn last_reason(log: &str) -> Option<String> {
    for line in log.lines().rev() {
        if line.contains("desk-hubd starting") {
            return None;
        }
        let Some(at) = line.find("exiting: ").or_else(|| {
            line.contains(" ERROR ")
                .then(|| line.find(": ").map(|i| i + 2))
                .flatten()
        }) else {
            continue;
        };
        let line = &line[at..];
        let line = line.strip_prefix("exiting: ").unwrap_or(line);
        return Some(line.trim().chars().take(400).collect());
    }
    None
}

/// The reason from the log file at `path`, reading only its end.
pub fn last_reason_in(path: &std::path::Path) -> Option<String> {
    last_reason(&log_tail(path)?)
}

/// How far Desk Helper has got since it last started, as its log says.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Stage {
    /// It has started, and is checking its programs.
    Starting,
    /// It is starting its database (on first launch, making it).
    Database,
    /// Its services are starting.
    Services,
    /// Its services are up, and Desk is being signed in to them.
    Connecting,
}

/// The furthest [`Stage`] the last start in `log` reached; none when the
/// log has no start in it.
pub fn stage(log: &str) -> Option<Stage> {
    let since = log.rfind("desk-hubd starting")?;
    let tail = &log[since..];
    Some(
        if tail.contains("Desk is paired with its local hub")
            || tail.contains("pairing with its local hub is current")
        {
            Stage::Connecting
        } else if tail.contains("local hub starting") {
            Stage::Services
        } else if tail.contains("hub binary") {
            Stage::Database
        } else {
            Stage::Starting
        },
    )
}

/// The [`stage`] in the log file at `path`, reading only its end.
pub fn stage_in(path: &std::path::Path) -> Option<Stage> {
    stage(&log_tail(path)?)
}

fn log_tail(path: &std::path::Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(64 * 1024)))
        .ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
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
    fn the_last_exit_line_is_the_reason() {
        let log = "2026-11-01T10:00:00Z  INFO desk_hubd::supervise: desk-hubd starting version=\"0.1.0\"\n\
                   2026-11-01T10:05:00Z  WARN desk_hubd::supervise: hub exited; restarting\n\
                   2026-11-01T10:06:00Z ERROR desk_hubd::supervise: exiting: Postgres failed: port busy\n";
        assert_eq!(last_reason(log).unwrap(), "Postgres failed: port busy");
        // Started again since: nothing to blame.
        let again =
            format!("{log}2026-11-01T10:07:00Z  INFO desk_hubd::supervise: desk-hubd starting\n");
        assert_eq!(last_reason(&again), None);
        // No exit line: the last error stands.
        let err = "t ERROR desk_hubd::supervise: could not pair Desk with its local hub\n";
        assert_eq!(
            last_reason(err).unwrap(),
            "could not pair Desk with its local hub"
        );
        assert_eq!(last_reason(""), None);
    }

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
        // Desk looks again when it comes forward: never "open Desk again".
        assert!(
            !Status::NeedsApproval
                .blocked()
                .unwrap()
                .contains("open Desk again")
        );
    }

    #[test]
    fn the_stage_is_the_furthest_the_last_start_reached() {
        let first = "t INFO desk_hubd::supervise: desk-hubd starting version=\"0.1.0\"\n";
        assert_eq!(stage(first), Some(Stage::Starting));
        let db = format!("{first}t INFO desk_hubd::supervise: hub binary hub=/x\n");
        assert_eq!(stage(&db), Some(Stage::Database));
        let up = format!("{db}t INFO desk_hubd::supervise: local hub starting gateway=x\n");
        assert_eq!(stage(&up), Some(Stage::Services));
        let paired =
            format!("{up}t INFO desk_hubd::bootstrap: Desk is paired with its local hub\n");
        assert_eq!(stage(&paired), Some(Stage::Connecting));
        // Started again since: only the new start counts.
        let again = format!("{paired}{first}");
        assert_eq!(stage(&again), Some(Stage::Starting));
        assert_eq!(stage(""), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_mac_app_run_from_its_disk_image_is_told_to_move() {
        let why = Status::MoveToApplications.blocked().unwrap();
        assert!(why.contains("Applications") && !why.to_lowercase().contains("workforce"));
        assert!(!why.to_lowercase().contains("hub"));
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
