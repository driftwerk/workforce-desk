//! Desk's secrets in the system store, read once per process.
//!
//! Each item in the macOS keychain has its own access list, and a binary not
//! on it is asked about each item it reads, every time, until the person
//! picks "Always Allow". So the secrets are kept as few items as possible and
//! read once per process:
//!
//! - **Two bundles, one per writer.** Desk Helper's secrets (the local hub's
//!   tokens, keys and password, and Desk's device token for it) are one item,
//!   `desk-helper-secrets`, which only Desk Helper writes. The app's own
//!   (remote hubs' device tokens) are another, `desk-app-secrets`, which only
//!   the app writes. An item's access list starts with the binary that made
//!   it; were one item written by both, an app-made item would leave the
//!   helper, a background agent nobody watches, asking to read its own
//!   secrets at its next start.
//! - **Cached for the process.** Every `Secrets` of a process shares one
//!   cache per folder: a value is read from the store once, and a reload of
//!   Desk's page reads nothing. Only values are cached, never their absence,
//!   so a secret another process is still creating is found once it exists.
//! - **Changes are said beside it.** Desk Helper bumps `secrets.rev` (no
//!   secret in it) whenever it writes its bundle, so the app reads it again
//!   only when it changed (Desk Helper paired Desk with the hub again).
//! - **Migrated, not broken.** A secret the bundle doesn't hold is read from
//!   its own item, as earlier versions kept it, and moved into the bundle by
//!   its writer. The separate items are kept, and Desk Helper keeps writing
//!   its own as well, so an older Desk or Desk Helper still finds them.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use eyre::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::{KEYRING_SERVICE, LOCAL_HUB_ID, Secret, device_token_account, write_private};

/// The item holding Desk Helper's secrets.
pub const HELPER_BUNDLE: &str = "desk-helper-secrets";
/// The item holding the app's own secrets.
pub const APP_BUNDLE: &str = "desk-app-secrets";
/// Beside the secrets: how many times Desk Helper has written its bundle.
const REV_FILE: &str = "secrets.rev";

/// Which process writes a secret: Desk Helper or the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum KeyOwner {
    Helper,
    App,
}

impl KeyOwner {
    /// Who writes `account`: Desk Helper its hub's secrets and Desk's device
    /// token for it; the app every other hub's.
    pub fn of(account: &str) -> Self {
        if Secret::ALL.iter().any(|s| s.account() == account)
            || account == device_token_account(LOCAL_HUB_ID)
        {
            KeyOwner::Helper
        } else {
            KeyOwner::App
        }
    }

    fn bundle(self) -> &'static str {
        match self {
            KeyOwner::Helper => HELPER_BUNDLE,
            KeyOwner::App => APP_BUNDLE,
        }
    }
}

static ROLE: OnceLock<KeyOwner> = OnceLock::new();

/// Says this process is Desk Helper, which writes (and migrates) the
/// helper's bundle. Every other process is the app. Set once, first thing.
pub fn writes_as(owner: KeyOwner) {
    let _ = ROLE.set(owner);
}

fn role() -> KeyOwner {
    ROLE.get().copied().unwrap_or(KeyOwner::App)
}

/// Single items in the system store, by account: what the vault is kept in.
pub trait Items: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>>;
    fn set(&self, account: &str, value: &str) -> Result<()>;
    fn delete(&self, account: &str) -> Result<()>;
}

/// The system's own store: the keychain on macOS, Credential Manager on
/// Windows, the Secret Service on a Linux desktop.
pub struct SystemItems;

impl Items for SystemItems {
    fn get(&self, account: &str) -> Result<Option<String>> {
        match keyring::Entry::new(KEYRING_SERVICE, account)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e).with_context(|| format!("reading {account} from {}", store_name())),
        }
    }

    fn set(&self, account: &str, value: &str) -> Result<()> {
        keyring::Entry::new(KEYRING_SERVICE, account)?
            .set_password(value)
            .with_context(|| format!("saving {account} to {}", store_name()))
    }

    fn delete(&self, account: &str) -> Result<()> {
        match keyring::Entry::new(KEYRING_SERVICE, account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e).with_context(|| format!("removing {account} from {}", store_name())),
        }
    }
}

fn store_name() -> &'static str {
    crate::KeyStore::System.name()
}

/// A bundle as the store keeps it.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Stored {
    #[serde(default)]
    secrets: BTreeMap<String, String>,
}

/// A bundle as this process last read it.
#[derive(Default)]
struct Loaded {
    secrets: BTreeMap<String, String>,
    /// Whether the store holds the bundle item at all.
    exists: bool,
    /// For the helper's bundle: `secrets.rev` when it was read.
    rev: Option<String>,
}

#[derive(Default)]
struct State {
    helper: Option<Loaded>,
    app: Option<Loaded>,
}

impl State {
    fn slot(&mut self, owner: KeyOwner) -> &mut Option<Loaded> {
        match owner {
            KeyOwner::Helper => &mut self.helper,
            KeyOwner::App => &mut self.app,
        }
    }
}

/// Desk's secrets in one folder's system store, read once per process.
pub struct Vault {
    items: Arc<dyn Items>,
    /// Whose bundle this process writes.
    role: KeyOwner,
    rev: PathBuf,
    /// Held across each read and write of the store, so two commands that
    /// both need a secret not yet read wait for one read, not make two.
    state: Mutex<State>,
}

impl Vault {
    pub fn new(root: &Path, items: Arc<dyn Items>) -> Self {
        Self::new_as(root, items, role())
    }

    /// A vault for a process that is `role`.
    pub fn new_as(root: &Path, items: Arc<dyn Items>, role: KeyOwner) -> Self {
        Self {
            items,
            role,
            rev: root.join(REV_FILE),
            state: Mutex::new(State::default()),
        }
    }

    fn rev(&self) -> Option<String> {
        std::fs::read_to_string(&self.rev).ok()
    }

    fn read_bundle(&self, owner: KeyOwner) -> Result<Loaded> {
        let rev = (owner == KeyOwner::Helper).then(|| self.rev()).flatten();
        Ok(match self.items.get(owner.bundle())? {
            Some(json) => Loaded {
                secrets: serde_json::from_str::<Stored>(&json)
                    .with_context(|| format!("reading {}", owner.bundle()))?
                    .secrets,
                exists: true,
                rev,
            },
            None => Loaded {
                rev,
                ..Loaded::default()
            },
        })
    }

    /// The bundle as it stands: read when this process hasn't, or, for the
    /// helper's in a process that isn't the helper, when the helper has
    /// written it since.
    fn loaded<'a>(&self, st: &'a mut State, owner: KeyOwner) -> Result<&'a mut Loaded> {
        let stale = match st.slot(owner) {
            None => true,
            Some(l) => {
                owner == KeyOwner::Helper && self.role != KeyOwner::Helper && l.rev != self.rev()
            }
        };
        if stale {
            // Values met outside the bundle (an older helper's own items)
            // stay known until the bundle says otherwise.
            let kept = st.slot(owner).take().map(|l| l.secrets).unwrap_or_default();
            let mut fresh = self.read_bundle(owner)?;
            for (k, v) in kept {
                fresh.secrets.entry(k).or_insert(v);
            }
            *st.slot(owner) = Some(fresh);
        }
        Ok(st.slot(owner).as_mut().expect("just loaded"))
    }

    fn save(&self, owner: KeyOwner, loaded: &mut Loaded) -> Result<()> {
        if loaded.secrets.is_empty() {
            if loaded.exists {
                self.items.delete(owner.bundle())?;
                loaded.exists = false;
            }
        } else {
            let json = serde_json::to_string(&Stored {
                secrets: loaded.secrets.clone(),
            })?;
            self.items.set(owner.bundle(), &json)?;
            loaded.exists = true;
        }
        if owner == KeyOwner::Helper {
            let next = self
                .rev()
                .and_then(|r| r.trim().parse::<u64>().ok())
                .unwrap_or(0)
                + 1;
            let rev = next.to_string();
            if let Some(dir) = self.rev.parent() {
                std::fs::create_dir_all(dir)?;
            }
            write_private(&self.rev, &rev)?;
            loaded.rev = Some(rev);
        }
        Ok(())
    }

    pub fn get(&self, account: &str) -> Result<Option<String>> {
        let owner = KeyOwner::of(account);
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(v) = self.loaded(&mut st, owner)?.secrets.get(account) {
            return Ok(Some(v.clone()));
        }
        // Not in the bundle: kept as its own item by an earlier version.
        let Some(v) = self.items.get(account)? else {
            // Not read again from the bundle until it changes; a miss of
            // the helper's is read again from its own item next time.
            return Ok(None);
        };
        let loaded = self.loaded(&mut st, owner)?;
        loaded.secrets.insert(account.into(), v.clone());
        // Its writer moves it into the bundle; anyone else just keeps it.
        if owner == self.role {
            self.save(owner, loaded)?;
        }
        Ok(Some(v))
    }

    pub fn set(&self, account: &str, value: &str) -> Result<()> {
        let owner = KeyOwner::of(account);
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let loaded = self.loaded(&mut st, owner)?;
        loaded.secrets.insert(account.into(), value.into());
        self.save(owner, loaded)?;
        // The helper keeps its own items too, for an older Desk or Desk
        // Helper (it made them, so writing them asks nothing).
        if owner == KeyOwner::Helper && self.role == KeyOwner::Helper {
            self.items.set(account, value)?;
        }
        Ok(())
    }

    pub fn delete(&self, account: &str) -> Result<()> {
        let owner = KeyOwner::of(account);
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let loaded = self.loaded(&mut st, owner)?;
        if loaded.secrets.remove(account).is_some() {
            self.save(owner, loaded)?;
        }
        // Its own item too, so it isn't found there instead.
        self.items.delete(account)
    }
}

static VAULTS: Mutex<BTreeMap<PathBuf, Arc<Vault>>> = Mutex::new(BTreeMap::new());

/// The vault of the store for the secrets kept beside `root`, one per folder
/// for the whole process.
pub fn shared(root: &Path) -> Arc<Vault> {
    shared_with(root, || Arc::new(SystemItems))
}

/// The same, made over `items` when this process has none for `root` yet: a
/// stand-in store for tests.
pub fn shared_with(root: &Path, items: impl FnOnce() -> Arc<dyn Items>) -> Arc<Vault> {
    let mut all = VAULTS.lock().unwrap_or_else(|e| e.into_inner());
    Arc::clone(
        all.entry(root.to_path_buf())
            .or_insert_with(|| Arc::new(Vault::new(root, items()))),
    )
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A store that counts what it is asked.
    #[derive(Default)]
    pub(crate) struct Counted {
        items: Mutex<HashMap<String, String>>,
        pub(crate) reads: AtomicUsize,
        pub(crate) writes: AtomicUsize,
    }

    impl Counted {
        pub(crate) fn with(items: &[(&str, &str)]) -> Arc<Self> {
            let c = Self::default();
            for (k, v) in items {
                c.items.lock().unwrap().insert((*k).into(), (*v).into());
            }
            Arc::new(c)
        }

        pub(crate) fn item(&self, account: &str) -> Option<String> {
            self.items.lock().unwrap().get(account).cloned()
        }

        pub(crate) fn bundle(&self, name: &str) -> BTreeMap<String, String> {
            self.item(name)
                .map(|j| serde_json::from_str::<Stored>(&j).unwrap().secrets)
                .unwrap_or_default()
        }

        pub(crate) fn calls(&self) -> usize {
            self.reads.load(Ordering::SeqCst) + self.writes.load(Ordering::SeqCst)
        }
    }

    impl Items for Counted {
        fn get(&self, account: &str) -> Result<Option<String>> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(self.item(account))
        }
        fn set(&self, account: &str, value: &str) -> Result<()> {
            self.writes.fetch_add(1, Ordering::SeqCst);
            self.items
                .lock()
                .unwrap()
                .insert(account.into(), value.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<()> {
            self.writes.fetch_add(1, Ordering::SeqCst);
            self.items.lock().unwrap().remove(account);
            Ok(())
        }
    }

    const GATEWAY: &str = "hub-gateway-token";
    const LOCAL: &str = "hub-local-device-token";
    const REMOTE: &str = "hub-workforce-example-com-device-token";

    #[test]
    fn ownership_follows_the_writer() {
        assert_eq!(KeyOwner::of(GATEWAY), KeyOwner::Helper);
        assert_eq!(KeyOwner::of(LOCAL), KeyOwner::Helper);
        assert_eq!(KeyOwner::of(REMOTE), KeyOwner::App);
    }

    #[test]
    fn a_second_read_asks_the_store_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[(
            HELPER_BUNDLE,
            r#"{"secrets":{"hub-gateway-token":"g","hub-local-device-token":"d"}}"#,
        )]);
        let v = Vault::new_as(dir.path(), items.clone(), KeyOwner::App);
        assert_eq!(v.get(GATEWAY).unwrap().as_deref(), Some("g"));
        assert_eq!(v.get(LOCAL).unwrap().as_deref(), Some("d"));
        assert_eq!(items.calls(), 1, "one bundle, one read");
        for _ in 0..5 {
            v.get(GATEWAY).unwrap();
            v.get(LOCAL).unwrap();
        }
        assert_eq!(items.calls(), 1);
    }

    #[test]
    fn the_apps_separate_items_move_into_its_bundle_and_stay() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[(REMOTE, "r")]);
        let v = Vault::new_as(dir.path(), items.clone(), KeyOwner::App);
        assert_eq!(v.get(REMOTE).unwrap().as_deref(), Some("r"));
        assert_eq!(
            items.bundle(APP_BUNDLE).get(REMOTE).map(String::as_str),
            Some("r")
        );
        assert_eq!(
            items.item(REMOTE).as_deref(),
            Some("r"),
            "kept for an older Desk"
        );
        // A new process (a rebuilt app) reads only the bundle.
        let next = Vault::new_as(dir.path(), items.clone(), KeyOwner::App);
        let before = items.reads.load(Ordering::SeqCst);
        assert_eq!(next.get(REMOTE).unwrap().as_deref(), Some("r"));
        assert_eq!(items.reads.load(Ordering::SeqCst) - before, 1);
    }

    #[test]
    fn without_a_bundle_the_helpers_own_items_are_read_and_left_to_it() {
        // An older Desk Helper: its secrets are separate items only.
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[(GATEWAY, "g"), (LOCAL, "d")]);
        let v = Vault::new_as(dir.path(), items.clone(), KeyOwner::App);
        assert_eq!(v.get(GATEWAY).unwrap().as_deref(), Some("g"));
        assert_eq!(v.get(LOCAL).unwrap().as_deref(), Some("d"));
        assert!(
            items.item(HELPER_BUNDLE).is_none(),
            "the app never makes the helper's bundle"
        );
        let read = items.calls();
        v.get(GATEWAY).unwrap();
        v.get(LOCAL).unwrap();
        assert_eq!(items.calls(), read, "kept for the process");
    }

    #[test]
    fn a_missing_secret_is_found_once_another_process_makes_it() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[]);
        let app = Vault::new_as(dir.path(), items.clone(), KeyOwner::App);
        assert_eq!(app.get(GATEWAY).unwrap(), None);
        // Desk Helper creates it, in its bundle, and says so beside it.
        items
            .set(HELPER_BUNDLE, r#"{"secrets":{"hub-gateway-token":"g"}}"#)
            .unwrap();
        write_private(&dir.path().join(REV_FILE), "1").unwrap();
        assert_eq!(app.get(GATEWAY).unwrap().as_deref(), Some("g"));
    }

    #[test]
    fn the_helpers_new_pairing_is_read_once_when_it_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[(
            HELPER_BUNDLE,
            r#"{"secrets":{"hub-local-device-token":"old"}}"#,
        )]);
        write_private(&dir.path().join(REV_FILE), "1").unwrap();
        let app = Vault::new_as(dir.path(), items.clone(), KeyOwner::App);
        assert_eq!(app.get(LOCAL).unwrap().as_deref(), Some("old"));
        items
            .set(
                HELPER_BUNDLE,
                r#"{"secrets":{"hub-local-device-token":"new"}}"#,
            )
            .unwrap();
        // Unsaid, unread.
        assert_eq!(app.get(LOCAL).unwrap().as_deref(), Some("old"));
        write_private(&dir.path().join(REV_FILE), "2").unwrap();
        assert_eq!(app.get(LOCAL).unwrap().as_deref(), Some("new"));
    }

    #[test]
    fn an_app_secret_is_written_to_its_bundle_and_removed_from_both() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[(REMOTE, "old")]);
        let v = Vault::new_as(dir.path(), items.clone(), KeyOwner::App);
        v.set(REMOTE, "new").unwrap();
        assert_eq!(
            items.bundle(APP_BUNDLE).get(REMOTE).map(String::as_str),
            Some("new")
        );
        assert_eq!(v.get(REMOTE).unwrap().as_deref(), Some("new"));
        v.delete(REMOTE).unwrap();
        assert!(items.item(APP_BUNDLE).is_none(), "an empty bundle goes");
        assert!(items.item(REMOTE).is_none());
        assert_eq!(v.get(REMOTE).unwrap(), None);
    }

    #[test]
    fn the_helper_moves_its_separate_items_into_its_bundle_and_keeps_them() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[(GATEWAY, "g")]);
        let helper = Vault::new_as(dir.path(), items.clone(), KeyOwner::Helper);
        assert_eq!(helper.get(GATEWAY).unwrap().as_deref(), Some("g"));
        assert_eq!(
            items.bundle(HELPER_BUNDLE).get(GATEWAY).map(String::as_str),
            Some("g")
        );
        assert_eq!(items.item(GATEWAY).as_deref(), Some("g"));
        // A new pairing: in the bundle and its own item, and said beside it.
        helper.set(LOCAL, "d").unwrap();
        assert_eq!(
            items.bundle(HELPER_BUNDLE).get(LOCAL).map(String::as_str),
            Some("d")
        );
        assert_eq!(items.item(LOCAL).as_deref(), Some("d"), "for an older Desk");
        assert_eq!(
            std::fs::read_to_string(dir.path().join(REV_FILE)).unwrap(),
            "2"
        );
        // The app, in its own process, reads the one bundle.
        let app = Vault::new_as(dir.path(), items.clone(), KeyOwner::App);
        let before = items.reads.load(Ordering::SeqCst);
        assert_eq!(app.get(GATEWAY).unwrap().as_deref(), Some("g"));
        assert_eq!(app.get(LOCAL).unwrap().as_deref(), Some("d"));
        assert_eq!(items.reads.load(Ordering::SeqCst) - before, 1);
    }

    #[test]
    fn concurrent_first_reads_read_once() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[(HELPER_BUNDLE, r#"{"secrets":{"hub-gateway-token":"g"}}"#)]);
        let v = Arc::new(Vault::new_as(dir.path(), items.clone(), KeyOwner::App));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let v = Arc::clone(&v);
                std::thread::spawn(move || v.get(GATEWAY).unwrap())
            })
            .collect();
        for t in threads {
            assert_eq!(t.join().unwrap().as_deref(), Some("g"));
        }
        assert_eq!(items.calls(), 1);
    }
}
