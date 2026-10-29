//! Desk's own copy of what it restores — the view and selection (`ui.*`)
//! and each window's frame per monitor arrangement (`window.*`) — in
//! `desk-state.json`, shaped like the hub's Desk state store.
//!
//! The hub holds the same keys; this file is what Desk reads before the hub
//! answers (a window's frame is placed before any page loads), what it falls
//! back to while the hub has no state store, and what it pushes to the hub
//! once it does: entries changed here and not yet stored there are `dirty`.
//!
//! Every change is in memory at once and on disk within [`DEBOUNCE`] (sooner
//! when the window loses focus, closes or Desk quits), so a crash or force
//! quit loses at most that much.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use eyre::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How long changes wait to be written together.
pub const DEBOUNCE: Duration = Duration::from_millis(300);
/// The longest a stream of changes (a window being dragged) waits.
const MAX_WAIT: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub value: Value,
    /// When the hub stored this value, as it says; none until it has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// Changed here and not yet stored by the hub.
    #[serde(default)]
    pub dirty: bool,
}

#[derive(Default, Serialize, Deserialize)]
struct Body {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    entries: BTreeMap<String, Entry>,
}

type Announce = Box<dyn Fn(Vec<(String, Entry)>) + Send + Sync>;

pub struct StateStore {
    path: PathBuf,
    entries: Mutex<BTreeMap<String, Entry>>,
    /// Keys Desk's native side changed since the last write, for the UI to
    /// pass on to the hub.
    native: Mutex<BTreeSet<String>>,
    changed: AtomicBool,
    /// One write at a time: `write_private`'s temporary file has one name.
    writing: Mutex<()>,
    wake: Mutex<Option<Sender<()>>>,
    announce: Mutex<Option<Announce>>,
}

impl StateStore {
    /// Reads the file (a missing one is empty; an unreadable one is set
    /// aside as `.corrupt` and Desk starts afresh) and starts the writer.
    pub fn open(path: PathBuf) -> Arc<Self> {
        let entries = match std::fs::read_to_string(&path) {
            Ok(s) => match serde_json::from_str::<Body>(&s) {
                Ok(b) => b.entries,
                Err(e) => {
                    tracing::warn!(error = %e, path = %path.display(), "desk state unreadable; starting afresh");
                    let _ = std::fs::rename(&path, path.with_extension("json.corrupt"));
                    BTreeMap::new()
                }
            },
            Err(_) => BTreeMap::new(),
        };
        let store = Arc::new(Self {
            path,
            entries: Mutex::new(entries),
            native: Mutex::new(BTreeSet::new()),
            changed: AtomicBool::new(false),
            writing: Mutex::new(()),
            wake: Mutex::new(None),
            announce: Mutex::new(None),
        });
        let (tx, rx) = mpsc::channel::<()>();
        *store.wake.lock().expect("wake") = Some(tx);
        let weak: Weak<Self> = Arc::downgrade(&store);
        std::thread::Builder::new()
            .name("desk-state".into())
            .spawn(move || {
                while rx.recv().is_ok() {
                    let first = Instant::now();
                    loop {
                        match rx.recv_timeout(DEBOUNCE) {
                            Ok(()) if first.elapsed() < MAX_WAIT => continue,
                            Ok(()) | Err(RecvTimeoutError::Timeout) => break,
                            Err(RecvTimeoutError::Disconnected) => break,
                        }
                    }
                    let Some(store) = weak.upgrade() else { return };
                    if let Err(e) = store.flush() {
                        tracing::warn!(error = %e, "couldn't save desk state");
                    }
                }
            })
            .expect("desk-state thread");
        store
    }

    /// Called with the entries Desk's native side changed, after each write.
    pub fn on_native_change(&self, f: impl Fn(Vec<(String, Entry)>) + Send + Sync + 'static) {
        *self.announce.lock().expect("announce") = Some(Box::new(f));
    }

    pub fn all(&self) -> BTreeMap<String, Entry> {
        self.entries.lock().expect("entries").clone()
    }

    pub fn get(&self, key: &str) -> Option<Entry> {
        self.entries.lock().expect("entries").get(key).cloned()
    }

    fn touch(&self) {
        self.changed.store(true, Ordering::SeqCst);
        if let Some(tx) = self.wake.lock().expect("wake").as_ref() {
            let _ = tx.send(());
        }
    }

    /// A change made here, for the hub to be told.
    pub fn put(&self, key: &str, value: Value) {
        let mut entries = self.entries.lock().expect("entries");
        if entries.get(key).is_some_and(|e| e.value == value) {
            return;
        }
        let updated_at = entries.get(key).and_then(|e| e.updated_at.clone());
        entries.insert(
            key.into(),
            Entry {
                value,
                updated_at,
                dirty: true,
            },
        );
        drop(entries);
        self.touch();
    }

    /// A change Desk's native side made (a window moved).
    pub fn put_native(&self, key: &str, value: Value) {
        if self.get(key).is_some_and(|e| e.value == value) {
            return;
        }
        self.native.lock().expect("native").insert(key.into());
        self.put(key, value);
    }

    pub fn remove(&self, key: &str) {
        if self.entries.lock().expect("entries").remove(key).is_some() {
            self.touch();
        }
    }

    /// The hub stored `value` under `key`: no longer dirty, unless it has
    /// changed here since.
    pub fn synced(&self, key: &str, value: &Value, updated_at: Option<String>) {
        let mut entries = self.entries.lock().expect("entries");
        if let Some(e) = entries.get_mut(key)
            && &e.value == value
        {
            e.dirty = false;
            e.updated_at = updated_at.or(e.updated_at.take());
            drop(entries);
            self.touch();
        }
    }

    /// The hub's value (none: it has no such key), taken unless this one has
    /// changed here and the hub hasn't been told. True when taken.
    pub fn adopt(&self, key: &str, from_hub: Option<(Value, Option<String>)>) -> bool {
        let mut entries = self.entries.lock().expect("entries");
        if entries.get(key).is_some_and(|e| e.dirty) {
            return false;
        }
        match from_hub {
            Some((value, updated_at)) => {
                entries.insert(
                    key.into(),
                    Entry {
                        value,
                        updated_at,
                        dirty: false,
                    },
                );
            }
            None => {
                entries.remove(key);
            }
        }
        drop(entries);
        self.touch();
        true
    }

    /// Writes now if anything changed (atomically: a temporary file, then
    /// renamed over the old one).
    pub fn flush(&self) -> Result<()> {
        let _writing = self.writing.lock().expect("writing");
        if !self.changed.swap(false, Ordering::SeqCst) {
            return Ok(());
        }
        let entries = self.all();
        let body = serde_json::to_string_pretty(&Body {
            version: 1,
            entries: entries.clone(),
        })?;
        if let Err(e) = desk_core::write_private(&self.path, &body) {
            self.changed.store(true, Ordering::SeqCst);
            return Err(e);
        }
        let native: Vec<String> = std::mem::take(&mut *self.native.lock().expect("native"))
            .into_iter()
            .collect();
        if !native.is_empty()
            && let Some(f) = self.announce.lock().expect("announce").as_ref()
        {
            f(native
                .into_iter()
                .filter_map(|k| entries.get(&k).cloned().map(|e| (k, e)))
                .collect());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn reopen(path: &std::path::Path) -> Arc<StateStore> {
        StateStore::open(path.to_path_buf())
    }

    #[test]
    fn changes_are_written_atomically_and_read_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("desk-state.json");
        let store = reopen(&path);
        store.put("ui.main", json!({"view": "rooms", "room": "r1"}));
        store.flush().unwrap();
        assert!(!path.with_extension("tmp").exists());
        let again = reopen(&path);
        let e = again.get("ui.main").unwrap();
        assert_eq!(e.value, json!({"view": "rooms", "room": "r1"}));
        assert!(e.dirty, "not yet on the hub");
    }

    #[test]
    fn the_writer_saves_on_its_own_within_the_debounce() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("desk-state.json");
        let store = reopen(&path);
        store.put("ui.main", json!({"view": "floor"}));
        assert!(!path.exists(), "not before the debounce");
        std::thread::sleep(DEBOUNCE * 3);
        assert!(path.exists());
        assert_eq!(
            reopen(&path).get("ui.main").unwrap().value,
            json!({"view": "floor"})
        );
    }

    #[test]
    fn synced_clears_dirty_only_for_the_value_the_hub_stored() {
        let dir = tempfile::tempdir().unwrap();
        let store = reopen(&dir.path().join("s.json"));
        store.put("ui.main", json!(1));
        store.put("ui.main", json!(2));
        store.synced("ui.main", &json!(1), Some("t1".into()));
        assert!(store.get("ui.main").unwrap().dirty, "changed since");
        store.synced("ui.main", &json!(2), Some("t2".into()));
        let e = store.get("ui.main").unwrap();
        assert!(!e.dirty);
        assert_eq!(e.updated_at.as_deref(), Some("t2"));
    }

    #[test]
    fn the_hubs_value_never_overwrites_one_it_hasnt_been_told() {
        let dir = tempfile::tempdir().unwrap();
        let store = reopen(&dir.path().join("s.json"));
        store.put("ui.main", json!("mine"));
        assert!(!store.adopt("ui.main", Some((json!("hubs"), None))));
        assert_eq!(store.get("ui.main").unwrap().value, json!("mine"));
        store.synced("ui.main", &json!("mine"), None);
        assert!(store.adopt("ui.main", Some((json!("hubs"), Some("t".into())))));
        assert_eq!(store.get("ui.main").unwrap().value, json!("hubs"));
        assert!(store.adopt("ui.main", None));
        assert!(store.get("ui.main").is_none());
    }

    #[test]
    fn an_unreadable_file_is_set_aside_and_desk_starts_afresh() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("desk-state.json");
        std::fs::write(&path, "{not json").unwrap();
        let store = reopen(&path);
        assert!(store.all().is_empty());
        assert!(path.with_extension("json.corrupt").exists());
    }

    #[test]
    fn native_changes_are_announced_after_theyre_written() {
        let dir = tempfile::tempdir().unwrap();
        let store = reopen(&dir.path().join("s.json"));
        let heard = Arc::new(Mutex::new(Vec::new()));
        let h = heard.clone();
        store.on_native_change(move |c| h.lock().unwrap().extend(c.into_iter().map(|(k, _)| k)));
        store.put("ui.main", json!(1));
        store.put_native("window.main.abc", json!({"x": 1}));
        store.flush().unwrap();
        assert_eq!(*heard.lock().unwrap(), vec!["window.main.abc".to_string()]);
        // The same frame again is no change.
        store.put_native("window.main.abc", json!({"x": 1}));
        store.flush().unwrap();
        assert_eq!(heard.lock().unwrap().len(), 1);
    }
}
