//! Moving the memories the hub kept in SQLite into the memory store, once:
//! the hub's own `memory move-sqlite` copies them, keeping their ids, and
//! reads every one back. Desk Helper checks its counts, notes the move, and
//! only then sets the SQLite file aside, kept as a backup.

use std::collections::BTreeMap;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use desk_core::Paths;
use eyre::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio::process::Command;

/// The SQLite file's name once it is set aside.
pub const BACKUP: &str = "memory-before-store.db";

/// What `memory move-sqlite --json` says it did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Counts {
    /// Memories in the SQLite file, forgotten ones included.
    pub in_sqlite: u64,
    /// Those with nothing in them to keep (empty content).
    pub unmovable: u64,
    /// Copied into the store.
    pub moved: u64,
    /// Read back from the store as they were.
    pub verified: u64,
}

impl Counts {
    /// Every memory with something in it is in the store, as it was.
    pub fn complete(&self) -> bool {
        self.moved + self.unmovable == self.in_sqlite && self.verified == self.moved
    }
}

/// The note that the move was made and checked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Moved {
    #[serde(flatten)]
    pub counts: Counts,
    /// The SQLite file, set aside under this name in the hub's data folder;
    /// `None` when there was none.
    pub backup: Option<String>,
}

pub fn moved(paths: &Paths) -> Option<Moved> {
    serde_json::from_str(&std::fs::read_to_string(paths.memory_moved()).ok()?).ok()
}

/// The counts the last line of the command's output gives.
pub fn parse(stdout: &str) -> Result<Counts> {
    let line = stdout
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .ok_or_else(|| eyre::eyre!("the move printed no counts"))?;
    Ok(serde_json::from_str(line)?)
}

/// Sets the SQLite file (and its write-ahead log, if any) aside as
/// [`BACKUP`], where the hub no longer opens it.
fn set_aside(db: &Path) -> Result<()> {
    let backup = db.with_file_name(BACKUP);
    for suffix in ["", "-wal", "-shm"] {
        let from = format!("{}{suffix}", db.display());
        let to = format!("{}{suffix}", backup.display());
        match std::fs::rename(&from, &to) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e).with_context(|| format!("setting {from} aside")),
        }
    }
    Ok(())
}

/// Notes `counts` as the move, then sets the SQLite file aside.
pub fn finish(paths: &Paths, counts: Counts) -> Result<Moved> {
    if !counts.complete() {
        bail!("the move is not complete: {counts:?}");
    }
    let db = paths.sqlite_memories();
    let had = db.exists();
    let note = Moved {
        counts,
        backup: had.then(|| BACKUP.to_string()),
    };
    desk_core::write_private(&paths.memory_moved(), &serde_json::to_string(&note)?)?;
    if had {
        set_aside(&db)?;
    }
    Ok(note)
}

/// Moves the SQLite memories into the store with the hub's `workforce`
/// binary, run on the hub's config (which must already say the store) and
/// environment, while the hub is stopped. Checked, noted and set aside, or
/// an error and nothing changed but what the store was given (a second run
/// gives it the same memories again, under the same ids).
pub async fn move_sqlite(
    workforce: &Path,
    paths: &Paths,
    env: &BTreeMap<String, String>,
) -> Result<Moved> {
    let db = paths.sqlite_memories();
    if !db.exists() {
        return finish(paths, Counts::default());
    }
    let run = Command::new(workforce)
        .args(["memory", "move-sqlite", "--apply", "--json", "-c"])
        .arg(paths.hub_config())
        .arg("--from")
        .arg(&db)
        .current_dir(paths.hub())
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(Duration::from_secs(60 * 60), run)
        .await
        .context("moving memories took over an hour")??;
    let stdout = String::from_utf8_lossy(&out.stdout);
    if !out.status.success() {
        bail!(
            "moving memories failed ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
                .lines()
                .rev()
                .take(5)
                .collect::<Vec<_>>()
                .join(" / ")
        );
    }
    let counts = parse(&stdout)?;
    tracing::info!(
        ?counts,
        "moved the hub's SQLite memories into the memory store"
    );
    finish(paths, counts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_counts_are_read_from_the_last_json_line() {
        let out =
            "Moving 3 memories\n{\"in_sqlite\":3,\"unmovable\":1,\"moved\":2,\"verified\":2}\n";
        let c = parse(out).unwrap();
        assert_eq!(
            c,
            Counts {
                in_sqlite: 3,
                unmovable: 1,
                moved: 2,
                verified: 2
            }
        );
        assert!(c.complete());
        assert!(parse("no counts\n").is_err());
    }

    #[test]
    fn a_move_that_lost_or_could_not_read_back_a_memory_is_not_finished() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        std::fs::create_dir_all(paths.hub_data()).unwrap();
        std::fs::write(paths.sqlite_memories(), "db").unwrap();
        for counts in [
            Counts {
                in_sqlite: 3,
                unmovable: 0,
                moved: 2,
                verified: 2,
            },
            Counts {
                in_sqlite: 3,
                unmovable: 0,
                moved: 3,
                verified: 2,
            },
        ] {
            assert!(finish(&paths, counts).is_err());
            assert!(paths.sqlite_memories().is_file());
            assert!(moved(&paths).is_none());
        }
    }

    #[test]
    fn a_checked_move_is_noted_and_the_sqlite_file_kept_aside() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        std::fs::create_dir_all(paths.hub_data()).unwrap();
        std::fs::write(paths.sqlite_memories(), "db").unwrap();
        std::fs::write(format!("{}-wal", paths.sqlite_memories().display()), "wal").unwrap();
        let counts = Counts {
            in_sqlite: 4,
            unmovable: 1,
            moved: 3,
            verified: 3,
        };
        let note = finish(&paths, counts).unwrap();
        assert_eq!(note.backup.as_deref(), Some(BACKUP));
        assert_eq!(moved(&paths), Some(note));
        assert!(!paths.sqlite_memories().exists());
        assert_eq!(
            std::fs::read_to_string(paths.hub_data().join(BACKUP)).unwrap(),
            "db"
        );
        assert!(paths.hub_data().join(format!("{BACKUP}-wal")).is_file());
    }
}
