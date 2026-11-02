//! Handing the hub its secrets on an inherited pipe, never in its
//! environment.
//!
//! A process's starting environment is readable by every other process of
//! the same user (`KERN_PROCARGS2` on macOS, `/proc/<pid>/environ` on Linux),
//! and whatever the hub starts would inherit it, the commands its agents
//! run included. So the secrets are written to a pipe whose read end the
//! child gets as descriptor [`FD`], named in [`FD_ENV`] and on its command
//! line (`--secrets-fd 3`); the hub reads it before anything else and
//! closes it. The payload is its length (4 bytes, big-endian), then one
//! JSON object of the variable names the hub reads to their values.
//!
//! Needs a hub that reads it (`hub.ref`). An older one refuses
//! `--secrets-fd` at once, which [`crate::supervise`] reports as a hub too
//! old for this Desk, rather than starting without its secrets.

use std::collections::BTreeMap;
use std::io::Write;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::sync::{Mutex, MutexGuard};

use desk_core::{Secret, SecretStore};
use eyre::{Context, Result};
use tokio::process::Command;

/// The variable naming the descriptor the hub reads its secrets from.
pub const FD_ENV: &str = "WORKFORCE_SECRETS_FD";
/// The flag naming it on the command line, which a hub too old to read it
/// refuses.
pub const FD_FLAG: &str = "--secrets-fd";
/// The descriptor the secrets arrive on in the child: the first after the
/// standard streams.
pub const FD: RawFd = 3;

/// Held while a handover pipe exists in this process, and by every other
/// spawn ([`spawning`]). On macOS a pipe is made close-on-exec only after
/// it is made (there is no `pipe2`), so a child spawned in between would
/// inherit it; with this held, none is.
static SPAWNS: Mutex<()> = Mutex::new(());

fn spawns() -> MutexGuard<'static, ()> {
    SPAWNS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Runs `spawn`, which starts a child, while no handover pipe exists. Every
/// child desk-hubd starts without a handover is started through this.
pub fn spawning<T>(spawn: impl FnOnce() -> T) -> T {
    let _spawns = spawns();
    spawn()
}

/// The hub's secrets, read once from the secret store, by the variable
/// name the hub reads each under. `Debug` shows the names only.
pub struct HubSecrets(BTreeMap<&'static str, String>);

impl std::fmt::Debug for HubSecrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_set().entries(self.0.keys()).finish()
    }
}

impl HubSecrets {
    /// Every secret the hub uses, made on first use.
    pub fn load(store: &impl SecretStore) -> Result<Self> {
        Secret::ALL
            .into_iter()
            .map(|s| Ok((s.env(), store.get_or_create(s)?)))
            .collect::<Result<_>>()
            .map(Self)
    }

    pub fn get(&self, secret: Secret) -> &str {
        // `load` holds every one of `Secret::ALL`.
        &self.0[secret.env()]
    }

    /// Gives `cmd` every secret on a pipe ([`hand_over`]).
    pub fn hand_to(&self, cmd: &mut Command) -> Result<Handover> {
        let entries: BTreeMap<&str, &str> = self.0.iter().map(|(k, v)| (*k, v.as_str())).collect();
        hand_over(cmd, &entries)
    }
}

/// Gives `cmd` `entries` on descriptor [`FD`], and names it in [`FD_ENV`]
/// and with [`FD_FLAG`] (appended to its arguments, so add them first).
/// Spawn `cmd` while holding what this returns, then drop it at once: it
/// holds the pipe's read end, and keeps every other spawn waiting.
///
/// The whole payload is written, and the write end closed, before the
/// child starts, so the child reads it without this process doing anything
/// more, and a child that never reads can't block it.
pub fn hand_over(cmd: &mut Command, entries: &BTreeMap<&str, &str>) -> Result<Handover> {
    let spawns = spawns();
    let json = serde_json::to_vec(entries).expect("a map of strings serializes");
    let len = u32::try_from(json.len()).context("the secrets are too large to hand over")?;
    let mut payload = len.to_be_bytes().to_vec();
    payload.extend_from_slice(&json);
    let (reader, mut writer) = std::io::pipe().context("making the secrets pipe")?;
    // A pipe buffers far more than the few hundred bytes written, so the
    // write never waits for a reader.
    writer
        .write_all(&payload)
        .context("writing the secrets pipe")?;
    drop(writer);
    let reader = OwnedFd::from(reader);
    let from = reader.as_raw_fd();
    cmd.arg(FD_FLAG).arg(FD.to_string());
    cmd.env(FD_ENV, FD.to_string());
    // SAFETY: between fork and exec only async-signal-safe calls are made
    // (`dup2`, `fcntl`), and nothing is allocated.
    unsafe {
        cmd.pre_exec(move || {
            if from == FD {
                // Already in place: `dup2` would leave it close-on-exec.
                if libc::fcntl(FD, libc::F_SETFD, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
            } else if libc::dup2(from, FD) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Ok(Handover {
        _reader: reader,
        _spawns: spawns,
    })
}

/// The read end of a secrets pipe, held until its child has been spawned,
/// with every other spawn held back meanwhile.
#[must_use = "the pipe must outlive the spawn"]
pub struct Handover {
    _reader: OwnedFd,
    _spawns: MutexGuard<'static, ()>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::process::Stdio;

    #[derive(Default)]
    struct Memory(RefCell<HashMap<Secret, String>>);

    impl SecretStore for Memory {
        fn get(&self, s: Secret) -> Result<Option<String>> {
            Ok(self.0.borrow().get(&s).cloned())
        }
        fn set(&self, s: Secret, v: &str) -> Result<()> {
            self.0.borrow_mut().insert(s, v.into());
            Ok(())
        }
    }

    #[test]
    fn every_secret_is_held_and_debug_shows_no_value() {
        let secrets = HubSecrets::load(&Memory::default()).unwrap();
        let shown = format!("{secrets:?}");
        for s in Secret::ALL {
            assert!(!secrets.get(s).is_empty());
            assert!(shown.contains(s.env()));
            assert!(!shown.contains(secrets.get(s)));
        }
    }

    /// The payload as the hub reads it: its length (4 bytes, big-endian),
    /// then the JSON.
    fn unframe(bytes: &[u8]) -> BTreeMap<String, String> {
        let (len, body) = bytes.split_at(4);
        let len = u32::from_be_bytes(len.try_into().unwrap()) as usize;
        assert_eq!(body.len(), len, "the payload is exactly its framed length");
        serde_json::from_slice(body).unwrap()
    }

    /// What the child gets: none of the secrets in its environment, all of
    /// them on descriptor 3, and the descriptor named on its command line
    /// too, so a hub too old to read it refuses to start.
    #[tokio::test]
    async fn the_child_gets_its_secrets_on_the_pipe_and_not_in_its_environment() {
        let secrets = HubSecrets::load(&Memory::default()).unwrap();
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "env; echo \"args=$*\"; echo ---; cat <&3", "sh"])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .stdin(Stdio::null())
            .stdout(Stdio::piped());
        let handover = secrets.hand_to(&mut cmd).unwrap();
        let child = cmd.spawn().unwrap();
        drop(handover);
        let out = child.wait_with_output().await.unwrap();
        assert!(out.status.success());
        let split = out.stdout.windows(4).position(|w| w == b"---\n").unwrap();
        let env = String::from_utf8(out.stdout[..split].to_vec()).unwrap();
        let read = unframe(&out.stdout[split + 4..]);
        assert!(env.lines().any(|l| l == "WORKFORCE_SECRETS_FD=3"), "{env}");
        assert!(env.lines().any(|l| l == "args=--secrets-fd 3"), "{env}");
        for s in Secret::ALL {
            let value = secrets.get(s);
            assert!(!env.contains(value), "{} is in the environment", s.env());
            assert!(!env.contains(s.env()), "{} is in the environment", s.env());
            assert_eq!(read.get(s.env()).map(String::as_str), Some(value));
        }
    }

    /// A restart makes a new pipe each time: the one before is read out and
    /// gone.
    #[tokio::test]
    async fn each_spawn_gets_a_full_payload() {
        let secrets = HubSecrets::load(&Memory::default()).unwrap();
        for _ in 0..2 {
            let mut cmd = Command::new("/bin/sh");
            cmd.args(["-c", "cat <&3", "sh"]).stdout(Stdio::piped());
            let handover = secrets.hand_to(&mut cmd).unwrap();
            let child = cmd.spawn().unwrap();
            drop(handover);
            let out = child.wait_with_output().await.unwrap();
            assert_eq!(unframe(&out.stdout).len(), Secret::ALL.len());
        }
    }

    /// One secret alone, as the PTY holder gets its token.
    #[tokio::test]
    async fn a_single_secret_is_handed_over_alone() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "cat <&3", "sh"]).stdout(Stdio::piped());
        let handover = hand_over(&mut cmd, &BTreeMap::from([("A_TOKEN", "tok-fixture")])).unwrap();
        let child = cmd.spawn().unwrap();
        drop(handover);
        let out = child.wait_with_output().await.unwrap();
        assert_eq!(
            unframe(&out.stdout),
            BTreeMap::from([("A_TOKEN".to_string(), "tok-fixture".to_string())])
        );
    }

    /// No other spawn starts while a handover is being set up, so no other
    /// child can inherit its pipe before it is close-on-exec.
    #[test]
    fn spawning_waits_for_a_handover_in_progress() {
        let mut cmd = Command::new("/bin/true");
        let handover = hand_over(&mut cmd, &BTreeMap::from([("A", "b")])).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let waiter = std::thread::spawn(move || spawning(|| tx.send(()).unwrap()));
        assert!(
            rx.recv_timeout(std::time::Duration::from_millis(200))
                .is_err(),
            "a spawn ran during a handover"
        );
        drop(handover);
        rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        waiter.join().unwrap();
    }
}
