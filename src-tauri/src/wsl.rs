//! Setting Desk up inside WSL on Windows, from the first run and from
//! Help: finding the distros, installing WSL or moving a distro to WSL 2,
//! installing and starting the backend in one, and fixing Windows' reach
//! into it. Progress arrives as `wsl-setup` events, one per step.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use desk_core::Paths;
use desk_core::backend::{Backend, write_host};
use desk_core::host::{Host, Invocation, Wsl};
use desk_wsl::reach::{self, Reach};
use desk_wsl::{Detection, WslExe, detect, install, wslconfig};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::{CommandResult, text};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Step {
    Copy,
    Check,
    Start,
    Reach,
    Startup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    Running,
    Done,
    Failed,
    /// Windows can't reach the hub inside WSL; the person can let Desk fix
    /// WSL's settings.
    Blocked,
}

#[derive(Debug, Clone, Serialize)]
struct Event {
    step: Step,
    state: State,
    note: Option<String>,
}

fn say(app: &AppHandle, step: Step, state: State, note: Option<String>) {
    let _ = app.emit("wsl-setup", Event { step, state, note });
}

/// Runs `work` as `step`, saying it started and how it ended.
fn step<T>(
    app: &AppHandle,
    step: Step,
    work: impl FnOnce() -> eyre::Result<T>,
) -> CommandResult<T> {
    say(app, step, State::Running, None);
    work().map_err(|e| {
        let message = format!("{e:#}");
        say(app, step, State::Failed, Some(message.clone()));
        message
    })
}

/// WSL on this computer and its distros.
#[tauri::command]
pub async fn wsl_detect() -> CommandResult<Detection> {
    tauri::async_runtime::spawn_blocking(|| detect(&WslExe::system()))
        .await
        .map_err(text)
}

/// Installs WSL with Ubuntu, as an administrator (Windows asks); Windows
/// then needs a restart.
#[tauri::command]
pub async fn wsl_install() -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(|| {
        let elevated = Invocation {
            program: "powershell.exe".into(),
            args: vec![
                "-NoProfile".into(),
                "-Command".into(),
                "Start-Process -FilePath wsl.exe -ArgumentList '--install','-d','Ubuntu' -Verb RunAs -Wait".into(),
            ],
        };
        let status = elevated.command().status().map_err(text)?;
        if !status.success() {
            return Err("WSL didn't install. Run “wsl --install -d Ubuntu” in PowerShell as an administrator.".into());
        }
        Ok(())
    })
    .await
    .map_err(text)?
}

/// Moves `distro` to WSL 2, which takes a few minutes and keeps its files.
#[tauri::command]
pub async fn wsl_convert(distro: String) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = WslExe::system()
            .run(&["--set-version", &distro, "2"])
            .map_err(text)?;
        if !out.status.success() {
            return Err(format!(
                "{distro} didn't move to WSL 2: {}",
                desk_wsl::detect::decode(&out.stderr).trim()
            ));
        }
        Ok(())
    })
    .await
    .map_err(text)?
}

/// What the check found, as the setup says it.
fn found_note(
    probe: Option<&desk_wsl::detect::Probe>,
    check: &desk_core::backend::Check,
) -> String {
    let kernel = probe
        .map(|p| {
            p.kernel
                .split(['.', '-'])
                .take(2)
                .collect::<Vec<_>>()
                .join(".")
        })
        .filter(|k| !k.is_empty());
    [
        kernel.map(|k| format!("Linux {k}")),
        check.glibc.as_ref().map(|g| format!("glibc {g}")),
        Some(check.arch.clone()),
        Some("home on ext4".into()),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ")
}

/// Waits for the hub inside `w` to answer, then for Windows to reach it.
fn reach_hub(app: &AppHandle, wsl: &WslExe, w: &Wsl) -> CommandResult<()> {
    let backend = Backend::wsl(w.clone());
    let gateway = step(app, Step::Start, || {
        let deadline = Instant::now() + Duration::from_secs(240);
        loop {
            if let Ok(Some(c)) =
                backend.connection_with(|i| wsl.invoke(i).map_err(std::io::Error::other))
            {
                return Ok(c.gateway_url);
            }
            if Instant::now() > deadline {
                eyre::bail!(
                    "Desk didn't start in {}. Settings → Help can save a report.",
                    w.distro
                );
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    })?;
    say(app, Step::Start, State::Done, None);
    say(app, Step::Reach, State::Running, None);
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        match reach::check(wsl, w, &gateway) {
            Reach::Ready => {
                let port = gateway.rsplit(':').next().map(|p| format!("localhost:{p}"));
                say(app, Step::Reach, State::Done, port);
                return Ok(());
            }
            Reach::PortUnreachable => {
                say(
                    app,
                    Step::Reach,
                    State::Blocked,
                    Some(wslconfig::FORWARDING.into()),
                );
                return Err(format!("Windows can't reach Desk inside {}", w.distro));
            }
            Reach::Starting if Instant::now() > deadline => {
                let message = format!("Desk in {} didn't answer", w.distro);
                say(app, Step::Reach, State::Failed, Some(message.clone()));
                return Err(message);
            }
            Reach::Starting => std::thread::sleep(Duration::from_secs(1)),
        }
    }
}

/// Starts Desk Helper.exe, and from then on at every sign-in.
#[cfg(windows)]
fn start_at_signin() -> eyre::Result<()> {
    desk_wsl::startup::register(&crate::helper::launcher()?)?;
    if !desk_wsl::startup::running() {
        crate::helper::start_launcher()?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn start_at_signin() -> eyre::Result<()> {
    eyre::bail!("Desk runs its backend in WSL on Windows only")
}

fn bundled(app: &AppHandle) -> eyre::Result<PathBuf> {
    Ok(app.path().resource_dir()?.join("backend"))
}

/// Sets Desk up in `distro`: copies the backend it carries there, checks
/// it runs, makes it current, starts it, waits for Windows to reach it,
/// and starts it at every sign-in. The app's next launch uses it.
#[tauri::command]
pub async fn wsl_setup(app: AppHandle, distro: String) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let wsl = WslExe::system();
        let found = detect(&wsl)
            .distros
            .into_iter()
            .find(|f| f.distro.name == distro)
            .ok_or_else(|| format!("WSL has no distro called {distro}"))?;
        let Some(Host::Wsl(w)) = found.host() else {
            return Err(found
                .problem
                .map_or_else(|| format!("Desk can't run in {distro}"), |p| p.to_string()));
        };
        let version = app.package_info().version.to_string();
        let source = bundled(&app).map_err(text)?;
        step(&app, Step::Copy, || {
            install::copy(&wsl, &w, &source, &version)
        })?;
        say(&app, Step::Copy, State::Done, None);
        let check = step(&app, Step::Check, || install::check(&wsl, &w, &version))?;
        say(
            &app,
            Step::Check,
            State::Done,
            Some(found_note(found.probe.as_ref(), &check)),
        );
        step(&app, Step::Start, || {
            install::flip(&wsl, &w, &version)?;
            write_host(&Paths::new()?, &Host::Wsl(w.clone()))?;
            start_at_signin()
        })?;
        reach_hub(&app, &wsl, &w)?;
        say(&app, Step::Startup, State::Done, None);
        Ok(())
    })
    .await
    .map_err(text)?
}

/// Turns on WSL's localhost forwarding in `%UserProfile%\.wslconfig`, then
/// restarts WSL (which ends every program in it) and waits for Windows to
/// reach Desk again.
#[tauri::command]
pub async fn wsl_fix_forwarding(app: AppHandle, distro: String) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::var_os("USERPROFILE").ok_or("no user profile folder")?;
        let path = PathBuf::from(home).join(".wslconfig");
        let before = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.to_string()),
        };
        std::fs::write(&path, wslconfig::with_localhost_forwarding(&before)).map_err(text)?;
        let wsl = WslExe::system();
        wsl.run(&["--shutdown"]).map_err(text)?;
        let found = detect(&wsl)
            .distros
            .into_iter()
            .find(|f| f.distro.name == distro)
            .and_then(|f| f.host());
        let Some(Host::Wsl(w)) = found else {
            return Err(format!("Desk can't run in {distro}"));
        };
        reach_hub(&app, &wsl, &w)?;
        say(&app, Step::Startup, State::Done, None);
        Ok(())
    })
    .await
    .map_err(text)?
}

/// The backend's version inside WSL, for Help; none when it isn't there.
#[tauri::command]
pub async fn wsl_installed(app: tauri::State<'_, crate::App>) -> CommandResult<Option<String>> {
    let Some(Host::Wsl(w)) = app.backend.as_ref().map(|b| b.host.clone()) else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || {
        install::installed(&WslExe::system(), &w).map_err(text)
    })
    .await
    .map_err(text)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_check_is_said_as_the_setup_shows_it() {
        let probe = desk_wsl::detect::parse_probe(
            "x86_64\n6.6.36.6-microsoft-standard-WSL2\nsarah\n/home/sarah\n/mnt/c/\nldd 2.39\n",
        );
        let check = desk_core::backend::Check::of(Some("2.39".into()), "x86_64", true, true);
        assert_eq!(
            found_note(probe.as_ref(), &check),
            "Linux 6.6 · glibc 2.39 · x86_64 · home on ext4"
        );
    }
}
