//! The PTY holder (`workforce pty-holder`): a small process that owns the
//! local hub's terminals and Claude Code sessions, so they outlive the hub
//! restarting and Desk being updated. Desk Helper starts it before the hub
//! and leaves it running; removing Desk's data stops it.

use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use eyre::{Context, Result};

use crate::Paths;

/// The holder protocol the bundled hub speaks (its `holder::PROTOCOL_VERSION`).
/// A running holder that speaks another is replaced.
pub const PROTOCOL: u32 = 1;
/// The variable the holder reads its token from.
pub const TOKEN_ENV: &str = "WORKFORCE_PTY_HOLDER_TOKEN";
/// macOS keeps a unix socket's path in 104 bytes, its NUL included.
const MAX_SOCKET: usize = 103;

impl Paths {
    /// The holder's socket: `hub/run/pty.sock`, or, when that path is too
    /// long for a unix socket (a development `DESK_HOME` deep in a temporary
    /// folder), one under `$TMPDIR` named for this Desk folder.
    pub fn pty_socket(&self) -> PathBuf {
        // SAFETY: getuid has no preconditions.
        let uid = unsafe { libc::getuid() };
        socket_path(&self.hub(), &self.root, &std::env::temp_dir(), uid)
    }
}

fn socket_path(hub: &Path, root: &Path, tmp: &Path, uid: u32) -> PathBuf {
    let preferred = hub.join("run").join("pty.sock");
    if preferred.as_os_str().len() <= MAX_SOCKET {
        return preferred;
    }
    // Named for the folder, so two Desk folders never share a holder.
    tmp.join(format!(
        "desk-{uid}-{:08x}",
        fnv32(root.as_os_str().as_encoded_bytes())
    ))
    .join("pty.sock")
}

/// FNV-1a: the same on every build, unlike std's hasher.
fn fnv32(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0x811c_9dc5, |h: u32, b| {
        (h ^ u32::from(*b)).wrapping_mul(0x0100_0193)
    })
}

/// Where the holder serving `socket` writes its process id.
pub fn pid_file(socket: &Path) -> PathBuf {
    socket.with_extension("pid")
}

/// Whether a holder is listening at `socket`.
pub fn answers(socket: &Path) -> bool {
    UnixStream::connect(socket).is_ok()
}

/// Stops the holder at `socket` (SIGTERM, which ends its terminals) and
/// waits up to `within` for it to go. `Ok(false)` when none was running.
/// The pid file is trusted only while the socket answers: one left by a
/// holder that crashed could name another process by now.
pub fn stop(socket: &Path, within: Duration) -> Result<bool> {
    if !answers(socket) {
        return Ok(false);
    }
    let path = pid_file(socket);
    let pid: i32 = std::fs::read_to_string(&path)
        .with_context(|| format!("reading {}", path.display()))?
        .trim()
        .parse()
        .with_context(|| format!("reading {}", path.display()))?;
    if pid <= 1 {
        eyre::bail!("{} names process {pid}", path.display());
    }
    // SAFETY: kill has no memory preconditions.
    if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
        let e = std::io::Error::last_os_error();
        if e.raw_os_error() != Some(libc::ESRCH) {
            return Err(e).context("stopping the PTY holder");
        }
    }
    let deadline = Instant::now() + within;
    while answers(socket) {
        if Instant::now() > deadline {
            eyre::bail!("the PTY holder (process {pid}) is still running");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_socket_is_under_the_hub_folder_when_it_fits() {
        let root = Path::new("/Users/someone/Library/Application Support/Desk");
        let p = socket_path(&root.join("hub"), root, Path::new("/tmp"), 501);
        assert_eq!(
            p,
            Path::new("/Users/someone/Library/Application Support/Desk/hub/run/pty.sock")
        );
    }

    #[test]
    fn a_long_folder_puts_the_socket_in_tmp_named_for_it() {
        let long = |n: &str| PathBuf::from(format!("/private/tmp/{}/{n}", "x".repeat(90)));
        let tmp = Path::new("/var/folders/ab/T");
        let a = socket_path(&long("a").join("hub"), &long("a"), tmp, 501);
        let b = socket_path(&long("b").join("hub"), &long("b"), tmp, 501);
        assert!(
            a.starts_with("/var/folders/ab/T") && a.ends_with("pty.sock"),
            "{a:?}"
        );
        assert!(a.parent().unwrap().to_string_lossy().contains("desk-501-"));
        assert_ne!(a, b);
        assert_eq!(a, socket_path(&long("a").join("hub"), &long("a"), tmp, 501));
        assert!(a.as_os_str().len() <= MAX_SOCKET);
    }

    #[test]
    fn nothing_listening_is_nothing_to_stop() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("pty.sock");
        // A stale pid file is never acted on.
        std::fs::write(pid_file(&socket), "1\n").unwrap();
        assert!(!stop(&socket, Duration::from_millis(10)).unwrap());
    }

    #[test]
    fn a_listening_holder_is_sent_sigterm() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("pty.sock");
        // A stand-in holder: a child that listens until it is terminated.
        let mut child = std::process::Command::new("/usr/bin/python3")
            .args([
                "-c",
                "import socket,sys,time\n\
                 s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.listen()\n\
                 time.sleep(60)",
            ])
            .arg(&socket)
            .spawn()
            .unwrap();
        let start = Instant::now();
        while !answers(&socket) && start.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(20));
        }
        std::fs::write(pid_file(&socket), format!("{}\n", child.id())).unwrap();
        // The stand-in leaves its socket file behind, but nothing answers.
        assert!(stop(&socket, Duration::from_secs(10)).unwrap());
        assert!(child.wait().unwrap().code().is_none());
    }
}
