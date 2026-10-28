//! Settings → Help: a report of recent logs the person can save and send,
//! and removing everything Desk keeps on this Mac.

use std::io::{Read, Seek, SeekFrom, Write};
use std::net::TcpListener;
use std::path::Path;
use std::time::{Duration, Instant};

use desk_core::{LOCAL_HUB_ID, Paths, Secret, Secrets, device_token_account, read_ports};
use eyre::{Context, Result};

/// The logs a report carries, newest part of each.
const LOGS: [&str; 6] = [
    "desk.log",
    "desk.log.1",
    "desk-hubd.log",
    "desk-hubd.log.1",
    "hub.log",
    "hub.log.1",
];
const TAIL: u64 = 4 * 1024 * 1024;

/// Every keychain account Desk may hold: the local hub's secrets and one
/// device token per hub.
fn accounts(paths: &Paths) -> Vec<String> {
    let mut out: Vec<String> = Secret::ALL.iter().map(|s| s.account().into()).collect();
    out.push(device_token_account(LOCAL_HUB_ID));
    for r in crate::hubs::read_records(paths).unwrap_or_default() {
        out.push(device_token_account(&r.id));
    }
    out
}

/// The values a log could contain verbatim, to blank exactly.
pub fn known_secrets(paths: &Paths) -> Vec<String> {
    let secrets = Secrets::for_paths(paths);
    accounts(paths)
        .iter()
        .filter_map(|a| secrets.get_account(a).ok().flatten())
        .collect()
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

/// A zip of the recent logs, every secret — `known` values and anything
/// shaped like one — taken out, plus what was running.
pub fn write_report(paths: &Paths, known: &[String], about: &str, to: &Path) -> Result<()> {
    let file = std::fs::File::create(to).with_context(|| format!("saving {}", to.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o600);
    zip.start_file("about.txt", opts)?;
    zip.write_all(desk_core::redact::redact(about, known).as_bytes())?;
    for name in LOGS {
        let path = paths.logs().join(name);
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

/// Waits for the hub and its Postgres to let go of their ports.
fn wait_stopped(paths: &Paths, within: Duration) -> Result<()> {
    let Some(ports) = read_ports(&paths.hub_state())? else {
        return Ok(());
    };
    let deadline = Instant::now() + within;
    let free = |p: u16| TcpListener::bind(("127.0.0.1", p)).is_ok();
    while !(free(ports.gateway) && free(ports.postgres)) {
        if Instant::now() > deadline {
            eyre::bail!(
                "Desk Helper is still running. Quit it (or restart your Mac) and try again."
            );
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Ok(())
}

/// Stops Desk Helper and takes it out of Login Items; with `everything`,
/// also deletes Desk's folder and its keychain items. Nothing is deleted
/// while the helper is still running.
pub fn remove(paths: &Paths, everything: bool) -> Result<()> {
    crate::helper::unregister(paths)?;
    if !everything {
        return Ok(());
    }
    wait_stopped(paths, Duration::from_secs(40))?;
    let secrets = Secrets::for_paths(paths);
    for a in accounts(paths) {
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
        write_report(&paths, &known, "Desk 0.1.0", &out).unwrap();
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
            },
        )
        .unwrap();
        assert!(wait_stopped(&paths, Duration::from_millis(50)).is_err());
        drop(held);
        wait_stopped(&paths, Duration::from_secs(2)).unwrap();
    }
}
