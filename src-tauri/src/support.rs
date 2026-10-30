//! Settings → Help: a report of recent logs the person can save and send,
//! and removing everything Desk keeps on this computer.

use std::io::{Read, Seek, SeekFrom, Write};
use std::net::TcpListener;
use std::path::Path;
use std::time::{Duration, Instant};

use desk_core::backend::Backend;
use desk_core::host::Host;
use desk_core::{Paths, device_token_account, read_ports};
use eyre::{Context, Result};

use crate::helper::Login;
use crate::hubs::app_secrets;

/// The logs a report carries, newest part of each: the app's own, and the
/// backend's.
const APP_LOGS: [&str; 2] = ["desk.log", "desk.log.1"];
const BACKEND_LOGS: [&str; 8] = [
    "desk-hubd.log",
    "desk-hubd.log.1",
    "hub.log",
    "hub.log.1",
    "pty-holder.log",
    "pty-holder.log.1",
    "memory.log",
    "memory.log.1",
];
const TAIL: u64 = 4 * 1024 * 1024;

/// The device tokens for remote hubs: the app's own secrets.
fn remote_accounts(paths: &Paths) -> Vec<String> {
    crate::hubs::read_records(paths)
        .unwrap_or_default()
        .iter()
        .map(|r| device_token_account(&r.id))
        .collect()
}

/// The values a log could contain verbatim, to blank exactly: the ones the
/// app reads anyway (the hub's gateway token and Desk's device tokens).
/// Desk Helper's other secrets stay unread so the keychain doesn't ask;
/// the patterns catch them by shape and by name.
pub fn known_secrets(paths: &Paths, backend: &Backend) -> Vec<String> {
    let local = backend
        .connection()
        .ok()
        .flatten()
        .map(|c| [Some(c.admin_token), c.device_token])
        .into_iter()
        .flatten()
        .flatten();
    let remote = app_secrets(paths)
        .map(|secrets| {
            remote_accounts(paths)
                .iter()
                .filter_map(|a| secrets.get_account(a).ok().flatten())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    local.chain(remote).collect()
}

/// Runs Desk Helper with `--remove-everything`: it stops the PTY holder,
/// forgets the backend's secrets (the keychain lets the binary that made
/// them delete them without asking) and deletes the backend's folder. A
/// development run, with no helper beside the app, does the same itself.
fn remove_backend(backend: &Backend) -> Result<()> {
    let beside = std::env::current_exe()?
        .parent()
        .map(|d| d.join(desk_core::HELPER_EXECUTABLE))
        .filter(|p| p.is_file());
    let invocation = match (&backend.host, beside) {
        (Host::Wsl(w), _) => backend
            .host
            .invocation(&w.helper(), &["--remove-everything"]),
        (Host::Native, Some(helper)) => backend
            .host
            .invocation(&helper.to_string_lossy(), &["--remove-everything"]),
        (Host::Native, None) => return remove_here(backend),
    };
    let out = invocation.command().output()?;
    if !out.status.success() {
        eyre::bail!(
            "Desk Helper couldn't remove what it keeps: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}

#[cfg(unix)]
fn remove_here(backend: &Backend) -> Result<()> {
    desk_core::backend::remove_everything(
        &backend.paths,
        &desk_core::Secrets::for_host(&backend.paths, &backend.host)?,
    )
}

#[cfg(not(unix))]
fn remove_here(_: &Backend) -> Result<()> {
    eyre::bail!("Desk Helper is missing from this install of Desk")
}

/// The last `max` bytes of a file, from the start of a line.
fn tail(path: &Path, max: u64) -> Result<String> {
    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(max);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    Ok(match (start > 0, text.find('\n')) {
        (true, Some(i)) => text[i + 1..].to_string(),
        _ => text,
    })
}

/// A zip of the recent logs from the app's folder and the backend's, every
/// secret — `known` values and anything shaped like one — taken out, plus
/// what was running.
pub fn write_report(
    paths: &Paths,
    backend: &Paths,
    known: &[String],
    about: &str,
    to: &Path,
) -> Result<()> {
    let file = std::fs::File::create(to).with_context(|| format!("saving {}", to.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o600);
    zip.start_file("about.txt", opts)?;
    zip.write_all(desk_core::redact::redact(about, known).as_bytes())?;
    let logs = APP_LOGS
        .iter()
        .map(|name| (paths, name))
        .chain(BACKEND_LOGS.iter().map(|name| (backend, name)));
    for (root, name) in logs {
        let path = root.logs().join(name);
        if !path.is_file() {
            continue;
        }
        let text = tail(&path, TAIL)?;
        zip.start_file(format!("logs/{name}"), opts)?;
        zip.write_all(desk_core::redact::redact(&text, known).as_bytes())?;
    }
    zip.finish()?;
    Ok(())
}

/// Waits for the hub, its Postgres and its memory store (in the backend's
/// folder `paths`) to let go of their ports.
fn wait_stopped(paths: &Paths, within: Duration) -> Result<()> {
    let Some(ports) = read_ports(&paths.hub_state())? else {
        return Ok(());
    };
    let deadline = Instant::now() + within;
    let free = |p: u16| TcpListener::bind(("127.0.0.1", p)).is_ok();
    while !(free(ports.gateway)
        && free(ports.postgres)
        && (ports.memory == 0 || free(ports.memory)))
    {
        if Instant::now() > deadline {
            eyre::bail!(
                "Desk Helper is still running. Quit it (or restart this computer) and try again."
            );
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Ok(())
}

/// Stops Desk Helper and takes it out of what starts at login; with
/// `everything`, also ends the PTY holder (and with it the hub's
/// terminals) and deletes the backend's folder and secrets, then the app's.
/// Nothing is deleted while the helper is still running.
pub fn remove(paths: &Paths, backend: &Backend, everything: bool) -> Result<()> {
    crate::helper::login(backend).unregister()?;
    if !everything {
        return Ok(());
    }
    wait_stopped(&backend.paths, Duration::from_secs(40))?;
    // Read before the backend's half: natively it shares the app's folder.
    let remote = remote_accounts(paths);
    remove_backend(backend)?;
    let secrets = app_secrets(paths)?;
    for a in remote {
        secrets.delete_account(&a)?;
    }
    match std::fs::remove_dir_all(&paths.root) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).with_context(|| format!("deleting {}", paths.root.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_report_has_the_logs_and_none_of_the_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        std::fs::create_dir_all(paths.logs()).unwrap();
        let token = "Zq8vN3xT0pL5mR7sK2wY9bC4dF6gH1jA-uE0iO";
        let key = format!("sk-ant-api03-{}", "x".repeat(30));
        std::fs::write(
            paths.logs().join("hub.log"),
            format!("INFO started\nWARN token {token} used\nkey {key}\n"),
        )
        .unwrap();
        std::fs::write(
            paths.logs().join("desk-hubd.log"),
            "INFO local hub starting\n",
        )
        .unwrap();
        let out = dir.path().join("report.zip");
        let known = vec![token.to_string()];
        write_report(&paths, &paths, &known, "Desk 0.1.0", &out).unwrap();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&out).unwrap()).unwrap();
        let names: Vec<String> = zip.file_names().map(|n| n.unwrap().into_owned()).collect();
        assert!(names.contains(&"about.txt".to_string()));
        assert!(names.contains(&"logs/hub.log".to_string()));
        assert!(names.contains(&"logs/desk-hubd.log".to_string()));
        let mut hub = String::new();
        zip.by_name("logs/hub.log")
            .unwrap()
            .read_to_string(&mut hub)
            .unwrap();
        assert!(hub.contains("INFO started"));
        assert!(!hub.contains("sk-ant") && !hub.contains(token), "{hub}");
    }

    #[test]
    fn a_report_reads_each_log_from_its_own_folder() {
        let dir = tempfile::tempdir().unwrap();
        let (app, backend) = (
            Paths::at(dir.path().join("app")),
            Paths::at(dir.path().join("wsl")),
        );
        for (root, name) in [(&app, "desk.log"), (&backend, "hub.log"), (&app, "hub.log")] {
            std::fs::create_dir_all(root.logs()).unwrap();
            std::fs::write(
                root.logs().join(name),
                format!("from {}\n", root.root.display()),
            )
            .unwrap();
        }
        let out = dir.path().join("report.zip");
        write_report(&app, &backend, &[], "Desk", &out).unwrap();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&out).unwrap()).unwrap();
        let read = |zip: &mut zip::ZipArchive<std::fs::File>, name: &str| {
            let mut text = String::new();
            zip.by_name(name)
                .unwrap()
                .read_to_string(&mut text)
                .unwrap();
            text
        };
        assert!(read(&mut zip, "logs/desk.log").contains("app"));
        assert!(read(&mut zip, "logs/hub.log").contains("wsl"));
    }

    #[test]
    fn a_long_log_is_cut_at_a_line() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("a.log");
        std::fs::write(&log, "first line\nsecond line\nthird\n").unwrap();
        assert_eq!(tail(&log, 14).unwrap(), "third\n");
        assert_eq!(
            tail(&log, 1000).unwrap(),
            "first line\nsecond line\nthird\n"
        );
    }

    #[test]
    fn removing_everything_deletes_the_folder_once_the_hub_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("Desk");
        let paths = Paths::at(&root);
        std::fs::create_dir_all(paths.logs()).unwrap();
        wait_stopped(&paths, Duration::from_millis(10)).unwrap();
        let held = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = held.local_addr().unwrap().port();
        desk_core::write_ports(
            &paths.hub_state(),
            &desk_core::HubPorts {
                postgres: port,
                admin: port,
                gateway: port,
                memory: port,
            },
        )
        .unwrap();
        assert!(wait_stopped(&paths, Duration::from_millis(50)).is_err());
        drop(held);
        wait_stopped(&paths, Duration::from_secs(2)).unwrap();
    }
}
