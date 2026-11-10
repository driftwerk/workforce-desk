//! Connecting a plan in one click: Desk runs the real CLI's own sign-in as
//! the person — `claude setup-token`, or `codex login` in a throwaway Codex
//! home so it never touches their own `codex` login — and saves the result
//! where their agents on this computer read it. The token never reaches the
//! page.

mod cli;
mod deadline;
pub mod install;
mod probe;
mod scan;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use desk_core::backend::Backend;
use desk_core::host::Host;
use portable_pty::{ChildKiller, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Plan {
    Claude,
    Chatgpt,
}

impl Plan {
    fn vault_path(self) -> &'static str {
        match self {
            Plan::Claude => "claude_code/oauth_token",
            Plan::Chatgpt => "codex/auth_json",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum Progress {
    Starting,
    Browser { url: String },
    NeedsCode,
    Saving,
    Done,
    Failed { message: String },
}

#[derive(Serialize, Clone)]
struct Event {
    plan: Plan,
    #[serde(flatten)]
    progress: Progress,
}

/// A sign-in that's running, and how to end it.
enum Running {
    /// `claude setup-token` on a pseudo-terminal here (macOS, Linux).
    Pty {
        writer: Box<dyn Write + Send>,
        killer: Box<dyn ChildKiller + Send + Sync>,
    },
    /// `claude setup-token` inside WSL: `wsl.exe` over plain pipes, with a
    /// terminal of Linux's own inside (see `cli::wsl_sign_in`).
    Wsl {
        stdin: ChildStdin,
        child: Arc<Mutex<Child>>,
        backend: Backend,
    },
    Chatgpt {
        child: Arc<Mutex<Child>>,
    },
}

/// What `claude setup-token`'s Linux process is found by when it's ended.
const CLAUDE_MARKER: &str = "setup-token";

impl Running {
    /// Ends the sign-in: the program, what it started, and inside WSL the
    /// Linux side too, which isn't in Windows' process tree.
    fn end(self) {
        match self {
            Running::Pty { mut killer, .. } => {
                let _ = killer.kill();
            }
            Running::Wsl {
                stdin,
                child,
                backend,
            } => {
                drop(stdin);
                deadline::kill_tree(&mut child.lock().expect("child"));
                cli::stop_sign_in(&backend, Plan::Claude.program(), CLAUDE_MARKER);
            }
            Running::Chatgpt { child } => deadline::kill_tree(&mut child.lock().expect("child")),
        }
    }
}

/// One attempt at a plan's sign-in: `running` is empty while it starts.
struct Slot {
    id: u64,
    running: Option<Running>,
}

type Slots = Arc<Mutex<HashMap<Plan, Slot>>>;

/// Takes attempt `id`'s slot out, if it is still the plan's current one;
/// whether it was (a later attempt, or Cancel, may have replaced it).
fn finish(slots: &Slots, plan: Plan, id: u64) -> bool {
    let mut slots = slots.lock().expect("logins");
    if slots.get(&plan).is_some_and(|s| s.id == id) {
        slots.remove(&plan);
        true
    } else {
        false
    }
}

#[derive(Default)]
pub struct Logins {
    running: Slots,
    next: AtomicU64,
}

type Report = Arc<dyn Fn(Progress) + Send + Sync>;
/// Opens a sign-in page in this computer's browser.
type Open = Arc<dyn Fn(&str) + Send + Sync>;

fn reporter(app: &AppHandle, plan: Plan) -> Report {
    let app = app.clone();
    Arc::new(move |progress| {
        let _ = app.emit("login-progress", Event { plan, progress });
    })
}

fn opener(app: &AppHandle) -> Open {
    use tauri_plugin_opener::OpenerExt;
    let app = app.clone();
    Arc::new(move |url| {
        if let Err(e) = app.opener().open_url(url, None::<&str>) {
            tracing::warn!(error = %e, "couldn't open the sign-in page");
        }
    })
}

/// Saves a login where the agents on this computer read it.
fn save(backend: &Backend, plan: Plan, value: &str) -> eyre::Result<()> {
    let hub = backend
        .connection()?
        .ok_or_else(|| eyre::eyre!("Desk is still starting"))?;
    // The admin token goes to the hub on this computer and nowhere else:
    // its address checked, never through a proxy, never after a redirect.
    let base = desk_core::net::loopback_url(&hub.gateway_url).map_err(|e| eyre::eyre!(e))?;
    let url = desk_core::net::at(&base, &format!("/api/vault/{}", plan.vault_path()), None)
        .map_err(|e| eyre::eyre!(e))?;
    let res = desk_core::net::loopback_blocking()
        .post(url)
        .bearer_auth(hub.admin_token)
        .json(&serde_json::json!({ "value": value }))
        .send()?;
    if !res.status().is_success() {
        eyre::bail!("saving the login failed ({})", res.status());
    }
    Ok(())
}

fn tail(text: &str) -> String {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    lines[lines.len().saturating_sub(3)..].join(" ")
}

/// Follows `claude setup-token`'s screen until it prints the token (`Ok`)
/// or ends (`Err` with what it showed), reporting the page to open and when
/// it asks for a code. With `open`, Desk opens the page itself.
fn follow_claude(
    reader: &mut dyn Read,
    report: &Report,
    open: Option<&Open>,
) -> Result<String, String> {
    let (mut text, mut url_sent, mut code_asked, mut buf) =
        (String::new(), false, false, [0u8; 4096]);
    while let Ok(n) = reader.read(&mut buf) {
        if n == 0 {
            break;
        }
        text.push_str(&scan::plain(&String::from_utf8_lossy(&buf[..n])));
        if !url_sent && let Some(url) = scan::sign_in_url(&text) {
            url_sent = true;
            if let Some(open) = open
                && scan::opens_itself(&url)
            {
                open(&url);
            }
            report(Progress::Browser { url });
        }
        if !code_asked && scan::wants_code(&text) {
            code_asked = true;
            report(Progress::NeedsCode);
        }
        if let Some(token) = scan::claude_token(&text) {
            return Ok(token);
        }
    }
    Err(text)
}

/// Saves the token and says how that went, or why the sign-in failed.
fn conclude_claude(backend: &Backend, report: &Report, read: Result<String, String>) {
    match read {
        Ok(token) => {
            report(Progress::Saving);
            report(match save(backend, Plan::Claude, &token) {
                Ok(()) => Progress::Done,
                Err(e) => Progress::Failed {
                    message: e.to_string(),
                },
            });
        }
        Err(text) => report(Progress::Failed {
            message: format!("Claude sign-in ended without a token. {}", tail(&text)),
        }),
    }
}

impl Logins {
    /// Starts a plan's sign-in, ending any earlier attempt at it first (on
    /// Windows, also one a Desk closed before left running inside WSL), so
    /// only one is ever waiting for the browser.
    pub fn start(&self, app: &AppHandle, backend: Backend, plan: Plan) -> Result<(), String> {
        self.cancel(plan, Some(&backend));
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.running
            .lock()
            .expect("logins")
            .insert(plan, Slot { id, running: None });
        let report = reporter(app, plan);
        report(Progress::Starting);
        let started = match plan {
            Plan::Claude if matches!(backend.host, Host::Wsl(_)) => {
                self.start_claude_wsl(backend, report, opener(app), id)
            }
            Plan::Claude => self.start_claude(backend, report, id),
            Plan::Chatgpt => self.start_chatgpt(backend, report, id),
        };
        let running = match started {
            Ok(r) => r,
            Err(e) => {
                finish(&self.running, plan, id);
                return Err(e.to_string());
            }
        };
        let mut slots = self.running.lock().expect("logins");
        match slots.get_mut(&plan) {
            Some(slot) if slot.id == id => slot.running = Some(running),
            // Cancelled, or already over, while it started.
            _ => {
                drop(slots);
                running.end();
            }
        }
        Ok(())
    }

    fn start_claude(&self, backend: Backend, report: Report, id: u64) -> eyre::Result<Running> {
        let cli = cli::cli(&backend, Plan::Claude.program(), &["setup-token"], &[])
            .map_err(|_| eyre::eyre!("Claude Code isn't installed on this computer"))?;
        // Wide, so the token is never wrapped across lines.
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 50,
                cols: 1000,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| eyre::eyre!("{e}"))?;
        let mut child = pair
            .slave
            .spawn_command(cli.pty())
            .map_err(|e| eyre::eyre!("{e}"))?;
        drop(pair.slave);
        let killer = child.clone_killer();
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| eyre::eyre!("{e}"))?;
        let writer = pair.master.take_writer().map_err(|e| eyre::eyre!("{e}"))?;
        let slots = Arc::clone(&self.running);
        std::thread::spawn(move || {
            let _master = pair.master;
            // The CLI opens the browser itself here.
            let read = follow_claude(&mut reader, &report, None);
            if read.is_ok() {
                let _ = child.kill();
            }
            let _ = child.wait();
            if finish(&slots, Plan::Claude, id) {
                conclude_claude(&backend, &report, read);
            }
        });
        Ok(Running::Pty { writer, killer })
    }

    /// Inside WSL (Windows): over plain pipes, every one read or written,
    /// and the sign-in page opened here on Windows.
    fn start_claude_wsl(
        &self,
        backend: Backend,
        report: Report,
        open: Open,
        id: u64,
    ) -> eyre::Result<Running> {
        let cli = cli::wsl_sign_in(&backend, Plan::Claude.program(), &["setup-token"])
            .map_err(|_| eyre::eyre!("Claude Code isn't installed on this computer"))?;
        let mut command = cli.command();
        deadline::isolate(&mut command);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let stdin = child.stdin.take().ok_or_else(|| eyre::eyre!("no stdin"))?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| eyre::eyre!("no stdout"))?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| eyre::eyre!("no stderr"))?;
        let errors = std::thread::spawn(move || {
            let mut out = Vec::new();
            let _ = stderr.read_to_end(&mut out);
            scan::plain(&String::from_utf8_lossy(&out))
        });
        let child = Arc::new(Mutex::new(child));
        let (waiting, slots, b) = (
            Arc::clone(&child),
            Arc::clone(&self.running),
            backend.clone(),
        );
        std::thread::spawn(move || {
            let read = follow_claude(&mut stdout, &report, Some(&open));
            let done = read.is_ok();
            if done {
                deadline::kill_tree(&mut waiting.lock().expect("child"));
                cli::stop_sign_in(&b, Plan::Claude.program(), CLAUDE_MARKER);
            }
            // stdout closed: the program has ended or is about to.
            loop {
                if !matches!(waiting.lock().expect("child").try_wait(), Ok(None)) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            let read = read.map_err(|text| match errors.join() {
                Ok(e) if !e.trim().is_empty() => format!("{text}\n{e}"),
                _ => text,
            });
            if finish(&slots, Plan::Claude, id) {
                conclude_claude(&b, &report, read);
            }
        });
        Ok(Running::Wsl {
            stdin,
            child,
            backend,
        })
    }

    fn start_chatgpt(&self, backend: Backend, report: Report, id: u64) -> eyre::Result<Running> {
        if !cli::installed(&backend, Plan::Chatgpt.program()) {
            eyre::bail!("Codex isn't installed on this computer");
        }
        let (home, codex_home) = cli::private_dir(&backend, "codex-login")?;
        let mut command = cli::cli(
            &backend,
            Plan::Chatgpt.program(),
            &["login"],
            &[("CODEX_HOME", &codex_home)],
        )?
        .command();
        deadline::isolate(&mut command);
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let streams = [
            child
                .stdout
                .take()
                .map(|s| Box::new(s) as Box<dyn Read + Send>),
            child
                .stderr
                .take()
                .map(|s| Box::new(s) as Box<dyn Read + Send>),
        ];
        let child = Arc::new(Mutex::new(child));
        let url_sent = Arc::new(Mutex::new(false));
        for mut stream in streams.into_iter().flatten() {
            let (report, url_sent) = (Arc::clone(&report), Arc::clone(&url_sent));
            std::thread::spawn(move || {
                let (mut text, mut buf) = (String::new(), [0u8; 4096]);
                while let Ok(n) = stream.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    text.push_str(&scan::plain(&String::from_utf8_lossy(&buf[..n])));
                    let mut sent = url_sent.lock().expect("url");
                    if !*sent && let Some(url) = scan::sign_in_url(&text) {
                        *sent = true;
                        report(Progress::Browser { url });
                    }
                }
            });
        }
        let (waiting, slots) = (Arc::clone(&child), Arc::clone(&self.running));
        std::thread::spawn(move || {
            let status = loop {
                if let Ok(Some(s)) = waiting.lock().expect("child").try_wait() {
                    break s;
                }
                std::thread::sleep(std::time::Duration::from_millis(250));
            };
            let cancelled = !finish(&slots, Plan::Chatgpt, id);
            let auth = std::fs::read_to_string(home.join("auth.json"));
            let _ = std::fs::remove_dir_all(&home);
            if cancelled {
                return;
            }
            report(match (status.success(), auth) {
                (true, Ok(auth)) => {
                    report(Progress::Saving);
                    match save(&backend, Plan::Chatgpt, &auth) {
                        Ok(()) => Progress::Done,
                        Err(e) => Progress::Failed {
                            message: e.to_string(),
                        },
                    }
                }
                _ => Progress::Failed {
                    message: "ChatGPT sign-in didn't finish.".into(),
                },
            });
        });
        Ok(Running::Chatgpt { child })
    }

    /// Sends the code the browser page shows back to `claude setup-token`.
    pub fn code(&self, plan: Plan, code: &str) -> Result<(), String> {
        let line = format!("{}\r", code.trim());
        let mut slots = self.running.lock().expect("logins");
        let writer: &mut dyn Write = match slots.get_mut(&plan).and_then(|s| s.running.as_mut()) {
            Some(Running::Pty { writer, .. }) => writer.as_mut(),
            Some(Running::Wsl { stdin, .. }) => stdin,
            _ => return Err("that sign-in isn't waiting for a code".into()),
        };
        writer
            .write_all(line.as_bytes())
            .and_then(|()| writer.flush())
            .map_err(|e| e.to_string())
    }

    /// Ends the plan's sign-in, if one is running. With the backend, a
    /// Claude sign-in inside WSL is looked for there too, even one this
    /// Desk didn't start.
    pub fn cancel(&self, plan: Plan, backend: Option<&Backend>) {
        let slot = self.running.lock().expect("logins").remove(&plan);
        let running = slot.and_then(|s| s.running);
        let wsl_ended = matches!(running, Some(Running::Wsl { .. }));
        if let Some(running) = running {
            running.end();
        }
        if plan == Plan::Claude
            && !wsl_ended
            && let Some(backend) = backend
        {
            cli::stop_sign_in(backend, Plan::Claude.program(), CLAUDE_MARKER);
        }
    }
}

/// Why a sign-in inside WSL doesn't go through a Windows pseudo-console:
/// one made as portable-pty makes it (`PSEUDOCONSOLE_INHERIT_CURSOR`) asks
/// where the cursor is and holds the program back until it's told, which
/// Desk's reader never did, so `wsl.exe` waited until Desk closed.
#[cfg(all(test, windows))]
mod windows_tests {
    use std::io::{Read, Write};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use portable_pty::{CommandBuilder, PtySize, native_pty_system};

    fn until(rx: &mpsc::Receiver<String>, text: &mut String, want: &str, within: Duration) -> bool {
        let start = Instant::now();
        while !text.contains(want) {
            let left = within.saturating_sub(start.elapsed());
            match rx.recv_timeout(left) {
                Ok(s) => text.push_str(&s),
                Err(_) => return false,
            }
        }
        true
    }

    #[test]
    fn a_pseudo_console_holds_its_program_until_the_cursor_question_is_answered() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 50,
                cols: 200,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("cmd.exe");
        command.args(["/c", "echo signed-in-marker"]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0
                    || tx
                        .send(String::from_utf8_lossy(&buf[..n]).into_owned())
                        .is_err()
                {
                    break;
                }
            }
        });
        let mut text = String::new();
        assert!(
            until(&rx, &mut text, "\x1b[6n", Duration::from_secs(10)),
            "{text:?}"
        );
        // Unanswered, nothing runs.
        assert!(
            !until(&rx, &mut text, "signed-in-marker", Duration::from_secs(3)),
            "{text:?}"
        );
        writer.write_all(b"\x1b[1;1R").unwrap();
        writer.flush().unwrap();
        assert!(
            until(&rx, &mut text, "signed-in-marker", Duration::from_secs(10)),
            "{text:?}"
        );
        let _ = child.kill();
        drop(pair.master);
    }
}
