//! Installing Claude Code or Codex when a plan's sign-in needs it and this
//! computer doesn't have it: each one's official installer, run as the person,
//! with what it prints passed on line by line.

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use desk_core::shell::{find_program, login_env, with_local_bin, without_claude_markers};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::{Plan, scan};

impl Plan {
    /// The CLI a plan signs in with.
    pub fn program(self) -> &'static str {
        match self {
            Plan::Claude => "claude",
            Plan::Chatgpt => "codex",
        }
    }

    pub fn cli_name(self) -> &'static str {
        match self {
            Plan::Claude => "Claude Code",
            Plan::Chatgpt => "Codex",
        }
    }

    /// The official installer, from each one's own install page:
    /// code.claude.com/docs/en/setup and learn.chatgpt.com/docs/codex/cli.
    fn installer(self) -> &'static str {
        match self {
            Plan::Claude => "curl -fsSL https://claude.ai/install.sh | bash",
            Plan::Chatgpt => "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
        }
    }
}

/// Whether the plan's CLI can be found: on the login PATH or in
/// `~/.local/bin`, where both installers put it.
pub fn installed(plan: Plan) -> bool {
    find_program(plan.program(), &login_env()).is_some()
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum Progress {
    Running { line: String },
    Done,
    Failed { message: String },
}

#[derive(Serialize, Clone)]
struct Event {
    plan: Plan,
    #[serde(flatten)]
    progress: Progress,
}

/// curl's exit codes for a network that isn't there or won't answer.
fn offline(code: Option<i32>) -> bool {
    matches!(code, Some(6 | 7 | 28 | 35 | 52 | 56))
}

/// What to tell the person when the installer stops.
fn failure(plan: Plan, code: Option<i32>, last: &str) -> String {
    if offline(code) {
        return format!(
            "Couldn't download {}. Check this computer is online and try again.",
            plan.cli_name()
        );
    }
    let last = last.trim();
    if last.is_empty() {
        format!(
            "{}'s installer stopped before it finished.",
            plan.cli_name()
        )
    } else {
        format!("{}'s installer stopped: {last}", plan.cli_name())
    }
}

#[derive(Default)]
pub struct Installs {
    running: Arc<Mutex<Vec<Plan>>>,
}

impl Installs {
    /// Runs the installer in the background; progress arrives as
    /// `cli-install` events.
    pub fn start(&self, app: &AppHandle, plan: Plan) -> Result<(), String> {
        {
            let mut running = self.running.lock().expect("installs");
            if running.contains(&plan) {
                return Ok(());
            }
            running.push(plan);
        }
        let report = {
            let app = app.clone();
            move |progress: Progress| {
                let _ = app.emit("cli-install", Event { plan, progress });
            }
        };
        let env = with_local_bin(without_claude_markers(login_env()));
        let script = format!("set -o pipefail; {}", plan.installer());
        let spawned = Command::new("/bin/bash")
            .args(["-c", &script])
            .env_clear()
            .envs(&env)
            .current_dir(env.get("HOME").map_or("/", String::as_str))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => {
                self.running
                    .lock()
                    .expect("installs")
                    .retain(|p| *p != plan);
                return Err(format!(
                    "Couldn't start {}'s installer: {e}",
                    plan.cli_name()
                ));
            }
        };
        let last = Arc::new(Mutex::new(String::new()));
        let mut readers = Vec::new();
        for stream in [
            child
                .stdout
                .take()
                .map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
            child
                .stderr
                .take()
                .map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        ]
        .into_iter()
        .flatten()
        {
            let (report, last) = (report.clone(), Arc::clone(&last));
            readers.push(std::thread::spawn(move || {
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    let line = scan::plain(&line);
                    let line = line.lines().last().unwrap_or("").trim().to_string();
                    if line.is_empty() {
                        continue;
                    }
                    *last.lock().expect("last") = line.clone();
                    report(Progress::Running { line });
                }
            }));
        }
        let running = Arc::clone(&self.running);
        std::thread::spawn(move || {
            let status = child.wait();
            for r in readers {
                let _ = r.join();
            }
            running.lock().expect("installs").retain(|p| *p != plan);
            let last = last.lock().expect("last").clone();
            report(match status {
                Ok(s) if s.success() && installed(plan) => Progress::Done,
                Ok(s) if s.success() => Progress::Failed {
                    message: format!(
                        "{} installed, but Desk can't find it. Open a new terminal, run `{} --version`, then try again.",
                        plan.cli_name(),
                        plan.program()
                    ),
                },
                Ok(s) => Progress::Failed {
                    message: failure(plan, s.code(), &last),
                },
                Err(e) => Progress::Failed {
                    message: failure(plan, None, &e.to_string()),
                },
            });
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failures_are_said_plainly() {
        assert_eq!(
            failure(Plan::Claude, Some(6), "curl: (6) Could not resolve host"),
            "Couldn't download Claude Code. Check this computer is online and try again."
        );
        assert_eq!(
            failure(Plan::Chatgpt, Some(1), "  Unsupported architecture  "),
            "Codex's installer stopped: Unsupported architecture"
        );
        assert_eq!(
            failure(Plan::Chatgpt, Some(1), ""),
            "Codex's installer stopped before it finished."
        );
    }

    #[test]
    fn each_plan_installs_its_own_cli_from_its_official_installer() {
        assert_eq!(Plan::Claude.program(), "claude");
        assert!(
            Plan::Claude
                .installer()
                .contains("https://claude.ai/install.sh")
        );
        assert_eq!(Plan::Chatgpt.program(), "codex");
        assert!(
            Plan::Chatgpt
                .installer()
                .contains("https://chatgpt.com/codex/install.sh")
        );
    }
}
