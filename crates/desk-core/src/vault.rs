//! Desk's secrets in the system store, read once per process.
//!
//! Each item in the macOS keychain has its own access list, and a binary not
//! on it is asked about each item it reads, every time, until the person
//! picks "Always Allow". So on macOS the secrets are kept as few items as
//! possible, and everywhere they are read once per process:
//!
//! - **Two bundles, one per writer (macOS).** Desk Helper's secrets (the
//!   local hub's tokens, keys and password, and Desk's device token for it)
//!   are one item, `desk-helper-secrets`, which only Desk Helper writes. The
//!   app's own (remote hubs' device tokens) are another, `desk-app-secrets`,
//!   which only the app writes. An item's access list starts with the binary
//!   that made it; were one item written by both, an app-made item would
//!   leave the helper, a background agent nobody watches, asking to read its
//!   own secrets at its next start. Neither process ever writes the other's
//!   bundle.
//! - **One item each elsewhere.** Credential Manager and the Secret Service
//!   don't ask per item, so bundling buys nothing there, and Credential
//!   Manager holds at most 2560 bytes (1280 characters as it stores them) in
//!   an item: a bundle of many hubs' tokens wouldn't fit. Those keep the
//!   layout earlier versions used ([`Layout`]).
//! - **Cached for the process.** Every `Secrets` of a process shares one
//!   cache per folder: a value is read from the store once, and a reload of
//!   Desk's page reads nothing. Only values are cached, never their absence,
//!   so a secret another process is still creating is found once it exists.
//!   The app keeps only the helper's secrets it uses (the gateway token and
//!   its device token), not the hub's keys and password.
//! - **Changes are said beside it.** Desk Helper writes a new random value
//!   to `secrets.rev` (no secret in it) whenever it changes its secrets, so
//!   the app drops what it holds of them and reads them again only then: a
//!   new pairing, or the backend removed. A counter would come round to the
//!   same value once the folder is deleted and made again.
//! - **Migrated, not broken.** A secret the bundle doesn't hold is read from
//!   its own item, as earlier versions kept it, and moved into the bundle by
//!   its writer. Every write lands in both, and a delete removes both (its
//!   own item first, so a value left there can't be moved back), so an older
//!   Desk or Desk Helper still finds them. A release that no longer has to
//!   run beside those stops writing the separate items and deletes them.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use eyre::{Context, Result};
use rand::RngExt;
use serde::{Deserialize, Serialize};

use crate::{KEYRING_SERVICE, LOCAL_HUB_ID, Secret, device_token_account, write_private};

/// The item holding Desk Helper's secrets.
pub const HELPER_BUNDLE: &str = "desk-helper-secrets";
/// The item holding the app's own secrets.
pub const APP_BUNDLE: &str = "desk-app-secrets";
/// Beside the secrets: changes each time Desk Helper changes its secrets.
const REV_FILE: &str = "secrets.rev";
/// What of `secrets.rev` is read: a random value, never longer.
const REV_MAX: u64 = 64;

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

    fn name(self) -> &'static str {
        match self {
            KeyOwner::Helper => "Desk Helper",
            KeyOwner::App => "the Desk app",
        }
    }
}

/// The helper's secrets the app reads: how to reach the local hub. The
/// hub's keys and password stay with Desk Helper.
fn app_reads(account: &str) -> bool {
    account == Secret::GatewayToken.account() || account == device_token_account(LOCAL_HUB_ID)
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

/// How the secrets are kept in the store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layout {
    /// Two bundles, one per writer, each secret also its own item for older
    /// versions: macOS, whose keychain asks per item.
    Bundled,
    /// One item per secret: Windows and the Secret Service.
    Separate,
}

impl Layout {
    /// This platform's.
    pub fn here() -> Self {
        if cfg!(target_os = "macos") {
            Layout::Bundled
        } else {
            Layout::Separate
        }
    }
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

/// A bundle as the store keeps it. No `Debug`: it is all secrets.
#[derive(Default, Serialize, Deserialize)]
struct Stored {
    #[serde(default)]
    secrets: BTreeMap<String, String>,
}

/// One writer's secrets as this process holds them.
struct Loaded {
    secrets: BTreeMap<String, String>,
    /// For the helper's, in another process: `secrets.rev` when read.
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
    /// Whose secrets this process writes.
    role: KeyOwner,
    layout: Layout,
    rev: PathBuf,
    /// Held across each read and write of the store, so two commands that
    /// both need a secret not yet read wait for one read, not make two.
    state: Mutex<State>,
}

impl Vault {
    pub fn new(root: &Path, items: Arc<dyn Items>) -> Self {
        Self::new_as(root, items, role())
    }

    /// A vault for a process that is `role`, laid out as this platform's.
    pub fn new_as(root: &Path, items: Arc<dyn Items>, role: KeyOwner) -> Self {
        Self {
            items,
            role,
            layout: Layout::here(),
            rev: root.join(REV_FILE),
            state: Mutex::new(State::default()),
        }
    }

    /// The same, laid out as `layout`: for tests of the other platforms'.
    pub fn laid_out(mut self, layout: Layout) -> Self {
        self.layout = layout;
        self
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Whether this process holds `owner`'s secrets only until the helper
    /// says they changed.
    fn watches(&self, owner: KeyOwner) -> bool {
        owner == KeyOwner::Helper && self.role != KeyOwner::Helper
    }

    fn rev(&self) -> Option<String> {
        use std::io::Read;
        let mut s = String::new();
        std::fs::File::open(&self.rev)
            .ok()?
            .take(REV_MAX)
            .read_to_string(&mut s)
            .ok()?;
        Some(s)
    }

    /// Says the helper's secrets changed, when this is the helper.
    fn said(&self, owner: KeyOwner) -> Result<()> {
        if owner != KeyOwner::Helper || self.role != KeyOwner::Helper {
            return Ok(());
        }
        let mut bytes = [0u8; 16];
        rand::rng().fill(&mut bytes);
        let rev: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        write_private(&self.rev, &rev)
    }

    /// The bundle as the store holds it, all of it. One that can't be read
    /// is an error, never empty: Desk Helper would otherwise make new keys
    /// for a hub whose data the old ones lock. The error doesn't quote it.
    fn read_bundle(&self, owner: KeyOwner) -> Result<BTreeMap<String, String>> {
        match self.items.get(owner.bundle())? {
            Some(json) => match serde_json::from_str::<Stored>(&json) {
                Ok(stored) => Ok(stored.secrets),
                Err(_) => eyre::bail!(
                    "{} in {} is damaged; Desk left it as it is",
                    owner.bundle(),
                    store_name()
                ),
            },
            None => Ok(BTreeMap::new()),
        }
    }

    /// `owner`'s secrets as they stand: read when this process hasn't, or,
    /// for the helper's in another process, again from scratch when the
    /// helper has changed them since, so nothing it removed is still served.
    fn loaded<'a>(&self, st: &'a mut State, owner: KeyOwner) -> Result<&'a mut Loaded> {
        let watched = self.watches(owner);
        let stale = match st.slot(owner) {
            None => true,
            Some(l) => watched && l.rev != self.rev(),
        };
        if stale {
            // The rev before the bundle: the helper writes the bundle, then
            // the rev, so a bundle read after a rev is at least as new.
            let rev = if watched { self.rev() } else { None };
            let mut secrets = match self.layout {
                Layout::Bundled => self.read_bundle(owner)?,
                Layout::Separate => BTreeMap::new(),
            };
            if watched {
                secrets.retain(|k, _| app_reads(k));
            }
            *st.slot(owner) = Some(Loaded { secrets, rev });
        }
        Ok(st.slot(owner).as_mut().expect("just loaded"))
    }

    /// Changes the bundle this process writes: read again first, so a write
    /// by another of its processes isn't lost, then written whole, and only
    /// then held, so a failed write leaves what's held as the store has it.
    fn change(
        &self,
        owner: KeyOwner,
        loaded: &mut Loaded,
        f: impl FnOnce(&mut BTreeMap<String, String>),
    ) -> Result<()> {
        self.check_writer(owner)?;
        let before = self.read_bundle(owner)?;
        let mut next = before.clone();
        f(&mut next);
        if next == before {
            loaded.secrets = next;
            return Ok(());
        }
        if next.is_empty() {
            self.items.delete(owner.bundle())?;
        } else {
            let json = serde_json::to_string(&Stored {
                secrets: next.clone(),
            })?;
            self.items.set(owner.bundle(), &json)?;
        }
        loaded.secrets = next;
        self.said(owner)
    }

    /// Only a bundle's writer changes it.
    fn check_writer(&self, owner: KeyOwner) -> Result<()> {
        if self.layout == Layout::Bundled && owner != self.role {
            eyre::bail!(
                "{} changes only {}'s secrets, not {}'s",
                self.role.name(),
                self.role.name(),
                owner.name()
            );
        }
        Ok(())
    }

    pub fn get(&self, account: &str) -> Result<Option<String>> {
        let owner = KeyOwner::of(account);
        let mut st = self.lock();
        let loaded = self.loaded(&mut st, owner)?;
        if let Some(v) = loaded.secrets.get(account) {
            return Ok(Some(v.clone()));
        }
        // Its own item: how it is kept here, or by an earlier version.
        let Some(v) = self.items.get(account)? else {
            // Not cached: read again next time, in case it's being made.
            return Ok(None);
        };
        // Its writer moves it into the bundle. A move that fails leaves it
        // where it was, and the value is still the answer.
        if self.layout == Layout::Bundled && owner == self.role {
            let moved = self.change(owner, loaded, |m| {
                m.insert(account.into(), v.clone());
            });
            if let Err(e) = moved {
                tracing::warn!("couldn't move {account} into {}: {e:#}", owner.bundle());
            }
        }
        loaded.secrets.insert(account.into(), v.clone());
        Ok(Some(v))
    }

    pub fn set(&self, account: &str, value: &str) -> Result<()> {
        let owner = KeyOwner::of(account);
        self.check_writer(owner)?;
        let mut st = self.lock();
        let loaded = self.loaded(&mut st, owner)?;
        match self.layout {
            Layout::Separate => {
                self.items.set(account, value)?;
                loaded.secrets.insert(account.into(), value.into());
                self.said(owner)
            }
            Layout::Bundled => {
                self.change(owner, loaded, |m| {
                    m.insert(account.into(), value.into());
                })?;
                // Its own item too, in step, for an older Desk or Desk
                // Helper (and so no older token is left there).
                self.items.set(account, value)
            }
        }
    }

    pub fn delete(&self, account: &str) -> Result<()> {
        let owner = KeyOwner::of(account);
        self.check_writer(owner)?;
        let mut st = self.lock();
        let loaded = self.loaded(&mut st, owner)?;
        // Its own item first: one left behind would be moved back in.
        self.items.delete(account)?;
        match self.layout {
            Layout::Separate => {
                loaded.secrets.remove(account);
                self.said(owner)
            }
            Layout::Bundled => self.change(owner, loaded, |m| {
                m.remove(account);
            }),
        }
    }

    /// Deletes all of `owner`'s secrets: each `accounts` item, and the
    /// whole bundle, with anything in it no record names. Either process
    /// may: deleting an item doesn't make the other its writer.
    pub fn forget(&self, owner: KeyOwner, accounts: &[String]) -> Result<()> {
        let mut st = self.lock();
        if let Some(a) = accounts.iter().find(|a| KeyOwner::of(a) != owner) {
            eyre::bail!("{a} isn't one of {}'s secrets", owner.name());
        }
        for a in accounts {
            self.items.delete(a)?;
        }
        if self.layout == Layout::Bundled {
            self.items.delete(owner.bundle())?;
        }
        *st.slot(owner) = None;
        self.said(owner)
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
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    /// A store that counts what it is asked, and can be made to refuse
    /// writes.
    #[derive(Default)]
    pub(crate) struct Counted {
        items: Mutex<HashMap<String, String>>,
        pub(crate) reads: AtomicUsize,
        pub(crate) writes: AtomicUsize,
        refuse_writes: AtomicBool,
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

        fn refuse(&self, refuse: bool) {
            self.refuse_writes.store(refuse, Ordering::SeqCst);
        }

        fn write(&self) -> Result<()> {
            self.writes.fetch_add(1, Ordering::SeqCst);
            if self.refuse_writes.load(Ordering::SeqCst) {
                eyre::bail!("the store said no");
            }
            Ok(())
        }
    }

    impl Items for Counted {
        fn get(&self, account: &str) -> Result<Option<String>> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(self.item(account))
        }
        fn set(&self, account: &str, value: &str) -> Result<()> {
            self.write()?;
            self.items
                .lock()
                .unwrap()
                .insert(account.into(), value.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<()> {
            self.write()?;
            self.items.lock().unwrap().remove(account);
            Ok(())
        }
    }

    const GATEWAY: &str = "hub-gateway-token";
    const VAULT_KEY: &str = "hub-vault-key";
    const LOCAL: &str = "hub-local-device-token";
    const REMOTE: &str = "hub-workforce-example-com-device-token";

    fn helper(dir: &Path, items: &Arc<Counted>) -> Vault {
        Vault::new_as(dir, items.clone(), KeyOwner::Helper).laid_out(Layout::Bundled)
    }

    fn app(dir: &Path, items: &Arc<Counted>) -> Vault {
        Vault::new_as(dir, items.clone(), KeyOwner::App).laid_out(Layout::Bundled)
    }

    fn helper_accounts() -> Vec<String> {
        Secret::ALL
            .iter()
            .map(|s| s.account().to_string())
            .chain([device_token_account(LOCAL_HUB_ID)])
            .collect()
    }

    #[test]
    fn ownership_follows_the_writer() {
        assert_eq!(KeyOwner::of(GATEWAY), KeyOwner::Helper);
        assert_eq!(KeyOwner::of(LOCAL), KeyOwner::Helper);
        assert_eq!(KeyOwner::of(REMOTE), KeyOwner::App);
    }

    #[test]
    fn only_macos_bundles() {
        assert_eq!(Layout::here() == Layout::Bundled, cfg!(target_os = "macos"));
    }

    #[test]
    fn a_second_read_asks_the_store_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[(
            HELPER_BUNDLE,
            r#"{"secrets":{"hub-gateway-token":"g","hub-local-device-token":"d"}}"#,
        )]);
        let v = app(dir.path(), &items);
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
    fn the_app_keeps_none_of_the_hubs_keys() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[(
            HELPER_BUNDLE,
            r#"{"secrets":{"hub-gateway-token":"g","hub-vault-key":"k"}}"#,
        )]);
        let v = app(dir.path(), &items);
        assert_eq!(v.get(GATEWAY).unwrap().as_deref(), Some("g"));
        let st = v.lock();
        let held = &st.helper.as_ref().unwrap().secrets;
        assert_eq!(held.keys().collect::<Vec<_>>(), [GATEWAY]);
    }

    #[test]
    fn the_apps_separate_items_move_into_its_bundle_and_stay() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[(REMOTE, "r")]);
        let v = app(dir.path(), &items);
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
        let next = app(dir.path(), &items);
        let before = items.reads.load(Ordering::SeqCst);
        assert_eq!(next.get(REMOTE).unwrap().as_deref(), Some("r"));
        assert_eq!(items.reads.load(Ordering::SeqCst) - before, 1);
    }

    #[test]
    fn a_new_token_replaces_the_old_in_both_places() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[(REMOTE, "old")]);
        let v = app(dir.path(), &items);
        assert_eq!(v.get(REMOTE).unwrap().as_deref(), Some("old"));
        v.set(REMOTE, "new").unwrap();
        assert_eq!(
            items.bundle(APP_BUNDLE).get(REMOTE).map(String::as_str),
            Some("new")
        );
        assert_eq!(items.item(REMOTE).as_deref(), Some("new"), "none left old");
    }

    #[test]
    fn without_a_bundle_the_helpers_own_items_are_read_and_left_to_it() {
        // An older Desk Helper: its secrets are separate items only.
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[(GATEWAY, "g"), (LOCAL, "d")]);
        let v = app(dir.path(), &items);
        assert_eq!(v.get(GATEWAY).unwrap().as_deref(), Some("g"));
        assert_eq!(v.get(LOCAL).unwrap().as_deref(), Some("d"));
        assert!(
            items.item(HELPER_BUNDLE).is_none(),
            "the app never makes the helper's bundle"
        );
        assert_eq!(items.writes.load(Ordering::SeqCst), 0);
        let read = items.calls();
        v.get(GATEWAY).unwrap();
        v.get(LOCAL).unwrap();
        assert_eq!(items.calls(), read, "kept for the process");
    }

    #[test]
    fn the_app_never_changes_the_helpers_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[(GATEWAY, "g")]);
        let v = app(dir.path(), &items);
        assert_eq!(v.get(GATEWAY).unwrap().as_deref(), Some("g"));
        assert!(v.set(GATEWAY, "other").is_err());
        assert!(v.set(LOCAL, "d").is_err());
        assert!(v.delete(GATEWAY).is_err());
        assert_eq!(items.writes.load(Ordering::SeqCst), 0);
        assert!(items.item(HELPER_BUNDLE).is_none());
        assert_eq!(items.item(GATEWAY).as_deref(), Some("g"));
        assert!(!dir.path().join(REV_FILE).exists());
    }

    #[test]
    fn a_missing_secret_is_found_once_another_process_makes_it() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[]);
        let app = app(dir.path(), &items);
        assert_eq!(app.get(GATEWAY).unwrap(), None);
        // Desk Helper creates it, in its bundle, and says so beside it.
        helper(dir.path(), &items).set(GATEWAY, "g").unwrap();
        assert_eq!(app.get(GATEWAY).unwrap().as_deref(), Some("g"));
    }

    #[test]
    fn the_helpers_new_pairing_is_read_once_when_it_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[]);
        let helper = helper(dir.path(), &items);
        helper.set(LOCAL, "old").unwrap();
        let app = app(dir.path(), &items);
        assert_eq!(app.get(LOCAL).unwrap().as_deref(), Some("old"));
        // Changed without saying so: unread.
        items
            .set(
                HELPER_BUNDLE,
                r#"{"secrets":{"hub-local-device-token":"other"}}"#,
            )
            .unwrap();
        assert_eq!(app.get(LOCAL).unwrap().as_deref(), Some("old"));
        helper.set(LOCAL, "new").unwrap();
        let before = items.reads.load(Ordering::SeqCst);
        assert_eq!(app.get(LOCAL).unwrap().as_deref(), Some("new"));
        assert_eq!(app.get(LOCAL).unwrap().as_deref(), Some("new"));
        assert_eq!(items.reads.load(Ordering::SeqCst) - before, 1);
    }

    #[test]
    fn a_token_the_helper_drops_is_not_served_again() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[]);
        let helper = helper(dir.path(), &items);
        helper.set(GATEWAY, "g").unwrap();
        helper.set(LOCAL, "revoked").unwrap();
        let app = app(dir.path(), &items);
        assert_eq!(app.get(LOCAL).unwrap().as_deref(), Some("revoked"));
        helper.delete(LOCAL).unwrap();
        assert_eq!(app.get(LOCAL).unwrap(), None, "dropped from the cache");
        assert_eq!(app.get(GATEWAY).unwrap().as_deref(), Some("g"));
        assert!(items.item(LOCAL).is_none(), "and from its own item");
    }

    #[test]
    fn nothing_is_served_once_the_backend_is_removed() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[]);
        let helper = helper(dir.path(), &items);
        helper.set(GATEWAY, "g").unwrap();
        helper.set(LOCAL, "d").unwrap();
        let app = app(dir.path(), &items);
        assert_eq!(app.get(GATEWAY).unwrap().as_deref(), Some("g"));
        assert_eq!(app.get(LOCAL).unwrap().as_deref(), Some("d"));
        // `--remove-everything`: the secrets, then the folder.
        helper.forget(KeyOwner::Helper, &helper_accounts()).unwrap();
        std::fs::remove_file(dir.path().join(REV_FILE)).unwrap();
        assert_eq!(app.get(GATEWAY).unwrap(), None);
        assert_eq!(app.get(LOCAL).unwrap(), None);
        assert!(items.item(HELPER_BUNDLE).is_none());
        for a in helper_accounts() {
            assert!(items.item(&a).is_none(), "{a} left behind");
        }
    }

    #[test]
    fn a_backend_made_again_is_read_again() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[]);
        let first = helper(dir.path(), &items);
        first.set(GATEWAY, "old").unwrap();
        let app = app(dir.path(), &items);
        assert_eq!(app.get(GATEWAY).unwrap().as_deref(), Some("old"));
        // Removed, folder and all, and set up again by a new Desk Helper
        // making as many changes as the first.
        first.forget(KeyOwner::Helper, &helper_accounts()).unwrap();
        std::fs::remove_file(dir.path().join(REV_FILE)).unwrap();
        helper(dir.path(), &items).set(GATEWAY, "new").unwrap();
        assert_eq!(app.get(GATEWAY).unwrap().as_deref(), Some("new"));
    }

    #[test]
    fn the_rev_says_nothing_secret() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[]);
        helper(dir.path(), &items)
            .set(GATEWAY, "0123456789abcdef")
            .unwrap();
        let rev = std::fs::read_to_string(dir.path().join(REV_FILE)).unwrap();
        assert_eq!(rev.len(), 32);
        assert!(rev.bytes().all(|b| b.is_ascii_hexdigit()));
        assert!(!rev.contains("0123456789abcdef"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join(REV_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o077, 0, "only its owner reads or writes it");
        }
    }

    #[test]
    fn an_app_secret_is_written_to_its_bundle_and_removed_from_both() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[(REMOTE, "old")]);
        let v = app(dir.path(), &items);
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
        // A new process doesn't find it either.
        assert_eq!(app(dir.path(), &items).get(REMOTE).unwrap(), None);
    }

    #[test]
    fn forgetting_the_apps_secrets_takes_ones_no_record_names() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[(
            APP_BUNDLE,
            r#"{"secrets":{"hub-a-device-token":"a","hub-orphan-device-token":"o"}}"#,
        )]);
        let v = app(dir.path(), &items);
        assert_eq!(v.get("hub-a-device-token").unwrap().as_deref(), Some("a"));
        v.forget(KeyOwner::App, &["hub-a-device-token".into()])
            .unwrap();
        assert!(items.item(APP_BUNDLE).is_none());
        assert_eq!(v.get("hub-orphan-device-token").unwrap(), None);
        assert!(
            v.forget(KeyOwner::App, &[GATEWAY.into()]).is_err(),
            "only its own"
        );
    }

    #[test]
    fn a_failed_write_leaves_the_cache_as_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[(APP_BUNDLE, r#"{"secrets":{"hub-a-device-token":"a"}}"#)]);
        let v = app(dir.path(), &items);
        assert_eq!(v.get("hub-a-device-token").unwrap().as_deref(), Some("a"));
        items.refuse(true);
        assert!(v.set("hub-a-device-token", "b").is_err());
        assert_eq!(v.get("hub-a-device-token").unwrap().as_deref(), Some("a"));
        assert!(v.delete("hub-a-device-token").is_err());
        assert_eq!(v.get("hub-a-device-token").unwrap().as_deref(), Some("a"));
        assert_eq!(
            items
                .bundle(APP_BUNDLE)
                .get("hub-a-device-token")
                .map(String::as_str),
            Some("a")
        );
    }

    #[test]
    fn a_failed_move_still_answers() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[(REMOTE, "r")]);
        items.refuse(true);
        let v = app(dir.path(), &items);
        assert_eq!(v.get(REMOTE).unwrap().as_deref(), Some("r"));
        assert!(items.item(APP_BUNDLE).is_none());
        let read = items.calls();
        assert_eq!(v.get(REMOTE).unwrap().as_deref(), Some("r"));
        assert_eq!(items.calls(), read, "and keeps it for the process");
    }

    #[test]
    fn a_damaged_bundle_is_an_error_that_quotes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        for damaged in [
            r#"{"secrets":"leaked leaked"}"#,
            r#"{"secrets":{"hub-vault-key":7357}}"#,
            r#"{"secrets":{"hub-vault-key":"leaked"#,
            "leaked",
        ] {
            let items = Counted::with(&[(HELPER_BUNDLE, damaged)]);
            let secrets =
                crate::Secrets::Keyring(crate::Keyring::with(Arc::new(helper(dir.path(), &items))));
            let e = crate::SecretStore::get_or_create(&secrets, Secret::VaultKey).unwrap_err();
            let said = format!("{e:#} {e:?}");
            assert!(!said.contains("leaked") && !said.contains("7357"), "{said}");
            assert_eq!(
                items.writes.load(Ordering::SeqCst),
                0,
                "no new key over the old"
            );
            assert_eq!(items.item(HELPER_BUNDLE).as_deref(), Some(damaged));
        }
    }

    #[test]
    fn the_helper_moves_its_separate_items_into_its_bundle_and_keeps_them() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[(GATEWAY, "g"), (VAULT_KEY, "k")]);
        let helper = helper(dir.path(), &items);
        assert_eq!(helper.get(GATEWAY).unwrap().as_deref(), Some("g"));
        assert_eq!(helper.get(VAULT_KEY).unwrap().as_deref(), Some("k"));
        assert_eq!(
            items.bundle(HELPER_BUNDLE).get(GATEWAY).map(String::as_str),
            Some("g")
        );
        assert_eq!(
            items
                .bundle(HELPER_BUNDLE)
                .get(VAULT_KEY)
                .map(String::as_str),
            Some("k"),
            "the second move keeps the first"
        );
        assert_eq!(items.item(GATEWAY).as_deref(), Some("g"));
        // A new pairing: in the bundle and its own item, and said beside it.
        let rev = std::fs::read_to_string(dir.path().join(REV_FILE)).unwrap();
        helper.set(LOCAL, "d").unwrap();
        assert_eq!(
            items.bundle(HELPER_BUNDLE).get(LOCAL).map(String::as_str),
            Some("d")
        );
        assert_eq!(items.item(LOCAL).as_deref(), Some("d"), "for an older Desk");
        assert_ne!(
            std::fs::read_to_string(dir.path().join(REV_FILE)).unwrap(),
            rev
        );
        // The app, in its own process, reads the one bundle.
        let app = app(dir.path(), &items);
        let before = items.reads.load(Ordering::SeqCst);
        assert_eq!(app.get(GATEWAY).unwrap().as_deref(), Some("g"));
        assert_eq!(app.get(LOCAL).unwrap().as_deref(), Some("d"));
        assert_eq!(items.reads.load(Ordering::SeqCst) - before, 1);
    }

    #[test]
    fn a_write_keeps_what_another_helper_process_wrote() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[]);
        let one = helper(dir.path(), &items);
        let two = helper(dir.path(), &items);
        assert_eq!(one.get(GATEWAY).unwrap(), None);
        two.set(VAULT_KEY, "k").unwrap();
        one.set(GATEWAY, "g").unwrap();
        let bundle = items.bundle(HELPER_BUNDLE);
        assert_eq!(bundle.get(VAULT_KEY).map(String::as_str), Some("k"));
        assert_eq!(bundle.get(GATEWAY).map(String::as_str), Some("g"));
    }

    #[test]
    fn concurrent_first_reads_read_once() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[(HELPER_BUNDLE, r#"{"secrets":{"hub-gateway-token":"g"}}"#)]);
        let v = Arc::new(app(dir.path(), &items));
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

    /// Credential Manager's limit on an item: 2560 bytes, as UTF-16.
    fn fits_credential_manager(value: &str) -> bool {
        value.encode_utf16().count() * 2 <= 2560
    }

    #[test]
    fn off_macos_each_secret_is_its_own_item_so_any_number_of_hubs_fit() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[]);
        let v = Vault::new_as(dir.path(), items.clone(), KeyOwner::App).laid_out(Layout::Separate);
        // A token as hubs pair them (`wfp_` and 32 hex), on long hostnames.
        let token = format!("wfp_{}", "0123456789abcdef".repeat(2));
        let accounts: Vec<String> = (0..200)
            .map(|i| device_token_account(&format!("hub-{i}-{}", "x".repeat(60))))
            .collect();
        for a in &accounts {
            v.set(a, &token).unwrap();
        }
        assert!(items.item(APP_BUNDLE).is_none(), "no bundle");
        for a in &accounts {
            let stored = items.item(a).unwrap();
            assert!(fits_credential_manager(&stored));
        }
        let read = items.calls();
        for a in &accounts {
            assert_eq!(v.get(a).unwrap().as_deref(), Some(token.as_str()));
        }
        assert_eq!(items.calls(), read, "cached all the same");
        // Twenty such hubs as one bundle wouldn't have fit.
        let bundle = serde_json::to_string(&Stored {
            secrets: accounts
                .iter()
                .take(20)
                .map(|a| (a.clone(), token.clone()))
                .collect(),
        })
        .unwrap();
        assert!(!fits_credential_manager(&bundle));
    }

    #[test]
    fn off_macos_the_helpers_changes_reach_the_app_too() {
        let dir = tempfile::tempdir().unwrap();
        let items = Counted::with(&[]);
        let helper =
            Vault::new_as(dir.path(), items.clone(), KeyOwner::Helper).laid_out(Layout::Separate);
        let app =
            Vault::new_as(dir.path(), items.clone(), KeyOwner::App).laid_out(Layout::Separate);
        assert_eq!(app.get(LOCAL).unwrap(), None);
        helper.set(LOCAL, "old").unwrap();
        assert_eq!(app.get(LOCAL).unwrap().as_deref(), Some("old"));
        let read = items.calls();
        assert_eq!(app.get(LOCAL).unwrap().as_deref(), Some("old"));
        assert_eq!(items.calls(), read);
        helper.set(LOCAL, "new").unwrap();
        assert_eq!(app.get(LOCAL).unwrap().as_deref(), Some("new"));
        helper.delete(LOCAL).unwrap();
        assert_eq!(app.get(LOCAL).unwrap(), None);
        helper.set(GATEWAY, "g").unwrap();
        helper.forget(KeyOwner::Helper, &helper_accounts()).unwrap();
        assert_eq!(app.get(GATEWAY).unwrap(), None);
        assert!(items.item(HELPER_BUNDLE).is_none() && items.item(APP_BUNDLE).is_none());
    }
}
