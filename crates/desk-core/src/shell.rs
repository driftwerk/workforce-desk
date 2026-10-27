//! The environment a terminal would have. launchd and Finder start Desk's
//! processes with almost none of it, so `claude`, `codex`, nvm and Homebrew
//! wouldn't be found.

use std::collections::BTreeMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MARKER: &str = "__DESK_ENV__";
const TIMEOUT: Duration = Duration::from_secs(20);

/// The login shell's environment, or this process's own when the shell
/// can't be read in time.
pub fn login_env() -> BTreeMap<String, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    read(&shell).unwrap_or_else(|| std::env::vars().collect())
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
}
