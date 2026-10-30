//! What Desk Helper does when asked rather than run: the app (on Windows,
//! through WSL) stops it, asks how to reach the hub, checks it can run, or
//! removes everything it keeps.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::{Duration, Instant};

use desk_core::host::Host;
use desk_core::{Paths, Secrets, backend, process};
use eyre::{Context, Result};
use serde::Serialize;

/// What the helper was started to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    /// Keep the hub running (no arguments, or `--workforce` / `--memory`).
    Run,
    Stop,
    Connection,
    RemoveEverything,
    Check,
}

impl Command {
    pub fn parse(args: &[String]) -> Result<Command> {
        let has = |flag: &str| args.iter().any(|a| a == flag);
        Ok(match args.first().map(String::as_str) {
            Some("connection") if has("--json") => Command::Connection,
            Some("connection") => eyre::bail!("connection only answers --json"),
            _ if has("--stop") => Command::Stop,
            _ if has("--remove-everything") => Command::RemoveEverything,
            _ if has("--check") => Command::Check,
            _ => Command::Run,
        })
    }
}

/// The process id in the helper's pid file, while that process is this
/// program (a pid left by one that crashed could name another by now).
fn running_helper(paths: &Paths) -> Option<u32> {
    let pid: u32 = std::fs::read_to_string(paths.helper_pid())
        .ok()?
        .trim()
        .parse()
        .ok()?;
    let name = std::env::current_exe()
        .ok()?
        .file_name()?
        .to_string_lossy()
        .into_owned();
    process::command_of(pid)
        .filter(|comm| process::is_program(comm, &name))
        .map(|_| pid)
}

/// How long a running helper gets to stop the hub, the memory store and
/// Postgres.
const STOP_WITHIN: Duration = Duration::from_secs(90);

/// `--stop`: signals the running helper and waits for it to go.
pub fn stop(paths: &Paths) -> Result<()> {
    let Some(pid) = running_helper(paths) else {
        return Ok(());
    };
    process::terminate(pid).context("stopping Desk Helper")?;
    let deadline = Instant::now() + STOP_WITHIN;
    while running_helper(paths) == Some(pid) {
        if Instant::now() > deadline {
            eyre::bail!("Desk Helper (process {pid}) is still running");
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Ok(())
}

/// `connection --json`: how to reach the hub, or `null` until it is set up.
pub fn connection(paths: &Paths, env: &BTreeMap<String, String>) -> Result<String> {
    let secrets = Secrets::for_host(paths, &Host::running_here(env))?;
    Ok(serde_json::to_string(&backend::read_connection(
        paths, &secrets,
    )?)?)
}

/// `--remove-everything`: ends the PTY holder (and the hub's terminals),
/// forgets the backend's secrets and deletes its folder. Refused while the
/// helper runs.
pub fn remove_everything(paths: &Paths, env: &BTreeMap<String, String>) -> Result<()> {
    if let Some(pid) = running_helper(paths) {
        eyre::bail!("Desk Helper (process {pid}) is still running; stop it first");
    }
    backend::remove_everything(paths, &Secrets::for_host(paths, &Host::running_here(env))?)
}

/// `--check`: whether the backend can run here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Check {
    pub ok: bool,
    /// The C library's version on Linux with glibc.
    pub glibc: Option<String>,
    pub arch: String,
    /// Whether a port can be opened on 127.0.0.1.
    pub loopback: bool,
    /// Whether Desk's folder is on a Linux filesystem, not a Windows drive
    /// WSL mounts (where Postgres and the PTY holder can't work).
    pub root_on_ext4: bool,
}

impl Check {
    pub fn of(glibc: Option<String>, arch: &str, loopback: bool, root_on_ext4: bool) -> Check {
        let ok = glibc.as_deref().is_none_or(backend::glibc_supported)
            && matches!(arch, "x86_64" | "aarch64")
            && loopback
            && root_on_ext4;
        Check {
            ok,
            glibc,
            arch: arch.into(),
            loopback,
            root_on_ext4,
        }
    }
}

/// The 9p filesystem WSL 2 mounts Windows drives with.
const V9FS_MAGIC: i64 = 0x0102_1997;

/// Whether `root` is on a Windows drive: under WSL's mounts, or on 9p.
pub fn on_windows_drive(root: &Path, filesystem: Option<i64>) -> bool {
    root.starts_with(desk_core::host::DEFAULT_AUTOMOUNT) || filesystem == Some(V9FS_MAGIC)
}

#[cfg(target_os = "linux")]
fn filesystem(path: &Path) -> Option<i64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut fs = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: a NUL-terminated path and a buffer statfs fills.
    let found = unsafe { libc::statfs(path.as_ptr(), fs.as_mut_ptr()) } == 0;
    // SAFETY: statfs filled it.
    found.then(|| i64::from(unsafe { fs.assume_init() }.f_type))
}

#[cfg(not(target_os = "linux"))]
fn filesystem(_: &Path) -> Option<i64> {
    None
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn glibc() -> Option<String> {
    // SAFETY: returns a static NUL-terminated string.
    let v = unsafe { std::ffi::CStr::from_ptr(libc::gnu_get_libc_version()) };
    Some(v.to_string_lossy().into_owned())
}

#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
fn glibc() -> Option<String> {
    None
}

/// Whether Desk's folder (or the nearest folder of it that exists) is on
/// a Windows drive.
pub fn root_on_windows_drive(root: &Path) -> bool {
    let existing = root.ancestors().find(|p| p.exists()).unwrap_or(root);
    on_windows_drive(root, filesystem(existing))
}

pub fn check(paths: &Paths) -> Check {
    Check::of(
        glibc(),
        std::env::consts::ARCH,
        std::net::TcpListener::bind("127.0.0.1:0").is_ok(),
        !root_on_windows_drive(&paths.root),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn each_command_is_read_from_its_arguments() {
        assert_eq!(Command::parse(&args(&[])).unwrap(), Command::Run);
        assert_eq!(
            Command::parse(&args(&["--workforce", "/x/workforce"])).unwrap(),
            Command::Run
        );
        assert_eq!(Command::parse(&args(&["--stop"])).unwrap(), Command::Stop);
        assert_eq!(
            Command::parse(&args(&["connection", "--json"])).unwrap(),
            Command::Connection
        );
        assert!(Command::parse(&args(&["connection"])).is_err());
        assert_eq!(
            Command::parse(&args(&["--remove-everything"])).unwrap(),
            Command::RemoveEverything
        );
        assert_eq!(Command::parse(&args(&["--check"])).unwrap(), Command::Check);
    }

    #[test]
    fn a_check_passes_only_when_everything_does() {
        let good = Check::of(Some("2.39".into()), "x86_64", true, true);
        assert!(good.ok);
        assert_eq!(
            serde_json::to_value(&good).unwrap(),
            serde_json::json!({"ok": true, "glibc": "2.39", "arch": "x86_64", "loopback": true, "root_on_ext4": true})
        );
        assert!(Check::of(None, "aarch64", true, true).ok);
        assert!(!Check::of(Some("2.31".into()), "x86_64", true, true).ok);
        assert!(!Check::of(Some("2.39".into()), "riscv64", true, true).ok);
        assert!(!Check::of(Some("2.39".into()), "x86_64", false, true).ok);
        assert!(!Check::of(Some("2.39".into()), "x86_64", true, false).ok);
    }

    #[test]
    fn a_folder_on_a_windows_drive_is_found() {
        assert!(on_windows_drive(
            Path::new("/mnt/c/Users/sarah/Desk"),
            Some(0xEF53)
        ));
        assert!(on_windows_drive(Path::new("/data/Desk"), Some(V9FS_MAGIC)));
        assert!(!on_windows_drive(
            Path::new("/home/sarah/.local/share/Desk"),
            Some(0xEF53)
        ));
        assert!(!on_windows_drive(Path::new("/home/sarah/Desk"), None));
    }

    #[test]
    fn this_computer_passes_its_own_check() {
        let dir = tempfile::tempdir().unwrap();
        let check = check(&Paths::at(dir.path().join("Desk")));
        assert!(check.loopback && check.root_on_ext4, "{check:?}");
    }

    #[test]
    fn nothing_running_is_nothing_to_stop() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        stop(&paths).unwrap();
        std::fs::create_dir_all(paths.helper_pid().parent().unwrap()).unwrap();
        // A pid left behind that names some other process is never signalled.
        let mut other = std::process::Command::new("sleep")
            .arg("60")
            .spawn()
            .unwrap();
        std::fs::write(paths.helper_pid(), other.id().to_string()).unwrap();
        stop(&paths).unwrap();
        assert!(other.try_wait().unwrap().is_none());
        let _ = other.kill();
    }

    #[test]
    fn removing_everything_takes_the_folder_and_the_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path().join("Desk"));
        let secrets = Secrets::of(&paths, desk_core::KeyStore::File);
        desk_core::SecretStore::get_or_create(&secrets, desk_core::Secret::GatewayToken).unwrap();
        std::fs::create_dir_all(paths.logs()).unwrap();
        let wsl = BTreeMap::from([("WSL_DISTRO_NAME".to_string(), "Ubuntu".to_string())]);
        remove_everything(&paths, &wsl).unwrap();
        assert!(!paths.root.exists());
        remove_everything(&paths, &wsl).unwrap();
    }

    #[test]
    fn the_connection_is_null_until_the_hub_is_set_up() {
        let dir = tempfile::tempdir().unwrap();
        let wsl = BTreeMap::from([("WSL_DISTRO_NAME".to_string(), "Ubuntu".to_string())]);
        assert_eq!(connection(&Paths::at(dir.path()), &wsl).unwrap(), "null");
    }
}
