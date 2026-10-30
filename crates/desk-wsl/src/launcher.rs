//! `Desk Helper.exe`: started at Windows sign-in, it runs Desk Helper inside
//! the distro and starts it again whenever it exits (an update handing
//! over, `wsl --shutdown`, a crash), with the same back-off desk-hubd gives
//! the hub. WSL keeps the distro's VM up while the process runs, so the
//! backend outlives Desk's window, as it does on macOS and Linux.

use std::process::ExitStatus;
use std::time::{Duration, Instant};

use desk_core::host::{COMPUTER_NAME_ENV, Host, Invocation, Wsl};
use eyre::{Context, Result};

use crate::run::WslExe;

/// Desk Helper inside the distro, through `current`, with `args`. `--exec`
/// skips the shell, so the path is the absolute one setup recorded.
pub fn helper(w: &Wsl, args: &[&str]) -> Invocation {
    Host::Wsl(w.clone()).invocation(&w.helper(), args)
}

/// `WSLENV` with the computer's name passed into Linux (`/u`: from Windows
/// to WSL only).
pub fn wslenv(existing: Option<&str>) -> String {
    let entry = format!("{COMPUTER_NAME_ENV}/u");
    match existing.filter(|e| !e.is_empty()) {
        Some(e)
            if e.split(':')
                .any(|v| v.split('/').next() == Some(COMPUTER_NAME_ENV)) =>
        {
            e.to_string()
        }
        Some(e) => format!("{e}:{entry}"),
        None => entry,
    }
}

const FIRST_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
const HEALTHY_AFTER: Duration = Duration::from_secs(300);

/// How long to wait before starting it again: from a second, doubling to a
/// minute, and back to a second after a run long enough to count as
/// healthy.
pub fn backoff(previous: Duration, ran_for: Duration) -> Duration {
    if ran_for > HEALTHY_AFTER {
        FIRST_BACKOFF
    } else {
        (previous * 2).clamp(FIRST_BACKOFF, MAX_BACKOFF)
    }
}

/// Runs Desk Helper in `w` until `stopping` says to stop, starting it again
/// after each exit; `pause` waits out a back-off (and returns early when
/// stopping), and `say` logs.
pub fn run(
    wsl: &WslExe,
    w: &Wsl,
    computer_name: &str,
    stopping: &dyn Fn() -> bool,
    pause: &dyn Fn(Duration),
    say: &dyn Fn(&str),
) -> Result<()> {
    let invocation = helper(w, &[]);
    let mut wait = Duration::ZERO;
    while !stopping() {
        let started = Instant::now();
        let status = wsl
            .command(&invocation.args)
            .env("WSLENV", wslenv(std::env::var("WSLENV").ok().as_deref()))
            .env(COMPUTER_NAME_ENV, computer_name)
            .status()
            .context("starting Desk Helper in WSL");
        if stopping() {
            break;
        }
        wait = backoff(wait, started.elapsed());
        say(&match status {
            Ok(s) => format!(
                "Desk Helper in {} exited ({s}); starting it again in {wait:?}",
                w.distro
            ),
            Err(e) => format!("{e:#}; trying again in {wait:?}"),
        });
        pause(wait);
    }
    Ok(())
}

/// `Desk Helper.exe --stop`: stops Desk Helper inside the distro (which
/// stops the hub, the memory store and Postgres).
pub fn stop(wsl: &WslExe, w: &Wsl) -> Result<ExitStatus> {
    wsl.command(&helper(w, &["--stop"]).args)
        .status()
        .context("stopping Desk Helper in WSL")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_helper_runs_through_current_from_the_linux_home() {
        let w = Wsl {
            distro: "Ubuntu".into(),
            user: "sarah".into(),
            home: "/home/sarah".into(),
            automount: "/mnt/".into(),
        };
        assert_eq!(
            helper(&w, &["--stop"]).args,
            [
                "-d",
                "Ubuntu",
                "--cd",
                "/home/sarah",
                "--exec",
                "/home/sarah/.local/share/Desk/bin/current/desk-helper",
                "--stop"
            ]
        );
    }

    #[test]
    fn the_computers_name_is_passed_into_linux_once() {
        assert_eq!(wslenv(None), "DESK_COMPUTER_NAME/u");
        assert_eq!(wslenv(Some("")), "DESK_COMPUTER_NAME/u");
        assert_eq!(wslenv(Some("GOPATH/l")), "GOPATH/l:DESK_COMPUTER_NAME/u");
        assert_eq!(
            wslenv(Some("DESK_COMPUTER_NAME/u:X")),
            "DESK_COMPUTER_NAME/u:X"
        );
    }

    #[test]
    fn restarts_back_off_and_recover_after_a_healthy_run() {
        let quick = Duration::from_secs(2);
        let waits: Vec<_> = (0..8)
            .scan(Duration::ZERO, |w, _| {
                *w = backoff(*w, quick);
                Some(w.as_secs())
            })
            .collect();
        assert_eq!(waits, [1, 2, 4, 8, 16, 32, 60, 60]);
        assert_eq!(
            backoff(MAX_BACKOFF, Duration::from_secs(600)),
            FIRST_BACKOFF
        );
    }
}
