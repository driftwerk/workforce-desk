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
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use desk_core::backend::Backend;
use desk_core::host::Host;
use desk_machine::callback;
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
    /// `problem`: why the CLI turned down the code pasted last, while it
    /// still waits for one.
    NeedsCode {
        #[serde(skip_serializing_if = "Option::is_none")]
        problem: Option<String>,
    },
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

/// Where what's typed into a sign-in goes.
type Keys = Arc<Mutex<dyn Write + Send>>;

/// A sign-in that's running, and how to end it.
enum Running {
    /// `claude setup-token` on a pseudo-terminal here (macOS, Linux).
    Pty {
        keys: Keys,
        killer: Box<dyn ChildKiller + Send + Sync>,
    },
    /// `claude setup-token` inside WSL: `wsl.exe` over plain pipes, with a
    /// terminal of Linux's own inside (see `cli::wsl_sign_in`).
    Wsl {
        keys: Keys,
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
                keys,
                child,
                backend,
                attempt,
            } => {
                drop(keys);
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

/// Reports a sign-in's progress to the page, and to Desk's log: a page by
/// its shape only, since its query holds the sign-in's state.
fn reporter(app: &AppHandle, plan: Plan) -> Report {
    let app = app.clone();
    Arc::new(move |progress| {
        match &progress {
            Progress::Browser { url } => {
                tracing::info!(?plan, page = %callback::page_shape(url), "sign-in: its page is shown");
            }
            Progress::Failed { message } => tracing::info!(?plan, %message, "sign-in failed"),
            other => tracing::info!(?plan, progress = ?other, "sign-in"),
        }
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

/// What `claude setup-token` runs with: the sign-in page's whole address
/// shown (Claude Code 2.1.330 shows a shortened one otherwise).
const SETUP_TOKEN_ENV: &[(&str, &str)] = &[("CLAUDE_CODE_FULL_SIGN_IN_LINK", "1")];

/// How long a Claude sign-in waits for the browser before Desk ends it.
const SIGN_IN_WITHIN: Duration = Duration::from_secs(10 * 60);
/// How often a sign-in with nothing new on its screen looks whether its CLI
/// has ended.
const LOOK_EVERY: Duration = Duration::from_millis(250);
/// How long what the CLI drew last may take to arrive once it has ended.
const LAST_DRAWN_WITHIN: Duration = Duration::from_millis(500);
/// The pause between a pasted code and its Enter, so the CLI takes the code
/// as one paste and the Enter as a key of its own, as a person's are.
const ENTER_AFTER: Duration = Duration::from_millis(200);

/// What `from` gives, a read at a time, read on a thread of its own so the
/// sign-in can keep an eye on its clock and its CLI meanwhile.
fn chunks(mut from: impl Read + Send + 'static) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = from.read(&mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    rx
}

/// Reports what the screen shows now that wasn't told yet, opening the
/// page when `open` says Desk does; what has been told since.
fn tell(told: scan::Shown, now: &scan::Shown, report: &Report, open: Option<&Open>) -> scan::Shown {
    if let Some(url) = now.page.as_ref().filter(|u| told.page.as_ref() != Some(*u)) {
        if let Some(open) = open
            && scan::opens_itself(url)
        {
            tracing::info!("sign-in: Desk opened its page");
            open(url);
        }
        report(Progress::Browser { url: url.clone() });
    }
    if now.asks_for_code && (!told.asks_for_code || now.refused != told.refused) {
        report(Progress::NeedsCode {
            problem: now.refused.map(str::to_string),
        });
    }
    scan::Shown {
        page: now.page.clone().or(told.page),
        asks_for_code: now.asks_for_code,
        refused: now.refused,
        ..scan::Shown::default()
    }
}

/// Follows `claude setup-token`'s screen until it shows the token (`Ok`) or
/// can't go on (`Err` with why): it failed, it ended (`ended` says so: its
/// terminal can stay open after it, held by what it started), or nobody
/// finished within `within`. Reports the page to open and when it waits
/// for a code; with `open`, Desk opens the page itself.
fn follow_claude(
    chunks: &mpsc::Receiver<Vec<u8>>,
    mut ended: impl FnMut() -> bool,
    report: &Report,
    open: Option<&Open>,
    within: Duration,
) -> Result<String, String> {
    let start = Instant::now();
    let mut screen = scan::Screen::default();
    let mut told = scan::Shown::default();
    loop {
        let over = match chunks.recv_timeout(LOOK_EVERY) {
            Ok(bytes) => {
                screen.feed(&bytes);
                ended()
            }
            Err(RecvTimeoutError::Timeout) => ended(),
            Err(RecvTimeoutError::Disconnected) => true,
        };
        if over {
            while let Ok(bytes) = chunks.recv_timeout(LAST_DRAWN_WITHIN) {
                screen.feed(&bytes);
            }
        }
        let text = screen.text();
        let now = scan::shown(&text, over);
        if let Some(token) = now.token {
            return Ok(token);
        }
        if let Some(why) = now.failure {
            return Err(why);
        }
        told = tell(told, &now, report, open);
        if over {
            return Err(match scan::last_words(&text) {
                Some(words) => format!("Claude sign-in ended without a token: {words}"),
                None => "Claude sign-in ended without a token.".into(),
            });
        }
        if start.elapsed() >= within {
            return Err(format!(
                "Nobody finished signing in within {} minutes, so Desk stopped it. Sign in again.",
                within.as_secs() / 60
            ));
        }
    }
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
        Err(why) => report(Progress::Failed {
            message: desk_core::redact::redact(&why, &[]),
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
        let cli = cli::cli(
            &backend,
            Plan::Claude.program(),
            &["setup-token"],
            SETUP_TOKEN_ENV,
        )
        .map_err(|_| eyre::eyre!("Claude Code isn't installed on this computer"))?;
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: scan::ROWS,
                cols: scan::COLS,
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
        let chunks = chunks(
            pair.master
                .try_clone_reader()
                .map_err(|e| eyre::eyre!("{e}"))?,
        );
        let keys: Keys = Arc::new(Mutex::new(
            pair.master.take_writer().map_err(|e| eyre::eyre!("{e}"))?,
        ));
        let slots = Arc::clone(&self.running);
        std::thread::spawn(move || {
            let _master = pair.master;
            // The CLI opens the browser itself here.
            let read = follow_claude(
                &chunks,
                || !matches!(child.try_wait(), Ok(None)),
                &report,
                None,
                SIGN_IN_WITHIN,
            );
            let _ = child.kill();
            let status = child.wait();
            tracing::info!(?status, "sign-in: Claude Code ended");
            if finish(&slots, Plan::Claude, id) {
                conclude_claude(&backend, &report, read, &use_);
            }
        });
        Ok(Running::Pty { keys, killer })
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
        let cli = cli::wsl_sign_in(
            &backend,
            Plan::Claude.program(),
            &["setup-token"],
            SETUP_TOKEN_ENV,
            &attempt,
        )
        .map_err(|_| eyre::eyre!("Claude Code isn't installed on this computer"))?;
        let mut command = cli.command();
        deadline::isolate(&mut command);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let stdin = child.stdin.take().ok_or_else(|| eyre::eyre!("no stdin"))?;
        let stdout = child
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
        let chunks = chunks(stdout);
        let child = Arc::new(Mutex::new(child));
        let (waiting, slots, b, mine) = (
            Arc::clone(&child),
            Arc::clone(&self.running),
            backend.clone(),
            attempt.clone(),
        );
        std::thread::spawn(move || {
            let read = follow_claude(
                &chunks,
                || !matches!(waiting.lock().expect("child").try_wait(), Ok(None)),
                &report,
                Some(&open),
                SIGN_IN_WITHIN,
            );
            deadline::kill_tree(&mut waiting.lock().expect("child"));
            cli::stop_sign_in(&b, Plan::Claude.program(), Some(&mine));
            let status = waiting.lock().expect("child").wait();
            tracing::info!(?status, "sign-in: Claude Code ended");
            let read = read.map_err(|why| {
                match errors.join().ok().as_deref().and_then(scan::last_words) {
                    Some(said) => format!("{why} {said}"),
                    None => why,
                }
            });
            if finish(&slots, Plan::Claude, id) {
                conclude_claude(&b, &report, read, &use_);
            }
        });
        Ok(Running::Wsl {
            keys: Arc::new(Mutex::new(stdin)),
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

    /// Types the code the browser page shows (or the address of that page)
    /// into `claude setup-token`, then Enter.
    pub fn code(&self, plan: Plan, code: &str) -> Result<(), String> {
        let code = callback::pasted_code(code);
        if code.is_empty() {
            return Err("Paste the code the sign-in page shows.".into());
        }
        let keys = match self
            .running
            .lock()
            .expect("logins")
            .get(&plan)
            .and_then(|s| s.running.as_ref())
        {
            Some(Running::Pty { keys, .. } | Running::Wsl { keys, .. }) => Arc::clone(keys),
            _ => return Err("that sign-in isn't waiting for a code".into()),
        };
        type_in(&keys, code.as_bytes())?;
        tracing::info!(?plan, "sign-in: a code was pasted");
        std::thread::spawn(move || {
            std::thread::sleep(ENTER_AFTER);
            if let Err(e) = type_in(&keys, b"\r") {
                tracing::warn!(?plan, error = %e, "sign-in: couldn't press Enter after the code");
            }
        });
        Ok(())
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

/// Types `bytes` into a sign-in.
fn type_in(keys: &Keys, bytes: &[u8]) -> Result<(), String> {
    let mut keys = keys.lock().expect("keys");
    keys.write_all(bytes)
        .and_then(|()| keys.flush())
        .map_err(|e| e.to_string())
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
    use super::scan::fixtures::{FULL, TOKEN, row, token_frame, waiting};
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

    /// What a sign-in reported, and the way to report it.
    fn reports() -> (Arc<Mutex<Vec<Progress>>>, Report) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let into = Arc::clone(&seen);
        (seen, Arc::new(move |p| into.lock().unwrap().push(p)))
    }

    /// A sign-in's screen as `drawn`, read a draw at a time, then (with
    /// `ends`) its CLI gone.
    fn follow(
        drawn: &[Vec<u8>],
        ends: bool,
        within: Duration,
    ) -> (Result<String, String>, Vec<Progress>) {
        let (tx, rx) = mpsc::channel();
        for d in drawn {
            tx.send(d.clone()).unwrap();
        }
        let (seen, report) = reports();
        let mut looked = 0;
        let ended = || {
            looked += 1;
            ends && looked > drawn.len()
        };
        let read = follow_claude(&rx, ended, &report, None, within);
        drop(tx);
        let seen = seen.lock().unwrap().clone();
        (read, seen)
    }

    #[test]
    fn claude_code_2_1_330s_sign_in_shows_its_page_asks_for_a_code_and_gives_its_token() {
        let (read, seen) = follow(&[waiting(FULL), token_frame(TOKEN)], false, SIGN_IN_WITHIN);
        assert_eq!(read.as_deref(), Ok(TOKEN));
        assert_eq!(
            seen,
            [
                Progress::Browser { url: FULL.into() },
                Progress::NeedsCode { problem: None }
            ]
        );
        assert_eq!(
            serde_json::to_value(&seen[1]).unwrap(),
            serde_json::json!({ "state": "needs-code" })
        );
    }

    #[test]
    fn a_code_turned_down_is_said_and_the_sign_in_waits_for_another() {
        let refused = row(
            2,
            "That's a web address, not the code. If it's a sign-in link, open it in your browser.",
        );
        let (read, seen) = follow(
            &[waiting(FULL), refused, token_frame(TOKEN)],
            false,
            SIGN_IN_WITHIN,
        );
        assert_eq!(read.as_deref(), Ok(TOKEN));
        assert_eq!(
            seen[1..],
            [
                Progress::NeedsCode { problem: None },
                Progress::NeedsCode {
                    problem: Some(
                        "That's a web address, not the code. Paste the code the last page shows."
                            .into()
                    )
                }
            ]
        );
    }

    #[test]
    fn a_cli_that_ended_without_a_token_ends_the_sign_in_with_its_last_words() {
        let (read, _) = follow(
            &[b"\x1b[31mError: not logged in\x1b[39m\n".to_vec()],
            true,
            SIGN_IN_WITHIN,
        );
        assert_eq!(
            read,
            Err("Claude sign-in ended without a token: Error: not logged in".into())
        );
        let (read, _) = follow(&[], true, SIGN_IN_WITHIN);
        assert_eq!(read, Err("Claude sign-in ended without a token.".into()));
    }

    #[test]
    fn an_error_the_cli_waits_on_ends_the_sign_in_while_it_still_runs() {
        let error = [
            waiting(FULL),
            b"\x1b[2J\x1b[H".to_vec(),
            row(
                1,
                "\u{2717} OAuth error: Couldn't finish signing in. Try again.",
            ),
            row(1, "Press Enter to retry"),
        ];
        let (read, _) = follow(&error, false, SIGN_IN_WITHIN);
        assert_eq!(
            read,
            Err("OAuth error: Couldn't finish signing in. Try again.".into())
        );
    }

    #[test]
    fn an_account_on_hold_ends_the_sign_in_and_its_appeal_page_is_never_offered_as_the_sign_in() {
        let on_hold = [
            waiting(FULL),
            b"\x1b[2J\x1b[H".to_vec(),
            row(
                2,
                "\u{26a0} Your account is on hold and can't sign in to Claude Code. View details or appeal: https://claude.ai/restricted",
            ),
        ];
        let (read, seen) = follow(&on_hold, true, SIGN_IN_WITHIN);
        assert_eq!(
            read,
            Err("Your account is on hold and can't sign in to Claude Code. View details or appeal: https://claude.ai/restricted".into())
        );
        assert_eq!(
            seen,
            [
                Progress::Browser { url: FULL.into() },
                Progress::NeedsCode { problem: None }
            ]
        );
    }

    #[test]
    fn nobody_finishing_in_time_ends_the_sign_in() {
        let (read, seen) = follow(&[waiting(FULL)], false, Duration::ZERO);
        assert_eq!(
            read,
            Err(
                "Nobody finished signing in within 0 minutes, so Desk stopped it. Sign in again."
                    .into()
            )
        );
        assert_eq!(seen.len(), 2);
    }

    /// The Mac's stall: the CLI ends, but what it started holds its
    /// terminal open, so no end of output ever comes.
    #[cfg(unix)]
    #[test]
    fn a_cli_that_ends_is_noticed_though_its_terminal_stays_open() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: scan::ROWS,
                cols: scan::COLS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = portable_pty::CommandBuilder::new("/bin/sh");
        command.args([
            "-c",
            "(trap '' HUP; exec sleep 30) & echo 'Error: the browser sign-in failed'; exit 3",
        ]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let chunks = chunks(pair.master.try_clone_reader().unwrap());
        let (_, report) = reports();
        let start = Instant::now();
        let read = follow_claude(
            &chunks,
            || !matches!(child.try_wait(), Ok(None)),
            &report,
            None,
            SIGN_IN_WITHIN,
        );
        assert_eq!(
            read,
            Err("Claude sign-in ended without a token: Error: the browser sign-in failed".into())
        );
        assert!(start.elapsed() < Duration::from_secs(10));
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
