//! Running `wsl.exe`: with UTF-8 output, and no console window flashing up.

use std::path::PathBuf;
use std::process::{Command, Output};

use desk_core::host::Invocation;
use eyre::{Context, Result};

/// The `wsl.exe` Desk runs: Windows' own, or a stand-in in tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslExe {
    program: PathBuf,
}

impl WslExe {
    pub fn system() -> Self {
        Self::at("wsl.exe")
    }

    pub fn at(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
        }
    }

    /// `wsl.exe args…`, asked to answer in UTF-8 (`--list` otherwise
    /// answers in UTF-16).
    pub fn command<S: AsRef<std::ffi::OsStr>>(&self, args: &[S]) -> Command {
        let mut command = Invocation {
            program: self.program.clone(),
            args: Vec::new(),
        }
        .command();
        command.args(args).env("WSL_UTF8", "1");
        command
    }

    pub fn run<S: AsRef<std::ffi::OsStr>>(&self, args: &[S]) -> Result<Output> {
        self.command(args)
            .output()
            .with_context(|| format!("running {}", self.program.display()))
    }

    /// A WSL host's invocation (`Host::Wsl(…).invocation(…)`), through this
    /// `wsl.exe`.
    pub fn invoke(&self, invocation: &Invocation) -> Result<Output> {
        self.run(&invocation.args)
    }

    /// Like [`WslExe::invoke`], and its standard output when it succeeds.
    pub fn answer(&self, invocation: &Invocation) -> Result<String> {
        let out = self.invoke(invocation)?;
        if !out.status.success() {
            eyre::bail!(
                "{} failed: {}",
                invocation.args.join(" "),
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }
}
