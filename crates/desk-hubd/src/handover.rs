//! Handing the hub its secrets on an inherited pipe, never in its
//! environment.
//!
//! A process's starting environment is readable by every other process of
//! the same user (`KERN_PROCARGS2` on macOS, `/proc/<pid>/environ` on Linux),
//! and whatever the hub starts would inherit it, the commands its agents
//! run included. So the secrets are written to a pipe whose read end the
//! hub gets as descriptor [`FD`], named in [`FD_ENV`]; the hub reads it to
//! the end before anything else and closes it. The payload is one JSON
//! object of the variable names the hub's config refers to (`${NAME}`) to
//! their values.
//!
//! Needs a hub that reads [`FD_ENV`] (`hub.ref`): an older one would start
//! without its secrets and fail to reach Postgres.

use std::collections::BTreeMap;
use std::io::Write;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};

use desk_core::{Secret, SecretStore};
use eyre::{Context, Result};
use tokio::process::Command;

/// The variable naming the descriptor the hub reads its secrets from.
pub const FD_ENV: &str = "WORKFORCE_SECRETS_FD";
/// The descriptor the secrets arrive on in the child: the first after the
/// standard streams.
pub const FD: RawFd = 3;

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

    fn payload(&self) -> Vec<u8> {
        serde_json::to_vec(&self.0).expect("a map of strings serializes")
    }

    /// Gives `cmd` the secrets on descriptor [`FD`] and names it in
    /// [`FD_ENV`]. Keep what this returns until `cmd` has been spawned: it
    /// holds the pipe's read end, which the child takes a copy of.
    ///
    /// The whole payload is written, and the write end closed, before the
    /// child starts, so the child reads to the end without this process
    /// doing anything more, and a child that never reads can't block it.
    pub fn hand_to(&self, cmd: &mut Command) -> Result<Handover> {
        let payload = self.payload();
        // Both ends are close-on-exec: no other child this process starts
        // can inherit either.
        let (reader, mut writer) = std::io::pipe().context("making the secrets pipe")?;
        // A pipe buffers far more than the few hundred bytes written, so the
        // write never waits for a reader.
        writer
            .write_all(&payload)
            .context("writing the secrets pipe")?;
        drop(writer);
        let reader = OwnedFd::from(reader);
        let from = reader.as_raw_fd();
        cmd.env(FD_ENV, FD.to_string());
        // SAFETY: between fork and exec only async-signal-safe calls are
        // made (`dup2`, `fcntl`), and nothing is allocated.
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
        Ok(Handover(reader))
    }
}

/// The read end of a secrets pipe, held until its child has been spawned.
#[must_use = "the pipe must outlive the spawn"]
pub struct Handover(#[allow(dead_code)] OwnedFd);

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

    /// What the child gets: none of the secrets in its environment, all of
    /// them on descriptor 3.
    #[tokio::test]
    async fn the_child_gets_its_secrets_on_the_pipe_and_not_in_its_environment() {
        let secrets = HubSecrets::load(&Memory::default()).unwrap();
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "env; echo ---; cat <&3"])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .stdin(Stdio::null())
            .stdout(Stdio::piped());
        let handover = secrets.hand_to(&mut cmd).unwrap();
        let child = cmd.spawn().unwrap();
        drop(handover);
        let out = child.wait_with_output().await.unwrap();
        assert!(out.status.success());
        let out = String::from_utf8(out.stdout).unwrap();
        let (env, pipe) = out.split_once("---\n").unwrap();
        assert!(env.lines().any(|l| l == "WORKFORCE_SECRETS_FD=3"), "{env}");
        let read: BTreeMap<String, String> = serde_json::from_str(pipe.trim()).unwrap();
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
            cmd.args(["-c", "cat <&3"]).stdout(Stdio::piped());
            let handover = secrets.hand_to(&mut cmd).unwrap();
            let out = cmd.spawn().unwrap().wait_with_output().await.unwrap();
            drop(handover);
            let read: BTreeMap<String, String> = serde_json::from_slice(&out.stdout).unwrap();
            assert_eq!(read.len(), Secret::ALL.len());
        }
    }
}
