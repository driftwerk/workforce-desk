//! Desk Helper on Windows: `Desk Helper.exe`, beside the app and started
//! from the Run key at sign-in, keeps the Linux Desk Helper running inside
//! the WSL distro setup chose. Each launch installs the backend the app
//! carries when the distro has an older one, so updating the app updates
//! its backend.

use std::os::windows::process::CommandExt;
use std::path::PathBuf;

use desk_core::backend::Backend;
use desk_core::host::{Host, Wsl};
use desk_wsl::install::{self, Plan};
use desk_wsl::reach::{self, Reach};
use desk_wsl::{WslExe, WslProblem, detect, startup};
use eyre::{Context, Result};

use super::{Login, Status};

pub struct Helper {
    backend: Backend,
}

/// The launcher, beside the app.
pub fn launcher() -> Result<PathBuf> {
    Ok(std::env::current_exe()?.with_file_name(format!("{}.exe", desk_core::HELPER_EXECUTABLE)))
}

/// The backend the app carries, in its resources.
fn bundled_backend() -> Result<PathBuf> {
    Ok(std::env::current_exe()?.with_file_name("backend"))
}

/// Starts the launcher on its own, outliving this window.
pub fn start_launcher() -> Result<()> {
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    let exe = launcher()?;
    std::process::Command::new(&exe)
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .with_context(|| format!("starting {}", exe.display()))?;
    Ok(())
}

/// Installs the version the app carries into `w` when the distro's is
/// older (a newer one there is kept: it is reinstalled only when asked).
fn update(wsl: &WslExe, w: &Wsl) -> Result<()> {
    let version = env!("CARGO_PKG_VERSION");
    match install::plan(install::installed(wsl, w)?.as_deref(), version) {
        Plan::Nothing => Ok(()),
        Plan::Install | Plan::Upgrade { .. } => {
            install::install(wsl, w, &bundled_backend()?, version).map(drop)
        }
        Plan::Downgrade { from } => {
            tracing::warn!(%from, %version, "the distro has a newer Desk backend; keeping it");
            Ok(())
        }
    }
}

/// Where the hub stands, seen from Windows.
fn reached(backend: &Backend, wsl: &WslExe, w: &Wsl) -> Status {
    match backend.connection() {
        Ok(Some(c)) => match reach::check(wsl, w, &c.gateway_url) {
            Reach::Ready => Status::Running,
            Reach::Starting => Status::Starting,
            Reach::PortUnreachable => Status::PortUnreachable,
        },
        Ok(None) => Status::Starting,
        Err(e) => Status::Failed {
            message: format!("{e:#}"),
        },
    }
}

impl Helper {
    pub fn new(backend: Backend) -> Self {
        Self { backend }
    }

    fn wsl(&self) -> Option<&Wsl> {
        match &self.backend.host {
            Host::Wsl(w) => Some(w),
            Host::Native => None,
        }
    }

    /// The distro setup chose, while WSL still has it as WSL 2.
    fn distro_problem(&self, wsl: &WslExe, w: &Wsl) -> Option<WslProblem> {
        match detect::list(wsl).into_iter().find(|d| d.name == w.distro) {
            None => Some(WslProblem::NoDistro),
            Some(d) if d.version != 2 => Some(WslProblem::Wsl1 { distro: d.name }),
            Some(_) => None,
        }
    }

    fn try_ensure(&self, w: &Wsl) -> Result<Status> {
        let wsl = WslExe::system();
        if let Some(problem) = self.distro_problem(&wsl, w) {
            return Ok(Status::NoWsl { problem });
        }
        update(&wsl, w)?;
        startup::register(&launcher()?)?;
        if startup::disabled() {
            return Ok(Status::NeedsApproval);
        }
        if !startup::running() {
            start_launcher()?;
        }
        Ok(self.status())
    }
}

impl Login for Helper {
    fn status(&self) -> Status {
        let Some(w) = self.wsl() else {
            return Status::Development;
        };
        if startup::registered().is_none() {
            Status::NotRegistered
        } else if startup::disabled() {
            Status::NeedsApproval
        } else if !startup::running() {
            Status::Starting
        } else {
            reached(&self.backend, &WslExe::system(), w)
        }
    }

    fn ensure(&self) -> Status {
        let Some(w) = self.wsl() else {
            return Status::Development;
        };
        self.try_ensure(w).unwrap_or_else(|e| {
            tracing::error!(error = %format!("{e:#}"), "could not keep Desk Helper running in WSL");
            Status::Failed {
                message: format!("{e:#}"),
            }
        })
    }

    /// `Desk Helper.exe --stop` stops the launcher and the backend in WSL.
    fn unregister(&self) -> Result<()> {
        if self.wsl().is_none() {
            return Ok(());
        }
        let out = std::process::Command::new(launcher()?)
            .arg("--stop")
            .output()
            .context("stopping Desk Helper")?;
        if !out.status.success() {
            eyre::bail!("Desk Helper didn't stop");
        }
        startup::unregister()
    }

    fn open_settings(&self) {
        let _ = std::process::Command::new("explorer.exe")
            .arg("ms-settings:startupapps")
            .spawn();
    }
}
