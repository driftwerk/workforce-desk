//! Running a plan's CLI as the person: natively, with their login shell's
//! environment, or inside WSL through a login shell there, so it finds what
//! the person's own terminal would.

use std::collections::BTreeMap;
use std::path::PathBuf;

use std::time::Duration;

use desk_core::backend::Backend;
use desk_core::host::{Host, Invocation, Wsl};
use desk_wsl::install::quote;
use eyre::Result;

use super::deadline;

/// How long a quick look inside WSL (is the CLI there, stop a sign-in) may
/// take: a WSL that doesn't answer must not hold a sign-in up for ever.
const WSL_CHECK: Duration = Duration::from_secs(30);

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
        Host::Ssh(m) => eyre::bail!("{program} signs in on {} itself", m.name),
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
        // Signed in to on the machine itself, never from here.
        Host::Ssh(_) => false,
        Host::Wsl(_) => {
            let p = quote(program);
            deadline::succeeds(
                backend
                    .host
                    .login_invocation(&wsl_script(&format!("command -v {p} >/dev/null")))
                    .command(),
                WSL_CHECK,
            )
        }
    }
}

/// Where a sign-in run inside WSL keeps its Linux process id, so Cancel,
/// the next attempt and the next Desk can end it.
fn sign_in_pidfile(w: &Wsl, program: &str) -> String {
    format!("{}/{program}-sign-in.pid", w.root())
}

/// The script that runs `program args…` inside WSL for a sign-in.
///
/// Windows gives it no console: `wsl.exe` runs over plain pipes, and
/// util-linux's `script` gives the CLI a terminal of Linux's own (wide, so
/// a token is never wrapped). A Windows pseudo-console (ConPTY) asks the
/// terminal where its cursor is and waits for the answer before it lets
/// `wsl.exe` start, so a sign-in through one stalled until Desk closed.
///
/// `BROWSER=true` makes the CLI's own attempt to open a browser a no-op:
/// Desk opens the page on Windows itself. The shell writes its pid (which
/// `exec` hands to `script`) where [`stop_sign_in`] finds it.
fn sign_in_script(w: &Wsl, program: &str, args: &[&str]) -> String {
    let words: Vec<String> = std::iter::once(program)
        .chain(args.iter().copied())
        .map(quote)
        .collect();
    let inner = format!(
        "stty cols 1000 rows 50 2>/dev/null; exec {}",
        words.join(" ")
    );
    wsl_script(&format!(
        "command -v script >/dev/null || {{ echo \"Signing in needs the script command (util-linux) in {distro}: sudo apt install util-linux\" >&2; exit 127; }}; \
         mkdir -p {root} && echo $$ >{pidfile}; \
         BROWSER=true; export BROWSER; \
         exec script -q -e -f -c {inner} /dev/null",
        distro = w.distro.replace(['"', '\\', '$', '`'], ""),
        root = quote(&w.root()),
        pidfile = quote(&sign_in_pidfile(w, program)),
        inner = quote(&inner),
    ))
}

/// The script that ends a sign-in [`sign_in_script`] started, if one is
/// still running: only the process its pidfile names, and only while that
/// is still the sign-in (a pid reused since is left alone).
fn stop_script(w: &Wsl, program: &str, marker: &str) -> String {
    format!(
        "f={f}; p=$(cat \"$f\" 2>/dev/null); rm -f \"$f\"; \
         case \"$p\" in ''|*[!0-9]*) exit 0;; esac; \
         grep -qaF -- {m} /proc/\"$p\"/cmdline 2>/dev/null || exit 0; \
         pkill -TERM -P \"$p\" 2>/dev/null; kill -TERM \"$p\" 2>/dev/null; exit 0",
        f = quote(&sign_in_pidfile(w, program)),
        m = quote(marker),
    )
}

/// `program args…` for a sign-in inside WSL; see [`sign_in_script`].
pub fn wsl_sign_in(backend: &Backend, program: &str, args: &[&str]) -> Result<Cli> {
    let Host::Wsl(w) = &backend.host else {
        eyre::bail!("not a WSL backend");
    };
    if !installed(backend, program) {
        eyre::bail!("{program} isn't installed on this computer");
    }
    Ok(Cli {
        invocation: backend
            .host
            .login_invocation(&sign_in_script(w, program, args)),
        env: None,
        cwd: None,
    })
}

/// Ends the Linux side of a sign-in inside WSL that [`wsl_sign_in`]
/// started (this Desk's, or one a Desk closed earlier left running), so a
/// stale one can't take the browser's answer. Nothing outside WSL.
pub fn stop_sign_in(backend: &Backend, program: &str, marker: &str) {
    if let Host::Wsl(w) = &backend.host {
        let _ = deadline::succeeds(
            backend
                .host
                .login_invocation(&stop_script(w, program, marker))
                .command(),
            WSL_CHECK,
        );
    }
}

/// An installer's script run by bash as the person (`pipefail` needs bash).
pub fn installer(backend: &Backend, script: &str) -> Result<Cli> {
    match &backend.host {
        Host::Native => native::installer(script),
        Host::Ssh(m) => eyre::bail!("Desk installs nothing on {} from here", m.name),
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
        Host::Ssh(m) => eyre::bail!("{} keeps its own files", m.name),
        Host::Wsl(w) => {
            let there = format!("{}/{name}", w.root());
            let q = quote(&there);
            let made = deadline::succeeds(
                backend
                    .host
                    .login_invocation(&format!("rm -rf {q} && mkdir -m 700 -p {q}"))
                    .command(),
                WSL_CHECK,
            );
            if !made {
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
    fn a_sign_in_inside_wsl_runs_on_linuxs_own_terminal_with_no_browser_there() {
        let Host::Wsl(w) = wsl().host else {
            unreachable!()
        };
        let script = sign_in_script(&w, "claude", &["setup-token"]);
        assert!(script.starts_with("PATH=\"$PATH:$HOME/.local/bin\"; "));
        assert!(script.contains("echo $$ >'/home/sarah/.local/share/Desk/claude-sign-in.pid'"));
        assert!(script.contains("BROWSER=true; export BROWSER;"));
        assert!(script.contains(
            r#"exec script -q -e -f -c 'stty cols 1000 rows 50 2>/dev/null; exec '\''claude'\'' '\''setup-token'\''' /dev/null"#
        ));
        // Through wsl.exe in the person's home, as a login shell.
        let i = wsl().host.login_invocation(&script);
        assert_eq!(i.program, PathBuf::from("wsl.exe"));
        assert_eq!(
            i.args[..6],
            ["-d", "Ubuntu", "--cd", "/home/sarah", "--exec", "/bin/sh"]
        );
        assert_eq!(i.args[6..], ["-lc".to_string(), script]);
    }

    #[test]
    fn stopping_a_sign_in_ends_only_the_process_it_recorded() {
        let Host::Wsl(w) = wsl().host else {
            unreachable!()
        };
        let stop = stop_script(&w, "claude", "setup-token");
        assert!(stop.starts_with("f='/home/sarah/.local/share/Desk/claude-sign-in.pid';"));
        assert!(stop.contains(r#"grep -qaF -- 'setup-token' /proc/"$p"/cmdline"#));
        assert!(stop.contains(r#"pkill -TERM -P "$p""#));
    }

    /// The scripts as WSL runs them, on this Linux: a stand-in `claude` that
    /// needs a terminal, shows a page and a prompt, and prints a token made
    /// from the code it's given.
    #[cfg(target_os = "linux")]
    mod on_linux {
        use super::*;
        use std::io::{Read, Write};
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        fn home(fake: &str) -> (tempfile::TempDir, Wsl) {
            use std::os::unix::fs::PermissionsExt;
            let dir = tempfile::tempdir().unwrap();
            let bin = dir.path().join(".local/bin");
            std::fs::create_dir_all(&bin).unwrap();
            std::fs::write(bin.join("claude"), fake).unwrap();
            std::fs::set_permissions(bin.join("claude"), std::fs::Permissions::from_mode(0o755))
                .unwrap();
            let w = Wsl {
                distro: "Ubuntu".into(),
                user: "sarah".into(),
                home: dir.path().to_string_lossy().into_owned(),
                automount: "/mnt/".into(),
            };
            (dir, w)
        }

        fn sh(w: &Wsl, script: &str) -> Command {
            let mut c = Command::new("/bin/sh");
            c.args(["-c", script])
                .env("HOME", &w.home)
                .env_remove("BROWSER");
            c
        }

        fn has_script() -> bool {
            Command::new("script")
                .arg("--version")
                .output()
                .is_ok_and(|o| o.status.success())
        }

        /// Reads until `want` is shown.
        fn read_until(stdout: &mut impl Read, want: &str) -> String {
            let (mut text, mut buf, start) = (String::new(), [0u8; 4096], Instant::now());
            while !text.contains(want) {
                let n = stdout.read(&mut buf).unwrap();
                assert!(n > 0 && start.elapsed() < Duration::from_secs(20), "{text}");
                text.push_str(&crate::logins::scan::plain(&String::from_utf8_lossy(
                    &buf[..n],
                )));
            }
            text
        }

        const FAKE: &str = "#!/bin/sh\n\
            [ -t 0 ] && [ -t 1 ] || { echo 'not a terminal'; exit 9; }\n\
            echo \"cols=$(stty size | cut -d' ' -f2) browser=$BROWSER\"\n\
            echo 'https://claude.ai/oauth/authorize?code=true'\n\
            printf 'Paste code here if prompted > '\n\
            read code\n\
            echo \"sk-ant-oat01-$code-0123456789012345678901234567890123456789\"\n";

        #[test]
        fn the_cli_gets_a_terminal_and_the_code_and_prints_its_token() {
            if !has_script() {
                eprintln!("no util-linux script here; skipped");
                return;
            }
            let (_dir, w) = home(FAKE);
            let mut child = sh(&w, &sign_in_script(&w, "claude", &["setup-token"]))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let mut stdin = child.stdin.take().unwrap();
            let mut stdout = child.stdout.take().unwrap();
            let text = read_until(&mut stdout, "Paste code");
            assert!(text.contains("cols=1000 browser=true"), "{text}");
            let pid = std::fs::read_to_string(format!("{}/claude-sign-in.pid", w.root())).unwrap();
            assert_eq!(pid.trim(), child.id().to_string());
            stdin.write_all(b"abc\r").unwrap();
            stdin.flush().unwrap();
            let rest = read_until(&mut stdout, "0123456789\n");
            assert!(rest.contains("sk-ant-oat01-abc-0123456789"), "{rest}");
            assert!(child.wait().unwrap().success());
        }

        #[test]
        fn a_sign_in_left_waiting_is_ended_through_its_pidfile() {
            if !has_script() {
                eprintln!("no util-linux script here; skipped");
                return;
            }
            let (_dir, w) = home(FAKE);
            let mut child = sh(&w, &sign_in_script(&w, "claude", &["setup-token"]))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let mut stdout = child.stdout.take().unwrap();
            read_until(&mut stdout, "Paste code");
            // A pidfile naming something else is left alone.
            let pidfile = format!("{}/claude-sign-in.pid", w.root());
            let real = std::fs::read_to_string(&pidfile).unwrap();
            std::fs::write(&pidfile, "1\n").unwrap();
            let stop = stop_script(&w, "claude", "setup-token");
            assert!(sh(&w, &stop).status().unwrap().success());
            std::thread::sleep(Duration::from_millis(300));
            assert!(child.try_wait().unwrap().is_none());
            std::fs::write(&pidfile, real).unwrap();
            let start = Instant::now();
            assert!(sh(&w, &stop).status().unwrap().success());
            let _ = child.wait();
            assert!(start.elapsed() < Duration::from_secs(10));
            assert!(!std::path::Path::new(&pidfile).exists());
        }
    }

    #[test]
    fn a_cli_inside_wsl_finds_local_bin_and_gets_its_variables_quoted() {
        assert_eq!(
            wsl_script("exec 'codex' 'login'"),
            "PATH=\"$PATH:$HOME/.local/bin\"; exec 'codex' 'login'"
        );
    }
}
