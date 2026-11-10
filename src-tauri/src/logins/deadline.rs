//! Running a program with a deadline: past it the program, and what it
//! started, are killed, so nothing waits on a network that never answers.

use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Makes `command`'s program the head of its own group, so its whole tree
/// can be killed together (on Unix; Windows kills the tree by pid).
pub fn isolate(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(not(unix))]
    let _ = command;
}

/// Kills the child and what it started. On Windows that is the Windows
/// process tree only: what `wsl.exe` runs inside Linux isn't part of it and
/// is ended inside WSL (see `cli::stop_sign_in`).
pub fn kill_tree(child: &mut Child) {
    let pid = child.id().to_string();
    #[cfg(unix)]
    let _ = Command::new("kill")
        .args(["-KILL", "--", &format!("-{pid}")])
        .stderr(Stdio::null())
        .status();
    #[cfg(not(unix))]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

/// Waits for the child, killing it at `deadline`; whether it was killed.
pub fn wait(
    child: &mut Child,
    deadline: Duration,
) -> (std::io::Result<std::process::ExitStatus>, bool) {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return (Ok(status), false),
            Err(e) => return (Err(e), false),
            Ok(None) => {}
        }
        if start.elapsed() >= deadline {
            kill_tree(child);
            return (child.wait(), true);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Whether `command` ran and succeeded within `deadline`, with nothing
/// connected to its stdin, stdout or stderr.
pub fn succeeds(mut command: Command, deadline: Duration) -> bool {
    isolate(&mut command);
    let Ok(mut child) = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    match wait(&mut child, deadline) {
        (Ok(status), false) => status.success(),
        _ => false,
    }
}

/// What `command` printed on stdout, or `None` when it couldn't start or
/// didn't end within `deadline`.
pub fn capture(mut command: Command, deadline: Duration) -> Option<String> {
    isolate(&mut command);
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    });
    let (_, killed) = wait(&mut child, deadline);
    if killed {
        // The pipe may be held open by a straggler; don't wait on it.
        return None;
    }
    let out = reader.join().ok()?;
    Some(String::from_utf8_lossy(&out).into_owned())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn sh(script: &str) -> Command {
        let mut c = Command::new("/bin/sh");
        c.args(["-c", script]);
        c
    }

    #[test]
    fn a_command_that_outlasts_its_deadline_is_killed() {
        let start = Instant::now();
        assert_eq!(capture(sh("sleep 30"), Duration::from_millis(300)), None);
        assert!(start.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn success_is_said_only_for_a_command_that_ends_well_in_time() {
        assert!(succeeds(sh("exit 0"), Duration::from_secs(10)));
        assert!(!succeeds(sh("exit 3"), Duration::from_secs(10)));
        assert!(!succeeds(sh("sleep 30"), Duration::from_millis(300)));
    }

    #[test]
    fn a_command_that_ends_in_time_gives_its_output() {
        assert_eq!(
            capture(sh("echo hi"), Duration::from_secs(10)).as_deref(),
            Some("hi\n")
        );
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    /// `cmd` starts `ping`, which holds the output pipe: killing the tree
    /// ends both, so the pipe closes at once instead of in 30 s.
    #[test]
    fn killing_the_tree_ends_what_the_child_started() {
        use std::os::windows::process::CommandExt;
        let mut child = Command::new("cmd")
            .args(["/c", "ping -n 30 127.0.0.1"])
            .creation_flags(0x0800_0000)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut stdout = child.stdout.take().unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        let start = Instant::now();
        kill_tree(&mut child);
        let _ = child.wait();
        let mut sink = Vec::new();
        let _ = stdout.read_to_end(&mut sink);
        assert!(start.elapsed() < Duration::from_secs(10));
    }
}
