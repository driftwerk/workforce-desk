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

/// Desk's own key line split into what the scripts take: its type, its
/// base64 and its comment; none for anything but one public key line.
pub fn key_fields(line: &str) -> Option<(String, String, String)> {
    let line = crate::probe::public_key_line(line)?;
    let mut w = line.split_whitespace();
    let (kind, b64) = (w.next()?.to_string(), w.next()?.to_string());
    let comment = w.collect::<Vec<_>>().join(" ");
    // As the scripts check them again: a type ssh names, base64 alone.
    let kind_ok = kind
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "-@.".contains(c));
    let b64_ok = b64.len() >= 16
        && b64
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+/=".contains(c));
    (kind_ok && b64_ok).then_some((kind, b64, comment))
}

/// What Desk's line in `authorized_keys` allows besides signing in: no
/// agent or X11 forwarding (Desk forwards a port, so not `restrict`).
pub const KEY_OPTIONS: &str = "no-agent-forwarding,no-X11-forwarding";

/// Checks the key (`$1` its type, `$2` its base64) and finds it in
/// `authorized_keys`: an uncommented line with exactly those two fields one
/// after the other, whatever options come before them. Defines `f`, `has`.
const FIND: &str = r#"type="$1"; b64="$2"
case "$type" in ''|*[!A-Za-z0-9@.-]*) echo "bad key" >&2; exit 3 ;; esac
case "$b64" in ''|*[!A-Za-z0-9+/=]*) echo "bad key" >&2; exit 3 ;; esac
[ "${#b64}" -ge 16 ] || { echo "bad key" >&2; exit 3; }
f="$HOME/.ssh/authorized_keys"
has() { awk -v t="$type" -v k="$b64" '$0 !~ /^[[:space:]]*#/ { for (i = 1; i < NF; i++) if ($i == t && $(i+1) == k) found = 1 } END { exit !found }' "$f"; }
"#;

/// Puts Desk's key (`$1` type, `$2` base64, `$3` comment) in the account's
/// `authorized_keys` unless it is there (see [`FIND`]): on a line of its
/// own, a line end added first to a file that lacks one, written through a
/// link rather than replacing it. Then turns linger on as the account, else
/// with `sudo -S` once, its password asked for (`desk-sudo-asks`) and given
/// only then; and says both.
pub fn install_script() -> String {
    format!(
        "set -e\numask 077\n{FIND}mkdir -p \"$HOME/.ssh\"\nchmod 700 \"$HOME/.ssh\"\n\
         [ -e \"$f\" ] || : > \"$f\"\n\
         if ! has; then\n\
           if [ -s \"$f\" ] && [ -n \"$(tail -c 1 \"$f\")\" ]; then printf '\\n' >> \"$f\"; fi\n\
           printf '%s %s %s %s\\n' '{KEY_OPTIONS}' \"$type\" \"$b64\" \"$3\" >> \"$f\"\n\
         fi\n\
         chmod 600 \"$f\"\n\
         has && echo key=ok\n\
         set +e\n\
         user=$(id -un)\n\
         if command -v loginctl >/dev/null 2>&1; then\n\
           if [ \"$(loginctl show-user \"$user\" -p Linger --value 2>/dev/null)\" != yes ]; then\n\
             if ! loginctl enable-linger \"$user\" </dev/null >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then\n\
               echo {SUDO_ASKS}\n\
               sudo -S -k -p '' loginctl enable-linger \"$user\" >/dev/null 2>&1\n\
             fi\n\
           fi\n\
           printf 'linger=%s\\n' \"$(loginctl show-user \"$user\" -p Linger --value 2>/dev/null)\"\n\
         fi\n\
         exit 0\n"
    )
}

/// What the scripts say, on a line of its own, just before `sudo -S` reads
/// the password: it is written to their input then, and only then.
pub const SUDO_ASKS: &str = "desk-sudo-asks";

/// Turns linger on with `sudo -S` once, the password asked for as
/// [`install_script`] asks; says it.
pub fn linger_script() -> String {
    format!(
        "user=$(id -un)\n\
         command -v loginctl >/dev/null 2>&1 || exit 0\n\
         if [ \"$(loginctl show-user \"$user\" -p Linger --value 2>/dev/null)\" != yes ] && command -v sudo >/dev/null 2>&1; then\n\
           echo {SUDO_ASKS}\n\
           sudo -S -k -p '' loginctl enable-linger \"$user\" >/dev/null 2>&1\n\
         fi\n\
         printf 'linger=%s\\n' \"$(loginctl show-user \"$user\" -p Linger --value 2>/dev/null)\"\n"
    )
}

/// Takes Desk's key (`$1` type, `$2` base64) out of the account's
/// `authorized_keys`: only uncommented lines with exactly those fields
/// (see [`FIND`]); every other line, comments included, as it was. A copy
/// of the file as it was is kept beside it (`authorized_keys.desk-bak`),
/// and the file is written in place, through a link.
pub fn remove_script() -> String {
    format!(
        "set -e\numask 077\n{FIND}[ -f \"$f\" ] || exit 0\n\
         has || exit 0\n\
         cp \"$f\" \"$f.desk-bak\"\n\
         t=$(mktemp \"$HOME/.ssh/.desk-keys.XXXXXX\")\n\
         awk -v t=\"$type\" -v k=\"$b64\" '{{ if ($0 !~ /^[[:space:]]*#/) {{ for (i = 1; i < NF; i++) if ($i == t && $(i+1) == k) next }} print }}' \"$f\" > \"$t\"\n\
         cat \"$t\" > \"$f\"\n\
         rm -f \"$t\"\n"
    )
}

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
    let (kind, b64, comment) = key_fields(public)
        .ok_or_else(|| Problem::Other("Desk's own SSH key can't be read.".into()))?;
    let words = [
        "sh".to_string(),
        "-c".to_string(),
        install_script(),
        "desk-key".to_string(),
        kind,
        b64,
        comment,
    ];
    let (said, asked) = with_password(
        ssh,
        &machine.password_command(&words),
        prompted,
        password,
        askpass,
    )?;
    let out = said.map_err(|e| Problem::Other(ssh::io_problem(&e)))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
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
    let words = ["sh".to_string(), "-c".to_string(), linger_script()];
    let child = ssh
        .command(&machine.command(&words))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| ssh::io_problem(&e))?;
    let out = run_feeding(child, &password).map_err(|e| ssh::io_problem(&e))?;
    drop(password);
    if !out.status.success() {
        return Err(ssh::problem(machine, &out.stderr));
    }
    Ok(linger_of(&String::from_utf8_lossy(&out.stdout)))
}

/// Waits for `child` (all three of its pipes Desk's) as [`ssh::wait`]
/// does, writing `password` and a line end on its input only when it says
/// [`SUDO_ASKS`] (for `sudo -S` there), and closing its input once it has
/// said all it will. What it said comes back with the password's text
/// taken out of it, wherever the machine echoed it.
fn run_feeding(
    mut child: std::process::Child,
    password: &Secret,
) -> std::io::Result<std::process::Output> {
    use std::io::BufRead as _;
    let input = child.stdin.take();
    let stdout = child.stdout.take();
    let secret = zeroize::Zeroizing::new(password.expose().as_bytes().to_vec());
    let out = std::thread::scope(|scope| {
        let reading = scope.spawn(|| {
            let mut input = input;
            let mut said = Vec::new();
            if let Some(out) = stdout {
                let mut lines = std::io::BufReader::new(out);
                let mut line = Vec::new();
                while lines.read_until(b'\n', &mut line).unwrap_or(0) > 0 {
                    if line.trim_ascii() == SUDO_ASKS.as_bytes() {
                        if let Some(mut i) = input.take() {
                            let mut answer = zeroize::Zeroizing::new(secret.to_vec());
                            answer.push(b'\n');
                            let _ = i.write_all(&answer);
                        }
                    } else {
                        said.extend_from_slice(&line);
                    }
                    line.clear();
                }
            }
            drop(input);
            said
        });
        let waited = ssh::wait(child);
        let said = reading.join().unwrap_or_default();
        waited.map(|mut o| {
            o.stdout = said;
            o
        })
    })?;
    Ok(scrubbed(out, &secret))
}

/// `out` with `secret`'s text taken out of what it said.
fn scrubbed(mut out: std::process::Output, secret: &[u8]) -> std::process::Output {
    let scrub = |said: &mut Vec<u8>| {
        if secret.is_empty() {
            return;
        }
        while let Some(at) = said.windows(secret.len()).position(|w| w == secret) {
            said.splice(at..at + secret.len(), b"\xe2\x80\xa6".iter().copied());
        }
    };
    scrub(&mut out.stdout);
    scrub(&mut out.stderr);
    out
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
    // The askpass token is in ssh's environment, and so in its children's
    // (a ProxyCommand's, a jump host's ssh): a token for one answer, to one
    // prompt, over a socket only the person can reach; never the password.
    let said = command
        .spawn()
        .and_then(|child| run_feeding(child, &for_sudo));
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

    const DESK: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINVryCC2LMDehVH2s0X1phBfYDkIBfEp4uRw/+7lxe8F Desk on mac";
    const OTHER: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOZhZmFrZWtleWZha2VrZXlmYWtla2V5ZmFrZWtleWY= someone";

    /// A home with `authorized_keys` holding `keys`, and the scripts run in it.
    struct Home(tempfile::TempDir);

    impl Home {
        fn with(keys: &str) -> Home {
            let home = tempfile::tempdir().unwrap();
            std::fs::create_dir_all(home.path().join(".ssh")).unwrap();
            std::fs::write(home.path().join(".ssh/authorized_keys"), keys).unwrap();
            Home(home)
        }
        fn file(&self) -> PathBuf {
            self.0.path().join(".ssh/authorized_keys")
        }
        fn keys(&self) -> String {
            std::fs::read_to_string(self.file()).unwrap()
        }
        fn run(&self, script: &str, args: &[&str]) -> std::process::Output {
            std::process::Command::new("sh")
                .arg("-c")
                .arg(script)
                .arg("desk-key")
                .args(args)
                .env_clear()
                .env("HOME", self.0.path())
                .env("PATH", "/usr/bin:/bin")
                .stdin(Stdio::null())
                .output()
                .unwrap()
        }
        fn install(&self) -> std::process::Output {
            let (t, k, c) = key_fields(DESK).unwrap();
            self.run(&install_script(), &[&t, &k, &c])
        }
        fn remove(&self, t: &str, k: &str) -> std::process::Output {
            self.run(&remove_script(), &[t, k])
        }
    }

    fn desk_line() -> String {
        format!("{KEY_OPTIONS} {DESK}")
    }

    #[test]
    fn the_key_is_added_once_on_a_line_of_its_own_and_taken_away_exactly() {
        let h = Home::with(&format!("{OTHER}\n"));
        for _ in 0..2 {
            let out = h.install();
            assert!(out.status.success(), "{out:?}");
            assert!(String::from_utf8_lossy(&out.stdout).contains("key=ok"));
        }
        assert_eq!(
            h.keys(),
            format!("{OTHER}\n{}\n", desk_line()),
            "added once"
        );
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(h.file()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let (t, k, _) = key_fields(DESK).unwrap();
        let out = h.remove(&t, &k);
        assert!(out.status.success(), "{out:?}");
        assert_eq!(h.keys(), format!("{OTHER}\n"), "every other key as it was");
        // The file as it was is kept beside it.
        let kept =
            std::fs::read_to_string(h.0.path().join(".ssh/authorized_keys.desk-bak")).unwrap();
        assert_eq!(kept, format!("{OTHER}\n{}\n", desk_line()));
    }

    #[test]
    fn a_file_with_no_last_line_end_keeps_its_last_key_whole() {
        let h = Home::with(OTHER);
        assert!(h.install().status.success());
        assert_eq!(h.keys(), format!("{OTHER}\n{}\n", desk_line()));
        let (t, k, _) = key_fields(DESK).unwrap();
        assert!(h.remove(&t, &k).status.success());
        assert_eq!(h.keys(), format!("{OTHER}\n"), "someone's key survives");
    }

    #[test]
    fn an_empty_or_partial_key_is_refused_and_removes_nothing() {
        let all = format!("{OTHER}\n{}\n", desk_line());
        let h = Home::with(&all);
        for (t, k) in [
            ("", ""),
            ("ssh-ed25519", ""),
            ("ssh-ed25519", "AAAAC3NzaC1lZDI1NTE5"),
            ("ssh-ed25519", "AAAA*"),
            (
                "ssh-ed25519; rm -rf ~",
                "AAAAC3NzaC1lZDI1NTE5AAAAINVryCC2LMDehVH2",
            ),
        ] {
            let out = h.remove(t, k);
            assert!(
                out.status.code() == Some(3) || out.status.success(),
                "{t} {k}: {out:?}"
            );
            assert_eq!(h.keys(), all, "{t} {k}: nothing removed");
        }
        // A prefix of every ed25519 key's base64 matches no line exactly.
        let out = h.remove("ssh-ed25519", "AAAAC3NzaC1lZDI1NTE5AAAAI");
        assert!(out.status.success(), "{out:?}");
        assert_eq!(h.keys(), all);
        assert!(key_fields("").is_none());
        assert!(key_fields("ssh-ed25519").is_none());
        assert!(key_fields("ssh-ed25519 AAAA").is_none());
    }

    #[test]
    fn a_commented_copy_doesnt_count_and_stays_and_one_with_options_is_found() {
        let commented = format!("# {DESK}");
        let h = Home::with(&format!("{commented}\n{OTHER}\n"));
        assert!(h.install().status.success());
        assert_eq!(
            h.keys(),
            format!("{commented}\n{OTHER}\n{}\n", desk_line()),
            "added: a comment isn't a key"
        );
        let (t, k, _) = key_fields(DESK).unwrap();
        assert!(h.remove(&t, &k).status.success());
        assert_eq!(
            h.keys(),
            format!("{commented}\n{OTHER}\n"),
            "the comment stays"
        );

        // A copy someone restricted is Desk's key all the same.
        let restricted = format!("restrict,from=\"10.0.0.0/8\" {DESK}");
        let h = Home::with(&format!("{restricted}\n{OTHER}\n"));
        let out = h.install();
        assert!(String::from_utf8_lossy(&out.stdout).contains("key=ok"));
        assert_eq!(
            h.keys(),
            format!("{restricted}\n{OTHER}\n"),
            "not added twice"
        );
        assert!(h.remove(&t, &k).status.success());
        assert_eq!(h.keys(), format!("{OTHER}\n"));
    }

    #[test]
    fn a_linked_authorized_keys_is_written_through_not_replaced() {
        let h = Home::with("");
        std::fs::remove_file(h.file()).unwrap();
        let real = h.0.path().join("real_keys");
        std::fs::write(&real, format!("{OTHER}\n")).unwrap();
        std::os::unix::fs::symlink(&real, h.file()).unwrap();
        assert!(h.install().status.success());
        let (t, k, _) = key_fields(DESK).unwrap();
        assert!(h.remove(&t, &k).status.success());
        assert!(
            std::fs::symlink_metadata(h.file())
                .unwrap()
                .file_type()
                .is_symlink(),
            "still a link"
        );
        assert_eq!(
            std::fs::read_to_string(&real).unwrap(),
            format!("{OTHER}\n")
        );
    }

    #[test]
    fn sudo_is_given_the_password_only_when_it_asks_and_it_is_never_said_back() {
        let password = Secret::new(zeroize::Zeroizing::new("hunter2".into())).unwrap();
        let run = |script: &str| {
            let child = std::process::Command::new("sh")
                .arg("-c")
                .arg(script)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            run_feeding(child, &password).unwrap()
        };
        // Not asked: it runs to its end, nothing written for it.
        let out = run("echo done");
        assert_eq!(String::from_utf8_lossy(&out.stdout), "done\n");
        // Asked: given, and echoed back only as “…”.
        let out = run(&format!(
            "echo {SUDO_ASKS}; read pw; echo \"got $pw\" >&2; echo ok"
        ));
        assert_eq!(String::from_utf8_lossy(&out.stdout), "ok\n");
        assert_eq!(String::from_utf8_lossy(&out.stderr), "got …\n");
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
