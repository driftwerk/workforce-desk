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
    fn process_one_and_none_are_never_signalled() {
        assert!(terminate(1).is_err());
        assert!(kill(0).is_err());
    }
}
