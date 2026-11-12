//! What a machine must pass before Desk adds it. The page can ask Desk to
//! add any SSH address it names, so script that got into the page could
//! have Desk install itself on a computer the person never chose. So:
//!
//! 1. The target is checked here, natively: it can only be ssh's
//!    destination, never an option (`-oProxyCommand=…`), and every `ssh`
//!    Desk runs puts `--` before it.
//! 2. The person says yes, natively (outside the page, where script can't
//!    click it), to a question naming the machine, with its exact SSH
//!    address on a line of its own; Cancel is the default. One question at
//!    a time, and after a Cancel none for a while, doubling with each
//!    Cancel in a row, as pairing asks. Before the yes nothing runs, not
//!    even `ssh -G` (a config's `Match exec` runs commands).
//! 3. The person's own `ssh` must reach it without a prompt, its host key
//!    in `known_hosts` and unchanged: there already, or trusted from Desk
//!    first (`hostkey::trust`: its fingerprint shown, read again, and a
//!    native yes; never a changed or revoked key). ssh never accepts one
//!    by itself.
//!
//! The person's `~/.ssh/config` is theirs, and applies as it does in a
//! terminal: a `Host` alias, its `User`, `IdentityFile`, `ProxyJump` or
//! `ProxyCommand` (a jump host, an AWS SSM or GCP IAP tunnel). Desk only
//! adds options that make the connection safer to keep open, and refuses a
//! config that would have it carry port forwards.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use desk_core::machine::{Machine, MachineId, Target};

use crate::ssh::{self, Settings, SshExe};

/// How long after a Cancel no new question is asked; doubled for each Cancel
/// in a row, up to [`MAX_QUIET`].
const QUIET_AFTER_CANCEL: Duration = Duration::from_secs(10);
const MAX_QUIET: Duration = Duration::from_secs(15 * 60);

/// The person's answer to "Let Desk run sessions on <machine>?". The real
/// one is the operating system's own dialog; tests answer for themselves.
pub trait Confirm: Send + Sync + 'static {
    /// Asks, and waits: true only when they said yes.
    fn run_on(&self, question: &Question) -> bool;
}

/// What the person is asked about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    pub name: String,
    pub target: String,
}

impl Question {
    /// The question as the dialog words it: the exact target alone on its
    /// line, so a name can't stand in for where Desk will connect.
    pub fn text(&self) -> String {
        format!(
            "Let Desk run sessions on {}?\n\n{}\n\nDesk installs its engine there. Anything you start runs on that machine as the account your SSH settings use for it, with full access to it. If Desk hasn't connected to it before, it shows you the machine's fingerprint next and trusts it when you continue.",
            self.name, self.target
        )
    }
}

/// Whether a question is open, and how soon after Cancels another may be.
#[derive(Default)]
struct Asking {
    open: bool,
    cancels: u32,
    quiet_until: Option<Instant>,
}

pub struct Gate {
    confirm: Arc<dyn Confirm>,
    quiet: Duration,
    asking: Arc<Mutex<Asking>>,
}

/// Marks the question closed however asking it ends, a panic included.
struct Open(Arc<Mutex<Asking>>);

impl Drop for Open {
    fn drop(&mut self) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).open = false;
    }
}

impl Gate {
    pub fn new(confirm: Arc<dyn Confirm>) -> Self {
        Self::with_quiet(confirm, QUIET_AFTER_CANCEL)
    }

    pub fn with_quiet(confirm: Arc<dyn Confirm>, quiet: Duration) -> Self {
        Self {
            confirm,
            quiet,
            asking: Arc::default(),
        }
    }

    /// Asks `question`, and waits; blocking. Refused at once while another
    /// is open or soon after a Cancel.
    pub fn ask(&self, question: &Question) -> Result<(), String> {
        let open = {
            let mut asking = self.asking.lock().unwrap_or_else(|e| e.into_inner());
            if asking.open {
                return Err("Desk is already asking about adding a machine.".into());
            }
            if let Some(left) = asking
                .quiet_until
                .and_then(|until| until.checked_duration_since(Instant::now()))
                .filter(|left| !left.is_zero())
            {
                return Err(format!(
                    "Adding a machine was cancelled. Try again in {} seconds.",
                    left.as_secs().max(1)
                ));
            }
            asking.open = true;
            Open(Arc::clone(&self.asking))
        };
        let agreed = self.confirm.run_on(question);
        {
            let mut asking = self.asking.lock().unwrap_or_else(|e| e.into_inner());
            if agreed {
                asking.cancels = 0;
                asking.quiet_until = None;
            } else {
                asking.cancels = asking.cancels.saturating_add(1);
                let wait = self
                    .quiet
                    .saturating_mul(1 << (asking.cancels - 1).min(16))
                    .min(MAX_QUIET);
                asking.quiet_until = Some(Instant::now() + wait);
            }
        }
        drop(open);
        if agreed {
            Ok(())
        } else {
            Err("Adding the machine was cancelled.".into())
        }
    }
}

/// Whether the person's own `ssh` reaches `machine` as it is, with no
/// prompt and a host key already known and unchanged.
pub fn known_host(ssh: &SshExe, machine: &Machine) -> Result<(), String> {
    let out = ssh
        .output(&machine.reachable())
        .map_err(|e| format!("Desk couldn't run ssh: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    Err(ssh::problem(machine, &out.stderr))
}

/// The machine the person typed, once it has passed all three; blocking.
/// Nothing is run on it before the person said yes.
pub fn admit(
    gate: &Gate,
    ssh: &SshExe,
    id: MachineId,
    name: &str,
    target: &str,
) -> Result<(Machine, Settings), String> {
    let target = Target::new(target).map_err(|e| e.to_string())?;
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 64 {
        return Err("Give the machine a short name.".into());
    }
    // Shown as it says: nothing that could make it read as something else.
    if !desk_core::machine::plain(name) {
        return Err(
            "A machine's name can only have letters, numbers, spaces and punctuation.".into(),
        );
    }
    let machine = Machine {
        id,
        name: name.to_string(),
        target,
    };
    gate.ask(&Question {
        name: machine.name.clone(),
        target: machine.target.to_string(),
    })?;
    // Only now: reading the config can run what it says (`Match exec`).
    let settings = ssh::settings(ssh, &machine)?;
    ssh::no_forwards(&machine, &settings)?;
    known_host(ssh, &machine)?;
    Ok((machine, settings))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Answer(bool, AtomicUsize);

    impl Confirm for Answer {
        fn run_on(&self, _: &Question) -> bool {
            self.1.fetch_add(1, Ordering::SeqCst);
            self.0
        }
    }

    #[test]
    fn a_cancel_quietens_the_next_question() {
        let answer = Arc::new(Answer(false, AtomicUsize::new(0)));
        let gate = Gate::with_quiet(answer.clone(), Duration::from_secs(60));
        let q = Question {
            name: "devbox".into(),
            target: "devbox".into(),
        };
        assert!(gate.ask(&q).unwrap_err().contains("cancelled"));
        assert!(gate.ask(&q).unwrap_err().contains("Try again"));
        assert_eq!(answer.1.load(Ordering::SeqCst), 1, "asked once");
    }

    #[test]
    fn the_question_shows_the_exact_target_on_its_own_line() {
        let q = Question {
            name: "prod-api".into(),
            target: "ec2-user@prod-api".into(),
        };
        let text = q.text();
        assert!(text.lines().any(|l| l == "ec2-user@prod-api"), "{text}");
        assert!(text.starts_with("Let Desk run sessions on prod-api?"));
    }
}
