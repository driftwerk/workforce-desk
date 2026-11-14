//! Installing Claude Code, Codex or Devin when this computer doesn't have
//! it: each one's official installer, run as the person, with what it prints
//! passed on line by line.

use std::io::{BufRead, BufReader};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use desk_core::backend::Backend;
use desk_core::host::Host;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::{Plan, cli, deadline, probe, scan};

/// A CLI Desk installs: the one a plan signs in with (named by its plan,
/// `claude` and `chatgpt`, as the page asks for it), or an engine's own
/// (`devin`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Cli {
    Claude,
    Chatgpt,
    Devin,
}

impl From<Plan> for Cli {
    fn from(plan: Plan) -> Self {
        match plan {
            Plan::Claude => Cli::Claude,
            Plan::Chatgpt => Cli::Chatgpt,
        }
    }
}

impl Plan {
    /// The CLI a plan signs in with.
    pub fn program(self) -> &'static str {
        Cli::from(self).program()
    }
}

/// Where Devin's manifest and bundles are, as its installer reads them.
const DEVIN_MANIFEST: &str = "https://static.devin.ai/cli/current/manifest.json";
const DEVIN_BUNDLES: &str = "https://static.devin.ai/cli/";

impl Cli {
    pub fn program(self) -> &'static str {
        match self {
            Cli::Claude => "claude",
            Cli::Chatgpt => "codex",
            Cli::Devin => "devin",
        }
    }

    pub fn cli_name(self) -> &'static str {
        match self {
            Cli::Claude => "Claude Code",
            Cli::Chatgpt => "Codex",
            Cli::Devin => "Devin",
        }
    }

    /// The official installer, from each one's own install page:
    /// code.claude.com/docs/en/setup, learn.chatgpt.com/docs/codex/cli and
    /// docs.devin.ai/cli. What the person runs by hand when Desk can't.
    fn installer(self) -> &'static str {
        match self {
            Cli::Claude => "curl -fsSL https://claude.ai/install.sh | bash",
            Cli::Chatgpt => "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
            Cli::Devin => "curl -fsSL https://cli.devin.ai/install.sh | bash",
        }
    }

    /// What Desk runs: the installer, except Devin's, whose own steps Desk
    /// does itself ([`devin_unpack`]): its installer ends with `devin
    /// setup`, which signs in, and can wait on a browser nobody is at or
    /// write the person's Devin config unasked. Sign-in is Desk's own step.
    fn run(self) -> String {
        match self {
            Cli::Devin => devin_unpack(DEVIN_MANIFEST, DEVIN_BUNDLES),
            _ => self.installer().to_string(),
        }
    }

    /// The other ways each one's own docs give, tried in turn when the
    /// installer can't be downloaded: npm into `~/.local` (no sudo; its
    /// `bin` is where Desk looks), then Homebrew. Each exits 127 when its
    /// tool isn't there, and is passed over. Devin's docs give none: its
    /// checked download is already what Desk runs.
    fn alternatives(self) -> Vec<(&'static str, String)> {
        let (package, cask) = match self {
            Cli::Claude => ("@anthropic-ai/claude-code", "claude-code"),
            Cli::Chatgpt => ("@openai/codex", "codex"),
            Cli::Devin => return Vec::new(),
        };
        vec![
            (
                "npm",
                format!(
                    "command -v npm >/dev/null 2>&1 || exit 127; npm install -g --prefix \"$HOME/.local\" {package}"
                ),
            ),
            (
                "Homebrew",
                format!("command -v brew >/dev/null 2>&1 || exit 127; brew install --cask {cask}"),
            ),
        ]
    }
}

/// Devin's installer's own steps, without the `devin setup` it ends with:
/// its manifest read for this computer's bundle, the bundle (only one under
/// `bundles`) downloaded and checked against the manifest's sha256, unpacked
/// into `~/.local/share/devin/cli/_versions/<version>`, made `current`, and
/// linked from `~/.local/bin/devin`. A `~/.local/bin/devin` that isn't
/// Devin's own link is left as it is, and said.
fn devin_unpack(manifest: &str, bundles: &str) -> String {
    // Over HTTPS, each stays HTTPS through every redirect.
    let https_of = |url: &str| match url.starts_with("https://") {
        true => "--proto '=https' --proto-redir '=https' ",
        false => "",
    };
    let (https_manifest, https) = (https_of(manifest), https_of(bundles));
    format!(
        r#"set -eu
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) target=aarch64-apple-darwin ;;
  Darwin/x86_64) target=x86_64-apple-darwin ;;
  Linux/x86_64) target=x86_64-unknown-linux ;;
  Linux/aarch64|Linux/arm64) target=aarch64-unknown-linux ;;
  *) echo "Devin doesn't run on $(uname -s) $(uname -m)."; exit 1 ;;
esac
manifest=$(curl -fsSL {https_manifest}--max-time 30 '{manifest}') || {{ echo "Failed to fetch Devin's manifest"; exit 1; }}
field() {{ grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*"\([^"]*\)"$/\1/'; }}
version=$(printf '%s' "$manifest" | field version || true)
entry=$(printf '%s' "$manifest" | grep -o "\"$target\"[[:space:]]*:[[:space:]]*{{[^}}]*}}" | head -1 || true)
url=$(printf '%s' "$entry" | field url || true)
sha=$(printf '%s' "$entry" | field sha256 || true)
case "$version" in ''|.*|*[!0-9A-Za-z.+-]*) echo "Devin's manifest has no version Desk can use."; exit 1 ;; esac
case "$sha" in *[!0-9a-f]*|'') echo "Devin's manifest has no checksum for $target."; exit 1 ;; esac
[ ${{#sha}} -eq 64 ] || {{ echo "Devin's manifest has no checksum for $target."; exit 1; }}
case "$url" in *..*|*[[:space:]]*) url= ;; '{bundles}'*) ;; *) url= ;; esac
[ -n "$url" ] || {{ echo "Devin's manifest has no download of Devin's own for $target."; exit 1; }}
data="${{XDG_DATA_HOME:-$HOME/.local/share}}"
for old in cognition chisel; do
  if [ -d "$data/$old" ] && [ ! -e "$data/devin" ]; then mv "$data/$old" "$data/devin" && ln -s "$data/devin" "$data/$old"; fi
done
versions="$data/devin/cli/_versions"
dir="$versions/$version"
mkdir -p "$versions" "$HOME/.local/bin"
if [ ! -x "$dir/bin/devin" ]; then
  tmp=$(mktemp -d "$versions/_desk.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL {https}-g --max-time 900 "$url" -o "$tmp/bundle.tar.gz" || {{ echo "Failed to download Devin"; exit 1; }}
  if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp/bundle.tar.gz" | cut -d' ' -f1)
  else got=$(shasum -a 256 "$tmp/bundle.tar.gz" | cut -d' ' -f1); fi
  [ "$got" = "$sha" ] || {{ echo "Devin's download didn't match its checksum, so Desk didn't install it."; exit 1; }}
  tar tzf "$tmp/bundle.tar.gz" > "$tmp/list" || {{ echo "Devin's download isn't one Desk can read."; exit 1; }}
  if grep -Eq '^/|(^|/)\.\.(/|$)' "$tmp/list"; then
    echo "Devin's download names files outside its own folder, so Desk didn't install it."; exit 1
  fi
  mkdir "$tmp/x"
  tar xzf "$tmp/bundle.tar.gz" --no-same-owner -C "$tmp/x"
  [ -x "$tmp/x/bin/devin" ] || {{ echo "Devin's download has no devin in it."; exit 1; }}
  rm -rf "$dir"
  mv "$tmp/x" "$dir"
fi
rm -f "$versions/current"
ln -s "$version" "$versions/current"
link="$HOME/.local/bin/devin"
if [ -L "$link" ]; then
  case "$(readlink "$link")" in
    */devin/cli/_versions/*|*/cognition/cli/_versions/*|*/chisel/cli/_versions/*) rm -f "$link" ;;
    *) echo "~/.local/bin/devin points somewhere else, so Desk left it."; exit 1 ;;
  esac
elif [ -e "$link" ]; then
  echo "~/.local/bin/devin is there already and isn't Devin's link, so Desk left it."; exit 1
fi
ln -s "$versions/current/bin/devin" "$link"
echo curl-bash > "$dir/distribution"
echo "Installed devin v$version."
"#
    )
}

/// The exit code a way to install gives when its tool isn't there.
const NOT_THERE: i32 = 127;

/// Whether the CLI can be found where the backend runs: on the login PATH
/// or in `~/.local/bin`, where the installers put it.
pub fn installed(backend: &Backend, plan: Cli) -> bool {
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
        /// What the installer last printed, for Details.
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<String>,
    },
}

impl Progress {
    fn failed(message: String) -> Self {
        Progress::Failed {
            message,
            command: None,
            hint: None,
            details: None,
        }
    }
}

#[derive(Serialize, Clone)]
struct Event {
    plan: Cli,
    #[serde(flatten)]
    progress: Progress,
}

/// curl's exit codes for a network that isn't there or won't answer.
fn offline(code: Option<i32>) -> bool {
    matches!(code, Some(6 | 7 | 28 | 35 | 52 | 56))
}

/// What to tell the person when the installer stops. What it last said
/// goes under Details, never in the sentence.
fn failure(plan: Cli, code: Option<i32>, _last: &str) -> String {
    if offline(code) {
        return format!(
            "Couldn't download {}. Check this computer is online and try again.",
            plan.cli_name()
        );
    }
    format!(
        "{}'s installer stopped before it finished.",
        plan.cli_name()
    )
}

/// How long one run of an installer may take before it is stopped.
const INSTALL_DEADLINE: std::time::Duration = std::time::Duration::from_secs(15 * 60);
/// How long the probe may take: its own curl has a 20 s cap, but a hung
/// shell must not hold the install up.
const PROBE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(45);

#[derive(Default)]
pub struct Installs {
    running: Arc<Mutex<Vec<Cli>>>,
}

impl Installs {
    /// Runs the installer in the background; progress arrives as
    /// `cli-install` events.
    pub fn start(&self, app: &AppHandle, backend: Backend, plan: Cli) -> Result<(), String> {
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
            // A download that still failed: the other ways the docs give,
            // before Desk hands out a command to run by hand. Not for a
            // timeout or any other failure, nor offline, where they'd fail
            // the same way. If none works, what's said and offered stays
            // the installer's; theirs goes under Details.
            let mut also = None;
            if worth_other_ways(&outcome, plan) {
                match other_ways(&backend, plan, &report, brew_here(&backend)) {
                    Other::Installed(other) => outcome = other,
                    Other::Failed { name, last } => also = Some((name, last)),
                    Other::NoneThere => {}
                }
            }
            running.lock().expect("installs").retain(|p| *p != plan);
            let by_hand =
                !outcome.ok() && (outcome.timed_out || probe::is_download_failure(&outcome.last));
            let last = outcome.last.trim().to_string();
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
            if let Progress::Failed { details, .. } = &mut progress {
                *details = said_under_details(&last, also.as_ref());
            }
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

/// Tries `plan`'s other ways to install in turn: the first that installs
/// it, else the last that was there and failed; none when no other way's
/// tool is there.
/// How the other ways went.
enum Other {
    /// One of them installed it.
    Installed(Outcome),
    /// The last that was there failed; what it printed last.
    Failed { name: &'static str, last: String },
    /// None's tool was there.
    NoneThere,
}

/// Whether a failed run is one the other ways may get round: a download
/// that failed, while this computer is online. Never a timeout, an
/// unsupported system, or anything else the installer stopped at. Devin's
/// own steps have no other way to try, so any failure online but a
/// timeout is worth one (there is none, and its command by hand is said).
fn worth_other_ways(outcome: &Outcome, plan: Cli) -> bool {
    let offline_now = matches!(&outcome.status, Ok(s) if offline(s.code()));
    !outcome.ok()
        && !outcome.timed_out
        && !offline_now
        && (plan == Cli::Devin || probe::is_download_failure(&outcome.last))
}

/// Whether Homebrew is one of the ways where `backend` runs: a Mac's own.
fn brew_here(backend: &Backend) -> bool {
    cfg!(target_os = "macos") && matches!(backend.host, Host::Native)
}

/// What goes under Details: what the installer last printed, and what
/// another way that also failed did.
fn said_under_details(last: &str, also: Option<&(&'static str, String)>) -> Option<String> {
    let mut lines = Vec::new();
    if !last.is_empty() {
        lines.push(last.to_string());
    }
    if let Some((name, said)) = also {
        let said = said.trim();
        lines.push(match said.is_empty() {
            true => format!("{name} didn't install it either."),
            false => format!("{name} didn't install it either: {said}"),
        });
    }
    (!lines.is_empty()).then(|| lines.join("\n"))
}

fn other_ways(
    backend: &Backend,
    plan: Cli,
    report: &(impl Fn(Progress) + Clone + Send + 'static),
    brew: bool,
) -> Other {
    let mut tried = Other::NoneThere;
    for (name, way) in plan.alternatives() {
        if name == "Homebrew" && !brew {
            continue;
        }
        let Ok(child) = spawn_script(backend, &format!("{}{way}", clear_dead_link(plan))) else {
            continue;
        };
        report(Progress::Running {
            line: format!("Trying {name} instead…"),
        });
        let outcome = drain(child, report, INSTALL_DEADLINE);
        if passed_over(&outcome) {
            continue;
        }
        if outcome.ok() && installed(backend, plan) {
            return Other::Installed(outcome);
        }
        tried = Other::Failed {
            name,
            last: outcome.last,
        };
    }
    tried
}

/// A way whose tool isn't there.
fn passed_over(outcome: &Outcome) -> bool {
    matches!(&outcome.status, Ok(s) if s.code() == Some(NOT_THERE))
}

fn script(plan: Cli) -> String {
    as_installer(plan, &plan.run())
}

/// `run` as an installer runs it: a dead link cleared first, and a failing
/// step anywhere in a pipe failing the pipe.
fn as_installer(plan: Cli, run: &str) -> String {
    format!("{}set -o pipefail; {run}", clear_dead_link(plan))
}

/// A `~/.local/bin/<cli>` link whose target is gone (an uninstall that
/// left it behind) stops the installer putting its own there: removed
/// first, and said. Only a dangling link at that one path.
fn clear_dead_link(plan: Cli) -> String {
    let at = format!("$HOME/.local/bin/{}", plan.program());
    format!(
        "if [ -L \"{at}\" ] && [ ! -e \"{at}\" ]; then rm -f \"{at}\" && echo \"Removed a broken link at ~/.local/bin/{}\"; fi; ",
        plan.program()
    )
}

fn spawn(backend: &Backend, plan: Cli) -> eyre::Result<std::process::Child> {
    spawn_as(backend, &script(plan), plan == Cli::Devin)
}

fn spawn_script(backend: &Backend, script: &str) -> eyre::Result<std::process::Child> {
    spawn_as(backend, script, false)
}

/// Runs `script` as an installer. `no_terminal`: in a session of its own,
/// with no terminal to open, so nothing it runs (Devin's steps never run its
/// `setup`, but a link to one could) finds anything to ask on and waits,
/// even when Desk itself was started from a terminal. It is still its own process group, so it is stopped whole.
fn spawn_as(
    backend: &Backend,
    script: &str,
    no_terminal: bool,
) -> eyre::Result<std::process::Child> {
    let c = cli::installer(backend, script)?;
    let mut command = c.command();
    if no_terminal {
        detach(&mut command);
    } else {
        deadline::isolate(&mut command);
    }
    Ok(command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?)
}

/// A new session for `command` (and so a new process group it leads): no
/// controlling terminal.
fn detach(command: &mut std::process::Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid is async-signal-safe, and nothing else runs
        // between fork and exec.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    #[cfg(not(unix))]
    deadline::isolate(command);
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
fn diagnose(backend: &Backend, plan: Cli) -> probe::Diagnosis {
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
            failure(Cli::Claude, Some(6), "curl: (6) Could not resolve host"),
            "Couldn't download Claude Code. Check this computer is online and try again."
        );
        assert_eq!(
            failure(Cli::Chatgpt, Some(1), "  Unsupported architecture  "),
            "Codex's installer stopped before it finished.",
            "what it printed is for Details"
        );
        assert_eq!(
            failure(Cli::Chatgpt, Some(1), ""),
            "Codex's installer stopped before it finished."
        );
    }

    #[test]
    fn each_plan_installs_its_own_cli_from_its_official_installer() {
        assert_eq!(Cli::Claude.program(), "claude");
        assert!(
            Cli::Claude
                .installer()
                .contains("https://claude.ai/install.sh")
        );
        assert_eq!(Cli::Chatgpt.program(), "codex");
        assert!(
            Cli::Chatgpt
                .installer()
                .contains("https://chatgpt.com/codex/install.sh")
        );
    }

    #[test]
    fn a_failed_install_carries_the_command_to_run_by_hand() {
        let p = Progress::Failed {
            message: "The download stalled.".into(),
            command: Some(Cli::Claude.installer().into()),
            hint: Some("Run it in Ubuntu (WSL).".into()),
            details: Some("curl: (56) Recv failure".into()),
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
                .args(["-c", &clear_dead_link(Cli::Claude)])
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
            script(Cli::Claude)
                .ends_with("set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash")
        );
    }

    #[test]
    fn each_cli_has_its_docs_other_ways_npm_into_home_then_homebrew() {
        let [npm, brew] = <[_; 2]>::try_from(Cli::Claude.alternatives()).unwrap();
        assert_eq!(npm.0, "npm");
        assert!(
            npm.1
                .ends_with(r#"npm install -g --prefix "$HOME/.local" @anthropic-ai/claude-code"#)
        );
        assert_eq!(brew.0, "Homebrew");
        assert!(brew.1.ends_with("brew install --cask claude-code"));
        let [npm, brew] = <[_; 2]>::try_from(Cli::Chatgpt.alternatives()).unwrap();
        assert!(npm.1.ends_with("@openai/codex"));
        assert!(brew.1.ends_with("brew install --cask codex"));
    }

    #[cfg(unix)]
    fn ran(code: i32, last: &str, timed_out: bool) -> Outcome {
        use std::os::unix::process::ExitStatusExt;
        Outcome {
            status: Ok(std::process::ExitStatus::from_raw(code << 8)),
            last: last.into(),
            timed_out,
        }
    }

    #[cfg(unix)]
    #[test]
    fn only_a_failed_download_while_online_tries_the_other_ways() {
        let stalled = "curl: (18) transfer closed with outstanding read data remaining";
        assert!(
            probe::is_download_failure(stalled),
            "the fixture is a download failure"
        );
        assert!(worth_other_ways(&ran(18, stalled, false), Cli::Claude));
        assert!(!worth_other_ways(
            &ran(1, "Unsupported architecture", false),
            Cli::Claude
        ));
        assert!(
            !worth_other_ways(&ran(18, stalled, true), Cli::Claude),
            "never after a timeout"
        );
        assert!(
            !worth_other_ways(
                &ran(6, "curl: (6) Could not resolve host", false),
                Cli::Claude
            ),
            "never offline"
        );
        assert!(!worth_other_ways(&ran(0, "", false), Cli::Claude));
        // Devin's own steps: after `setup` stopped too, never offline or late.
        assert!(worth_other_ways(
            &ran(1, "Error: no tty", false),
            Cli::Devin
        ));
        assert!(!worth_other_ways(&ran(1, "x", true), Cli::Devin));
        assert!(!worth_other_ways(
            &ran(6, "curl: (6) Could not resolve host", false),
            Cli::Devin
        ));
        assert!(!worth_other_ways(&ran(0, "", false), Cli::Devin));
    }

    #[test]
    fn homebrew_is_only_a_way_on_a_macs_own_desk() {
        let wsl = Backend::wsl(desk_core::host::Wsl {
            distro: "Ubuntu".into(),
            user: "sarah".into(),
            home: "/home/sarah".into(),
            automount: "/mnt/".into(),
        });
        assert!(!brew_here(&wsl));
    }

    #[test]
    fn what_the_other_ways_said_goes_only_under_details() {
        assert_eq!(said_under_details("", None), None);
        assert_eq!(
            said_under_details(
                "curl: (56) Recv failure",
                Some(&("npm", "npm ERR! 404".into()))
            )
            .unwrap(),
            "curl: (56) Recv failure\nnpm didn't install it either: npm ERR! 404"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_way_whose_tool_isnt_there_is_passed_over_and_one_that_is_runs() {
        let bin = tempfile::tempdir().unwrap();
        let run = |path: &str| {
            let [(_, npm), _] = <[_; 2]>::try_from(Cli::Claude.alternatives()).unwrap();
            let mut command = std::process::Command::new("/bin/bash");
            command
                .args(["-c", &npm])
                .env("PATH", path)
                .env("HOME", bin.path())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            drain(
                command.spawn().unwrap(),
                &|_: Progress| {},
                std::time::Duration::from_secs(10),
            )
        };
        // No npm on PATH: passed over, never a failure of its own.
        let none = run(bin.path().to_str().unwrap());
        assert!(passed_over(&none));
        // A stand-in npm that says what it was asked.
        let npm = bin.path().join("npm");
        std::fs::write(&npm, "#!/bin/sh\necho \"npm $*\"\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&npm, std::fs::Permissions::from_mode(0o755)).unwrap();
        let ran = run(&format!("{}:/usr/bin:/bin", bin.path().display()));
        assert!(ran.ok() && !passed_over(&ran));
        assert_eq!(
            ran.last,
            format!(
                "npm install -g --prefix {}/.local @anthropic-ai/claude-code",
                bin.path().display()
            )
        );
    }

    #[test]
    fn devin_installs_from_its_checked_download_and_never_runs_its_setup() {
        let run = Cli::Devin.run();
        assert!(run.contains("https://static.devin.ai/cli/current/manifest.json"));
        assert!(!run.contains("setup"), "Desk signs in itself");
        assert!(!run.contains("install.sh"));
        assert!(
            run.contains("--proto '=https' --proto-redir '=https'"),
            "HTTPS all the way"
        );
        // What the person runs by hand when Desk can't.
        assert_eq!(
            Cli::Devin.installer(),
            "curl -fsSL https://cli.devin.ai/install.sh | bash"
        );
        assert!(Cli::Devin.alternatives().is_empty());
        assert_eq!(Cli::from(Plan::Chatgpt), Cli::Chatgpt);
        assert_eq!(
            serde_json::from_str::<Cli>("\"devin\"").unwrap(),
            Cli::Devin
        );
    }

    /// A Devin manifest, bundle and home in a folder: the bundle's `devin`
    /// prints `devin 9.9.9`.
    #[cfg(unix)]
    fn devin_release(sha: Option<&str>) -> (tempfile::TempDir, String, String) {
        devin_release_of(sha, |_| vec!["bin".into()])
    }

    /// [`devin_release`] whose bundle is `entries` (as `tar` names them,
    /// read from `build/`, which already holds `bin/devin`), each kept as
    /// written, `../` and leading `/` too.
    #[cfg(unix)]
    fn devin_release_of(
        sha: Option<&str>,
        entries: impl FnOnce(&std::path::Path) -> Vec<String>,
    ) -> (tempfile::TempDir, String, String) {
        use std::os::unix::fs::PermissionsExt;
        let at = tempfile::tempdir().unwrap();
        let root = at.path();
        let bundle = root.join("build/bin");
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(bundle.join("devin"), "#!/bin/sh\necho devin 9.9.9\n").unwrap();
        std::fs::set_permissions(bundle.join("devin"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        std::fs::create_dir_all(root.join("cdn/9.9.9")).unwrap();
        let tarball = root.join("cdn/9.9.9/devin.tar.gz");
        let list = root.join("entries");
        std::fs::write(&list, entries(&root.join("build")).join("\n") + "\n").unwrap();
        let made = std::process::Command::new("tar")
            .args(["czPf", tarball.to_str().unwrap(), "-C"])
            .arg(root.join("build"))
            .arg("-T")
            .arg(&list)
            .status()
            .unwrap();
        assert!(made.success());
        let real = {
            let out = std::process::Command::new("sh")
                .args([
                    "-c",
                    "sha256sum \"$1\" 2>/dev/null || shasum -a 256 \"$1\"",
                    "_",
                ])
                .arg(&tarball)
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout)
                .split_whitespace()
                .next()
                .unwrap()
                .to_string()
        };
        let bundles = format!("file://{}/cdn/", root.display());
        let platforms = [
            "aarch64-apple-darwin",
            "x86_64-apple-darwin",
            "x86_64-unknown-linux",
            "aarch64-unknown-linux",
        ]
        .map(|t| {
            format!(
                r#""{t}":{{"url":"{bundles}9.9.9/devin.tar.gz","sha256":"{}"}}"#,
                sha.unwrap_or(&real)
            )
        })
        .join(",");
        std::fs::write(
            root.join("cdn/manifest.json"),
            format!(r#"{{"version":"9.9.9","platforms":{{{platforms}}}}}"#),
        )
        .unwrap();
        std::fs::create_dir_all(root.join("home")).unwrap();
        let manifest = format!("file://{}/cdn/manifest.json", root.display());
        (at, manifest, bundles)
    }

    #[cfg(unix)]
    fn unpack(home: &std::path::Path, manifest: &str, bundles: &str) -> std::process::Output {
        std::process::Command::new("/bin/bash")
            .args([
                "-c",
                &as_installer(Cli::Devin, &devin_unpack(manifest, bundles)),
            ])
            .env("HOME", home)
            .env_remove("XDG_DATA_HOME")
            .stdin(Stdio::null())
            .output()
            .unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn desk_unpacks_devins_checked_bundle_itself_without_setup() {
        let (at, manifest, bundles) = devin_release(None);
        let home = at.path().join("home");
        let out = unpack(&home, &manifest, &bundles);
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stdout)
        );
        let link = home.join(".local/bin/devin");
        assert_eq!(
            std::fs::read_link(&link).unwrap(),
            home.join(".local/share/devin/cli/_versions/current/bin/devin")
        );
        let ran = std::process::Command::new(&link).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&ran.stdout).trim(), "devin 9.9.9");
        let version = home.join(".local/share/devin/cli/_versions/9.9.9");
        assert_eq!(
            std::fs::read_to_string(version.join("distribution")).unwrap(),
            "curl-bash\n"
        );
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            "Installed devin v9.9.9."
        );
        // Again, over its own link: kept as Devin's.
        assert!(unpack(&home, &manifest, &bundles).status.success());
        assert!(std::fs::read_link(&link).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn a_bundle_that_doesnt_match_its_checksum_or_isnt_devins_own_is_never_installed() {
        let (at, manifest, bundles) = devin_release(Some(&"0".repeat(64)));
        let home = at.path().join("home");
        let out = unpack(&home, &manifest, &bundles);
        assert!(!out.status.success());
        assert!(
            String::from_utf8_lossy(&out.stdout).contains("didn't match its checksum"),
            "{}",
            String::from_utf8_lossy(&out.stdout)
        );
        assert!(std::fs::symlink_metadata(home.join(".local/bin/devin")).is_err());
        assert!(!home.join(".local/share/devin/cli/_versions/9.9.9").exists());

        // A download from anywhere but Devin's own: refused before it's fetched.
        let (at, manifest, _) = devin_release(None);
        let home = at.path().join("home");
        let out = unpack(&home, &manifest, "https://static.devin.ai/cli/");
        assert!(!out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("no download of Devin's own"));
        assert!(std::fs::symlink_metadata(home.join(".local/bin/devin")).is_err());

        // A ~/.local/bin/devin of the person's own: left as it is, and said.
        let (at, manifest, bundles) = devin_release(None);
        let home = at.path().join("home");
        std::fs::create_dir_all(home.join(".local/bin")).unwrap();
        std::fs::write(home.join(".local/bin/devin"), "mine").unwrap();
        let out = unpack(&home, &manifest, &bundles);
        assert!(!out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("Desk left it"));
        assert_eq!(
            std::fs::read_to_string(home.join(".local/bin/devin")).unwrap(),
            "mine"
        );
    }

    /// A long bundle (thousands of files) with one file outside its own
    /// folder near its end, by `../` or by a path from `/`: refused whole,
    /// and nothing of it is left anywhere.
    #[cfg(unix)]
    #[test]
    fn a_bundle_naming_a_file_outside_its_folder_is_never_unpacked() {
        for absolute in [false, true] {
            let mut escape = None;
            let (at, manifest, bundles) = devin_release_of(None, |build| {
                let many = build.join("bin/lib");
                std::fs::create_dir_all(&many).unwrap();
                let mut entries = vec!["bin/devin".to_string()];
                for i in 0..3000 {
                    std::fs::write(many.join(format!("f{i}")), "x").unwrap();
                    entries.push(format!("bin/lib/f{i}"));
                }
                // Beside `build`, where a `../` from it lands.
                let out = build.parent().unwrap().join("escaped");
                std::fs::write(&out, "out").unwrap();
                let bad = match absolute {
                    true => out.to_str().unwrap().to_string(),
                    false => "../escaped".to_string(),
                };
                entries.insert(entries.len() - 5, bad);
                escape = Some(out);
                entries
            });
            let escape = escape.unwrap();
            std::fs::remove_file(&escape).unwrap();
            let home = at.path().join("home");
            let out = unpack(&home, &manifest, &bundles);
            let said = String::from_utf8_lossy(&out.stdout);
            assert!(!out.status.success(), "{said}");
            assert!(
                said.contains("names files outside its own folder"),
                "{said}"
            );
            assert!(!escape.exists());
            let versions = home.join(".local/share/devin/cli/_versions");
            assert!(!versions.join("9.9.9").exists());
            assert!(std::fs::symlink_metadata(versions.join("current")).is_err());
            assert!(std::fs::symlink_metadata(home.join(".local/bin/devin")).is_err());
            let left: Vec<_> = std::fs::read_dir(&versions)
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .collect();
            assert!(left.is_empty(), "{left:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn devins_installer_runs_with_no_terminal_to_ask_on() {
        let mut command = std::process::Command::new("/bin/sh");
        command.args(["-c", "(exec 3</dev/tty) 2>/dev/null && echo has-tty || echo no-tty; ps -o sid= -p $$; echo $$"]);
        detach(&mut command);
        let out = command.stdin(Stdio::null()).output().unwrap();
        let said = String::from_utf8_lossy(&out.stdout);
        let lines: Vec<&str> = said.lines().map(str::trim).collect();
        assert_eq!(lines[0], "no-tty", "{said}");
        assert_eq!(lines[1], lines[2], "it leads a session of its own: {said}");
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
