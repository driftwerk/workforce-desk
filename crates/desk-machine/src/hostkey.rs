//! A machine's SSH host key: whether this computer knows it, the key it
//! shows when it doesn't, and trusting that key once the person has seen
//! its fingerprint and said yes.
//!
//! The key is read by the person's own `ssh` (so a `Host` alias, its
//! `HostName`, `Port`, `HostKeyAlias` and `ProxyJump` apply as they do in a
//! terminal), into a file of Desk's own, trusting nothing and signing in
//! with nothing (`Machine::capture_host_key`). Trusting writes exactly the
//! line ssh wrote there into the person's known hosts, and only when the key
//! it holds is the one whose fingerprint the person was shown.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use desk_core::machine::{HostKey, Machine};

use crate::ssh::{self, SshExe};

/// What ssh's error output says about the machine's host key, if anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyTrouble {
    /// No key for it is known here.
    Unknown,
    /// A key for it is known here, and it showed another.
    Changed,
}

impl KeyTrouble {
    pub fn of(stderr: &[u8]) -> Option<KeyTrouble> {
        let said = String::from_utf8_lossy(stderr);
        let has = |s: &str| said.contains(s);
        if has("REMOTE HOST IDENTIFICATION HAS CHANGED")
            || has("Host key for") && has("has changed")
        {
            return Some(KeyTrouble::Changed);
        }
        if has("Host key verification failed") || has("No matching host key") {
            return Some(KeyTrouble::Unknown);
        }
        None
    }
}

/// What the person's `ssh -G` says about the files Desk reads.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Files {
    /// The keys ssh would sign in with, in its order, `~` expanded.
    pub identities: Vec<PathBuf>,
    /// Where ssh keeps the hosts the person trusts: the first of
    /// `UserKnownHostsFile`, `~` expanded.
    pub known_hosts: Option<PathBuf>,
    /// Whether the person's ssh hashes the host names it writes there.
    pub hash: bool,
}

/// `~/x` as ssh means it, under `home`; none for a path with ssh's `%`
/// tokens, which Desk doesn't guess at.
fn expand(path: &str, home: &Path) -> Option<PathBuf> {
    if path.contains('%') || path == "none" {
        return None;
    }
    match path.strip_prefix("~/") {
        Some(rest) => Some(home.join(rest)),
        None if path.starts_with('/') => Some(PathBuf::from(path)),
        None => None,
    }
}

impl Files {
    /// From what `ssh -G` printed, with `home` this computer's home.
    pub fn parse(said: &str, home: &Path) -> Files {
        let mut files = Files::default();
        for line in said.lines() {
            let Some((key, value)) = line.split_once(' ') else {
                continue;
            };
            let value = value.trim();
            match key.to_ascii_lowercase().as_str() {
                "identityfile" => files.identities.extend(expand(value, home)),
                "userknownhostsfile" if files.known_hosts.is_none() => {
                    files.known_hosts = value
                        .split_whitespace()
                        .next()
                        .and_then(|p| expand(p, home));
                }
                "hashknownhosts" => files.hash = value.eq_ignore_ascii_case("yes"),
                _ => {}
            }
        }
        files
    }
}

/// The key `machine` shows now, as ssh writes it into a known_hosts file
/// of Desk's own (thrown away after), with that line. Blocking.
pub fn capture(ssh: &SshExe, machine: &Machine) -> Result<(HostKey, String), String> {
    let dir = tempfile::tempdir().map_err(|e| format!("Desk couldn't make a folder: {e}"))?;
    let known = dir.path().join("known_hosts");
    let out = ssh
        .output(&machine.capture_host_key(&known))
        .map_err(|e| format!("Desk couldn't run ssh: {e}"))?;
    let written = std::fs::read_to_string(&known).unwrap_or_default();
    written
        .lines()
        .find_map(|l| HostKey::of_line(l).map(|k| (k, l.trim().to_string())))
        .ok_or_else(|| ssh::problem(machine, &out.stderr))
}

/// Whether `machine`'s key is known here as it shows it: Desk's ordinary
/// connection (`StrictHostKeyChecking=yes`) gets past the key, whether or
/// not it then signs in. Blocking.
pub fn trouble(ssh: &SshExe, machine: &Machine) -> Result<Option<KeyTrouble>, String> {
    let out = ssh
        .output(&machine.reachable())
        .map_err(|e| format!("Desk couldn't run ssh: {e}"))?;
    if out.status.success() {
        return Ok(None);
    }
    if let Some(t) = KeyTrouble::of(&out.stderr) {
        return Ok(Some(t));
    }
    let said = String::from_utf8_lossy(&out.stderr);
    if said.contains("Permission denied") || said.contains("Too many authentication failures") {
        return Ok(None);
    }
    Err(ssh::problem(machine, &out.stderr))
}

/// The person's yes to trusting a machine's key, asked natively (outside
/// the page), Cancel the default.
pub trait TrustConfirm: Send + Sync + 'static {
    fn trust_key(&self, question: &TrustQuestion) -> bool;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustQuestion {
    pub name: String,
    pub target: String,
    /// `ED25519`.
    pub kind: String,
    pub fingerprint: String,
}

impl TrustQuestion {
    /// The exact target on a line of its own, so a name can't stand in for
    /// where Desk connects.
    pub fn text(&self) -> String {
        format!(
            "Trust {}'s SSH host key?\n\n{}\n\n{} key {}\n\nOnly trust it if you know this is the machine you meant. Desk adds it to your known_hosts, as ssh would when you say yes there.",
            self.name, self.target, self.kind, self.fingerprint
        )
    }
}

/// Adds `machine`'s key to the person's known hosts (`files.known_hosts`),
/// once it is the one whose fingerprint they saw (`seen`) and they said yes;
/// refused when the key they know for it is another (a changed key is never
/// trusted from Desk). Blocking.
pub fn trust(
    ssh: &SshExe,
    machine: &Machine,
    files: &Files,
    seen: &str,
    confirm: &dyn TrustConfirm,
) -> Result<(), String> {
    let name = &machine.name;
    let known_hosts = files.known_hosts.clone().ok_or_else(|| {
        format!("Your SSH settings for {name} keep no known hosts file Desk can add to.")
    })?;
    match trouble(ssh, machine)? {
        None => return Ok(()),
        Some(KeyTrouble::Changed) => {
            return Err(format!(
                "{name}'s host key isn't the one your Mac knows. Desk won't trust another key for it."
            ));
        }
        Some(KeyTrouble::Unknown) => {}
    }
    let (key, _) = capture(ssh, machine)?;
    if key.fingerprint != seen {
        return Err(format!(
            "{name} now shows another key ({}) than the one you were shown. Desk didn't trust it.",
            key.fingerprint
        ));
    }
    if !confirm.trust_key(&TrustQuestion {
        name: name.clone(),
        target: machine.target.to_string(),
        kind: key.kind(),
        fingerprint: key.fingerprint.clone(),
    }) {
        return Err("Trusting the machine was cancelled.".into());
    }
    // Read again after the yes: the line written is a key with the
    // fingerprint the person said yes to, whatever the machine showed while
    // they read the question.
    let (now, mut line) = capture(ssh, machine)?;
    if now.fingerprint != seen {
        return Err(format!(
            "{name} showed another key ({}) while you were asked. Desk didn't trust it.",
            now.fingerprint
        ));
    }
    if files.hash {
        line = hashed(&line)?;
    }
    append(&known_hosts, &line)?;
    match trouble(ssh, machine)? {
        None => Ok(()),
        Some(_) => Err(format!(
            "Desk added {name}'s key, but ssh still doesn't take it."
        )),
    }
}

/// `line` with its host names hashed, as ssh writes them with
/// `HashKnownHosts yes`.
fn hashed(line: &str) -> Result<String, String> {
    let dir = tempfile::tempdir().map_err(|e| format!("Desk couldn't make a folder: {e}"))?;
    let file = dir.path().join("known_hosts");
    std::fs::write(&file, format!("{line}\n")).map_err(|e| e.to_string())?;
    let out = std::process::Command::new("/usr/bin/ssh-keygen")
        .arg("-H")
        .arg("-f")
        .arg(&file)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Desk couldn't run ssh-keygen: {e}"))?;
    if !out.status.success() {
        return Err("ssh-keygen couldn't hash the machine's name.".into());
    }
    let said = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
    said.lines()
        .find(|l| l.starts_with("|1|"))
        .map(str::to_string)
        .ok_or_else(|| "ssh-keygen couldn't hash the machine's name.".into())
}

/// Appends `line` to `file`, on a line of its own; the file (and its
/// folder) made private if it isn't there yet.
fn append(file: &Path, line: &str) -> Result<(), String> {
    let say = |e: std::io::Error| format!("Desk couldn't add to {}: {e}", file.display());
    if let Some(dir) = file.parent()
        && !dir.exists()
    {
        let mut b = std::fs::DirBuilder::new();
        b.recursive(true);
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
        b.create(dir).map_err(say)?;
    }
    let before = std::fs::read(file).unwrap_or_default();
    let mut o = std::fs::OpenOptions::new();
    o.create(true).append(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    let mut f = o.open(file).map_err(say)?;
    let sep = if before.is_empty() || before.ends_with(b"\n") {
        ""
    } else {
        "\n"
    };
    writeln!(f, "{sep}{line}").map_err(say)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_says_what_is_wrong_with_the_key() {
        assert_eq!(
            KeyTrouble::of(b"No ED25519 host key is known for devbox and you have requested strict checking.\nHost key verification failed.\n"),
            Some(KeyTrouble::Unknown)
        );
        assert_eq!(
            KeyTrouble::of(b"@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\nHost key for devbox has changed and you have requested strict checking.\nHost key verification failed.\n"),
            Some(KeyTrouble::Changed)
        );
        assert_eq!(
            KeyTrouble::of(b"dev@devbox: Permission denied (publickey).\n"),
            None
        );
    }

    #[test]
    fn the_files_are_read_from_the_settings() {
        let home = Path::new("/Users/k");
        let f = Files::parse(
            "user dev\nidentityfile ~/.ssh/id_ed25519\nidentityfile /keys/work\nidentityfile ~/.ssh/%h\nuserknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2\nhashknownhosts yes\n",
            home,
        );
        assert_eq!(
            f.identities,
            [
                PathBuf::from("/Users/k/.ssh/id_ed25519"),
                PathBuf::from("/keys/work")
            ]
        );
        assert_eq!(
            f.known_hosts,
            Some(PathBuf::from("/Users/k/.ssh/known_hosts"))
        );
        assert!(f.hash);
        let none = Files::parse("userknownhostsfile none\n", home);
        assert_eq!(none.known_hosts, None);
    }

    #[test]
    fn a_line_is_added_on_a_line_of_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("ssh/known_hosts");
        append(&file, "a ssh-ed25519 AAAA").unwrap();
        std::fs::write(&file, std::fs::read_to_string(&file).unwrap().trim_end()).unwrap();
        append(&file, "b ssh-ed25519 BBBB").unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "a ssh-ed25519 AAAA\nb ssh-ed25519 BBBB\n"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(file.parent().unwrap())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o700);
        }
    }
}
