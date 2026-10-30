//! The environment a terminal would have. launchd, systemd and the desktop
//! start Desk's processes with almost none of it, so `claude`, `codex`, nvm
//! and Homebrew wouldn't be found.

use std::collections::BTreeMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MARKER: &str = "__DESK_ENV__";
const TIMEOUT: Duration = Duration::from_secs(20);

/// The login shell's environment, or this process's own when the shell
/// can't be read in time.
pub fn login_env() -> BTreeMap<String, String> {
    let shell = login_shell(
        std::env::var("SHELL").ok().as_deref(),
        account_shell().as_deref(),
        |p| std::path::Path::new(p).is_file(),
    );
    read(&shell).unwrap_or_else(|| std::env::vars().collect())
}

/// The shell when neither `$SHELL` nor the account names one.
const FALLBACK_SHELL: &str = if cfg!(target_os = "macos") {
    "/bin/zsh"
} else {
    "/bin/sh"
};

/// The person's login shell: `$SHELL` when it is a file, else the one their
/// account names, else the system's own.
pub fn login_shell(
    shell: Option<&str>,
    account: Option<&str>,
    is_file: impl Fn(&str) -> bool,
) -> String {
    [shell, account]
        .into_iter()
        .flatten()
        .find(|s| is_file(s))
        .unwrap_or(FALLBACK_SHELL)
        .to_string()
}

/// The shell in a `getent passwd` line (its last field).
pub fn passwd_shell(line: &str) -> Option<String> {
    let shell = line.trim().split(':').nth(6)?.trim();
    (!shell.is_empty()).then(|| shell.to_string())
}

/// The shell in `dscl . -read /Users/<user> UserShell`'s answer.
pub fn dscl_shell(text: &str) -> Option<String> {
    let shell = text.trim().strip_prefix("UserShell:")?.trim();
    (!shell.is_empty()).then(|| shell.to_string())
}

/// The shell the person's account names.
fn account_shell() -> Option<String> {
    let user = std::env::var("USER").ok()?;
    let read = |program: &str, args: &[&str]| {
        let out = Command::new(program).args(args).output().ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    };
    if cfg!(target_os = "macos") {
        read(
            "dscl",
            &[".", "-read", &format!("/Users/{user}"), "UserShell"],
        )
        .and_then(|t| dscl_shell(&t))
    } else {
        read("getent", &["passwd", &user]).and_then(|t| passwd_shell(&t))
    }
}

fn read(shell: &str) -> Option<BTreeMap<String, String>> {
    let script = format!("printf '\\0{MARKER}\\0'; env -0");
    let mut child = Command::new(shell)
        .args(["-l", "-i", "-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let started = Instant::now();
    loop {
        if child.try_wait().ok()?.is_some() {
            break;
        }
        if started.elapsed() > TIMEOUT {
            let _ = child.kill();
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let mut out = Vec::new();
    child.stdout.take()?.read_to_end(&mut out).ok()?;
    parse_env(&out)
}

/// The variables after the marker, so whatever a shell profile prints first
/// is ignored.
pub fn parse_env(raw: &[u8]) -> Option<BTreeMap<String, String>> {
    let text = String::from_utf8_lossy(raw);
    let (_, after) = text.split_once(&format!("\0{MARKER}\0"))?;
    Some(
        after
            .split('\0')
            .filter_map(|kv| kv.split_once('='))
            .filter(|(k, _)| !k.is_empty())
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    )
}

/// An environment for running `claude` or `codex` on the person's behalf:
/// nothing a parent Claude Code session leaked into it.
pub fn without_claude_markers(env: BTreeMap<String, String>) -> BTreeMap<String, String> {
    env.into_iter()
        .filter(|(k, _)| !k.starts_with("CLAUDE"))
        .collect()
}

/// A program's full path on `env`'s PATH.
pub fn which(program: &str, env: &BTreeMap<String, String>) -> Option<std::path::PathBuf> {
    env.get("PATH")?
        .split(':')
        .map(|dir| std::path::Path::new(dir).join(program))
        .find(|p| p.is_file())
}

/// Where the official Claude Code and Codex installers put their
/// launchers: `~/.local/bin`, which a login shell may not have on PATH until
/// a new terminal opens.
pub fn local_bin(env: &BTreeMap<String, String>) -> Option<std::path::PathBuf> {
    Some(std::path::Path::new(env.get("HOME")?).join(".local/bin"))
}

/// `env` with `~/.local/bin` at the end of PATH when it isn't there, so a
/// CLI installed while Desk runs is found without a restart.
pub fn with_local_bin(mut env: BTreeMap<String, String>) -> BTreeMap<String, String> {
    if let Some(dir) = local_bin(&env) {
        let dir = dir.to_string_lossy().into_owned();
        let path = env.get("PATH").cloned().unwrap_or_default();
        if !path.split(':').any(|d| d == dir) {
            let joined = if path.is_empty() {
                dir
            } else {
                format!("{path}:{dir}")
            };
            env.insert("PATH".into(), joined);
        }
    }
    env
}

/// A program on `env`'s PATH or in `~/.local/bin`.
pub fn find_program(program: &str, env: &BTreeMap<String, String>) -> Option<std::path::PathBuf> {
    which(program, &with_local_bin(env.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_env_is_read_after_the_marker_so_shell_noise_is_ignored() {
        let raw =
            b"Welcome!\n\0__DESK_ENV__\0PATH=/opt/homebrew/bin:/usr/bin\0HOME=/Users/k\0EQ=a=b\0";
        let env = parse_env(raw).unwrap();
        assert_eq!(env["PATH"], "/opt/homebrew/bin:/usr/bin");
        assert_eq!(env["EQ"], "a=b");
        assert_eq!(env.len(), 3);
        assert!(parse_env(b"no marker").is_none());
    }

    #[test]
    fn the_login_shell_is_shell_then_the_accounts_then_the_systems() {
        let exists = |p: &str| ["/bin/zsh", "/usr/bin/fish"].contains(&p);
        assert_eq!(
            login_shell(Some("/usr/bin/fish"), Some("/bin/zsh"), exists),
            "/usr/bin/fish"
        );
        assert_eq!(
            login_shell(Some("/gone/bash"), Some("/bin/zsh"), exists),
            "/bin/zsh"
        );
        assert_eq!(login_shell(None, Some("/gone"), exists), FALLBACK_SHELL);
        assert_eq!(
            passwd_shell("sarah:x:1000:1000:Sarah Lee:/home/sarah:/usr/bin/fish\n").as_deref(),
            Some("/usr/bin/fish")
        );
        assert_eq!(passwd_shell("sarah:x:1000:1000::/home/sarah:"), None);
        assert_eq!(
            dscl_shell("UserShell: /bin/zsh\n").as_deref(),
            Some("/bin/zsh")
        );
        assert_eq!(dscl_shell("No such key: UserShell"), None);
    }

    #[test]
    fn programs_are_found_on_the_given_path_and_claude_markers_dropped() {
        let env = BTreeMap::from([
            ("PATH".to_string(), "/nope:/bin".to_string()),
            ("CLAUDE_CODE_CHILD_SESSION".to_string(), "1".to_string()),
        ]);
        assert_eq!(
            which("sh", &env).as_deref(),
            Some(std::path::Path::new("/bin/sh"))
        );
        assert!(which("no-such-program-desk", &env).is_none());
        assert!(
            !without_claude_markers(env)
                .keys()
                .any(|k| k.starts_with("CLAUDE"))
        );
    }

    #[test]
    fn a_cli_in_local_bin_is_found_off_path() {
        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join(".local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("codex"), "").unwrap();
        let env = BTreeMap::from([
            ("PATH".to_string(), "/usr/bin".to_string()),
            (
                "HOME".to_string(),
                home.path().to_string_lossy().into_owned(),
            ),
        ]);
        assert_eq!(find_program("codex", &env), Some(bin.join("codex")));
        let path = with_local_bin(env)["PATH"].clone();
        assert_eq!(path, format!("/usr/bin:{}", bin.display()));
        let again = with_local_bin(BTreeMap::from([
            ("PATH".to_string(), path.clone()),
            (
                "HOME".to_string(),
                home.path().to_string_lossy().into_owned(),
            ),
        ]));
        assert_eq!(again["PATH"], path);
    }
}
