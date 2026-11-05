//! A machine: a Linux computer the person owns (a build server) that runs
//! Desk's backend, reached from here with the person's own `ssh`: their
//! keys, agent, `~/.ssh/config` and `known_hosts`.
//!
//! Every `ssh` Desk runs is built here, from fixed options and a target
//! checked when it is made, so nothing the page types becomes an option
//! (`-oProxyCommand=…`) or a second argument. A command run on the machine
//! is a fixed one from Desk's code, each word quoted for the shell sshd
//! hands it to.

use serde::{Deserialize, Serialize};

use crate::LINUX_HELPER_EXECUTABLE;
use crate::host::Invocation;

/// The system's own OpenSSH. Fixed: no `ssh` found on a PATH, which anything
/// that can set the app's environment could point elsewhere.
pub const SSH: &str = "/usr/bin/ssh";

/// The longest target Desk takes: a host name's own limit.
pub const MAX_TARGET: usize = 255;

/// The options every `ssh` Desk runs takes, whatever the person's config
/// says (the first value ssh reads for an option is the one it keeps, and
/// the command line is read first):
/// - no terminal, no X11 and no agent forwarding: sessions outlive the
///   connection, and the box would hold the Mac's keys meanwhile;
/// - never a prompt (a passphrase key must be in the agent), and only a
///   host already in `known_hosts`, its key unchanged: Desk never accepts
///   or learns a key itself;
/// - its own connection, never a shared one (`ControlMaster`), whose owner
///   would carry Desk's forward under its own settings, or fork into the
///   background (`ControlPersist`) and look to Desk as if it had ended;
/// - no local command and no tunnel device;
/// - a dead connection noticed within 45 seconds.
const ALWAYS: &[&str] = &[
    "-T",
    "-x",
    "-a",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "Tunnel=no",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
];

/// What a command takes besides: no forwards at all, whatever the config
/// sets, and the command Desk gives rather than one from the config.
/// (`ClearAllForwardings` also clears forwards given on the command line,
/// so the forward itself can't take it; see [`Machine::forward`].)
const COMMAND: &[&str] = &["-o", "ClearAllForwardings=yes", "-o", "RemoteCommand=none"];

/// The forwards a person's SSH config can set for a host, as `ssh -G`
/// prints them. Desk's forward runs all the time, so it won't carry any.
pub const CONFIG_FORWARDS: &[&str] = &["localforward", "remoteforward", "dynamicforward"];

/// An SSH address as the person gave it (`devbox`, `dev@203.0.113.7`),
/// checked when it is made: it can only ever be ssh's destination.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Target(String);

/// Why a target was refused, in the person's words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BadTarget(pub String);

impl std::fmt::Display for BadTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for BadTarget {}

/// What a target may be written with: a host name or address, a user
/// before an `@`, a bracketed IPv6 address. Nothing a shell reads as more
/// than a word, so a `ProxyCommand` in the person's config that names the
/// host (`%h`) can't be made to run anything either.
fn target_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || "._-@:[]".contains(c)
}

impl Target {
    pub fn new(raw: &str) -> Result<Target, BadTarget> {
        let refuse = |why: &str| Err(BadTarget(why.to_string()));
        if raw.is_empty() {
            return refuse("Give the machine's SSH address, such as devbox or dev@203.0.113.7.");
        }
        if raw.len() > MAX_TARGET {
            return refuse("That SSH address is too long.");
        }
        // An option, not a place: `-oProxyCommand=…` would run a command.
        if raw.starts_with('-') {
            return refuse("An SSH address can't start with -.");
        }
        if raw.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return refuse("An SSH address can't have spaces or control characters in it.");
        }
        if !raw.chars().all(target_char) {
            return refuse(
                "An SSH address is a host name or address, with a user and @ before it if you like.",
            );
        }
        let host = raw.rsplit('@').next().unwrap_or_default();
        if host.is_empty() || raw.starts_with('@') || host.starts_with('-') {
            return refuse("That SSH address has no host in it.");
        }
        Ok(Target(raw.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for Target {
    type Error = BadTarget;

    fn try_from(raw: String) -> Result<Self, Self::Error> {
        Target::new(&raw)
    }
}

impl From<Target> for String {
    fn from(t: Target) -> String {
        t.0
    }
}

impl std::fmt::Display for Target {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// A machine's id as Desk names it everywhere (the page, its hub account):
/// lowercase letters, digits and `-`, and never `local` (This Mac).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct MachineId(String);

impl MachineId {
    pub fn new(raw: &str) -> Result<MachineId, BadTarget> {
        let ok = !raw.is_empty()
            && raw.len() <= 64
            && raw != crate::LOCAL_HUB_ID
            && !raw.starts_with('-')
            && raw
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if ok {
            Ok(MachineId(raw.to_string()))
        } else {
            Err(BadTarget(format!("{raw:?} isn't a machine's id.")))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for MachineId {
    type Error = BadTarget;

    fn try_from(raw: String) -> Result<Self, Self::Error> {
        MachineId::new(&raw)
    }
}

impl From<MachineId> for String {
    fn from(id: MachineId) -> String {
        id.0
    }
}

impl std::fmt::Display for MachineId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// A machine as Desk keeps it: no secret, only where it is and what it is
/// called.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Machine {
    pub id: MachineId,
    /// What the person calls it ("devbox").
    pub name: String,
    pub target: Target,
}

/// The backend's folder on a machine, from the home sshd starts commands
/// in.
pub const MACHINE_ROOT: &str = ".local/share/Desk";

/// `word` as one word to a POSIX shell (sshd runs a command through the
/// account's shell, with the words ssh was given joined by spaces): as it
/// is when nothing in it is special, else in single quotes.
pub fn quote(word: &str) -> String {
    let plain = |c: char| c.is_ascii_alphanumeric() || "_./=:,+@%-".contains(c);
    if !word.is_empty() && word.chars().all(plain) {
        return word.to_string();
    }
    format!("'{}'", word.replace('\'', r"'\''"))
}

impl Machine {
    /// The installed versions of the backend's programs.
    pub fn bin(&self) -> String {
        format!("{MACHINE_ROOT}/bin")
    }

    /// Desk Helper on the machine, through the `current` link setup flips.
    pub fn helper(&self) -> String {
        format!("{}/current/{LINUX_HELPER_EXECUTABLE}", self.bin())
    }

    fn ssh(&self, options: &[&[&str]], after: Option<String>) -> Invocation {
        let args = options
            .iter()
            .flat_map(|o| o.iter().map(|s| s.to_string()))
            .chain(["--".to_string(), self.target.0.clone()])
            .chain(after)
            .collect();
        Invocation {
            program: SSH.into(),
            args,
        }
    }

    /// `words` run on the machine: one command line of quoted words, after
    /// `--` and the target.
    pub fn command(&self, words: &[String]) -> Invocation {
        let line = words.iter().map(|w| quote(w)).collect::<Vec<_>>().join(" ");
        self.ssh(&[ALWAYS, COMMAND], Some(line))
    }

    /// Whether the person's own `ssh` reaches the machine as it is: its
    /// host key already known and unchanged, and a key that needs no
    /// prompt.
    pub fn reachable(&self) -> Invocation {
        self.command(&["true".to_string()])
    }

    /// The settings ssh would use for the machine, without connecting
    /// (`ssh -G`): read for forwards in the person's config.
    pub fn settings(&self) -> Invocation {
        self.ssh(&[&["-G"], ALWAYS], None)
    }

    /// The forward from `mac_port` on this computer's loopback to the
    /// machine's gateway at `box_port` on its loopback. It can't clear the
    /// person's config's forwards (`ClearAllForwardings` would clear this
    /// one too), so Desk reads [`Machine::settings`] for any first.
    pub fn forward(&self, mac_port: u16, box_port: u16) -> Invocation {
        let spec = format!("127.0.0.1:{mac_port}:127.0.0.1:{box_port}");
        self.ssh(
            &[
                &["-N"],
                ALWAYS,
                &["-o", "ExitOnForwardFailure=yes", "-L", &spec],
            ],
            None,
        )
    }
}

/// The forwards `ssh -G`'s output says the config sets, by name.
pub fn config_forwards(settings: &str) -> Vec<String> {
    settings
        .lines()
        .filter_map(|l| l.split_whitespace().next())
        .map(str::to_ascii_lowercase)
        .filter(|k| CONFIG_FORWARDS.contains(&k.as_str()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn devbox() -> Machine {
        Machine {
            id: MachineId::new("devbox").unwrap(),
            name: "devbox".into(),
            target: Target::new("dev@devbox").unwrap(),
        }
    }

    #[test]
    fn a_target_can_only_ever_be_a_destination() {
        for refused in [
            "-oProxyCommand=touch /tmp/x",
            "-oProxyCommand=x",
            "-p",
            "-",
            "dev box",
            "devbox\n-oProxyCommand=x",
            "dev\tbox",
            "devbox\u{0}",
            "devbox\u{7f}",
            "",
            "@devbox",
            "dev@",
            "dev@-oProxyCommand=x",
            "$(touch x)",
            "dev;box",
            "dev'box",
            "`id`",
            "ssh://devbox",
            "dévbox",
            &"a".repeat(256),
        ] {
            assert!(Target::new(refused).is_err(), "{refused:?}");
        }
        for ok in [
            "devbox",
            "dev@devbox",
            "dev@203.0.113.7",
            "build-1.example.com",
            "dev_user@[2001:db8::1]",
            &"a".repeat(255),
        ] {
            assert_eq!(Target::new(ok).unwrap().as_str(), ok);
        }
    }

    #[test]
    fn a_kept_target_is_checked_as_it_is_read() {
        let kept =
            serde_json::json!({"id": "devbox", "name": "devbox", "target": "-oProxyCommand=x"});
        assert!(serde_json::from_value::<Machine>(kept).is_err());
        let kept = serde_json::json!({"id": "local", "name": "x", "target": "devbox"});
        assert!(serde_json::from_value::<Machine>(kept).is_err());
        let m: Machine = serde_json::from_value(
            serde_json::json!({"id": "devbox", "name": "devbox", "target": "dev@devbox"}),
        )
        .unwrap();
        assert_eq!(m, devbox());
    }

    #[test]
    fn every_ssh_has_the_fixed_options_and_the_target_after_them() {
        let m = devbox();
        for i in [
            m.reachable(),
            m.settings(),
            m.forward(41000, 4226),
            m.command(&["x".into()]),
        ] {
            assert_eq!(i.program, std::path::PathBuf::from("/usr/bin/ssh"));
            let dash = i.args.iter().position(|a| a == "--").unwrap();
            assert_eq!(i.args[dash + 1], "dev@devbox");
            let before = &i.args[..dash];
            for (o, v) in [
                ("-o", "BatchMode=yes"),
                ("-o", "StrictHostKeyChecking=yes"),
                ("-o", "ControlPath=none"),
            ] {
                assert!(
                    before.windows(2).any(|w| w == [o, v]),
                    "{v} in {:?}",
                    i.args
                );
            }
            assert!(before.contains(&"-a".to_string()));
            assert!(before.contains(&"-x".to_string()));
            // Only the command's line comes after the target.
            assert!(i.args.len() <= dash + 3);
        }
        let f = m.forward(41000, 4226);
        assert!(
            f.args
                .windows(2)
                .any(|w| w == ["-L", "127.0.0.1:41000:127.0.0.1:4226"])
        );
        assert!(f.args.contains(&"ExitOnForwardFailure=yes".to_string()));
        assert!(!f.args.iter().any(|a| a.starts_with("ClearAllForwardings")));
        let c = m.reachable();
        assert!(c.args.contains(&"ClearAllForwardings=yes".to_string()));
        assert!(!c.args.contains(&"-L".to_string()));
    }

    #[test]
    fn a_command_on_the_machine_is_quoted_word_by_word() {
        let m = devbox();
        let i = m.command(&[
            m.helper(),
            "connection".into(),
            "--json".into(),
            "it's $(here); `too`".into(),
            String::new(),
        ]);
        assert_eq!(
            i.args.last().unwrap(),
            r#".local/share/Desk/bin/current/desk-helper connection --json 'it'\''s $(here); `too`' ''"#
        );
        let login = crate::host::Host::Ssh(m).login_invocation("echo ~");
        assert_eq!(login.args.last().unwrap(), "/bin/sh -lc 'echo ~'");
    }

    #[test]
    fn forwards_in_the_persons_config_are_found() {
        let said = "user dev\nhostname 203.0.113.7\nlocalforward [127.0.0.1]:8080 [127.0.0.1]:80\nRemoteForward 9000 127.0.0.1:9000\nforwardagent no\n";
        assert_eq!(config_forwards(said), ["localforward", "remoteforward"]);
        assert!(config_forwards("user dev\nclearallforwardings no\n").is_empty());
    }

    #[test]
    fn a_machine_is_kept_as_tagged_json() {
        let host = crate::host::Host::Ssh(devbox());
        let json = serde_json::to_value(&host).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"kind": "ssh", "id": "devbox", "name": "devbox", "target": "dev@devbox"})
        );
        assert_eq!(
            serde_json::from_value::<crate::host::Host>(json).unwrap(),
            host
        );
        assert_eq!(host.backend_path(std::path::Path::new("/Users/x")), None);
        assert_eq!(
            host.helper().as_deref(),
            Some(".local/share/Desk/bin/current/desk-helper")
        );
    }
}
