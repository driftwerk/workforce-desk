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

/// How often running logs are looked at against their limit.
pub const CAP_EVERY: Duration = Duration::from_secs(60);

/// The most a log is let past its limit while its older part can't be
/// kept (the disk is full): past this it is emptied all the same.
const OVER_AT_MOST: u64 = 2;

/// The most looks a log that can't be kept waits out before its next copy.
const BACKOFF_AT_MOST: u32 = 60;

/// Where `log`'s older part is kept.
pub fn rotated(log: &Path) -> PathBuf {
    log.with_extension("log.1")
}

/// `log`, opened to append, moved aside to [`rotated`] first when it is
/// over `limit`. The rename replaces `.1` in one step (both are in the
/// same folder, so on the same volume); at a hub's restart it can race
/// [`keep_capped`] copying the same log, which at worst leaves `.1` with
/// the older of the two.
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
    /// Its older part couldn't be kept, and it was emptied all the same: it
    /// was past twice its limit. Why, unless a copy already failed and is
    /// waited out.
    Dropped(Option<io::Error>),
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
    let Some(size) = size(log)?.filter(|s| *s > limit) else {
        return Ok(Capped::Under);
    };
    match keep(log) {
        Ok(()) => emptied(log).map(|()| Capped::Kept),
        Err(e) if size > limit * OVER_AT_MOST => emptied(log).map(|()| Capped::Dropped(Some(e))),
        Err(e) => Err(e),
    }
}

fn size(log: &Path) -> io::Result<Option<u64>> {
    match std::fs::metadata(log) {
        Ok(m) => Ok(Some(m.len())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn emptied(log: &Path) -> io::Result<()> {
    std::fs::OpenOptions::new()
        .write(true)
        .open(log)?
        .set_len(0)
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

/// A log's failures to be kept in a row, and the looks left before its
/// next copy.
#[derive(Debug, Default)]
struct Failing {
    times: u32,
    wait: u32,
}

/// What one look at a log came to.
#[derive(Debug)]
enum Looked {
    /// Under its limit, or kept (`again` after failing).
    Fine { again: bool },
    /// Over its limit, its next copy still waited out.
    Waiting,
    /// Past twice its limit and emptied without its older part (why, unless
    /// a copy already failed and is waited out).
    Dropped(Option<io::Error>),
    /// Its older part couldn't be kept (why, said once while it fails).
    Failed { first: bool, why: io::Error },
}

/// One look at `log`: its size every time, its copy only once a failing
/// one's wait is out, though one past twice its limit is emptied while
/// it waits.
fn look(log: &Path, limit: u64, failing: &mut HashMap<PathBuf, Failing>) -> Looked {
    let fine = |failing: &mut HashMap<PathBuf, Failing>| Looked::Fine {
        again: failing.remove(log).is_some(),
    };
    let waiting = failing.get_mut(log).filter(|f| f.wait > 0);
    let result = match waiting {
        Some(f) => {
            f.wait -= 1;
            match size(log) {
                Ok(Some(s)) if s > limit * OVER_AT_MOST => {
                    emptied(log).map(|()| Capped::Dropped(None))
                }
                Ok(Some(s)) if s > limit => return Looked::Waiting,
                Ok(_) => Ok(Capped::Under),
                Err(e) => Err(e),
            }
        }
        None => cap(log, limit),
    };
    match result {
        Ok(Capped::Under | Capped::Kept) => fine(failing),
        Ok(Capped::Dropped(e)) => {
            failed(failing, log);
            Looked::Dropped(e)
        }
        Err(why) => {
            let first = !failing.contains_key(log);
            failed(failing, log);
            Looked::Failed { first, why }
        }
    }
}

fn failed(failing: &mut HashMap<PathBuf, Failing>, log: &Path) {
    let f = failing.entry(log.to_path_buf()).or_default();
    f.times += 1;
    f.wait = 2u32.saturating_pow(f.times).min(BACKOFF_AT_MOST);
}

/// [`keep_capped`] on a thread of its own, for a process with no runtime of
/// its own: it ends with the process.
pub fn keep_capped_on_thread(logs: Vec<PathBuf>, limit: u64, every: Duration) {
    std::thread::spawn(move || {
        if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
        {
            rt.block_on(keep_capped(logs, limit, every));
        }
    });
}

/// Keeps each of `logs` under `limit` while what writes them runs,
/// looking every `every`. One that can't be kept is copied less often the
/// more it fails, said once until it is kept again, and emptied past
/// twice its limit meanwhile.
pub async fn keep_capped(logs: Vec<PathBuf>, limit: u64, every: Duration) {
    let mut failing: HashMap<PathBuf, Failing> = HashMap::new();
    let mut tick = tokio::time::interval(every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let logs = logs.clone();
        let looked = tokio::task::spawn_blocking(move || {
            let looked: Vec<(PathBuf, Looked)> = logs
                .into_iter()
                .map(|log| {
                    let l = look(&log, limit, &mut failing);
                    (log, l)
                })
                .collect();
            (failing, looked)
        })
        .await;
        let Ok((kept, looked)) = looked else {
            failing = HashMap::new();
            continue;
        };
        failing = kept;
        for (log, l) in looked {
            let log = log.display();
            match l {
                Looked::Fine { again: true } => tracing::info!(%log, "back under its limit"),
                Looked::Fine { again: false } | Looked::Waiting => {}
                Looked::Dropped(why) => tracing::warn!(
                    %log,
                    error = why.as_ref().map(tracing::field::display),
                    "emptied at twice its limit without its older part"
                ),
                Looked::Failed { first: true, why } => {
                    tracing::warn!(%log, error = %why, "couldn't be kept under its limit")
                }
                Looked::Failed { first: false, .. } => {}
            }
        }
    }
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
        assert!(matches!(cap(&log, 10).unwrap(), Capped::Dropped(Some(_))));
        assert_eq!(std::fs::metadata(&log).unwrap().len(), 0);
        assert_eq!(std::fs::read(rotated(&log)).unwrap(), b"older");
    }

    #[test]
    fn a_copy_that_cant_take_the_older_ones_place_leaves_no_copy_behind() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("hub.log");
        // `.1` can't be replaced: a folder with something in it.
        std::fs::create_dir(rotated(&log)).unwrap();
        std::fs::write(rotated(&log).join("kept"), "older").unwrap();
        std::fs::write(&log, [b'x'; 15]).unwrap();
        assert!(cap(&log, 10).is_err());
        assert!(!log.with_extension("log.1.tmp").exists());
        assert_eq!(std::fs::metadata(&log).unwrap().len(), 15);
    }

    #[test]
    fn a_failing_log_is_copied_less_often_emptied_past_twice_its_limit_meanwhile_and_forgotten_once_under()
     {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("hub.log");
        let blocked = log.with_extension("log.1.tmp");
        std::fs::create_dir(&blocked).unwrap();
        let mut failing = HashMap::new();
        std::fs::write(&log, [b'x'; 15]).unwrap();
        assert!(matches!(
            look(&log, 10, &mut failing),
            Looked::Failed { first: true, .. }
        ));
        assert_eq!(failing[&log].wait, 2);
        // Its copy is waited out, though its size is looked at.
        assert!(matches!(look(&log, 10, &mut failing), Looked::Waiting));
        assert_eq!(failing[&log].wait, 1);
        std::fs::write(&log, [b'x'; 25]).unwrap();
        assert!(matches!(
            look(&log, 10, &mut failing),
            Looked::Dropped(None)
        ));
        assert_eq!(
            std::fs::metadata(&log).unwrap().len(),
            0,
            "emptied while it waits"
        );
        assert_eq!(failing[&log].wait, 4);
        // Under its limit: forgotten, said once.
        assert!(matches!(
            look(&log, 10, &mut failing),
            Looked::Fine { again: true }
        ));
        assert!(failing.is_empty());
        // Copied again once the way is clear.
        std::fs::remove_dir(&blocked).unwrap();
        std::fs::write(&log, [b'x'; 15]).unwrap();
        assert!(matches!(
            look(&log, 10, &mut failing),
            Looked::Fine { again: false }
        ));
        assert_eq!(std::fs::read(rotated(&log)).unwrap(), [b'x'; 15]);
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

    #[tokio::test]
    async fn a_log_kept_capped_is_emptied_under_its_writer_and_the_writer_goes_on() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("chrome-host.log");
        let mut writer = append_log(&log, LOG_LIMIT).unwrap();
        writer.write_all(&[b'x'; 100]).unwrap();
        let task = tokio::spawn(keep_capped(
            vec![log.clone()],
            10,
            Duration::from_millis(10),
        ));
        for _ in 0..200 {
            if std::fs::metadata(&log).unwrap().len() == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        task.abort();
        assert_eq!(std::fs::read(rotated(&log)).unwrap(), [b'x'; 100]);
        writer.write_all(b"next\n").unwrap();
        assert_eq!(std::fs::read(&log).unwrap(), b"next\n");
    }

    #[test]
    fn a_log_kept_capped_on_a_thread_is_emptied() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("desk-helper.log");
        let mut writer = append_log(&log, LOG_LIMIT).unwrap();
        writer.write_all(&[b'x'; 100]).unwrap();
        keep_capped_on_thread(vec![log.clone()], 10, Duration::from_millis(10));
        let emptied = (0..200).any(|_| {
            std::thread::sleep(Duration::from_millis(10));
            std::fs::metadata(&log).unwrap().len() == 0
        });
        assert!(emptied);
        assert_eq!(std::fs::read(rotated(&log)).unwrap(), [b'x'; 100]);
    }
}
