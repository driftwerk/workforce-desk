//! Installing Claude Code or Codex when a plan's sign-in needs it and this
//! computer doesn't have it: each one's official installer, run as the person,
//! with what it prints passed on line by line.

use std::io::{BufRead, BufReader};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use desk_core::backend::Backend;
use desk_core::host::Host;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::{Plan, cli, deadline, probe, scan};

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

/// Whether the plan's CLI can be found where the backend runs: on the
/// login PATH or in `~/.local/bin`, where both installers put it.
pub fn installed(backend: &Backend, plan: Plan) -> bool {
    cli::installed(backend, plan.program())
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum Progress {
    Running {
        line: String,
    },
    Done,
    /// `command` is what the person can run in a terminal themselves, and
    /// `hint` where to run it.
    Failed {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        command: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        hint: Option<String>,
    },
}

impl Progress {
    fn failed(message: String) -> Self {
        Progress::Failed {
            message,
            command: None,
            hint: None,
        }
    }
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

/// How long one run of an installer may take before it is stopped.
const INSTALL_DEADLINE: std::time::Duration = std::time::Duration::from_secs(15 * 60);
/// How long the probe may take: its own curl has a 20 s cap, but a hung
/// shell must not hold the install up.
const PROBE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(45);

#[derive(Default)]
pub struct Installs {
    running: Arc<Mutex<Vec<Plan>>>,
}

impl Installs {
    /// Runs the installer in the background; progress arrives as
    /// `cli-install` events.
    pub fn start(&self, app: &AppHandle, backend: Backend, plan: Plan) -> Result<(), String> {
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
        let child = match spawn(&backend, plan) {
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
        let running = Arc::clone(&self.running);
        std::thread::spawn(move || {
            let mut outcome = drain(child, &report, INSTALL_DEADLINE);
            // A download that failed is looked into where the installer
            // ran, and tried once more when nothing there is wrong.
            let mut retried = false;
            let mut cause = None;
            while !outcome.ok() && probe::is_download_failure(&outcome.last) {
                let found = diagnose(&backend, plan);
                if found == probe::Diagnosis::Healthy && !retried {
                    retried = true;
                    report(Progress::Running {
                        line: "Trying again…".into(),
                    });
                    match spawn(&backend, plan) {
                        Ok(child) => {
                            outcome = drain(child, &report, INSTALL_DEADLINE);
                            continue;
                        }
                        Err(e) => {
                            outcome = Outcome::error(e.to_string());
                            break;
                        }
                    }
                }
                if let probe::Diagnosis::Cause(message) = found {
                    cause = Some(message);
                }
                break;
            }
            running.lock().expect("installs").retain(|p| *p != plan);
            let by_hand =
                !outcome.ok() && (outcome.timed_out || probe::is_download_failure(&outcome.last));
            let mut progress = match &outcome.status {
                _ if outcome.timed_out => Progress::failed(format!(
                    "{}'s installer didn't finish within {} minutes.",
                    plan.cli_name(),
                    INSTALL_DEADLINE.as_secs() / 60
                )),
                Ok(s) if s.success() && installed(&backend, plan) => Progress::Done,
                Ok(s) if s.success() => Progress::failed(format!(
                    "{} installed, but Desk can't find it. Open a new terminal, run `{} --version`, then try again.",
                    plan.cli_name(),
                    plan.program()
                )),
                Ok(s) => Progress::failed(
                    cause.unwrap_or_else(|| failure(plan, s.code(), &outcome.last)),
                ),
                Err(e) => Progress::failed(failure(plan, None, e)),
            };
            if let (true, Progress::Failed { command, hint, .. }) = (by_hand, &mut progress) {
                *command = Some(plan.installer().to_string());
                *hint = match &backend.host {
                    Host::Wsl(w) => Some(format!("Run it in {} (WSL).", w.distro)),
                    _ => None,
                };
            }
            report(progress);
        });
        Ok(())
    }
}

fn script(plan: Plan) -> String {
    format!(
        "{}set -o pipefail; {}",
        clear_dead_link(plan),
        plan.installer()
    )
}

/// A `~/.local/bin/<cli>` link whose target is gone (an uninstall that
/// left it behind) stops the installer putting its own there: removed
/// first, and said. Only a dangling link at that one path.
fn clear_dead_link(plan: Plan) -> String {
    let at = format!("$HOME/.local/bin/{}", plan.program());
    format!(
        "if [ -L \"{at}\" ] && [ ! -e \"{at}\" ]; then rm -f \"{at}\" && echo \"Removed a broken link at ~/.local/bin/{}\"; fi; ",
        plan.program()
    )
}

fn spawn(backend: &Backend, plan: Plan) -> eyre::Result<std::process::Child> {
    let c = cli::installer(backend, &script(plan))?;
    let mut command = c.command();
    deadline::isolate(&mut command);
    Ok(command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?)
}

/// How one run of the installer ended, and the last thing it printed.
struct Outcome {
    status: Result<std::process::ExitStatus, String>,
    last: String,
    /// Stopped for taking too long.
    timed_out: bool,
}

impl Outcome {
    fn ok(&self) -> bool {
        self.status.as_ref().is_ok_and(|s| s.success())
    }

    fn error(e: String) -> Self {
        Outcome {
            status: Err(e),
            last: String::new(),
            timed_out: false,
        }
    }
}

/// Passes the installer's output on line by line until it ends.
fn drain(
    mut child: std::process::Child,
    report: &(impl Fn(Progress) + Clone + Send + 'static),
    limit: std::time::Duration,
) -> Outcome {
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
    let (status, timed_out) = deadline::wait(&mut child, limit);
    let status = status.map_err(|e| e.to_string());
    for r in readers {
        let _ = r.join();
    }
    let last = last.lock().expect("last").clone();
    Outcome {
        status,
        last,
        timed_out,
    }
}

/// Looks into a failed download where the installer ran.
fn diagnose(backend: &Backend, plan: Plan) -> probe::Diagnosis {
    let target = plan.target();
    let ran = cli::installer(backend, &probe::wrapped(&target.script()))
        .ok()
        .and_then(|c| deadline::capture(c.command(), PROBE_DEADLINE));
    match ran {
        Some(out) => probe::diagnose(&probe::parse(&out), target.host),
        None => probe::Diagnosis::Unknown,
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

    #[test]
    fn a_failed_install_carries_the_command_to_run_by_hand() {
        let p = Progress::Failed {
            message: "The download stalled.".into(),
            command: Some(Plan::Claude.installer().into()),
            hint: Some("Run it in Ubuntu (WSL).".into()),
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["state"], "failed");
        assert_eq!(
            v["command"],
            "curl -fsSL https://claude.ai/install.sh | bash"
        );
        let v = serde_json::to_value(Progress::failed("x".into())).unwrap();
        assert!(v.get("command").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_link_where_the_cli_goes_is_removed_and_nothing_else() {
        use std::os::unix::fs::symlink;
        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join(".local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let run = || {
            std::process::Command::new("/bin/bash")
                .args(["-c", &clear_dead_link(Plan::Claude)])
                .env("HOME", home.path())
                .output()
                .unwrap()
        };
        // Dangling: removed, and said.
        symlink(home.path().join("gone"), bin.join("claude")).unwrap();
        let out = run();
        assert!(out.status.success());
        assert!(std::fs::symlink_metadata(bin.join("claude")).is_err());
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            "Removed a broken link at ~/.local/bin/claude"
        );
        // A link that works, and a real file, are kept, silently.
        std::fs::write(home.path().join("real"), "x").unwrap();
        symlink(home.path().join("real"), bin.join("claude")).unwrap();
        assert!(run().stdout.is_empty());
        assert!(bin.join("claude").exists());
        std::fs::remove_file(bin.join("claude")).unwrap();
        std::fs::write(bin.join("claude"), "x").unwrap();
        assert!(run().stdout.is_empty());
        assert!(bin.join("claude").exists());
        // Nothing there: nothing done.
        std::fs::remove_file(bin.join("claude")).unwrap();
        assert!(run().status.success());
        assert!(
            script(Plan::Claude)
                .ends_with("set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash")
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_installer_that_never_ends_is_stopped_and_said() {
        let mut command = std::process::Command::new("/bin/sh");
        command.args(["-c", "echo working; sleep 30"]);
        deadline::isolate(&mut command);
        let child = command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let start = std::time::Instant::now();
        let out = drain(
            child,
            &|_: Progress| {},
            std::time::Duration::from_millis(500),
        );
        assert!(out.timed_out && !out.ok());
        assert!(start.elapsed() < std::time::Duration::from_secs(10));
    }
}
