//! The sessions to resume after Desk restarts into an update: written just
//! before the restart, read once by the new version when it connects.

use desk_core::Paths;
use eyre::Result;

fn path(paths: &Paths) -> std::path::PathBuf {
    paths.root.join("resume-after-update.json")
}

pub fn resume_later(paths: &Paths, ids: &[String]) -> Result<()> {
    desk_core::write_private(&path(paths), &serde_json::to_string(ids)?)
}

/// The ids saved before the restart, forgotten as they are read.
pub fn resume_take(paths: &Paths) -> Result<Vec<String>> {
    let p = path(paths);
    let ids = match std::fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.into()),
    };
    std::fs::remove_file(&p)?;
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sessions_to_resume_are_read_once() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        assert!(resume_take(&paths).unwrap().is_empty());
        resume_later(&paths, &["a".into(), "b".into()]).unwrap();
        assert_eq!(resume_take(&paths).unwrap(), vec!["a", "b"]);
        assert!(resume_take(&paths).unwrap().is_empty());
    }
}
