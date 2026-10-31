//! Running a plan's CLI as the person: natively, with their login shell's
//! environment, or inside WSL through a login shell there, so it finds what
//! the person's own terminal would.

use std::collections::BTreeMap;
use std::path::PathBuf;

use desk_core::backend::Backend;
use desk_core::host::{Host, Invocation};
use desk_wsl::install::quote;
use eyre::Result;

/// A program ready to run: natively with the environment and folder it
/// needs; inside WSL its login shell sets those up.
pub struct Cli {
    pub invocation: Invocation,
    pub env: Option<BTreeMap<String, String>>,
    pub cwd: Option<String>,
}

impl Cli {
    pub fn command(&self) -> std::process::Command {
        let mut command = self.invocation.command();
        if let Some(env) = &self.env {
            command.env_clear().envs(env);
        }
        if let Some(cwd) = &self.cwd {
            command.current_dir(cwd);
        }
        command
    }

    /// The same, for a pseudo-terminal (ConPTY on Windows).
    pub fn pty(&self) -> portable_pty::CommandBuilder {
        let mut command = portable_pty::CommandBuilder::new(&self.invocation.program);
        command.args(&self.invocation.args);
        if let Some(env) = &self.env {
            command.env_clear();
            for (k, v) in env {
                command.env(k, v);
            }
        }
        if let Some(cwd) = &self.cwd {
            command.cwd(cwd);
        }
        command
    }
}

/// A login shell's script inside WSL that finds `~/.local/bin`, where the
/// official installers put both CLIs.
fn wsl_script(body: &str) -> String {
    format!("PATH=\"$PATH:$HOME/.local/bin\"; {body}")
}

/// `program args…` with `env` added, for the backend's host; an error when
/// the program isn't installed there.
pub fn cli(backend: &Backend, program: &str, args: &[&str], env: &[(&str, &str)]) -> Result<Cli> {
    if !installed(backend, program) {
        eyre::bail!("{program} isn't installed on this computer");
    }
    match &backend.host {
        Host::Native => native::cli(program, args, env),
        Host::Wsl(_) => {
            let assigns: String = env
                .iter()
                .map(|(k, v)| format!("{k}={} ", quote(v)))
                .collect();
            let words: Vec<String> = std::iter::once(program)
                .chain(args.iter().copied())
                .map(quote)
                .collect();
            Ok(Cli {
                invocation: backend
                    .host
                    .login_invocation(&wsl_script(&format!("{assigns}exec {}", words.join(" ")))),
                env: None,
                cwd: None,
            })
        }
    }
}

/// Whether `program` is installed where the backend runs: on its PATH or
/// in `~/.local/bin`.
pub fn installed(backend: &Backend, program: &str) -> bool {
    match &backend.host {
        Host::Native => native::installed(program),
        Host::Wsl(_) => {
            let p = quote(program);
            backend
                .host
                .login_invocation(&wsl_script(&format!("command -v {p} >/dev/null")))
                .command()
                .status()
                .is_ok_and(|s| s.success())
        }
    }
}

/// An installer's script run by bash as the person (`pipefail` needs bash).
pub fn installer(backend: &Backend, script: &str) -> Result<Cli> {
    match &backend.host {
        Host::Native => native::installer(script),
        Host::Wsl(_) => Ok(Cli {
            invocation: backend.host.invocation("/bin/bash", &["-lc", script]),
            env: None,
            cwd: None,
        }),
    }
}

/// A fresh folder in the backend's own folder only the person can read: as
/// this computer opens it, and as the CLI there names it.
pub fn private_dir(backend: &Backend, name: &str) -> Result<(PathBuf, String)> {
    let here = backend.paths.root.join(name);
    match &backend.host {
        Host::Native => {
            native::private_dir(&here).map(|p| (p.clone(), p.to_string_lossy().into_owned()))
        }
        Host::Wsl(w) => {
            let there = format!("{}/{name}", w.root());
            let q = quote(&there);
            let made = backend
                .host
                .login_invocation(&format!("rm -rf {q} && mkdir -m 700 -p {q}"))
                .command()
                .status()?;
            if !made.success() {
                eyre::bail!("couldn't make {there} in Linux");
            }
            Ok((here, there))
        }
    }
}

#[cfg(unix)]
mod native {
    use std::path::{Path, PathBuf};

    use desk_core::host::Invocation;
    use desk_core::shell::{find_program, login_env, with_local_bin, without_claude_markers};
    use eyre::Result;

    use super::Cli;

    fn env() -> std::collections::BTreeMap<String, String> {
        with_local_bin(without_claude_markers(login_env()))
    }

    pub fn cli(program: &str, args: &[&str], extra: &[(&str, &str)]) -> Result<Cli> {
        let mut env = env();
        let path = find_program(program, &env)
            .ok_or_else(|| eyre::eyre!("{program} isn't installed on this computer"))?;
        env.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        Ok(Cli {
            invocation: Invocation {
                program: path,
                args: args.iter().map(|a| a.to_string()).collect(),
            },
            cwd: env.get("HOME").cloned(),
            env: Some(env),
        })
    }

    pub fn installed(program: &str) -> bool {
        find_program(program, &login_env()).is_some()
    }

    pub fn installer(script: &str) -> Result<Cli> {
        let env = env();
        Ok(Cli {
            invocation: Invocation {
                program: "/bin/bash".into(),
                args: vec!["-c".into(), script.into()],
            },
            cwd: Some(env.get("HOME").cloned().unwrap_or_else(|| "/".into())),
            env: Some(env),
        })
    }

    pub fn private_dir(path: &Path) -> Result<PathBuf> {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::remove_dir_all(path);
        std::fs::create_dir_all(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
        Ok(path.to_path_buf())
    }
}

/// On Windows the backend, and every CLI it signs in with, is in WSL.
#[cfg(not(unix))]
mod native {
    use std::path::{Path, PathBuf};

    use eyre::Result;

    use super::Cli;

    const WSL_ONLY: &str = "On Windows, Desk runs Claude Code and Codex inside WSL";

    pub fn cli(_: &str, _: &[&str], _: &[(&str, &str)]) -> Result<Cli> {
        eyre::bail!(WSL_ONLY)
    }

    pub fn installed(_: &str) -> bool {
        false
    }

    pub fn installer(_: &str) -> Result<Cli> {
        eyre::bail!(WSL_ONLY)
    }

    pub fn private_dir(_: &Path) -> Result<PathBuf> {
        eyre::bail!(WSL_ONLY)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use desk_core::host::Wsl;

    fn wsl() -> Backend {
        Backend::wsl(Wsl {
            distro: "Ubuntu".into(),
            user: "sarah".into(),
            home: "/home/sarah".into(),
            automount: "/mnt/".into(),
        })
    }

    #[test]
    fn inside_wsl_the_installer_runs_in_bash_as_a_login_shell() {
        let i = installer(
            &wsl(),
            "set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash",
        )
        .unwrap()
        .invocation;
        assert_eq!(i.program, PathBuf::from("wsl.exe"));
        assert_eq!(
            i.args[4..],
            [
                "--exec",
                "/bin/bash",
                "-lc",
                "set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash"
            ]
        );
    }

    #[test]
    fn a_cli_inside_wsl_finds_local_bin_and_gets_its_variables_quoted() {
        assert_eq!(
            wsl_script("exec 'codex' 'login'"),
            "PATH=\"$PATH:$HOME/.local/bin\"; exec 'codex' 'login'"
        );
    }
}
