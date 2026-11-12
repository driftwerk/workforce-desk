//! Desk's own SSH key, and putting it on a machine with the person's
//! password once, so adding a machine never needs a terminal: no
//! `ssh-copy-id`, no line pasted into `authorized_keys`, no `ssh-add`.
//!
//! - The key is an ed25519 key with no passphrase (Desk must reach its
//!   machines while nobody is there to type one), made by `ssh-keygen` in a
//!   folder of Desk's only the person can open. Only the machines it was
//!   put on are offered it ([`crate::ssh::SshExe::uses_own_key`]).
//! - The password is typed into Desk's own field (never the page), held
//!   only in memory, wiped when done, and given to `ssh` by Desk's askpass
//!   ([`crate::askpass`]) for the machine's own `user@host` prompt only,
//!   once. The one `ssh` that uses it signs in with nothing else, to a
//!   machine whose host key is already known and unchanged.
//! - In the same session it turns linger on for the account, so Desk keeps
//!   running there after a restart: as the account where it may, else with
//!   `sudo -S` and the same password on that command's input, once. When
//!   neither can, the one step left is said.
//! - A key that needs a passphrase no agent holds is added to the agent
//!   the same way ([`add_to_agent`]), never stored.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use desk_core::machine::Machine;

use crate::askpass::{Asked, Askpass, Expect, Refused, Secret};
use crate::ssh::{self, SSH_FAILED, SshExe};

/// `ssh-keygen`.
const KEYGEN: &str = "/usr/bin/ssh-keygen";
/// `ssh-add`.
const SSH_ADD: &str = "/usr/bin/ssh-add";

/// Desk's own public key line, made first when it isn't there (`file`,
/// `file.pub`, in a folder made the person's alone). Blocking.
pub fn ensure(file: &Path) -> Result<String, String> {
    let made = |e: std::io::Error| format!("Desk couldn't make its own SSH key: {e}");
    let public = pub_of(file);
    if !file.is_file() || !public.is_file() {
        let dir = file.parent().ok_or("Desk's SSH key has no folder.")?;
        std::fs::create_dir_all(dir).map_err(made)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(made)?;
        }
        let _ = std::fs::remove_file(file);
        let _ = std::fs::remove_file(&public);
        let comment = format!("Desk on {}", computer_name());
        let out = std::process::Command::new(KEYGEN)
            .args(["-q", "-t", "ed25519", "-N", "", "-C"])
            .arg(&comment)
            .arg("-f")
            .arg(file)
            .stdin(Stdio::null())
            .output()
            .map_err(made)?;
        if !out.status.success() {
            return Err("Desk couldn't make its own SSH key (ssh-keygen refused).".into());
        }
    }
    let line = std::fs::read_to_string(&public).map_err(made)?;
    crate::probe::public_key_line(&line).ok_or_else(|| "Desk's own SSH key can't be read.".into())
}

/// Where Desk's own public key is, beside `file`.
pub fn public_file(file: &Path) -> PathBuf {
    pub_of(file)
}

fn pub_of(file: &Path) -> PathBuf {
    let mut p = file.as_os_str().to_owned();
    p.push(".pub");
    PathBuf::from(p)
}

/// This computer's name, for the key's comment (so the person can tell it
/// apart in `authorized_keys` there).
fn computer_name() -> String {
    std::process::Command::new("/bin/hostname")
        .arg("-s")
        .stdin(Stdio::null())
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|h| h.trim().to_string())
        .filter(|h| {
            !h.is_empty()
                && h.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        })
        .unwrap_or_else(|| "this computer".into())
}

/// The `type base64` part of a public key line.
fn key_part(line: &str) -> String {
    line.split_whitespace()
        .take(2)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Puts the key (`$1`, one public key line) in the account's
/// `authorized_keys` unless it is there, then turns linger on as the
/// account, else with `sudo -S` once (its password on the input), and says
/// both.
pub const INSTALL_SCRIPT: &str = "set -e\n\
     umask 077\n\
     key=\"$1\"\n\
     part=\"$2\"\n\
     mkdir -p \"$HOME/.ssh\"\n\
     chmod 700 \"$HOME/.ssh\"\n\
     f=\"$HOME/.ssh/authorized_keys\"\n\
     [ -f \"$f\" ] || : > \"$f\"\n\
     chmod 600 \"$f\"\n\
     grep -qF -- \"$part\" \"$f\" || printf '%s\\n' \"$key\" >> \"$f\"\n\
     echo key=ok\n\
     set +e\n\
     user=$(id -un)\n\
     if command -v loginctl >/dev/null 2>&1; then\n\
       if [ \"$(loginctl show-user \"$user\" -p Linger --value 2>/dev/null)\" != yes ]; then\n\
         loginctl enable-linger \"$user\" </dev/null >/dev/null 2>&1 \\\n\
           || { command -v sudo >/dev/null 2>&1 && sudo -S -k -p '' loginctl enable-linger \"$user\" >/dev/null 2>&1; }\n\
       fi\n\
       printf 'linger=%s\\n' \"$(loginctl show-user \"$user\" -p Linger --value 2>/dev/null)\"\n\
     fi\n\
     exit 0\n";

/// Turns linger on with `sudo -S` once, its password on the input; says it.
pub const LINGER_SCRIPT: &str = "user=$(id -un)\n\
     command -v loginctl >/dev/null 2>&1 || exit 0\n\
     if [ \"$(loginctl show-user \"$user\" -p Linger --value 2>/dev/null)\" != yes ]; then\n\
       command -v sudo >/dev/null 2>&1 && sudo -S -k -p '' loginctl enable-linger \"$user\" >/dev/null 2>&1\n\
     fi\n\
     printf 'linger=%s\\n' \"$(loginctl show-user \"$user\" -p Linger --value 2>/dev/null)\"\n";

/// Takes Desk's own key (`$1`, its `type base64`) out of the account's
/// `authorized_keys`, leaving every other line as it was.
pub const REMOVE_SCRIPT: &str = "f=\"$HOME/.ssh/authorized_keys\"\n\
     [ -f \"$f\" ] || exit 0\n\
     grep -qF -- \"$1\" \"$f\" || exit 0\n\
     t=$(mktemp \"$f.XXXXXX\") || exit 1\n\
     grep -vF -- \"$1\" \"$f\" > \"$t\"\n\
     chmod 600 \"$t\" && mv \"$t\" \"$f\"\n";

/// What putting the key there did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    /// Linger as it is now there: on, off (an administrator turns it on),
    /// or `None` where the machine has no `loginctl`.
    pub linger: Option<bool>,
}

/// Why it didn't.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Problem {
    /// The machine said no to that password.
    Wrong,
    /// It never asked for a password: it signs in with keys only.
    KeysOnly,
    /// A jump host asked for its own password, which Desk doesn't give.
    JumpHost,
    /// Anything else, in the person's words.
    Other(String),
}

impl Problem {
    pub fn said(&self, name: &str) -> String {
        match self {
            Problem::Wrong => format!("{name} didn't take that password. Try it again."),
            Problem::KeysOnly => format!(
                "{name} only lets keys sign in, not passwords, so Desk can't put its key there with one."
            ),
            Problem::JumpHost => format!(
                "The jump host on the way to {name} asked for its own password. Desk only gives a password to {name} itself."
            ),
            Problem::Other(s) => s.clone(),
        }
    }
}

/// The settings ssh resolves for `machine` that the password prompt names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prompted {
    pub user: String,
    pub hostname: String,
    /// No jump host or proxy command between.
    pub direct: bool,
}

/// Puts Desk's own key (`public`, its line) on `machine` with the person's
/// `password`, asked for by `askpass` (Desk), and turns linger on in the
/// same session. Only for a machine whose host key is known and unchanged:
/// that is checked by ssh itself (`StrictHostKeyChecking=yes`). Blocking.
pub fn install(
    ssh: &SshExe,
    machine: &Machine,
    prompted: &Prompted,
    public: &str,
    password: Secret,
    askpass: &Path,
) -> Result<Installed, Problem> {
    let words = [
        "sh".to_string(),
        "-c".to_string(),
        INSTALL_SCRIPT.to_string(),
        "desk-key".to_string(),
        public.to_string(),
        key_part(public),
    ];
    let (said, asked) = with_password(
        ssh,
        &machine.password_command(&words),
        prompted,
        password,
        askpass,
    )?;
    let out = said.map_err(|e| Problem::Other(ssh::io_problem(&e)))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    if out.status.success() && stdout.lines().any(|l| l.trim() == "key=ok") {
        return Ok(Installed {
            linger: linger_of(&stdout),
        });
    }
    Err(failed(machine, &out, &asked))
}

/// Turns linger on for `machine`'s account with `sudo -S` and the person's
/// `password`, over Desk's ordinary connection (its key gets in): the one
/// step a machine without linger needs. Whether it is on now.
pub fn linger_with(
    ssh: &SshExe,
    machine: &Machine,
    password: Secret,
) -> Result<Option<bool>, String> {
    let words = [
        "sh".to_string(),
        "-c".to_string(),
        LINGER_SCRIPT.to_string(),
    ];
    let mut child = ssh
        .command(&machine.command(&words))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| ssh::io_problem(&e))?;
    feed(&mut child, &password);
    drop(password);
    let out = ssh::wait(child).map_err(|e| ssh::io_problem(&e))?;
    if !out.status.success() {
        return Err(ssh::problem(machine, &out.stderr));
    }
    Ok(linger_of(&String::from_utf8_lossy(&out.stdout)))
}

/// Writes `password` and a line end on `child`'s input, for `sudo -S`
/// there, then closes it.
fn feed(child: &mut std::process::Child, password: &Secret) {
    if let Some(mut input) = child.stdin.take() {
        let mut line = zeroize::Zeroizing::new(password.expose().as_bytes().to_vec());
        line.push(b'\n');
        let _ = input.write_all(&line);
    }
}

/// Runs `invocation` with `password` given by Desk's askpass (to its own
/// prompt only) and on its input (for `sudo -S` there); what it said and
/// what was asked.
fn with_password(
    ssh: &SshExe,
    invocation: &desk_core::host::Invocation,
    prompted: &Prompted,
    password: Secret,
    askpass: &Path,
) -> Result<(std::io::Result<std::process::Output>, Asked), Problem> {
    // A second copy, for sudo's input, wiped as the first is.
    let for_sudo = Secret::new(zeroize::Zeroizing::new(password.expose().to_string()))
        .map_err(Problem::Other)?;
    let serving = Askpass::start(
        password,
        Expect::Password {
            user: prompted.user.clone(),
            host: prompted.hostname.clone(),
            direct: prompted.direct,
        },
        askpass,
    )
    .map_err(|e| Problem::Other(format!("Desk couldn't get ready to sign in: {e}")))?;
    let mut command = ssh.command(invocation);
    command
        .env_remove("SSH_ASKPASS")
        .envs(serving.env())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let said = command.spawn().and_then(|mut child| {
        feed(&mut child, &for_sudo);
        ssh::wait(child)
    });
    drop(for_sudo);
    Ok((said, serving.finish()))
}

fn linger_of(said: &str) -> Option<bool> {
    said.lines()
        .filter_map(|l| l.trim().strip_prefix("linger="))
        .find_map(|v| match v.trim() {
            "yes" => Some(true),
            "no" => Some(false),
            _ => None,
        })
}

/// Why the password session didn't put the key there.
fn failed(machine: &Machine, out: &std::process::Output, asked: &Asked) -> Problem {
    let said = String::from_utf8_lossy(&out.stderr);
    let denied = out.status.code() == Some(SSH_FAILED)
        && (said.contains("Permission denied")
            || said.contains("Too many authentication failures"));
    if denied {
        if asked.answered {
            return Problem::Wrong;
        }
        if asked.refused.contains(&Refused::OtherPassword) {
            return Problem::JumpHost;
        }
        return Problem::KeysOnly;
    }
    if out.status.code() == Some(SSH_FAILED) {
        return Problem::Other(ssh::problem(machine, &out.stderr));
    }
    Problem::Other(format!(
        "Desk signed in to {}, but couldn't put its key there.{}",
        machine.name,
        desk_core::machine::said_by(&machine.name, said.lines().last().unwrap_or_default())
            .map(|s| format!(" {s}"))
            .unwrap_or_default()
    ))
}

/// Adds `key` (a key that needs its passphrase) to the person's SSH agent
/// with `passphrase`, given by Desk's askpass for that key's prompt only;
/// never stored. Blocking.
pub fn add_to_agent(key: &Path, passphrase: Secret, askpass: &Path) -> Result<(), String> {
    if std::env::var_os("SSH_AUTH_SOCK").is_none_or(|s| s.is_empty()) {
        return Err("No SSH agent is running for Desk to unlock your key in.".into());
    }
    let serving = Askpass::start(
        passphrase,
        Expect::Passphrase {
            key: key.to_path_buf(),
        },
        askpass,
    )
    .map_err(|e| format!("Desk couldn't get ready to unlock your key: {e}"))?;
    let out = std::process::Command::new(SSH_ADD)
        .arg("--")
        .arg(key)
        .env_remove("SSH_ASKPASS")
        .envs(serving.env())
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Desk couldn't run ssh-add: {e}"))?;
    let asked = serving.finish();
    if out.status.success() {
        return Ok(());
    }
    if asked.answered || asked.refused.contains(&Refused::Again) {
        return Err("That isn't your key's passphrase. Try it again.".into());
    }
    Err("Your SSH agent didn't take the key.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_install_script_adds_the_key_once_and_keeps_the_rest() {
        let home = tempfile::tempdir().unwrap();
        let ssh = home.path().join(".ssh");
        std::fs::create_dir_all(&ssh).unwrap();
        let other = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOTHERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx someone";
        std::fs::write(ssh.join("authorized_keys"), format!("{other}\n")).unwrap();
        let key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDESKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx Desk on mac";
        let run = |script: &str, args: &[&str]| {
            std::process::Command::new("sh")
                .arg("-c")
                .arg(script)
                .arg("desk-key")
                .args(args)
                .env("HOME", home.path())
                .env("PATH", "/usr/bin:/bin")
                .stdin(Stdio::null())
                .output()
                .unwrap()
        };
        for _ in 0..2 {
            let out = run(INSTALL_SCRIPT, &[key, &key_part(key)]);
            assert!(out.status.success(), "{out:?}");
            assert!(String::from_utf8_lossy(&out.stdout).contains("key=ok"));
        }
        let kept = std::fs::read_to_string(ssh.join("authorized_keys")).unwrap();
        assert_eq!(kept, format!("{other}\n{key}\n"), "added once");
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(ssh.join("authorized_keys"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);

        let out = run(REMOVE_SCRIPT, &[&key_part(key)]);
        assert!(out.status.success(), "{out:?}");
        assert_eq!(
            std::fs::read_to_string(ssh.join("authorized_keys")).unwrap(),
            format!("{other}\n")
        );
    }

    #[test]
    fn what_went_wrong_is_said_plainly() {
        assert_eq!(linger_of("key=ok\nlinger=yes\n"), Some(true));
        assert_eq!(linger_of("key=ok\nlinger=\n"), None);
        assert!(
            Problem::KeysOnly
                .said("devbox")
                .contains("only lets keys sign in")
        );
        assert!(Problem::JumpHost.said("devbox").contains("jump host"));
        assert_eq!(
            key_part("ssh-ed25519 AAAA comment here"),
            "ssh-ed25519 AAAA"
        );
    }

    #[test]
    fn its_own_key_is_made_once_in_a_private_folder() {
        if !Path::new(KEYGEN).exists() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("ssh").join("id_ed25519");
        let line = ensure(&file).unwrap();
        assert!(line.starts_with("ssh-ed25519 "), "{line}");
        assert!(line.contains("Desk on "), "{line}");
        assert_eq!(ensure(&file).unwrap(), line, "kept");
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(file.parent().unwrap())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
    }
}
