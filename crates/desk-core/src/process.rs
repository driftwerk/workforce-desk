//! Other processes by id: whether one runs, what it is, and stopping it.

use std::io;

fn signal(pid: u32, signal: libc::c_int) -> io::Result<()> {
    let pid = libc::pid_t::try_from(pid)
        .ok()
        .filter(|&p| p > 1)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, format!("process {pid}")))?;
    // SAFETY: kill has no memory preconditions.
    if unsafe { libc::kill(pid, signal) } == 0 {
        return Ok(());
    }
    let e = io::Error::last_os_error();
    match e.raw_os_error() {
        Some(libc::ESRCH) => Ok(()),
        _ => Err(e),
    }
}

/// Asks process `pid` to stop (SIGTERM). One already gone is no error.
pub fn terminate(pid: u32) -> io::Result<()> {
    signal(pid, libc::SIGTERM)
}

/// Stops process `pid` at once (SIGKILL). One already gone is no error.
pub fn kill(pid: u32) -> io::Result<()> {
    signal(pid, libc::SIGKILL)
}

/// Asks process `pid` to stop at once, as it would on Ctrl-C (SIGINT):
/// Postgres's fast shutdown. One already gone is no error.
pub fn interrupt(pid: u32) -> io::Result<()> {
    signal(pid, libc::SIGINT)
}

/// Process `pid`'s whole command line, its arguments joined by spaces;
/// none when nothing runs as `pid`.
pub fn args_of(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
        let args: Vec<_> = raw
            .split(|&b| b == 0)
            .filter(|a| !a.is_empty())
            .map(String::from_utf8_lossy)
            .collect();
        (!args.is_empty()).then(|| args.join(" "))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let out = std::process::Command::new("ps")
            .args(["-ww", "-p", &pid.to_string(), "-o", "args="])
            .output()
            .ok()?;
        let args = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (out.status.success() && !args.is_empty()).then_some(args)
    }
}

/// The folder process `pid` runs in; none when nothing runs as `pid` (or
/// it isn't this user's).
pub fn cwd_of(pid: u32) -> Option<std::path::PathBuf> {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let out = std::process::Command::new("lsof")
            .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
            .output()
            .ok()?;
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .find_map(|l| l.strip_prefix('n'))
            .map(std::path::PathBuf::from)
    }
}

/// The command process `pid` runs (`ps`'s `comm`: the full path on macOS,
/// the name cut to 15 bytes on Linux); none when nothing runs as `pid`.
pub fn command_of(pid: u32) -> Option<String> {
    let out = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .ok()?;
    let comm = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !comm.is_empty()).then_some(comm)
}

/// Whether `comm` (from [`command_of`]) is the program named `name`.
pub fn is_program(comm: &str, name: &str) -> bool {
    let base = comm.rsplit('/').next().unwrap_or(comm);
    !name.is_empty() && (base == name || (base.len() == 15 && name.starts_with(base)))
}

/// Raises this process's soft limit on open files to `want` (or its hard
/// limit, when that is lower); the limit it has after. A GUI app on macOS
/// starts with 256, and Desk holds its hubs' sockets itself.
pub fn raise_open_files(want: libc::rlim_t) -> io::Result<libc::rlim_t> {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: getrlimit writes only the struct it is given.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let target = want.min(limit.rlim_max);
    if limit.rlim_cur >= target {
        return Ok(limit.rlim_cur);
    }
    limit.rlim_cur = target;
    // SAFETY: setrlimit reads only the struct it is given.
    if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn a_program_is_known_by_its_name_whole_or_cut_short() {
        assert!(is_program(
            "/Applications/Desk.app/Contents/MacOS/Desk Memory",
            "Desk Memory"
        ));
        assert!(is_program("desk-memory", "desk-memory"));
        assert!(is_program("a-very-long-pro", "a-very-long-program-name"));
        assert!(!is_program("bash", "desk-memory"));
        assert!(!is_program("desk-memory", ""));
    }

    #[test]
    fn a_running_child_is_found_terminated_and_gone() {
        let mut child = std::process::Command::new("sleep")
            .arg("60")
            .spawn()
            .unwrap();
        let pid = child.id();
        assert!(is_program(&command_of(pid).unwrap(), "sleep"));
        terminate(pid).unwrap();
        let start = Instant::now();
        let status = loop {
            if let Some(s) = child.try_wait().unwrap() {
                break s;
            }
            assert!(start.elapsed() < Duration::from_secs(10));
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(!status.success());
        assert_eq!(command_of(pid), None);
        terminate(pid).unwrap();
        kill(pid).unwrap();
    }

    #[test]
    fn a_process_is_known_by_its_command_line_and_folder() {
        let dir = tempfile::tempdir().unwrap();
        let dir = dir.path().canonicalize().unwrap();
        let mut child = std::process::Command::new("sh")
            .args([
                "-c",
                "sleep 60; :",
                "fake",
                "serve",
                "-c",
                "/a b/config.toml",
            ])
            .current_dir(&dir)
            .spawn()
            .unwrap();
        let pid = child.id();
        let args = args_of(pid).unwrap();
        assert!(args.contains("serve -c /a b/config.toml"), "{args}");
        assert_eq!(cwd_of(pid).unwrap().canonicalize().unwrap(), dir);
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(args_of(pid), None);
    }

    #[test]
    fn process_one_and_none_are_never_signalled() {
        assert!(terminate(1).is_err());
        assert!(interrupt(1).is_err());
        assert!(kill(0).is_err());
    }

    #[test]
    fn the_open_files_limit_is_raised_and_never_lowered() {
        let now = raise_open_files(64).unwrap();
        assert!(now >= 64);
        assert_eq!(
            raise_open_files(64).unwrap(),
            now,
            "a lower ask changes nothing"
        );
    }
}
