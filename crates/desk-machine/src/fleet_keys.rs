//! What adding a machine needs of the person beyond the one native yes,
//! done by Desk rather than in a terminal (friction sweep #3):
//!
//! - its password once, to put Desk's own key there and turn linger on
//!   ([`Fleet::install_key`]);
//! - a locked key's passphrase, to add it to the SSH agent
//!   ([`Fleet::unlock_key`]);
//! - forgetting a reinstalled machine's old host key for its new one, once
//!   the person has seen both and said yes natively ([`Fleet::forget_key`]);
//! - linger on a machine added already, with its password once
//!   ([`Fleet::linger_with_password`]).
//!
//! Every secret is typed into Desk's own field ([`super::Host::ask_secret`]),
//! never the page, and goes only to Desk's askpass and the one command that
//! uses it; it is wiped when done, and never in an event, a log line, an
//! error or `machines.json`.

use serde::Serialize;

#[cfg(unix)]
use super::{Fleet, KeptKey, LogKind, now_ms};
#[cfg(unix)]
use crate::hostkey::{self, Files, ForgetQuestion};
#[cfg(unix)]
use crate::own_key::{self, Problem, Prompted};
#[cfg(unix)]
use crate::{probe, ssh};

/// How long putting the key there may take, the password typed.
#[cfg(unix)]
const INSTALL_WITHIN: std::time::Duration = std::time::Duration::from_secs(90);
/// How many times a wrong password is asked for again.
#[cfg(unix)]
const TRIES: usize = 3;

/// What Desk asks the person for, in its own field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretQuestion {
    pub kind: SecretKind,
    /// The machine's name, and its exact address.
    pub name: String,
    pub target: String,
    /// The account it signs in as there.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    /// The key a passphrase unlocks.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// Why it is asked again (the last one was wrong).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
    /// The host key this computer trusts for it (`SHA256:…`): shown in
    /// Desk's own field, so the person can check it there, outside the
    /// page, before their password goes to it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SecretKind {
    /// The machine's password: to put Desk's key there, and linger.
    Password,
    /// A key's passphrase, to add it to the SSH agent.
    Passphrase,
    /// The machine's password, for `sudo` to turn linger on.
    Linger,
}

/// What a step that asked for a secret did, as the page is told.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Unlocked {
    /// Done. `linger`: as it is now there, where it was asked about.
    Done {
        #[serde(skip_serializing_if = "Option::is_none")]
        linger: Option<bool>,
    },
    /// The person closed Desk's field: nothing was sent.
    Cancelled,
}

#[cfg(unix)]
impl Fleet {
    /// Asks the person in Desk's own field, through its gate: one at a
    /// time, and refused for a while after a Cancel, the wait doubling.
    fn ask_secret(
        &self,
        question: &SecretQuestion,
    ) -> Result<Option<crate::askpass::Secret>, String> {
        let mut got = None;
        self.secret_gate.ask(|| {
            got = self.host.ask_secret(question);
            got.is_some()
        })?;
        Ok(got)
    }

    fn askpass_program(&self) -> Result<std::path::PathBuf, String> {
        self.host
            .askpass()
            .ok_or_else(|| "This Desk can't sign in with a password.".to_string())
    }

    /// `target` as the person said yes to adding it in the last few
    /// minutes, with its settings: what a password or passphrase is asked
    /// for. Nothing is asked for an address they haven't said yes to.
    fn admitted_machine(
        &self,
        target: &str,
    ) -> Result<(desk_core::machine::Machine, ssh::Settings, Files), String> {
        let machine = Self::looked_at(target)?;
        if !self.admitted.has(machine.target.as_str()) {
            return Err("Look at the machine in Settings → Machines first.".into());
        }
        let said = self.settings_said(&machine)?;
        let settings = ssh::Settings::parse(&said);
        ssh::no_forwards(&machine, &settings)?;
        let files = Files::parse(&said, &self.home);
        Ok((machine, settings, files))
    }

    /// Puts Desk's own key on `target` with the person's password, typed
    /// into Desk's own field (`machine_install_key`), and turns linger on
    /// in the same session where it can. Only for an address the person
    /// said yes to adding, whose host key is known and unchanged: the
    /// password goes to no machine they haven't trusted. A wrong password
    /// is asked for again, up to three times. Blocking.
    pub fn install_key(&self, target: &str) -> Result<Unlocked, String> {
        let (machine, settings, files) = self.admitted_machine(target)?;
        let name = machine.name.clone();
        if hostkey::trouble(&self.ssh, &machine)?.is_some() {
            return Err(format!("Trust {name}'s host key first."));
        }
        // Before 8.4, ssh shows a keyboard-interactive prompt without the
        // `(user@host)` it came from, so a jump host could ask for this
        // machine's password in its words: no password through one then.
        if settings.via.is_some() {
            let new_enough = self.ssh.version().is_some_and(|v| v >= (8, 4));
            if !new_enough {
                return Err(format!(
                    "{name} is reached through a jump host, and {}'s ssh is older than OpenSSH 8.4, which can't tell the jump host's password prompt from {name}'s. Update OpenSSH, or put {}'s key on {name} yourself.",
                    crate::this_computer(),
                    crate::this_computer()
                ));
            }
        }
        let askpass = self.askpass_program()?;
        let file = self
            .ssh
            .own_key_file()
            .ok_or("This Desk keeps no SSH key of its own.")?
            .to_path_buf();
        let public = own_key::ensure(&file)?;
        let prompted = Prompted {
            user: settings.user.clone().unwrap_or_default(),
            hostname: settings
                .prompted_host()
                .map(str::to_string)
                .unwrap_or_else(|| probe::name_of(machine.target.as_str())),
            direct: settings.via.is_none(),
        };
        // The key ssh will hold it to (StrictHostKeyChecking=yes): what
        // the person checks in Desk's own field.
        let fingerprint = hostkey::known_fingerprints(&files).into_iter().next();
        let mut problem = None;
        for _ in 0..TRIES {
            let question = SecretQuestion {
                kind: SecretKind::Password,
                name: name.clone(),
                target: machine.target.to_string(),
                user: settings.user.clone(),
                key: None,
                problem: problem.take(),
                fingerprint: fingerprint.clone(),
            };
            let Some(password) = self.ask_secret(&question)? else {
                return Ok(Unlocked::Cancelled);
            };
            let step = ssh::Step::new(Default::default(), INSTALL_WITHIN);
            match step.run(|| {
                own_key::install(&self.ssh, &machine, &prompted, &public, password, &askpass)
            }) {
                Ok(installed) => {
                    self.ssh.uses_own_key(machine.target.as_str(), true);
                    tracing::info!(machine = %name, linger = ?installed.linger, "put Desk's own key on a machine");
                    return Ok(Unlocked::Done {
                        linger: installed.linger,
                    });
                }
                Err(Problem::Wrong) => problem = Some(Problem::Wrong.said(&name)),
                Err(p) => return Err(p.said(&name)),
            }
        }
        Err(format!(
            "{name} didn't take that password, three times. Check it, then try again."
        ))
    }

    /// Adds the key `target` would sign in with, which needs a passphrase
    /// no agent holds, to the SSH agent with the person's passphrase, typed
    /// into Desk's own field (`machine_unlock_key`); never stored. Blocking.
    pub fn unlock_key(&self, target: &str) -> Result<Unlocked, String> {
        let (machine, settings, files) = self.admitted_machine(target)?;
        let key = probe::locked_key(&files).ok_or("Your SSH key isn't locked any more.")?;
        let askpass = self.askpass_program()?;
        let mut problem = None;
        for _ in 0..TRIES {
            let question = SecretQuestion {
                kind: SecretKind::Passphrase,
                name: machine.name.clone(),
                target: machine.target.to_string(),
                user: settings.user.clone(),
                key: Some(key.to_string_lossy().into_owned()),
                problem: problem.take(),
                fingerprint: None,
            };
            let Some(passphrase) = self.ask_secret(&question)? else {
                return Ok(Unlocked::Cancelled);
            };
            match own_key::add_to_agent(&key, passphrase, &askpass) {
                Ok(()) => return Ok(Unlocked::Done { linger: None }),
                Err(m) if m.contains("isn't your key's passphrase") => problem = Some(m),
                Err(m) => return Err(m),
            }
        }
        Err("That isn't your key's passphrase, three times. Check it, then try again.".into())
    }

    /// Forgets `target`'s old host key and trusts the one it shows now
    /// (`machine_forget_key`), once the person has seen both fingerprints
    /// and said yes natively. For an address they said yes to adding, or
    /// one of Desk's machines. Whether they said yes. Blocking.
    pub fn forget_key(&self, target: &str, shown: &str) -> Result<bool, String> {
        let machine = Self::looked_at(target)?;
        let ours: Vec<String> = self
            .rows()
            .iter()
            .filter(|(_, r)| r.kept.machine.target == machine.target)
            .map(|(id, _)| id.clone())
            .collect();
        if ours.is_empty() && !self.admitted.has(machine.target.as_str()) {
            return Err("Look at the machine in Settings → Machines first.".into());
        }
        let name = ours
            .first()
            .and_then(|id| self.machine(id))
            .map_or_else(|| machine.name.clone(), |m| m.name);
        let said = self.settings_said(&machine)?;
        ssh::no_forwards(&machine, &ssh::Settings::parse(&said))?;
        let files = Files::parse(&said, &self.home);
        if hostkey::trouble(&self.ssh, &machine)? != Some(hostkey::KeyTrouble::Changed) {
            return Err(format!("{name}'s host key hasn't changed."));
        }
        let (now, _) = hostkey::capture(&self.ssh, &machine)?;
        if now.fingerprint != shown {
            return Err(format!(
                "{name} now shows another key ({}) than the one you were shown. Nothing changed.",
                now.fingerprint
            ));
        }
        let question = ForgetQuestion {
            name: name.clone(),
            target: machine.target.to_string(),
            old: hostkey::known_fingerprints(&files),
            kind: now.kind(),
            fingerprint: now.fingerprint.clone(),
        };
        let confirm = &self.trust;
        if !self.trust_gate.ask(|| confirm.forget_key(&question))? {
            return Ok(false);
        }
        let key = hostkey::forget_and_trust(&self.ssh, &machine, &files, &self.home, shown)?;
        let kept = KeptKey {
            kind: key.kind(),
            fingerprint: key.fingerprint.clone(),
            trusted_at: Some(now_ms()),
        };
        for id in &ours {
            self.update_kept(id, |k| k.host_key = Some(kept.clone()));
            self.set_now(id, |n| n.shown_key = None);
            self.note(
                id,
                LogKind::Info,
                format!("forgot its old host key; trusting {}", key.fingerprint),
            );
            self.kick(id);
        }
        if ours.is_empty() {
            self.kept_trusted(&machine, key);
        }
        self.host.changed();
        Ok(true)
    }

    /// Turns linger on for machine `id`'s account with `sudo` and the
    /// person's password, typed into Desk's own field
    /// (`machine_linger_with_password`): the one step left when Desk
    /// couldn't turn it on as the account. Blocking.
    pub fn linger_with_password(&self, id: &str) -> Result<Unlocked, String> {
        let machine = self
            .machine(id)
            .ok_or("That machine isn't in Desk any more.")?;
        let user = self
            .rows()
            .get(id)
            .and_then(|r| r.now.details.as_ref().and_then(|d| d.user.clone()));
        // Only for an address the person said yes to a moment ago, or once
        // they say yes natively now: never a password field the page
        // conjures for any machine.
        if !self.admitted.has(machine.target.as_str()) {
            let ask = hostkey::LingerQuestion {
                name: machine.name.clone(),
                target: machine.target.to_string(),
            };
            let confirm = &self.trust;
            if !self.trust_gate.ask(|| confirm.linger(&ask))? {
                return Ok(Unlocked::Cancelled);
            }
        }
        let question = SecretQuestion {
            kind: SecretKind::Linger,
            name: machine.name.clone(),
            target: machine.target.to_string(),
            user: user.clone(),
            key: None,
            problem: None,
            fingerprint: None,
        };
        let Some(password) = self.ask_secret(&question)? else {
            return Ok(Unlocked::Cancelled);
        };
        let step = ssh::Step::new(Default::default(), INSTALL_WITHIN);
        let linger = step.run(|| own_key::linger_with(&self.ssh, &machine, password))?;
        if linger == Some(true) {
            self.note(id, LogKind::Ok, "linger turned on with sudo");
            self.kick(id);
            return Ok(Unlocked::Done { linger });
        }
        Err(format!(
            "{} isn't allowed to use sudo there, or that wasn't its password. An administrator of {} runs this there: {}",
            user.as_deref().unwrap_or("That account"),
            machine.name,
            desk_core::backend_install::linger_by_hand(user.as_deref().unwrap_or("$USER"))
        ))
    }

    /// Takes Desk's own key out of machine `machine`'s `authorized_keys`,
    /// as it is uninstalled: best effort, said in its log.
    pub(super) fn take_own_key_away(&self, id: &str, machine: &desk_core::machine::Machine) {
        let Some(file) = self.ssh.own_key_file() else {
            return;
        };
        let Ok(line) = std::fs::read_to_string(own_key::public_file(file)) else {
            return;
        };
        // Only ever exactly Desk's key: a line that doesn't read as one
        // removes nothing.
        let Some((kind, b64, _)) = own_key::key_fields(&line) else {
            self.note(
                id,
                LogKind::Warn,
                "Desk's own key can't be read, so it was left in authorized_keys there",
            );
            return;
        };
        let words = [
            "sh".to_string(),
            "-c".to_string(),
            own_key::remove_script(),
            "desk-key".to_string(),
            kind,
            b64,
        ];
        let done = self
            .step_uncancellable()
            .run(|| self.ssh.output(&machine.command(&words)));
        match done {
            Ok(o) if o.status.success() => self.note(
                id,
                LogKind::Info,
                "took Desk's key out of authorized_keys there",
            ),
            _ => self.note(
                id,
                LogKind::Warn,
                "couldn't take Desk's key out of authorized_keys there",
            ),
        }
        self.ssh.uses_own_key(machine.target.as_str(), false);
    }
}
