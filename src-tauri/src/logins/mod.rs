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
    Browser {
        url: String,
    },
    NeedsCode,
    Saving,
    /// `account`: the Desk account the sign-in went to, when it went to one.
    Done {
        #[serde(skip_serializing_if = "Option::is_none")]
        account: Option<String>,
    },
    Failed {
        message: String,
    },
}

/// Where one Claude sign-in goes: one sign-in serves both places it's
/// asked for. To the crew's agents (the plan they run on, in the vault),
/// to a Desk account coding sessions run on, or both.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUse {
    #[serde(default = "yes")]
    pub agents: bool,
    #[serde(default)]
    pub account: Option<AccountUse>,
}

fn yes() -> bool {
    true
}

impl Default for ClaudeUse {
    /// As it always was: for the agents alone.
    fn default() -> Self {
        Self {
            agents: true,
            account: None,
        }
    }
}

/// The Desk account a Claude sign-in goes to: a new one, named `name`
/// (made the default with `make_default`), or account `again`, whose
/// sign-in it replaces.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUse {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub make_default: bool,
    #[serde(default)]
    pub again: Option<String>,
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
        /// Names its pidfile inside WSL.
        attempt: String,
    },
    Chatgpt {
        child: Arc<Mutex<Child>>,
    },
}

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
                attempt,
            } => {
                drop(stdin);
                deadline::kill_tree(&mut child.lock().expect("child"));
                cli::stop_sign_in(&backend, Plan::Claude.program(), Some(&attempt));
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

/// Posts `body` to `path` on the hub on this computer, as Desk: what it
/// answered.
fn post(
    backend: &Backend,
    path: &str,
    body: &serde_json::Value,
) -> eyre::Result<(reqwest::StatusCode, serde_json::Value)> {
    let hub = backend
        .connection()?
        .ok_or_else(|| eyre::eyre!("Desk is still starting"))?;
    // The admin token goes to the hub on this computer and nowhere else:
    // its address checked, never through a proxy, never after a redirect.
    let base = desk_core::net::loopback_url(&hub.gateway_url).map_err(|e| eyre::eyre!(e))?;
    let url = desk_core::net::at(&base, path, None).map_err(|e| eyre::eyre!(e))?;
    let res = desk_core::net::loopback_blocking()
        .post(url)
        .bearer_auth(hub.admin_token)
        .json(body)
        .send()?;
    let status = res.status();
    let said = res
        .json::<serde_json::Value>()
        .unwrap_or(serde_json::Value::Null);
    Ok((status, said))
}

/// How long Desk waits before each further try at keeping a sign-in.
const SAVE_RETRIES: [std::time::Duration; 2] = [
    std::time::Duration::from_secs(1),
    std::time::Duration::from_secs(3),
];

/// Saves a login where the agents on this computer read it. A sign-in the
/// person just finished is kept and the save tried again while Desk's
/// helper is busy or briefly away, rather than lost to one bad answer.
fn save(backend: &Backend, plan: Plan, value: &str) -> eyre::Result<()> {
    keep_trying(&SAVE_RETRIES, std::thread::sleep, || {
        post(
            backend,
            &format!("/api/vault/{}", plan.vault_path()),
            &serde_json::json!({ "value": value }),
        )
        .map(|(status, _)| status)
    })
}

/// Runs `attempt` once, then again after each of `waits` while it fails in
/// a way worth trying again (no answer, or a 5xx).
fn keep_trying(
    waits: &[std::time::Duration],
    sleep: impl Fn(std::time::Duration),
    mut attempt: impl FnMut() -> eyre::Result<reqwest::StatusCode>,
) -> eyre::Result<()> {
    let mut waits = waits.iter();
    loop {
        let again = match attempt() {
            Ok(status) if status.is_success() => return Ok(()),
            Ok(status) if !status.is_server_error() => {
                eyre::bail!("Desk couldn't keep the sign-in ({status}).")
            }
            Ok(_) | Err(_) => waits.next(),
        };
        match again {
            Some(wait) => sleep(*wait),
            None => eyre::bail!(
                "Desk couldn't keep the sign-in just now: its helper didn't answer. Sign in again in a moment."
            ),
        }
    }
}

/// What a hub refusal says, in its words.
fn refusal(status: reqwest::StatusCode, said: &serde_json::Value) -> String {
    said.get("error")
        .and_then(|e| e.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("the hub said {status}"))
}

/// An account's id as the hub makes them: a UUID, in its one written form
/// (lowercase, hyphenated). Anything else is none: it never reaches a path.
fn account_id(raw: &str) -> Option<String> {
    let id = raw.trim().to_ascii_lowercase();
    let groups: Vec<&str> = id.split('-').collect();
    let shaped = groups.iter().map(|g| g.len()).eq([8, 4, 4, 4, 12])
        && groups
            .iter()
            .all(|g| g.chars().all(|c| c.is_ascii_hexdigit()));
    shaped.then_some(id)
}

/// What keeping a Claude token as a Desk account sends: a new account, or
/// the one signed in again. An account to sign in again whose id isn't one
/// is refused before anything is sent.
fn account_request(account: &AccountUse, token: &str) -> eyre::Result<(String, serde_json::Value)> {
    Ok(match &account.again {
        Some(raw) => {
            let id =
                account_id(raw).ok_or_else(|| eyre::eyre!("that isn't one of your accounts"))?;
            (
                format!("/api/desk/accounts/{id}/sign-in"),
                serde_json::json!({ "token": token }),
            )
        }
        None => (
            "/api/desk/accounts".to_string(),
            serde_json::json!({
                "engine": "claude",
                "name": account
                    .name
                    .as_deref()
                    .map(str::trim)
                    .filter(|n| !n.is_empty())
                    .unwrap_or("Claude"),
                "token": token,
                "makeDefault": account.make_default,
            }),
        ),
    })
}

/// Keeps a Claude token as a Desk account on this computer's hub (which
/// checks Claude Code signs in by it first). Its id.
fn keep_account(backend: &Backend, account: &AccountUse, token: &str) -> eyre::Result<String> {
    let (path, body) = account_request(account, token)?;
    let (status, said) = post(backend, &path, &body)?;
    if !status.is_success() {
        eyre::bail!(refusal(status, &said));
    }
    said.pointer("/account/id")
        .and_then(|v| v.as_str())
        .and_then(account_id)
        .ok_or_else(|| eyre::eyre!("the hub didn't say which account it kept"))
}

/// The screen up to the code prompt: what follows it may echo the code the
/// person pasted, which no message repeats.
fn before_code(text: &str) -> &str {
    let lower = text.to_lowercase();
    match lower.find("paste code") {
        // Lowercasing can move byte offsets; cut only on a boundary.
        Some(i) if text.is_char_boundary(i) => &text[..i],
        Some(_) => "",
        None => text,
    }
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

/// Where a Claude token goes, as `use_` asks: the agents' plan, a Desk
/// account, or both. What that did.
fn keep_claude(backend: &Backend, use_: &ClaudeUse, token: &str) -> Progress {
    if use_.agents
        && let Err(e) = save(backend, Plan::Claude, token)
    {
        return Progress::Failed {
            message: e.to_string(),
        };
    }
    let Some(account) = &use_.account else {
        return Progress::Done { account: None };
    };
    match keep_account(backend, account, token) {
        Ok(id) => Progress::Done { account: Some(id) },
        Err(e) if use_.agents => Progress::Failed {
            message: format!(
                "Your crew is signed in, but Desk couldn't keep it for coding sessions: {e}"
            ),
        },
        Err(e) => Progress::Failed {
            message: format!("Desk couldn't keep the sign-in: {e}"),
        },
    }
}

/// Saves the token and says how that went, or why the sign-in failed.
fn conclude_claude(
    backend: &Backend,
    report: &Report,
    read: Result<String, String>,
    use_: &ClaudeUse,
) {
    match read {
        Ok(token) => {
            report(Progress::Saving);
            report(keep_claude(backend, use_, &token));
        }
        Err(text) => report(Progress::Failed {
            message: format!(
                "Claude sign-in ended without a token. {}",
                tail(before_code(&text))
            ),
        }),
    }
}

impl Logins {
    /// Starts a plan's sign-in, ending any earlier attempt at it first (on
    /// Windows, also one a Desk closed before left running inside WSL), so
    /// only one is ever waiting for the browser.
    pub fn start(
        &self,
        app: &AppHandle,
        backend: Backend,
        plan: Plan,
        use_: ClaudeUse,
    ) -> Result<(), String> {
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
                self.start_claude_wsl(backend, report, opener(app), id, use_)
            }
            Plan::Claude => self.start_claude(backend, report, id, use_),
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

    fn start_claude(
        &self,
        backend: Backend,
        report: Report,
        id: u64,
        use_: ClaudeUse,
    ) -> eyre::Result<Running> {
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
                conclude_claude(&backend, &report, read, &use_);
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
        use_: ClaudeUse,
    ) -> eyre::Result<Running> {
        let attempt = format!("{}-{id}", std::process::id());
        let cli = cli::wsl_sign_in(&backend, Plan::Claude.program(), &["setup-token"], &attempt)
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
        let (waiting, slots, b, mine) = (
            Arc::clone(&child),
            Arc::clone(&self.running),
            backend.clone(),
            attempt.clone(),
        );
        std::thread::spawn(move || {
            let read = follow_claude(&mut stdout, &report, Some(&open));
            let done = read.is_ok();
            if done {
                deadline::kill_tree(&mut waiting.lock().expect("child"));
                cli::stop_sign_in(&b, Plan::Claude.program(), Some(&mine));
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
                conclude_claude(&b, &report, read, &use_);
            }
        });
        Ok(Running::Wsl {
            stdin,
            child,
            backend,
            attempt,
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
                        Ok(()) => Progress::Done { account: None },
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
            cli::stop_sign_in(backend, Plan::Claude.program(), None);
        }
    }
}

#[cfg(test)]
mod save_tests {
    use std::cell::{Cell, RefCell};
    use std::time::Duration;

    use reqwest::StatusCode;

    use super::{SAVE_RETRIES, keep_trying};

    #[test]
    fn a_sign_in_is_kept_by_trying_again_while_the_helper_is_busy() {
        let answers = RefCell::new(vec![
            Ok(StatusCode::OK),
            Err(eyre::eyre!("connection refused")),
            Ok(StatusCode::INTERNAL_SERVER_ERROR),
        ]);
        let slept = RefCell::new(Vec::new());
        keep_trying(
            &SAVE_RETRIES,
            |d| slept.borrow_mut().push(d),
            || answers.borrow_mut().pop().unwrap(),
        )
        .unwrap();
        assert_eq!(*slept.borrow(), SAVE_RETRIES.to_vec());
    }

    #[test]
    fn it_gives_up_plainly_and_never_retries_a_refusal() {
        let tries = Cell::new(0);
        let e = keep_trying(
            &SAVE_RETRIES,
            |_| {},
            || {
                tries.set(tries.get() + 1);
                Ok(StatusCode::BAD_GATEWAY)
            },
        )
        .unwrap_err();
        assert_eq!(tries.get(), 3);
        assert!(
            e.to_string()
                .starts_with("Desk couldn't keep the sign-in just now"),
            "{e}"
        );
        assert!(!e.to_string().contains("502"));

        let tries = Cell::new(0);
        let _ = keep_trying(
            &[Duration::ZERO; 2],
            |_| {},
            || {
                tries.set(tries.get() + 1);
                Ok(StatusCode::FORBIDDEN)
            },
        )
        .unwrap_err();
        assert_eq!(tries.get(), 1, "a refusal isn't tried again");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_claude_sign_in_goes_where_it_was_asked() {
        // As it always was, with nothing said: to the agents alone.
        let none: ClaudeUse = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(none, ClaudeUse::default());
        let to: ClaudeUse = serde_json::from_value(serde_json::json!({
            "agents": false,
            "account": { "name": " ", "makeDefault": true }
        }))
        .unwrap();
        let account = to.account.unwrap();
        let (path, body) = account_request(&account, "sk-ant-oat01-x").unwrap();
        assert_eq!(path, "/api/desk/accounts");
        assert_eq!(
            body,
            serde_json::json!({ "engine": "claude", "name": "Claude", "token": "sk-ant-oat01-x", "makeDefault": true })
        );
        let again = AccountUse {
            name: None,
            make_default: false,
            again: Some(" 7B1E0D2C-3F4A-4B5C-8D6E-0F1A2B3C4D5E ".into()),
        };
        let (path, body) = account_request(&again, "sk-ant-oat01-y").unwrap();
        assert_eq!(
            path,
            "/api/desk/accounts/7b1e0d2c-3f4a-4b5c-8d6e-0f1a2b3c4d5e/sign-in"
        );
        assert_eq!(body, serde_json::json!({ "token": "sk-ant-oat01-y" }));
        // An id that isn't an account's never reaches a path.
        for bad in [
            "7b1e",
            "../../vault/x",
            "7b1e0d2c-3f4a-4b5c-8d6e-0f1a2b3c4d5e/../x",
            "7b1e0d2c3f4a4b5c8d6e0f1a2b3c4d5e",
            "g7b1e0d2-3f4a-4b5c-8d6e-0f1a2b3c4d5e",
        ] {
            let bad = AccountUse {
                name: None,
                make_default: false,
                again: Some(bad.into()),
            };
            assert!(account_request(&bad, "sk-ant-oat01-y").is_err());
        }
        // Done says which account it went to, only when it went to one.
        assert_eq!(
            serde_json::to_value(Progress::Done { account: None }).unwrap(),
            serde_json::json!({ "state": "done" })
        );
        assert_eq!(
            serde_json::to_value(Progress::Done {
                account: Some("7b1e".into())
            })
            .unwrap(),
            serde_json::json!({ "state": "done", "account": "7b1e" })
        );
    }

    #[test]
    fn a_failure_never_repeats_what_followed_the_code_prompt() {
        let screen = "Opening browser\nhttps://claude.ai/oauth\nPaste code here if prompted > abc#secret\nOAuth error: invalid code";
        let said = tail(before_code(screen));
        assert!(!said.contains("abc#secret"), "{said}");
        assert!(!said.contains("Paste code"), "{said}");
        assert_eq!(said, "Opening browser https://claude.ai/oauth");
        assert_eq!(
            tail(before_code("Error: not logged in")),
            "Error: not logged in"
        );
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
