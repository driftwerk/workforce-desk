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
    /// What WSL said when it fails goes to the log (a report has it), not
    /// into the words the person reads.
    pub fn answer(&self, invocation: &Invocation) -> Result<String> {
        let out = self.invoke(invocation)?;
        if !out.status.success() {
            tracing::warn!(
                args = %invocation.args.join(" "),
                code = ?out.status.code(),
                said = %crate::detect::decode(&out.stderr).trim(),
                "a command in WSL failed"
            );
            let said = crate::detect::decode(&out.stderr);
            match plain(&said) {
                Some(plain) => eyre::bail!("{plain}"),
                None => eyre::bail!(
                    "Linux said no (Settings → Help can save a report with what it said)"
                ),
            }
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }
}

/// What WSL or the Linux in it said, in the person's words, when it is
/// something they can put right; none for anything else (which goes to the
/// log, not to them).
pub fn plain(said: &str) -> Option<String> {
    let s = said.to_lowercase();
    let says = |words: &[&str]| words.iter().any(|w| s.contains(w));
    Some(
        if says(&["no space left on device", "disk quota exceeded", "enospc"]) {
            "Linux in WSL is out of disk space. Free some (or make its disk bigger), then try again.".into()
        } else if says(&["read-only file system"]) {
            "Linux in WSL can't write to its disk (it's read-only now). Restart WSL with wsl --shutdown, then try again.".into()
        } else if says(&[
            "virtual machine platform",
            "hcs_e_hyperv_not_installed",
            "virtualization",
        ]) {
            "WSL needs virtualization turned on (in the BIOS) and Windows' Virtual Machine Platform. Turn them on, then try again.".into()
        } else if says(&["0x80072ee", "network", "could not resolve", "timed out"]) {
            "WSL couldn't reach the internet. Check your connection or VPN, then try again.".into()
        } else if says(&[
            "there is no distribution with the supplied name",
            "wsl_e_distro_not_found",
        ]) {
            "That Linux isn't in WSL any more. Look again.".into()
        } else {
            return None;
        },
    )
}

#[cfg(test)]
mod tests {
    use super::plain;

    #[test]
    fn what_people_can_fix_is_said_plainly_and_the_rest_not_at_all() {
        assert!(
            plain("tar: write error: No space left on device")
                .unwrap()
                .contains("out of disk space")
        );
        assert!(
            plain("Error code: Wsl/Service/CreateInstance/HCS_E_HYPERV_NOT_INSTALLED")
                .unwrap()
                .contains("virtualization")
        );
        assert!(
            plain("WslRegisterDistribution failed with error: 0x80072ee7")
                .unwrap()
                .contains("internet")
        );
        assert_eq!(plain("segfault at 0x0 in libc.so.6"), None);
    }
}
