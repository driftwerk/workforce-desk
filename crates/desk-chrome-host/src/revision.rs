//! The extension's revision, and bringing an old one up to date. Chrome
//! keeps running the extension it loaded until it's reloaded, and an
//! unpacked build (development) isn't reloaded when a Desk install rebuilds
//! `extension/dist`. Desk Helper is built with the revision beside it
//! (`extension/protocol/desk-helper.json`) and says it to the extension on
//! every hello; one older and unpacked reloads itself, once per revision,
//! and says so first. That message, and this one, are between the two of
//! them: neither reaches the hub.
//!
//! What's logged is plain: which revision Chrome runs, which Desk expects,
//! and what the extension did about it.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;

use serde_json::{Value, json};

/// What Desk Helper and the extension say to each other alone.
pub const FIXTURE: &str = include_str!("../../../extension/protocol/desk-helper.json");

/// The revision of the extension this Desk was built with.
pub fn expected() -> u64 {
    static R: OnceLock<u64> = OnceLock::new();
    *R.get_or_init(|| {
        serde_json::from_str::<Value>(FIXTURE)
            .ok()
            .and_then(|f| f["revision"].as_u64())
            .unwrap_or(1)
    })
}

/// The revision a hello says; 1 for an extension older than revisions.
pub fn said(hello: &Value) -> u64 {
    hello["revision"].as_u64().unwrap_or(1)
}

/// What Desk Helper tells the extension on each hello.
pub fn expects() -> Vec<u8> {
    serde_json::to_vec(&json!({ "type": "expects", "revision": expected() })).unwrap_or_default()
}

/// What to log of a hello: nothing when the extension is current.
pub fn on_hello(hello: &Value) -> Option<String> {
    let (has, wants) = (said(hello), expected());
    if has >= wants {
        return None;
    }
    let version = hello["version"].as_str().unwrap_or("?");
    Some(if hello["revision"].is_null() {
        format!(
            "Chrome is running an old Desk extension ({version}, from before it could update itself); Desk expects revision {wants}. Reload it once in chrome://extensions: from then on it reloads itself."
        )
    } else {
        format!(
            "Chrome is running an old Desk extension (revision {has}, {version}); Desk expects revision {wants}. Told it to bring itself up to date."
        )
    })
}

/// The extension's answer to [`expects`], never relayed: `None` when
/// `frame` isn't one, else what to log.
pub fn updating(frame: &[u8]) -> Option<String> {
    let v = serde_json::from_slice::<Value>(frame).ok()?;
    if v["type"] != "updating" {
        return None;
    }
    let r = v["revision"].as_u64().unwrap_or_default();
    Some(match v["outcome"].as_str() {
        Some("reloading") => format!(
            "Desk's extension is an unpacked build: it reloads itself from disk now, for revision {r}, and reconnects."
        ),
        Some("store") => format!(
            "Desk's extension isn't an unpacked build, so it doesn't reload itself; Chrome updates it from the Web Store to revision {r}."
        ),
        Some("unbuilt") => format!(
            "Desk's extension is an unpacked build, but its folder (extension/dist) isn't built at revision {r} yet: it reloads itself once it is, on its next connection. Run `npm run extension` if it stays like this."
        ),
        Some("tried") => format!(
            "Desk's extension reloaded itself for revision {r} already and is still older: its folder (extension/dist) wasn't rebuilt. Run `npm run extension` and reload it in chrome://extensions."
        ),
        _ => "Desk's extension said something about updating that Desk doesn't know.".to_string(),
    })
}

/// What a file is, to tell whether it was replaced: its size, when it
/// was written, and (on Unix) which file it is.
type Stamp = (u64, Option<SystemTime>, u64);

fn stamp(path: &Path) -> Option<Stamp> {
    let m = std::fs::metadata(path).ok()?;
    #[cfg(unix)]
    let ino = std::os::unix::fs::MetadataExt::ino(&m);
    #[cfg(not(unix))]
    let ino = 0;
    Some((m.len(), m.modified().ok(), ino))
}

/// This program as it was when Chrome started it. The relay outlives the
/// hub's restarts; once a Desk install replaced it, it steps aside so
/// Chrome starts the new one, which says the new revision.
pub struct Program {
    path: Option<PathBuf>,
    was: Option<Stamp>,
}

impl Program {
    pub fn now() -> Self {
        Self::at(std::env::current_exe().ok())
    }

    pub fn at(path: Option<PathBuf>) -> Self {
        let was = path.as_deref().and_then(stamp);
        Self { path, was }
    }

    /// Whether the file it was started from is another now (or gone).
    pub fn replaced(&self) -> bool {
        match (&self.path, &self.was) {
            (Some(p), Some(was)) => stamp(p).as_ref() != Some(was),
            // Not known at the start: nothing to compare.
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    #[test]
    fn it_expects_the_revision_beside_it_and_says_so_as_the_fixture_has_it() {
        let f = fixture();
        assert_eq!(expected(), f["revision"].as_u64().unwrap());
        assert!(expected() >= 2);
        let said: Value = serde_json::from_slice(&expects()).unwrap();
        assert_eq!(said, f["to_chrome"]["expects"]);
    }

    #[test]
    fn a_current_hello_logs_nothing_and_an_old_one_says_plainly() {
        let f = fixture();
        assert_eq!(on_hello(&f["from_chrome"]["hello"]), None);
        let mut old = f["from_chrome"]["hello"].clone();
        old["revision"] = json!(expected() - 1);
        let line = on_hello(&old).unwrap();
        assert!(
            line.contains(&format!("revision {}", expected() - 1)),
            "{line}"
        );
        assert!(line.contains("bring itself up to date"), "{line}");
        // From before revisions: it can't reload itself, once by hand.
        old.as_object_mut().unwrap().remove("revision");
        assert_eq!(said(&old), 1);
        assert!(on_hello(&old).unwrap().contains("chrome://extensions"));
    }

    #[test]
    fn the_extensions_answer_is_known_and_logged_never_relayed() {
        let f = fixture();
        for (k, says) in [
            ("reloading", "reloads itself"),
            ("store", "Web Store"),
            ("unbuilt", "isn't built"),
            ("tried", "wasn't rebuilt"),
        ] {
            let frame = serde_json::to_vec(&f["from_chrome"][k]).unwrap();
            let line = updating(&frame).unwrap();
            assert!(line.contains(says), "{k}: {line}");
        }
        assert_eq!(updating(br#"{"type":"result","id":1}"#), None);
        assert_eq!(updating(b"not json"), None);
    }

    #[test]
    fn a_replaced_program_is_told_apart() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("Desk Helper");
        std::fs::write(&exe, b"old build").unwrap();
        let p = Program::at(Some(exe.clone()));
        assert!(!p.replaced());
        // An install writes the new one beside it and moves it in place.
        let new = dir.path().join("Desk Helper.new");
        std::fs::write(&new, b"the new build").unwrap();
        std::fs::rename(&new, &exe).unwrap();
        assert!(p.replaced());
        std::fs::remove_file(&exe).unwrap();
        assert!(p.replaced(), "gone counts as replaced");
        assert!(!Program::at(None).replaced());
    }
}
