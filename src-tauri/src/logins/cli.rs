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

/// Where Claude Code and Codex are put inside WSL, joined onto PATH after
/// what the login shell has, as `desk_core::shell::install_dirs` does on a
/// Mac or Linux: their own installers' `~/.local/bin`, Claude Code's npm
/// folder, npm's global folder, Volta's and Homebrew on Linux's; npm's own
/// prefix only when it is absolute.
const WSL_INSTALL_PATH: &str = "PATH=\"$PATH:$HOME/.local/bin:$HOME/.claude/local:$HOME/.npm-global/bin:$HOME/.volta/bin:/home/linuxbrew/.linuxbrew/bin\"; \
     case \"${NPM_CONFIG_PREFIX:-}\" in /*) PATH=\"$PATH:$NPM_CONFIG_PREFIX/bin\" ;; esac; ";

/// A login shell's script inside WSL that finds both CLIs where their
/// installers put them ([`WSL_INSTALL_PATH`]).
fn wsl_script(body: &str) -> String {
    format!("{WSL_INSTALL_PATH}{body}")
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

/// Where one sign-in attempt inside WSL keeps its Linux process id, so
/// Cancel, the next attempt and the next Desk can end it. Each attempt has
/// its own, so ending a stale one never ends the one after it.
fn sign_in_pidfile(w: &Wsl, program: &str, attempt: &str) -> String {
    format!("{}/{program}-sign-in-{attempt}.pid", w.root())
}

/// The script that runs `program args…` inside WSL for a sign-in.
///
/// Windows gives it no console: `wsl.exe` runs over plain pipes, and
/// util-linux's `script` gives the CLI a terminal of Linux's own (wide, so
/// a token is never wrapped). A Windows pseudo-console (ConPTY) asks the
/// terminal where its cursor is and waits for the answer before it lets
/// `wsl.exe` start, so a sign-in through one stalled until Desk closed.
///
/// `BROWSER=true` makes the CLI's own attempt to open a browser a no-op
/// (Claude Code still prints the page, 3 s later): Desk opens the page on
/// Windows itself. The shell writes its pid (which `exec` hands to
/// `script`) where [`stop_sign_in`] finds it, and the command `script`
/// runs starts with this attempt's [`marker`], so only it is ever ended.
fn sign_in_script(w: &Wsl, program: &str, args: &[&str], attempt: &str) -> String {
    let words: Vec<String> = std::iter::once(program)
        .chain(args.iter().copied())
        .map(quote)
        .collect();
    let inner = format!(
        "{} stty cols 1000 rows 50 2>/dev/null; exec {}",
        marker(attempt),
        words.join(" ")
    );
    wsl_script(&format!(
        "command -v script >/dev/null || {{ echo \"Signing in needs the script command (util-linux) in {distro}: sudo apt install util-linux\" >&2; exit 127; }}; \
         mkdir -p {root} && echo $$ >{pidfile}; \
         BROWSER=true; export BROWSER; \
         exec script -q -e -f -c {inner} /dev/null",
        distro = w.distro.replace(['"', '\\', '$', '`'], ""),
        root = quote(&w.root()),
        pidfile = quote(&sign_in_pidfile(w, program, attempt)),
        inner = quote(&inner),
    ))
}

/// What the command `script` runs for `attempt` starts with: a no-op that
/// names the attempt, so a `claude setup-token` the person runs by hand is
/// never taken for Desk's.
fn marker(attempt: &str) -> String {
    format!(": desk-sign-in-{attempt};")
}

/// The script that ends sign-ins [`sign_in_script`] started that are still
/// running: `attempt`'s, or with none every one's. Only the processes their
/// pidfiles name, and only while each is still exactly that attempt's
/// `script -q -e -f -c ': desk-sign-in-<attempt>; …'` (a pid reused since,
/// or a sign-in run by hand, is left alone).
fn stop_script(w: &Wsl, program: &str, attempt: Option<&str>) -> String {
    let prefix = format!("{program}-sign-in-");
    let files = match attempt {
        Some(a) => quote(&sign_in_pidfile(w, program, a)),
        None => format!("{}/{}*.pid", quote(&w.root()), quote(&prefix)),
    };
    format!(
        "S=$(printf '\\001'); \
         for f in {files}; do [ -e \"$f\" ] || continue; \
         a=${{f##*/{prefix}}}; a=${{a%.pid}}; \
         p=$(cat \"$f\" 2>/dev/null); rm -f \"$f\"; \
         case \"$a\" in ''|*[!0-9-]*) continue;; esac; \
         case \"$p\" in ''|*[!0-9]*) continue;; esac; \
         c=$(tr '\\000' '\\001' </proc/\"$p\"/cmdline 2>/dev/null); \
         case \"$c\" in \"script${{S}}-q${{S}}-e${{S}}-f${{S}}-c${{S}}: desk-sign-in-$a;\"*) ;; *) continue;; esac; \
         pkill -TERM -P \"$p\" 2>/dev/null; kill -TERM \"$p\" 2>/dev/null; \
         done; exit 0"
    )
}

/// `program args…` for sign-in `attempt` inside WSL; see
/// [`sign_in_script`].
pub fn wsl_sign_in(backend: &Backend, program: &str, args: &[&str], attempt: &str) -> Result<Cli> {
    let Host::Wsl(w) = &backend.host else {
        eyre::bail!("not a WSL backend");
    };
    if !installed(backend, program) {
        eyre::bail!("{program} isn't installed on this computer");
    }
    Ok(Cli {
        invocation: backend
            .host
            .login_invocation(&sign_in_script(w, program, args, attempt)),
        env: None,
        cwd: None,
    })
}

/// Ends the Linux side of sign-ins inside WSL that [`wsl_sign_in`] started:
/// `attempt`'s, or with none every one still running (this Desk's, or ones
/// a Desk closed earlier left behind), so a stale one can't take the
/// browser's answer. Nothing outside WSL.
pub fn stop_sign_in(backend: &Backend, program: &str, attempt: Option<&str>) {
    if let Host::Wsl(w) = &backend.host {
        let _ = deadline::succeeds(
            backend
                .host
                .login_invocation(&stop_script(w, program, attempt))
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
        let script = sign_in_script(&w, "claude", &["setup-token"], "41-7");
        assert!(script.starts_with(WSL_INSTALL_PATH));
        assert!(
            script.contains("echo $$ >'/home/sarah/.local/share/Desk/claude-sign-in-41-7.pid'")
        );
        assert!(script.contains("BROWSER=true; export BROWSER;"));
        assert!(script.contains(
            r#"exec script -q -e -f -c ': desk-sign-in-41-7; stty cols 1000 rows 50 2>/dev/null; exec '\''claude'\'' '\''setup-token'\''' /dev/null"#
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
        let one = stop_script(&w, "claude", Some("41-7"));
        assert!(
            one.contains("for f in '/home/sarah/.local/share/Desk/claude-sign-in-41-7.pid'; do")
        );
        let every = stop_script(&w, "claude", None);
        assert!(
            every.contains("for f in '/home/sarah/.local/share/Desk'/'claude-sign-in-'*.pid; do")
        );
        let stop = one;
        assert!(stop.contains(
            r#"case "$c" in "script${S}-q${S}-e${S}-f${S}-c${S}: desk-sign-in-$a;"*) ;; *) continue;; esac;"#
        ));
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
            let mut child = sh(&w, &sign_in_script(&w, "claude", &["setup-token"], "1-0"))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let mut stdin = child.stdin.take().unwrap();
            let mut stdout = child.stdout.take().unwrap();
            let text = read_until(&mut stdout, "Paste code");
            assert!(text.contains("cols=1000 browser=true"), "{text}");
            let pid =
                std::fs::read_to_string(format!("{}/claude-sign-in-1-0.pid", w.root())).unwrap();
            assert_eq!(pid.trim(), child.id().to_string());
            stdin.write_all(b"abc\r").unwrap();
            stdin.flush().unwrap();
            let rest = read_until(&mut stdout, "0123456789\n");
            assert!(rest.contains("sk-ant-oat01-abc-0123456789"), "{rest}");
            assert!(child.wait().unwrap().success());
        }

        #[test]
        fn ending_one_attempt_leaves_the_next_and_a_sweep_ends_every_one() {
            if !has_script() {
                eprintln!("no util-linux script here; skipped");
                return;
            }
            let (_dir, w) = home(FAKE);
            let waiting = |attempt: &str| {
                let mut child = sh(&w, &sign_in_script(&w, "claude", &["setup-token"], attempt))
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap();
                let mut stdout = child.stdout.take().unwrap();
                read_until(&mut stdout, "Paste code");
                (child, stdout)
            };
            let stop = |attempt: Option<&str>| {
                assert!(
                    sh(&w, &stop_script(&w, "claude", attempt))
                        .status()
                        .unwrap()
                        .success()
                );
            };
            let ended = |child: &mut std::process::Child| {
                let start = Instant::now();
                while child.try_wait().unwrap().is_none() {
                    if start.elapsed() > Duration::from_secs(10) {
                        return false;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                true
            };
            // A sign-in the person runs by hand, even under `script`, whose
            // pid a pidfile names: never Desk's, so never ended.
            let mut by_hand = Command::new("script")
                .args(["-q", "-e", "-f", "-c", "claude setup-token", "/dev/null"])
                .env("HOME", &w.home)
                .env("PATH", format!("{}/.local/bin:/usr/bin:/bin", w.home))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let mut by_hand_out = by_hand.stdout.take().unwrap();
            read_until(&mut by_hand_out, "Paste code");
            let (mut a, _a_out) = waiting("1-1");
            let (mut b, _b_out) = waiting("1-2");
            std::fs::write(
                format!("{}/claude-sign-in-5-5.pid", w.root()),
                format!("{}\n", by_hand.id()),
            )
            .unwrap();
            // A pidfile naming something that isn't a sign-in is left alone.
            let other = format!("{}/claude-sign-in-9-9.pid", w.root());
            std::fs::write(&other, "1\n").unwrap();
            stop(Some("9-9"));
            stop(Some("1-1"));
            assert!(ended(&mut a));
            std::thread::sleep(Duration::from_millis(300));
            assert!(
                b.try_wait().unwrap().is_none(),
                "the next attempt was ended too"
            );
            // Nor is one attempt's process ended through another's pidfile.
            std::fs::write(
                format!("{}/claude-sign-in-7-7.pid", w.root()),
                format!("{}\n", b.id()),
            )
            .unwrap();
            stop(Some("7-7"));
            std::thread::sleep(Duration::from_millis(300));
            assert!(
                b.try_wait().unwrap().is_none(),
                "ended through a pidfile not its own"
            );
            std::fs::write(
                format!("{}/claude-sign-in-1-2.pid", w.root()),
                format!("{}\n", b.id()),
            )
            .unwrap();
            stop(None);
            assert!(ended(&mut b));
            std::thread::sleep(Duration::from_millis(300));
            assert!(
                by_hand.try_wait().unwrap().is_none(),
                "the hand-run sign-in was ended"
            );
            let _ = by_hand.kill();
            let _ = by_hand.wait();
            assert!(
                std::fs::read_dir(w.root()).unwrap().all(|e| !e
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".pid"))
            );
        }
    }

    #[test]
    fn a_cli_inside_wsl_finds_local_bin_and_gets_its_variables_quoted() {
        assert_eq!(
            wsl_script("exec 'codex' 'login'"),
            format!("{WSL_INSTALL_PATH}exec 'codex' 'login'")
        );
    }

    /// Run as WSL's login shell would: each install folder is found, after
    /// what PATH has, and npm's prefix only when it is absolute.
    #[cfg(unix)]
    #[test]
    fn inside_wsl_a_cli_is_found_wherever_its_installers_put_it() {
        let home = tempfile::tempdir().unwrap();
        let run = |prefix: &str| {
            let out = std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(wsl_script("printf %s \"$PATH\""))
                .env_clear()
                .env("HOME", home.path())
                .env("PATH", "/usr/bin:/bin")
                .env("NPM_CONFIG_PREFIX", prefix)
                .output()
                .unwrap();
            String::from_utf8(out.stdout).unwrap()
        };
        let h = home.path().display();
        let path = run("/opt/npm");
        assert_eq!(
            path,
            format!(
                "/usr/bin:/bin:{h}/.local/bin:{h}/.claude/local:{h}/.npm-global/bin:{h}/.volta/bin:/home/linuxbrew/.linuxbrew/bin:/opt/npm/bin"
            )
        );
        assert!(!run("npm").contains("npm/bin:") && !run("npm").ends_with(":npm/bin"));
        assert!(run("").ends_with(":/home/linuxbrew/.linuxbrew/bin"));
    }
}
