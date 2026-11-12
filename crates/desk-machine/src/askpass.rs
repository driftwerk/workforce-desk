//! Handing `ssh` (or `ssh-add`) one secret the person typed into Desk's own
//! field (a machine's password, a key's passphrase) without it ever being
//! on a command line, in an environment, in a file or in a log.
//!
//! ssh asks its `SSH_ASKPASS` program for it, with the prompt as its only
//! word. Desk's askpass is Desk itself ([`client`], run when
//! [`SOCKET_ENV`] is set): it connects to a Unix socket in a folder only
//! the person can open, says a one-time token (the only thing in its
//! environment) and the prompt, and prints what it is given. [`Askpass`]
//! answers at most once, and only a prompt that is the one it expects: the
//! machine's own `user@host` password prompt (never a jump host's, never a
//! host-key yes/no), or `ssh-add`'s for the one key. Every other prompt is
//! refused, and said to the caller by its kind only.
//!
//! Unix only: Desk reaches machines with the system's `ssh` there.

use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use zeroize::Zeroizing;

/// Where Desk's askpass finds the socket.
pub const SOCKET_ENV: &str = "DESK_ASKPASS_SOCKET";
/// The one-time token it says first.
pub const TOKEN_ENV: &str = "DESK_ASKPASS_TOKEN";

pub use crate::secret::{MAX_SECRET, Secret};

/// The one prompt a secret is for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expect {
    /// The machine's password: `user@host's password: ` as ssh asks it for
    /// password authentication, or a keyboard-interactive `Password:`
    /// prefixed `(user@host) ` as ssh 8.4 and later shows it. `direct`:
    /// no jump host or proxy command, so an unprefixed `Password:` can only
    /// be the machine's.
    Password {
        user: String,
        host: String,
        direct: bool,
    },
    /// `ssh-add`'s for the key at `key`.
    Passphrase { key: PathBuf },
}

impl Expect {
    /// Whether `prompt` is the one this secret is for.
    pub fn answers(&self, prompt: &str) -> bool {
        let prompt = prompt.trim();
        match self {
            Expect::Password { user, host, direct } => {
                let lower = prompt.to_lowercase();
                let at = format!("{}@{}", user.to_lowercase(), host.to_lowercase());
                if lower == format!("{at}'s password:") {
                    return true;
                }
                let password = |rest: &str| {
                    let rest = rest.trim();
                    rest == "password:" || rest == "password"
                };
                if let Some(rest) = lower.strip_prefix(&format!("({at})")) {
                    return password(rest);
                }
                *direct && password(&lower)
            }
            Expect::Passphrase { key } => {
                let key = key.to_string_lossy();
                prompt
                    .strip_prefix("Enter passphrase for ")
                    .and_then(|rest| rest.strip_prefix(key.as_ref()))
                    .is_some_and(|rest| {
                        // Just the colon, or ssh-add's own note in brackets
                        // before it: nothing else may follow the key's path.
                        let rest = rest.trim_end();
                        rest == ":"
                            || rest
                                .strip_prefix(" (")
                                .and_then(|r| r.strip_suffix("):"))
                                .is_some_and(|note| !note.contains(['(', ')', ':']))
                    })
            }
        }
    }
}

/// What a prompt ssh asked was, said without its words (a machine's
/// keyboard-interactive prompt is its own words).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    /// Another account's or another host's password: a jump host's.
    OtherPassword,
    /// A key's passphrase.
    Passphrase,
    /// Anything else (a yes/no, a code).
    Other,
    /// The secret's prompt again: it was wrong the first time.
    Again,
}

fn kind_of(prompt: &str) -> Refused {
    let lower = prompt.to_lowercase();
    if lower.contains("passphrase") {
        Refused::Passphrase
    } else if lower.contains("password") {
        Refused::OtherPassword
    } else {
        Refused::Other
    }
}

/// What asking went: whether the secret was given, and what was refused.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Asked {
    pub answered: bool,
    pub refused: Vec<Refused>,
}

/// Serves one secret to Desk's askpass, until it is dropped.
pub struct Askpass {
    dir: tempfile::TempDir,
    token: Zeroizing<String>,
    program: PathBuf,
    stop: Arc<AtomicBool>,
    asked: Arc<Mutex<Asked>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Askpass {
    /// Serves `secret` for the prompt `expect` names, to askpass `program`
    /// (Desk itself).
    pub fn start(secret: Secret, expect: Expect, program: &Path) -> std::io::Result<Askpass> {
        let dir = tempfile::Builder::new().prefix("desk-askpass").tempdir()?;
        // Only the person reaches the socket: the folder is theirs alone.
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))?;
        let listener = UnixListener::bind(dir.path().join("s"))?;
        listener.set_nonblocking(true)?;
        let token = Zeroizing::new(new_token());
        let stop = Arc::new(AtomicBool::new(false));
        let asked = Arc::new(Mutex::new(Asked::default()));
        let thread = {
            let (stop, asked, token) = (Arc::clone(&stop), Arc::clone(&asked), token.clone());
            std::thread::Builder::new()
                .name("askpass".into())
                .spawn(move || serve(listener, secret, expect, token, stop, asked))?
        };
        Ok(Askpass {
            dir,
            token,
            program: program.to_path_buf(),
            stop,
            asked,
            thread: Some(thread),
        })
    }

    /// What `ssh` (or `ssh-add`) is run with to ask Desk.
    pub fn env(&self) -> Vec<(&'static str, std::ffi::OsString)> {
        vec![
            ("SSH_ASKPASS", self.program.clone().into_os_string()),
            ("SSH_ASKPASS_REQUIRE", "force".into()),
            // Older ssh asks its askpass only with a display set.
            (
                "DISPLAY",
                std::env::var_os("DISPLAY").unwrap_or_else(|| ":0".into()),
            ),
            (SOCKET_ENV, self.dir.path().join("s").into_os_string()),
            (TOKEN_ENV, self.token.as_str().into()),
        ]
    }

    /// Stops serving; what was asked.
    pub fn finish(mut self) -> Asked {
        self.stop_thread();
        self.asked.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn stop_thread(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Askpass {
    fn drop(&mut self) {
        self.stop_thread();
    }
}

fn new_token() -> String {
    use rand::RngExt as _;
    let mut bytes = [0u8; 32];
    rand::rng().fill(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Equal, taking as long whatever differs.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

fn serve(
    listener: UnixListener,
    secret: Secret,
    expect: Expect,
    token: Zeroizing<String>,
    stop: Arc<AtomicBool>,
    asked: Arc<Mutex<Asked>>,
) {
    let mut secret = Some(secret);
    while !stop.load(Ordering::SeqCst) {
        let stream = match listener.accept() {
            Ok((s, _)) => s,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(20));
                continue;
            }
            Err(_) => break,
        };
        let _ = answer(stream, &mut secret, &expect, &token, &asked);
    }
}

/// One askpass's question: the token, then the prompt, each on a line.
fn answer(
    stream: UnixStream,
    secret: &mut Option<Secret>,
    expect: &Expect,
    token: &str,
    asked: &Mutex<Asked>,
) -> std::io::Result<()> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut reader = BufReader::new((&stream).take(4096));
    let mut said_token = Zeroizing::new(String::new());
    reader.read_line(&mut said_token)?;
    if !same(said_token.trim_end().as_bytes(), token.as_bytes()) {
        return Ok(());
    }
    let mut prompt = String::new();
    reader.read_line(&mut prompt)?;
    let mut asked = asked.lock().unwrap_or_else(|e| e.into_inner());
    if !expect.answers(&prompt) {
        asked.refused.push(kind_of(&prompt));
        return Ok(());
    }
    // Once only: the same prompt again means the first answer was wrong.
    let Some(s) = secret.take() else {
        asked.refused.push(Refused::Again);
        return Ok(());
    };
    asked.answered = true;
    let mut out = &stream;
    out.write_all(s.expose().as_bytes())?;
    out.flush()
}

/// Desk run as ssh's askpass: asks the Desk that ran ssh for the answer to
/// `prompt`, and prints it. Exits 1 (ssh then takes it as cancelled) when
/// Desk gives none.
pub fn client(prompt: &str) -> i32 {
    let (Some(socket), Some(token)) = (std::env::var_os(SOCKET_ENV), std::env::var_os(TOKEN_ENV))
    else {
        return 1;
    };
    let Ok(mut stream) = UnixStream::connect(&socket) else {
        return 1;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let line = |s: &str| s.replace(['\n', '\r'], " ");
    let ask = format!("{}\n{}\n", token.to_string_lossy(), line(prompt));
    if stream.write_all(ask.as_bytes()).is_err() {
        return 1;
    }
    let _ = stream.shutdown(std::net::Shutdown::Write);
    let mut answer = Zeroizing::new(Vec::new());
    if stream
        .take(MAX_SECRET as u64 + 1)
        .read_to_end(&mut answer)
        .is_err()
        || answer.is_empty()
    {
        return 1;
    }
    let mut out = std::io::stdout().lock();
    if out
        .write_all(&answer)
        .and_then(|()| out.write_all(b"\n"))
        .is_err()
    {
        return 1;
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn password(direct: bool) -> Expect {
        Expect::Password {
            user: "dev".into(),
            host: "devbox.example.com".into(),
            direct,
        }
    }

    #[test]
    fn only_the_machines_own_prompt_is_answered() {
        let e = password(false);
        assert!(e.answers("dev@devbox.example.com's password: "));
        assert!(e.answers("DEV@Devbox.Example.com's password:"));
        assert!(e.answers("(dev@devbox.example.com) Password: "));
        // A jump host's, another account's, a passphrase, a yes/no.
        assert!(!e.answers("dev@bastion's password: "));
        assert!(!e.answers("root@devbox.example.com's password: "));
        assert!(!e.answers("(dev@bastion) Password: "));
        assert!(!e.answers("Enter passphrase for key '/Users/me/.ssh/id_ed25519': "));
        assert!(
            !e.answers("Are you sure you want to continue connecting (yes/no/[fingerprint])? ")
        );
        assert!(!e.answers("(dev@devbox.example.com) Verification code: "));
        // An unprefixed Password: only with nothing in between.
        assert!(!e.answers("Password: "));
        assert!(password(true).answers("Password: "));

        let key = Expect::Passphrase {
            key: "/Users/me/.ssh/id_ed25519".into(),
        };
        assert!(key.answers("Enter passphrase for /Users/me/.ssh/id_ed25519: "));
        assert!(
            key.answers("Enter passphrase for /Users/me/.ssh/id_ed25519 (will confirm each use): ")
        );
        assert!(!key.answers("Enter passphrase for /Users/me/.ssh/other: "));
        // Nothing else after the key's path.
        assert!(!key.answers("Enter passphrase for /Users/me/.ssh/id_ed25519.evil: "));
        assert!(
            !key.answers(
                "Enter passphrase for /Users/me/.ssh/id_ed25519 or dev@bastion's password: "
            )
        );
        assert!(!key.answers("Enter passphrase for /Users/me/.ssh/id_ed25519 (x): (y):"));
        assert!(!key.answers("dev@devbox's password: "));
    }

    #[test]
    fn a_secret_is_never_printed_and_holds_no_line_break() {
        let s = Secret::new(Zeroizing::new("hunter2".into())).unwrap();
        assert_eq!(format!("{s:?}"), "Secret(…)");
        assert!(Secret::new(Zeroizing::new(String::new())).is_err());
        assert!(Secret::new(Zeroizing::new("a\nb".into())).is_err());
        assert!(Secret::new(Zeroizing::new("x".repeat(MAX_SECRET + 1))).is_err());
    }

    /// Asks `askpass` as Desk's askpass client would, with `token`.
    fn ask(askpass: &Askpass, token: &str, prompt: &str) -> Option<String> {
        let env: std::collections::HashMap<_, _> = askpass.env().into_iter().collect();
        let mut s = UnixStream::connect(&env[SOCKET_ENV]).unwrap();
        s.write_all(format!("{token}\n{prompt}\n").as_bytes())
            .unwrap();
        s.shutdown(std::net::Shutdown::Write).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        (!out.is_empty()).then_some(out)
    }

    #[test]
    fn the_secret_is_given_once_to_its_prompt_and_its_token() {
        let secret = Secret::new(Zeroizing::new("hunter2".into())).unwrap();
        let a = Askpass::start(secret, password(false), Path::new("/bin/false")).unwrap();
        let env: std::collections::HashMap<_, _> = a.env().into_iter().collect();
        let token = env[TOKEN_ENV].to_string_lossy().into_owned();
        assert_eq!(env["SSH_ASKPASS_REQUIRE"], "force");
        assert!(
            !env.values()
                .any(|v| v.to_string_lossy().contains("hunter2")),
            "never in the environment"
        );
        // The socket's folder is the person's alone.
        use std::os::unix::fs::PermissionsExt as _;
        let dir = Path::new(&env[SOCKET_ENV]).parent().unwrap().to_path_buf();
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );

        assert_eq!(
            ask(&a, "wrong", "dev@devbox.example.com's password: "),
            None
        );
        assert_eq!(ask(&a, &token, "dev@bastion's password: "), None);
        assert_eq!(
            ask(&a, &token, "dev@devbox.example.com's password: ").as_deref(),
            Some("hunter2")
        );
        assert_eq!(
            ask(&a, &token, "dev@devbox.example.com's password: "),
            None,
            "once"
        );
        let asked = a.finish();
        assert!(asked.answered);
        assert_eq!(asked.refused, [Refused::OtherPassword, Refused::Again]);
        assert!(!dir.exists(), "its folder goes with it");
    }
}
