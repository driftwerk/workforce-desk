//! The steps of installing Desk's backend on a machine and keeping it
//! running there, each a fixed script from `desk_core::backend_install` run
//! over the person's `ssh`:
//!
//! - **copy**: the backend's tarball (signature-checked on this computer
//!   before it gets here) streams over ssh into a file beside `bin`, its
//!   SHA-256 is checked there against the one here, then it is unpacked
//!   into `bin/<version>` and that version asked `--check`;
//! - **flip**: `bin/current` points at it in one step; a running helper
//!   notices and hands over;
//! - **keep**: the systemd user service with linger, which Desk turns on
//!   itself only where the account may (never with sudo); else Desk starts
//!   the helper at each connect, and says the one line that would let it
//!   start at boot;
//! - **engines**: Claude Code's and Codex's own installers, for the account
//!   (`~/.local/bin`), never with sudo.

use std::process::Stdio;

use desk_core::backend_install as install;
use desk_core::machine::Machine;
use sha2::Digest as _;

use crate::probe::words;
use crate::ssh::{self, SSH_FAILED, SshExe};

/// What a step said went wrong: the machine's words when it said any.
fn failed(machine: &Machine, what: &str, out: &std::process::Output) -> String {
    if out.status.code() == Some(SSH_FAILED) {
        return ssh::problem(machine, &out.stderr);
    }
    match desk_core::machine::said_by(&machine.name, &String::from_utf8_lossy(&out.stderr)) {
        Some(said) => format!("{what}. {said}"),
        None => format!("{what}."),
    }
}

/// Runs `script` there with `sh`; what it printed, or why it failed.
pub fn run(ssh: &SshExe, machine: &Machine, script: &str, what: &str) -> Result<String, String> {
    let out = ssh
        .output(&machine.command(&["sh".into(), "-c".into(), script.into()]))
        .map_err(|e| format!("Desk couldn't run ssh: {e}"))?;
    if !out.status.success() {
        return Err(failed(machine, what, &out));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The SHA-256 of `data`, in hex.
fn sha256(data: &[u8]) -> String {
    sha2::Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The script that takes the tarball on its input into `bin/<version>`,
/// checking it arrived whole (`sha`), then asks that version `--check`.
pub fn copy_script(bin: &str, version: &str, sha: &str) -> Result<String, String> {
    let e = |e: eyre::Report| e.to_string();
    let unpack = install::unpack_script(bin, version).map_err(e)?;
    let check = install::check_script(bin, version).map_err(e)?;
    if sha.len() != 64 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("That isn't a SHA-256.".into());
    }
    Ok(format!(
        "set -eu\n\
         mkdir -p {bin}\n\
         tmp={tmp}\n\
         cat > \"$tmp\"\n\
         sum=$(sha256sum \"$tmp\" | cut -d' ' -f1)\n\
         if [ \"$sum\" != {sha} ]; then rm -f \"$tmp\"; echo \"the copy of Desk didn't arrive whole\" >&2; exit 1; fi\n\
         (\n{unpack}) < \"$tmp\"\n\
         rm -f \"$tmp\"\n\
         {check}\n",
        bin = install::quote(bin),
        tmp = install::quote(&format!("{bin}/{version}.tar.gz.partial")),
    ))
}

/// Copies `data` (the tarball's bytes, as they were checked here) there as
/// `version`, checks it, unpacks it and asks it `--check`. Blocking.
pub fn copy(
    ssh: &SshExe,
    machine: &Machine,
    bin: &str,
    version: &str,
    data: &[u8],
) -> Result<(), String> {
    let script = copy_script(bin, version, &sha256(data))?;
    let mut command = ssh.command(&machine.command(&["sh".into(), "-c".into(), script]));
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Desk couldn't run ssh: {e}"))?;
    let mut stdin = child.stdin.take().expect("piped");
    let data = data.to_vec();
    let feed = std::thread::spawn(move || {
        use std::io::Write as _;
        let _ = stdin.write_all(&data);
    });
    let out = child
        .wait_with_output()
        .map_err(|e| format!("Desk couldn't run ssh: {e}"))?;
    let _ = feed.join();
    if !out.status.success() {
        return Err(failed(machine, "Desk couldn't be copied there", &out));
    }
    Ok(())
}

/// Points `bin/current` at `version`. Blocking.
pub fn flip(ssh: &SshExe, machine: &Machine, bin: &str, version: &str) -> Result<(), String> {
    let script = install::flip_script(bin, version).map_err(|e| e.to_string())?;
    run(
        ssh,
        machine,
        &script,
        "Desk couldn't switch to its new version there",
    )
    .map(drop)
}

/// Linger, turned on by the account itself where it may: never `sudo`.
pub fn linger_script() -> &'static str {
    "user=$(id -un)\n\
     loginctl enable-linger \"$user\" >/dev/null 2>&1 || true\n\
     loginctl show-user \"$user\" -p Linger\n"
}

/// Turns linger on where the account may; whether it is on now. Blocking.
pub fn linger(ssh: &SshExe, machine: &Machine) -> Result<bool, String> {
    let said = run(
        ssh,
        machine,
        linger_script(),
        "Desk couldn't ask about linger there",
    )?;
    Ok(install::parse_linger(&said) == Some(true))
}

/// Who owns the machine, for its service there.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Person {
    pub name: Option<String>,
    pub email: Option<String>,
}

/// Writes, enables and starts Desk's service (restarting it when its unit
/// changed). Blocking.
pub fn service(ssh: &SshExe, machine: &Machine, bin: &str, person: &Person) -> Result<(), String> {
    let unit = install::machine_unit(bin, person.name.as_deref(), person.email.as_deref());
    let script = install::service_script(desk_core::systemd::UNIT, &unit);
    run(
        ssh,
        machine,
        &script,
        "Desk couldn't set up its service there",
    )
    .map(drop)
}

/// Starts Desk Helper there outside systemd, for a machine without linger.
/// Blocking.
pub fn start(ssh: &SshExe, machine: &Machine, bin: &str, person: &Person) -> Result<(), String> {
    let script = install::start_script(bin, person.name.as_deref(), person.email.as_deref());
    run(ssh, machine, &script, "Desk couldn't start there").map(drop)
}

/// Stops the helper Desk started outside systemd (its PTY holder, and so
/// the sessions, stay). Blocking.
pub fn stop(ssh: &SshExe, machine: &Machine, bin: &str) -> Result<(), String> {
    let script = format!(
        "{} --stop || true",
        install::quote(&install::current_helper(bin))
    );
    run(ssh, machine, &script, "Desk couldn't stop there").map(drop)
}

/// Starts the service if it is enabled and not running: systemd would
/// restart it anyway, unless someone stopped it. Blocking.
pub fn start_service(ssh: &SshExe, machine: &Machine) -> Result<(), String> {
    let script = format!("systemctl --user start {}", desk_core::systemd::UNIT);
    run(
        ssh,
        machine,
        &script,
        "Desk couldn't start its service there",
    )
    .map(drop)
}

/// The version of the Desk Helper running there (its version's folder,
/// from the process its pid file names); empty when none runs.
pub fn running_script() -> String {
    format!(
        "p=$(cat \"$HOME/{root}/hub/run/desk-hubd.pid\" 2>/dev/null) || exit 0\n\
         exe=$(readlink \"/proc/$p/exe\" 2>/dev/null) || exit 0\n\
         case \"$exe\" in \"$HOME/{root}/bin/\"*) basename \"$(dirname \"$exe\")\" ;; esac\n",
        root = desk_core::machine::MACHINE_ROOT,
    )
}

/// The version of the Desk Helper running there, if one is. Blocking.
pub fn running(ssh: &SshExe, machine: &Machine) -> Result<Option<String>, String> {
    let said = run(
        ssh,
        machine,
        &running_script(),
        "Desk couldn't ask what runs there",
    )?;
    Ok(Some(said.trim())
        .filter(|v| install::valid_version(v))
        .map(str::to_string))
}

/// Claude Code's and Codex's own installers, as their makers give them:
/// each for the account, into `~/.local/bin`, without sudo. Each is
/// fetched to a file first, so a download cut short runs nothing. One
/// already there is kept. It says `new=1` when it installed one: the hub
/// there finds its engines' programs when it starts, so it is restarted.
pub const CLAUDE_INSTALLER: &str = "https://claude.ai/install.sh";
pub const CODEX_INSTALLER: &str = "https://chatgpt.com/codex/install.sh";

pub fn engines_script() -> String {
    format!(
        "set -u\n\
         export PATH=\"$HOME/.local/bin:$PATH\"\n\
         command -v curl >/dev/null 2>&1 || {{ echo 'curl is needed to install Claude Code and Codex' >&2; exit 3; }}\n\
         tmp=$(mktemp -d)\n\
         trap 'rm -rf \"$tmp\"' EXIT\n\
         if ! command -v claude >/dev/null 2>&1; then\n  \
           curl -fsSL {claude} -o \"$tmp/claude.sh\" && bash \"$tmp/claude.sh\" </dev/null >\"$tmp/claude.log\" 2>&1 || {{ tail -n 3 \"$tmp/claude.log\" >&2; echo 'Claude Code could not be installed' >&2; exit 4; }}\n  \
           echo new=1\n\
         fi\n\
         if ! command -v codex >/dev/null 2>&1; then\n  \
           curl -fsSL {codex} -o \"$tmp/codex.sh\" && CODEX_NON_INTERACTIVE=1 sh \"$tmp/codex.sh\" </dev/null >\"$tmp/codex.log\" 2>&1 || {{ tail -n 3 \"$tmp/codex.log\" >&2; echo 'Codex could not be installed' >&2; exit 5; }}\n  \
           echo new=1\n\
         fi\n\
         printf 'claude=%s\\n' \"$(claude --version 2>/dev/null | head -n 1)\"\n\
         printf 'codex=%s\\n' \"$(codex --version 2>/dev/null | head -n 1)\"\n",
        claude = CLAUDE_INSTALLER,
        codex = CODEX_INSTALLER,
    )
}

/// What the engines step says it did, from what its script printed.
pub fn engines_detail(said: &str) -> String {
    let version = |k: &str| {
        said.lines()
            .find_map(|l| l.strip_prefix(&format!("{k}=")))
            .and_then(words)
            .and_then(|v| {
                v.split_whitespace()
                    .find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()))
                    .map(str::to_string)
            })
    };
    match (version("claude"), version("codex")) {
        (Some(c), Some(x)) => format!("Claude Code {c} and Codex {x} installed"),
        _ => "Claude Code and Codex installed".into(),
    }
}

/// What the engines step did: what it says, and whether it installed one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Engines {
    pub detail: String,
    pub installed: bool,
}

/// Installs Claude Code and Codex for the account there. Blocking.
pub fn engines(ssh: &SshExe, machine: &Machine) -> Result<Engines, String> {
    run(
        ssh,
        machine,
        &engines_script(),
        "Claude Code and Codex couldn't be installed",
    )
    .map(|said| Engines {
        detail: engines_detail(&said),
        installed: said.lines().any(|l| l.trim() == "new=1"),
    })
}

/// Restarts Desk there (its hub finds its engines' programs as it starts);
/// its PTY holder, and so any session, stays. Blocking.
pub fn restart(
    ssh: &SshExe,
    machine: &Machine,
    bin: &str,
    person: &Person,
    service: bool,
) -> Result<(), String> {
    if service {
        let script = format!("systemctl --user restart {}", desk_core::systemd::UNIT);
        return run(ssh, machine, &script, "Desk couldn't restart there").map(drop);
    }
    stop(ssh, machine, bin)?;
    start(ssh, machine, bin, person)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_copy_is_checked_before_it_is_unpacked() {
        let sha = "a".repeat(64);
        let s = copy_script("/home/dev/.local/share/Desk/bin", "0.3.0", &sha).unwrap();
        let sum = s.find("sha256sum").unwrap();
        let tar = s.find("tar -xzf").unwrap();
        let check = s.find("--check").unwrap();
        assert!(sum < tar && tar < check, "{s}");
        assert!(s.contains(&sha));
        assert!(copy_script("/b", "../x", &sha).is_err());
        assert!(copy_script("/b", "0.3.0", "$(id)").is_err());
    }

    #[test]
    fn linger_is_never_asked_of_sudo() {
        assert!(!linger_script().contains("sudo"));
        assert!(!engines_script().contains("sudo"));
    }

    #[test]
    fn the_engines_say_their_versions() {
        assert_eq!(
            engines_detail("claude=2.1.211 (Claude Code)\ncodex=codex-cli 0.98.0\n"),
            "Claude Code 2.1.211 and Codex 0.98.0 installed"
        );
        assert_eq!(
            engines_detail("claude=\ncodex=\n"),
            "Claude Code and Codex installed"
        );
    }
}
