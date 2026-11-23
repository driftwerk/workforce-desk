//! Desk's log files, kept from filling the disk: moved aside to
//! `<name>.1` when opened over their limit, and kept under it while what
//! writes them runs.

use std::collections::HashMap;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The size a log is kept under.
pub const LOG_LIMIT: u64 = 20 * 1024 * 1024;

/// The most a log is let past its limit while its older part can't be
/// kept (the disk is full): past this it is emptied all the same.
const OVER_AT_MOST: u64 = 2;

/// The most looks a log that can't be kept waits out before the next try.
const BACKOFF_AT_MOST: u32 = 60;

/// Where `log`'s older part is kept.
pub fn rotated(log: &Path) -> PathBuf {
    log.with_extension("log.1")
}

/// `log`, opened to append, moved aside to [`rotated`] first when it is
/// over `limit`.
pub fn append_log(log: &Path, limit: u64) -> io::Result<File> {
    if std::fs::metadata(log).is_ok_and(|m| m.len() > limit) {
        let _ = std::fs::rename(log, rotated(log));
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
}

/// What [`cap`] did to a log.
#[derive(Debug)]
pub enum Capped {
    /// It is under its limit: left as it is.
    Under,
    /// Its older part is kept at [`rotated`], and it was emptied.
    Kept,
    /// Its older part couldn't be kept (why), and it was emptied all the
    /// same: it was past twice its limit.
    Dropped(io::Error),
}

/// `log`, which a running process appends to, kept under `limit`: once
/// over, it is copied to [`rotated`] (through a file beside it, so a copy
/// cut short never takes the last one kept) and emptied in place. It can't
/// be moved aside, as [`append_log`] does at a start, while the process
/// holds it open; opened to append, the writer's next line lands at the
/// start of the emptied file. A line written between the copy and the
/// emptying is lost. When the copy fails it is left to grow, to twice its
/// limit, then emptied without it.
pub fn cap(log: &Path, limit: u64) -> io::Result<Capped> {
    let size = match std::fs::metadata(log) {
        Ok(m) => m.len(),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Capped::Under),
        Err(e) => return Err(e),
    };
    if size <= limit {
        return Ok(Capped::Under);
    }
    let emptied = || std::fs::OpenOptions::new().write(true).open(log)?.set_len(0);
    match keep(log) {
        Ok(()) => emptied().map(|()| Capped::Kept),
        Err(e) if size > limit * OVER_AT_MOST => emptied().map(|()| Capped::Dropped(e)),
        Err(e) => Err(e),
    }
}

/// `log` copied whole over [`rotated`], or that left as it was.
fn keep(log: &Path) -> io::Result<()> {
    let tmp = log.with_extension("log.1.tmp");
    std::fs::copy(log, &tmp)
        .and_then(|_| std::fs::rename(&tmp, rotated(log)))
        .inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })
}

/// A log's failures to be kept in a row, and the looks left before the
/// next try.
#[derive(Default)]
struct Failing {
    times: u32,
    wait: u32,
}

/// Keeps each of `logs` under `limit` while what writes them runs,
/// looking every `every`. One that can't be kept is tried less often the
/// more it fails, said once until it is kept again.
pub async fn keep_capped(logs: Vec<PathBuf>, limit: u64, every: Duration) {
    let mut failing: HashMap<PathBuf, Failing> = HashMap::new();
    let mut tick = tokio::time::interval(every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        for log in &logs {
            if let Some(f) = failing.get_mut(log).filter(|f| f.wait > 0) {
                f.wait -= 1;
                continue;
            }
            match cap(log, limit) {
                Ok(Capped::Under) => {}
                Ok(Capped::Kept) => {
                    if failing.remove(log).is_some() {
                        tracing::info!(log = %log.display(), "a log's older part is kept again");
                    }
                }
                Ok(Capped::Dropped(e)) => {
                    tracing::warn!(log = %log.display(), error = %e, "a log at twice its limit was emptied: its older part couldn't be kept");
                    failed(&mut failing, log);
                }
                Err(e) => {
                    if !failing.contains_key(log) {
                        tracing::warn!(log = %log.display(), error = %e, "couldn't keep a log under its limit");
                    }
                    failed(&mut failing, log);
                }
            }
        }
    }
}

fn failed(failing: &mut HashMap<PathBuf, Failing>, log: &Path) {
    let f = failing.entry(log.to_path_buf()).or_default();
    f.times += 1;
    f.wait = 2u32.saturating_pow(f.times).min(BACKOFF_AT_MOST);
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    #[test]
    fn logs_over_their_limit_are_moved_aside_when_opened() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("hub.log");
        std::fs::write(&log, "x".repeat(100)).unwrap();
        append_log(&log, 10).unwrap();
        assert_eq!(std::fs::metadata(&log).unwrap().len(), 0);
        assert!(rotated(&log).is_file());
    }

    #[test]
    fn a_log_written_to_as_it_runs_is_kept_under_its_limit() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("hub.log");
        let mut writer = append_log(&log, LOG_LIMIT).unwrap();
        writer.write_all(&[b'x'; 100]).unwrap();
        assert!(matches!(cap(&log, 1000).unwrap(), Capped::Under));
        assert_eq!(std::fs::metadata(&log).unwrap().len(), 100);
        assert!(matches!(cap(&log, 10).unwrap(), Capped::Kept));
        assert_eq!(std::fs::read(rotated(&log)).unwrap(), [b'x'; 100]);
        assert_eq!(std::fs::metadata(&log).unwrap().len(), 0);
        // What it writes next starts the emptied file, never past a gap.
        writer.write_all(b"next line\n").unwrap();
        assert_eq!(std::fs::read(&log).unwrap(), b"next line\n");
        assert!(matches!(
            cap(&dir.path().join("memory.log"), 10).unwrap(),
            Capped::Under
        ));
    }

    #[test]
    fn a_copy_that_fails_keeps_the_last_one_and_empties_the_log_only_past_twice_its_limit() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("hub.log");
        std::fs::write(rotated(&log), "older").unwrap();
        // The copy can't be written: its place is taken.
        std::fs::create_dir(log.with_extension("log.1.tmp")).unwrap();
        std::fs::write(&log, [b'x'; 15]).unwrap();
        assert!(cap(&log, 10).is_err());
        assert_eq!(std::fs::metadata(&log).unwrap().len(), 15, "left to grow");
        assert_eq!(std::fs::read(rotated(&log)).unwrap(), b"older");
        std::fs::write(&log, [b'x'; 25]).unwrap();
        assert!(matches!(cap(&log, 10).unwrap(), Capped::Dropped(_)));
        assert_eq!(std::fs::metadata(&log).unwrap().len(), 0);
        assert_eq!(std::fs::read(rotated(&log)).unwrap(), b"older");
    }

    #[test]
    fn a_log_that_cant_be_kept_is_tried_less_often_the_more_it_fails() {
        let mut failing = HashMap::new();
        let log = Path::new("hub.log");
        let waits: Vec<u32> = (0..8)
            .map(|_| {
                failed(&mut failing, log);
                failing[log].wait
            })
            .collect();
        assert_eq!(waits, [2, 4, 8, 16, 32, 60, 60, 60]);
    }
}
