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
    /// A key for it is known here, and it showed another; or the key it
    /// showed is one the person marked revoked. Never trusted from Desk.
    Changed,
}

impl KeyTrouble {
    pub fn of(stderr: &[u8]) -> Option<KeyTrouble> {
        let said = String::from_utf8_lossy(stderr);
        let has = |s: &str| said.contains(s);
        if has("REMOTE HOST IDENTIFICATION HAS CHANGED")
            || has("Host key for") && has("has changed")
            || has("REVOKED HOST KEY")
            || has("marked as revoked")
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
    /// Every file ssh checks a host's key against: all of
    /// `UserKnownHostsFile`, then `GlobalKnownHostsFile`.
    pub all_known: Vec<PathBuf>,
    /// The name ssh looks the machine's key up by: its `HostKeyAlias`,
    /// else its `HostName`, as `[name]:port` off port 22.
    pub known_as: Option<String>,
}

/// `ssh-keygen`, beside the system's `ssh`.
const KEYGEN: &str = if cfg!(windows) {
    "ssh-keygen"
} else {
    "/usr/bin/ssh-keygen"
};

/// The fingerprints the person's known_hosts files hold for the machine
/// (`files.known_as`), read with `ssh-keygen -F` (hashed names too): no
/// network. A key Desk read from the machine is the machine's own only
/// when it is one of these.
pub fn known_fingerprints(files: &Files) -> Vec<String> {
    let Some(name) = &files.known_as else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for file in files.all_known.iter().filter(|f| f.is_file()) {
        let Ok(out) = std::process::Command::new(KEYGEN)
            .arg("-F")
            .arg(name)
            .arg("-f")
            .arg(file)
            .stdin(Stdio::null())
            .output()
        else {
            continue;
        };
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if let Some(k) = HostKey::of_line(line)
                && !found.contains(&k.fingerprint)
            {
                found.push(k.fingerprint);
            }
        }
    }
    found
}

/// The line that removes the machine's old key from the person's
/// known_hosts: by the name ssh looks it up by, from the file ssh writes
/// (named when it isn't ssh's own default). None when Desk can't say it.
pub fn forget_line(files: &Files, home: &Path) -> Option<String> {
    let name = files.known_as.as_deref()?;
    let quote = desk_core::machine::quote;
    let mut line = format!("ssh-keygen -R {}", quote(name));
    if let Some(file) = &files.known_hosts
        && *file != home.join(".ssh").join("known_hosts")
    {
        line.push_str(&format!(" -f {}", quote(&file.to_string_lossy())));
    }
    Some(line)
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
        let (mut alias, mut hostname, mut port) = (None, None, None);
        let mut global = Vec::new();
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
                "hostkeyalias" if value != "none" => alias = Some(value.to_string()),
                "hostname" => hostname = Some(value.to_string()),
                "port" => port = Some(value.to_string()),
                "globalknownhostsfile" => {
                    global.extend(value.split_whitespace().filter_map(|p| expand(p, home)))
                }
                _ => {}
            }
            if key.eq_ignore_ascii_case("userknownhostsfile") {
                files
                    .all_known
                    .extend(value.split_whitespace().filter_map(|p| expand(p, home)));
            }
        }
        files.all_known.extend(global);
        files.known_as = alias.or(hostname).map(|name| match port.as_deref() {
            Some(p) if p != "22" => format!("[{name}]:{p}"),
            _ => name,
        });
        files
    }
}

/// An ssh that couldn't run, or ran out of time.
fn ran(machine: &Machine, e: &std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::TimedOut {
        format!("{} didn't answer in time. Nothing changed.", machine.target)
    } else {
        format!("Desk couldn't run ssh: {e}")
    }
}

/// The key `machine` shows now, as ssh writes it into a known_hosts file
/// of Desk's own (thrown away after), with that line. Blocking.
pub fn capture(ssh: &SshExe, machine: &Machine) -> Result<(HostKey, String), String> {
    let dir = tempfile::tempdir().map_err(|e| format!("Desk couldn't make a folder: {e}"))?;
    let known = dir.path().join("known_hosts");
    let out = ssh
        .output(&machine.capture_host_key(&known))
        .map_err(|e| ran(machine, &e))?;
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
        .map_err(|e| ran(machine, &e))?;
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
    /// The person's yes to reaching a machine at another address, once
    /// Desk has checked it shows the machine's own key. No unless asked.
    fn switch_to(&self, question: &SwitchQuestion) -> bool {
        let _ = question;
        false
    }
    /// The person's yes to uninstalling Desk from a machine. No unless asked.
    fn uninstall(&self, question: &UninstallQuestion) -> bool {
        let _ = question;
        false
    }
    /// The person's yes to forgetting a machine's old host key for the one
    /// it shows now. No unless asked.
    fn forget_key(&self, question: &ForgetQuestion) -> bool {
        let _ = question;
        false
    }
}

/// Forgetting a machine's old host key and trusting the one it shows now:
/// both fingerprints, and the exact address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgetQuestion {
    pub name: String,
    pub target: String,
    /// The fingerprints known for it here now.
    pub old: Vec<String>,
    /// `ED25519`.
    pub kind: String,
    pub fingerprint: String,
}

impl ForgetQuestion {
    pub fn text(&self) -> String {
        let old = if self.old.is_empty() {
            "a key Desk can't read".to_string()
        } else {
            self.old.join(", ")
        };
        format!(
            "Forget {name}'s old host key and trust its new one?\n\n{target}\n\nOld: {old}\nNew: {kind} {fp}\n\nA machine's key changes when it is reinstalled or replaced. If you don't know why it changed, Cancel: someone may be pretending to be {name}.",
            name = self.name,
            target = self.target,
            kind = self.kind,
            fp = self.fingerprint
        )
    }
}

/// Uninstalling Desk from a machine: its name and the exact address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UninstallQuestion {
    pub name: String,
    pub target: String,
}

impl UninstallQuestion {
    pub fn text(&self) -> String {
        format!(
            "Uninstall Desk from {name}?\n\n{target}\n\nDesk stops its service there and removes ~/.local/share/Desk, with the sign-ins and memory Desk keeps there; its sessions end. Your files, repos, Claude Code and Codex stay, and so does Codex's own sign-in (~/.codex).",
            name = self.name,
            target = self.target
        )
    }
}

/// Reaching a machine another way: the same machine, by its host key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwitchQuestion {
    pub name: String,
    pub from: String,
    pub to: String,
    /// `ED25519`.
    pub kind: String,
    pub fingerprint: String,
}

impl SwitchQuestion {
    /// Both addresses on lines of their own, and the key that makes them
    /// one machine.
    pub fn text(&self) -> String {
        format!(
            "Reach {} at another address?\n\nFrom {}\nTo {}\n\nDesk checks it shows {}'s own SSH host key ({} {}) before anything changes. Its sessions, sign-ins and settings stay. Desk adds the key for the new address to your known_hosts when you switch.",
            self.name, self.from, self.to, self.name, self.kind, self.fingerprint
        )
    }
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

/// How long after a Cancel no new trust question is asked; doubled for
/// each Cancel in a row, up to [`MAX_QUIET`].
const QUIET_AFTER_CANCEL: std::time::Duration = std::time::Duration::from_secs(10);
const MAX_QUIET: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// The trust question as adding's is asked (`admit::Gate`): one at a time
/// (another while it is open is refused, not queued), and after a Cancel
/// none for a while, the wait doubling with each Cancel in a row, so script
/// calling in a loop gets refusals, not a stream of dialogs.
pub struct TrustGate {
    quiet: std::time::Duration,
    asking: std::sync::Mutex<Asking>,
    /// What it asks about, as its refusals say it ("Trusting a machine").
    what: &'static str,
}

#[derive(Default)]
struct Asking {
    open: bool,
    cancels: u32,
    quiet_until: Option<std::time::Instant>,
}

impl Default for TrustGate {
    fn default() -> Self {
        Self::with_quiet(QUIET_AFTER_CANCEL)
    }
}

impl TrustGate {
    pub fn with_quiet(quiet: std::time::Duration) -> Self {
        Self {
            quiet,
            asking: Default::default(),
            what: "Trusting a machine",
        }
    }

    /// The same gate for another kind of question, `what` naming it
    /// ("Asking for a machine's password").
    pub fn named(what: &'static str) -> Self {
        Self {
            what,
            ..Self::default()
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Asking> {
        self.asking.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Asks with `ask`, unless a question is open or one was cancelled a
    /// moment ago; whether the person said yes.
    pub fn ask(&self, ask: impl FnOnce() -> bool) -> Result<bool, String> {
        {
            let mut a = self.lock();
            if a.open {
                return Err(format!(
                    "Desk is already asking you something about a machine: {} waits until you answer it.",
                    self.what.to_lowercase()
                ));
            }
            if let Some(left) = a
                .quiet_until
                .and_then(|u| u.checked_duration_since(std::time::Instant::now()))
                .filter(|l| !l.is_zero())
            {
                return Err(format!(
                    "{} was cancelled. Try again in {} seconds.",
                    self.what,
                    left.as_secs().max(1)
                ));
            }
            a.open = true;
        }
        // Closed however asking ends, a panic included.
        struct Open<'a>(&'a TrustGate);
        impl Drop for Open<'_> {
            fn drop(&mut self) {
                self.0.lock().open = false;
            }
        }
        let open = Open(self);
        let yes = ask();
        {
            let mut a = self.lock();
            if yes {
                a.cancels = 0;
                a.quiet_until = None;
            } else {
                a.cancels = a.cancels.saturating_add(1);
                let wait = self
                    .quiet
                    .saturating_mul(1 << (a.cancels - 1).min(16))
                    .min(MAX_QUIET);
                a.quiet_until = Some(std::time::Instant::now() + wait);
            }
        }
        drop(open);
        Ok(yes)
    }
}

/// A trust question asked through `gate`.
pub struct Gated<'a> {
    pub gate: &'a TrustGate,
    pub confirm: &'a dyn TrustConfirm,
}

impl Gated<'_> {
    fn ask(&self, question: &TrustQuestion) -> Result<bool, String> {
        self.gate.ask(|| self.confirm.trust_key(question))
    }
}

/// Adds `machine`'s key to the person's known hosts (`files.known_hosts`),
/// once it is the one whose fingerprint they saw (`seen`) and they said yes;
/// refused when the key they know for it is another (a changed key is never
/// trusted from Desk). Blocking.
///
/// `confirm`: asked natively before it is written; none when the person's
/// native yes to adding this exact address already stands (adding a
/// machine asks one question, not two).
pub fn trust(
    ssh: &SshExe,
    machine: &Machine,
    files: &Files,
    seen: &str,
    confirm: Option<&Gated<'_>>,
) -> Result<Option<HostKey>, String> {
    let name = &machine.name;
    let known_hosts = files.known_hosts.clone().ok_or_else(|| {
        format!("Your SSH settings for {name} keep no known hosts file Desk can add to.")
    })?;
    match trouble(ssh, machine)? {
        None => return Ok(None),
        Some(KeyTrouble::Changed) => {
            return Err(format!(
                "{name} shows a different host key from the one {here} knows. Forget the old key first, if it was reinstalled.",
                here = crate::this_computer()
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
    if let Some(confirm) = confirm
        && !confirm.ask(&TrustQuestion {
            name: name.clone(),
            target: machine.target.to_string(),
            kind: key.kind(),
            fingerprint: key.fingerprint.clone(),
        })?
    {
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
        None => Ok(Some(now)),
        Some(_) => Err(format!(
            "Desk added {name}'s key, but ssh still doesn't take it."
        )),
    }
}

/// Takes the machine's old key out of the person's own known hosts files
/// (`ssh-keygen -R` by the name ssh looks it up by), then trusts the one it
/// shows now, once it is the one whose fingerprint they were shown
/// (`seen`). A key in a known hosts file of the system's (not under
/// `home`) stays: an administrator removes it. Blocking; only after the
/// person's native yes ([`ForgetQuestion`]).
pub fn forget_and_trust(
    ssh: &SshExe,
    machine: &Machine,
    files: &Files,
    home: &Path,
    seen: &str,
) -> Result<HostKey, String> {
    let name = &machine.name;
    let known_as = files
        .known_as
        .as_deref()
        .ok_or_else(|| format!("Desk can't tell which name {name}'s key is kept under."))?;
    for file in files
        .all_known
        .iter()
        .filter(|f| f.starts_with(home) && f.is_file())
    {
        let out = std::process::Command::new(KEYGEN)
            .arg("-R")
            .arg(known_as)
            .arg("-f")
            .arg(file)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("Desk couldn't run ssh-keygen: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "Desk couldn't take {name}'s old key out of {}.",
                file.display()
            ));
        }
        // ssh-keygen keeps the file as it was beside it.
        let mut old = file.as_os_str().to_owned();
        old.push(".old");
        let _ = std::fs::remove_file(PathBuf::from(old));
    }
    match trouble(ssh, machine)? {
        Some(KeyTrouble::Changed) => {
            return Err(format!(
                "{name}'s old key is also in a known hosts file of this computer's own, which Desk doesn't change. An administrator removes it there."
            ));
        }
        None => {
            return Err(format!(
                "{name} now shows the key {} knows.",
                crate::this_computer()
            ));
        }
        Some(KeyTrouble::Unknown) => {}
    }
    let known_hosts = files.known_hosts.clone().ok_or_else(|| {
        format!("Your SSH settings for {name} keep no known hosts file Desk can add to.")
    })?;
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
        None => Ok(now),
        Some(_) => Err(format!(
            "Desk added {name}'s key, but ssh still doesn't take it."
        )),
    }
}

/// Writes `line` (a known_hosts line ssh wrote for a machine's address)
/// into the person's known hosts, hashed when their ssh hashes: for an
/// address the person said yes to reaching a machine they trust by.
pub fn learn(files: &Files, line: &str) -> Result<(), String> {
    let known_hosts = files
        .known_hosts
        .clone()
        .ok_or("Your SSH settings keep no known hosts file Desk can add to.")?;
    let line = if files.hash {
        hashed(line)?
    } else {
        line.to_string()
    };
    append(&known_hosts, &line)
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
        // A revoked key is never offered to be trusted.
        assert_eq!(
            KeyTrouble::of(b"@       WARNING: REVOKED HOST KEY DETECTED!       @\nThe ED25519 host key for devbox is marked as revoked.\nHost key verification failed.\n"),
            Some(KeyTrouble::Changed)
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
    fn a_key_is_looked_up_by_the_name_and_port_ssh_uses() {
        let home = Path::new("/Users/k");
        let f = Files::parse(
            "hostname 10.0.3.14\nport 2222\nhostkeyalias none\nuserknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2\nglobalknownhostsfile /etc/ssh/ssh_known_hosts\n",
            home,
        );
        assert_eq!(f.known_as.as_deref(), Some("[10.0.3.14]:2222"));
        assert_eq!(
            f.all_known,
            [
                PathBuf::from("/Users/k/.ssh/known_hosts"),
                PathBuf::from("/Users/k/.ssh/known_hosts2"),
                PathBuf::from("/etc/ssh/ssh_known_hosts")
            ]
        );
        assert_eq!(
            forget_line(&f, home).as_deref(),
            Some("ssh-keygen -R '[10.0.3.14]:2222'")
        );
        let aliased = Files::parse(
            "hostname 10.0.3.14\nport 22\nhostkeyalias atlas\nuserknownhostsfile /keys/hosts\n",
            home,
        );
        assert_eq!(aliased.known_as.as_deref(), Some("atlas"));
        assert_eq!(
            forget_line(&aliased, home).as_deref(),
            Some("ssh-keygen -R atlas -f /keys/hosts")
        );
    }

    #[cfg(unix)]
    #[test]
    fn only_a_key_the_person_already_trusts_is_known() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("known_hosts");
        let atlas_pub = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
        let acme_pub = "AAAAC3NzaC1lZDI1NTE5AAAAIB+aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        std::fs::write(
            &file,
            format!("[atlas]:2222 ssh-ed25519 {atlas_pub}\natlas ssh-ed25519 {acme_pub}\n"),
        )
        .unwrap();
        let files = |name: &str| Files {
            all_known: vec![file.clone()],
            known_as: Some(name.into()),
            ..Files::default()
        };
        let mine = HostKey::of_line(&format!("x ssh-ed25519 {atlas_pub}")).unwrap();
        assert_eq!(
            known_fingerprints(&files("[atlas]:2222")),
            std::slice::from_ref(&mine.fingerprint)
        );
        assert!(!known_fingerprints(&files("atlas")).contains(&mine.fingerprint));
        assert!(known_fingerprints(&files("acme")).is_empty());
        // Hashed names are found too.
        std::process::Command::new(KEYGEN)
            .arg("-H")
            .arg("-f")
            .arg(&file)
            .output()
            .unwrap();
        assert_eq!(
            known_fingerprints(&files("[atlas]:2222")),
            [mine.fingerprint]
        );
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

    #[test]
    fn the_trust_question_is_asked_one_at_a_time_and_quietly_after_a_cancel() {
        let gate = TrustGate::with_quiet(std::time::Duration::from_secs(60));
        let asked = std::sync::atomic::AtomicUsize::new(0);
        let no = || {
            asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            false
        };
        assert_eq!(gate.ask(no), Ok(false));
        assert!(gate.ask(|| true).unwrap_err().contains("Try again"));
        assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 1);
        // While one is open, another is refused, not queued.
        let open = TrustGate::default();
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let (started_tx, started) = std::sync::mpsc::channel::<()>();
        let gate = &open;
        std::thread::scope(|s| {
            s.spawn(move || {
                gate.ask(move || {
                    started_tx.send(()).unwrap();
                    rx.recv().unwrap();
                    true
                })
            });
            started.recv().unwrap();
            assert!(open.ask(|| true).unwrap_err().contains("already asking"));
            tx.send(()).unwrap();
        });
        assert_eq!(open.ask(|| true), Ok(true), "closed once answered");
    }
}
