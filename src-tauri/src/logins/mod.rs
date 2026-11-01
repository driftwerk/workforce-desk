//! Connecting a plan in one click: Desk runs the real CLI's own sign-in as
//! the person — `claude setup-token`, or `codex login` in a throwaway Codex
//! home so it never touches their own `codex` login — and saves the result
//! where their agents on this computer read it. The token never reaches the
//! page.

mod cli;
pub mod install;
mod scan;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};

use desk_core::backend::Backend;
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

enum Running {
    Claude {
        writer: Box<dyn Write + Send>,
        killer: Box<dyn ChildKiller + Send + Sync>,
    },
    Chatgpt {
        child: Arc<Mutex<Child>>,
    },
}

#[derive(Default)]
pub struct Logins {
    running: Arc<Mutex<HashMap<Plan, Running>>>,
}

type Report = Arc<dyn Fn(Progress) + Send + Sync>;

fn reporter(app: &AppHandle, plan: Plan) -> Report {
    let app = app.clone();
    Arc::new(move |progress| {
        let _ = app.emit("login-progress", Event { plan, progress });
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

impl Logins {
    pub fn start(&self, app: &AppHandle, backend: Backend, plan: Plan) -> Result<(), String> {
        self.cancel(plan);
        let report = reporter(app, plan);
        report(Progress::Starting);
        let running = match plan {
            Plan::Claude => self.start_claude(backend, report),
            Plan::Chatgpt => self.start_chatgpt(backend, report),
        }
        .map_err(|e| e.to_string())?;
        self.running.lock().expect("logins").insert(plan, running);
        Ok(())
    }

    fn start_claude(&self, backend: Backend, report: Report) -> eyre::Result<Running> {
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
        let running = Arc::clone(&self.running);
        std::thread::spawn(move || {
            let _master = pair.master;
            let (mut text, mut url_sent, mut code_asked, mut buf) =
                (String::new(), false, false, [0u8; 4096]);
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                text.push_str(&scan::plain(&String::from_utf8_lossy(&buf[..n])));
                if !url_sent && let Some(url) = scan::sign_in_url(&text) {
                    url_sent = true;
                    report(Progress::Browser { url });
                }
                if !code_asked && scan::wants_code(&text) {
                    code_asked = true;
                    report(Progress::NeedsCode);
                }
                if let Some(token) = scan::claude_token(&text) {
                    report(Progress::Saving);
                    report(match save(&backend, Plan::Claude, &token) {
                        Ok(()) => Progress::Done,
                        Err(e) => Progress::Failed {
                            message: e.to_string(),
                        },
                    });
                    let _ = child.kill();
                    running.lock().expect("logins").remove(&Plan::Claude);
                    return;
                }
            }
            let _ = child.wait();
            if running
                .lock()
                .expect("logins")
                .remove(&Plan::Claude)
                .is_some()
            {
                report(Progress::Failed {
                    message: format!("Claude sign-in ended without a token. {}", tail(&text)),
                });
            }
        });
        Ok(Running::Claude { writer, killer })
    }

    fn start_chatgpt(&self, backend: Backend, report: Report) -> eyre::Result<Running> {
        if !cli::installed(&backend, Plan::Chatgpt.program()) {
            eyre::bail!("Codex isn't installed on this computer");
        }
        let (home, codex_home) = cli::private_dir(&backend, "codex-login")?;
        let mut child = cli::cli(
            &backend,
            Plan::Chatgpt.program(),
            &["login"],
            &[("CODEX_HOME", &codex_home)],
        )?
        .command()
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
        let (waiting, running) = (Arc::clone(&child), Arc::clone(&self.running));
        std::thread::spawn(move || {
            let status = loop {
                if let Ok(Some(s)) = waiting.lock().expect("child").try_wait() {
                    break s;
                }
                std::thread::sleep(std::time::Duration::from_millis(250));
            };
            let cancelled = running
                .lock()
                .expect("logins")
                .remove(&Plan::Chatgpt)
                .is_none();
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
        let mut running = self.running.lock().expect("logins");
        match running.get_mut(&plan) {
            Some(Running::Claude { writer, .. }) => writer
                .write_all(format!("{}\r", code.trim()).as_bytes())
                .and_then(|()| writer.flush())
                .map_err(|e| e.to_string()),
            _ => Err("that sign-in isn't waiting for a code".into()),
        }
    }

    pub fn cancel(&self, plan: Plan) {
        match self.running.lock().expect("logins").remove(&plan) {
            Some(Running::Claude { mut killer, .. }) => {
                let _ = killer.kill();
            }
            Some(Running::Chatgpt { child }) => {
                let _ = child.lock().expect("child").kill();
            }
            None => {}
        }
    }
}
