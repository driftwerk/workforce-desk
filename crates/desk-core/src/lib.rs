//! What the Desk app and `desk-hubd` share: where Desk keeps its files, the
//! local hub's ports and secrets, how to reach the backend wherever it runs,
//! its PTY holder, and what this computer and its person are called.

pub mod backend;
#[cfg(unix)]
pub mod holder;
pub mod host;
pub mod install;
#[cfg(unix)]
pub mod process;
pub mod redact;
pub mod shell;

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use eyre::{Context, Result};
use rand::RngExt;
use serde::{Deserialize, Serialize};

use crate::host::Host;

/// Desk's bundle identifier.
pub const BUNDLE_ID: &str = "xyz.driftwerk.desk";
/// The service Desk's items are kept under in the keychain, Credential
/// Manager or Secret Service.
pub const KEYRING_SERVICE: &str = "xyz.driftwerk.desk";
/// The login item that keeps Desk's helper running: registered with
/// `SMAppService` from the plist inside the app bundle.
pub const LAUNCH_AGENT_LABEL: &str = "xyz.driftwerk.desk.helper";
/// The LaunchAgent earlier builds wrote to `~/Library/LaunchAgents` by hand;
/// moved to [`LAUNCH_AGENT_LABEL`] once.
pub const LEGACY_LAUNCH_AGENT_LABEL: &str = "xyz.driftwerk.desk.hub";

/// The backend's programs on Linux, natively and inside WSL.
pub const LINUX_HELPER_EXECUTABLE: &str = "desk-helper";
pub const LINUX_HUB_EXECUTABLE: &str = "desk-agents";
pub const LINUX_MEMORY_EXECUTABLE: &str = "desk-memory";

/// The supervisor: in `Desk.app/Contents/MacOS` the name Activity Monitor
/// shows; on Windows the launcher that runs the Linux one inside WSL.
#[cfg(any(target_os = "macos", windows))]
pub const HELPER_EXECUTABLE: &str = "Desk Helper";
#[cfg(all(unix, not(target_os = "macos")))]
pub const HELPER_EXECUTABLE: &str = LINUX_HELPER_EXECUTABLE;
/// The local hub's executable beside it.
#[cfg(target_os = "macos")]
pub const HUB_EXECUTABLE: &str = "Desk Agents";
#[cfg(all(unix, not(target_os = "macos")))]
pub const HUB_EXECUTABLE: &str = LINUX_HUB_EXECUTABLE;
/// The local hub's memory store (a vellev node) beside them.
#[cfg(target_os = "macos")]
pub const MEMORY_EXECUTABLE: &str = "Desk Memory";
#[cfg(all(unix, not(target_os = "macos")))]
pub const MEMORY_EXECUTABLE: &str = LINUX_MEMORY_EXECUTABLE;

/// Desk's folder and what lives under it: `~/Library/Application
/// Support/Desk` on macOS, `~/.local/share/Desk` on Linux and inside WSL,
/// `%APPDATA%\Desk` on Windows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    pub root: PathBuf,
}

impl Paths {
    /// `DESK_HOME` overrides the location (for development and tests).
    pub fn new() -> Result<Self> {
        if let Some(home) = std::env::var_os("DESK_HOME") {
            return Ok(Self::at(home));
        }
        let root = dirs::data_dir()
            .ok_or_else(|| eyre::eyre!("no folder for applications' data"))?
            .join("Desk");
        Ok(Self { root })
    }

    pub fn at(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn hub(&self) -> PathBuf {
        self.root.join("hub")
    }
    pub fn hub_data(&self) -> PathBuf {
        self.hub().join("data")
    }
    pub fn postgres_data(&self) -> PathBuf {
        self.hub().join("postgres")
    }
    pub fn postgres_install(&self) -> PathBuf {
        self.hub().join("postgres-install")
    }
    pub fn hub_config(&self) -> PathBuf {
        self.hub().join("workforce.toml")
    }
    pub fn hub_state(&self) -> PathBuf {
        self.hub().join("state.toml")
    }
    pub fn logs(&self) -> PathBuf {
        self.root.join("logs")
    }
    /// Where Desk Helper writes its process id while it runs.
    pub fn helper_pid(&self) -> PathBuf {
        self.hub().join("run").join("desk-hubd.pid")
    }
    /// The backend's installed versions, inside WSL.
    pub fn bin(&self) -> PathBuf {
        self.root.join("bin")
    }
    /// The backend the app uses, where setup chose one (WSL on Windows).
    pub fn backend_host(&self) -> PathBuf {
        self.root.join("backend.json")
    }
    /// Which store this folder's secrets are in, once chosen.
    pub fn keys(&self) -> PathBuf {
        self.root.join("keys.toml")
    }
    /// The memory store's folder: its data, its cache, and the embedding
    /// model it runs.
    pub fn memory(&self) -> PathBuf {
        self.hub().join("memory")
    }
    pub fn memory_store(&self) -> PathBuf {
        self.memory().join("store")
    }
    pub fn memory_cache(&self) -> PathBuf {
        self.memory().join("cache")
    }
    pub fn memory_models(&self) -> PathBuf {
        self.memory().join("models")
    }
    /// How far the embedding model's download has got, for Desk to show.
    pub fn memory_model_state(&self) -> PathBuf {
        self.memory().join("model.json")
    }
    /// Written once the memories kept in SQLite were moved into the memory
    /// store and checked.
    pub fn memory_moved(&self) -> PathBuf {
        self.memory().join("moved.json")
    }
    /// The local hub's SQLite memories, before they move to the memory store.
    pub fn sqlite_memories(&self) -> PathBuf {
        self.hub_data().join("memory.db")
    }
    pub fn themes(&self) -> PathBuf {
        self.root.join("themes")
    }
    pub fn settings(&self) -> PathBuf {
        self.root.join("settings.json")
    }
    pub fn hubs(&self) -> PathBuf {
        self.root.join("hubs.json")
    }
    /// What Desk restores on launch (its views, selection and window
    /// frames), kept here as well as on the hub.
    pub fn desk_state(&self) -> PathBuf {
        self.root.join("desk-state.json")
    }
}

/// Ports chosen on first run and kept, so the app always finds the hub.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct HubPorts {
    pub postgres: u16,
    pub admin: u16,
    pub gateway: u16,
    /// The memory store's; 0 in a `state.toml` from before it, until one is
    /// chosen.
    #[serde(default)]
    pub memory: u16,
}

impl HubPorts {
    pub fn gateway_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.gateway)
    }
}

pub fn read_ports(path: &Path) -> Result<Option<HubPorts>> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(Some(
            toml::from_str(&s).with_context(|| format!("reading {}", path.display()))?,
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

pub fn write_ports(path: &Path, ports: &HubPorts) -> Result<()> {
    write_private(path, &toml::to_string(ports)?)
}

/// Writes a file only the user can read, atomically (on Windows the
/// folder's own access list keeps it the user's).
pub fn write_private(path: &Path, contents: &str) -> Result<()> {
    use std::io::Write;
    let dir = path
        .parent()
        .ok_or_else(|| eyre::eyre!("{} has no folder", path.display()))?;
    std::fs::create_dir_all(dir)?;
    let tmp = path.with_extension("tmp");
    let mut f = std::fs::File::create(&tmp)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    f.write_all(contents.as_bytes())?;
    f.sync_all()?;
    std::fs::rename(&tmp, path).with_context(|| format!("writing {}", path.display()))
}

/// The local hub's secrets, each one item in the secret store.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Secret {
    GatewayToken,
    JwtSecret,
    VaultKey,
    PostgresPassword,
    MemoryKey,
}

impl Secret {
    pub const ALL: [Secret; 5] = [
        Secret::GatewayToken,
        Secret::JwtSecret,
        Secret::VaultKey,
        Secret::PostgresPassword,
        Secret::MemoryKey,
    ];

    /// Its account in the secret store.
    pub fn account(self) -> &'static str {
        match self {
            Secret::GatewayToken => "hub-gateway-token",
            Secret::JwtSecret => "hub-jwt-secret",
            Secret::VaultKey => "hub-vault-key",
            Secret::PostgresPassword => "hub-postgres-password",
            Secret::MemoryKey => "hub-memory-key",
        }
    }

    /// The hub's environment variable for this secret.
    pub fn env(self) -> &'static str {
        match self {
            Secret::GatewayToken => "WORKFORCE_GATEWAY_TOKEN",
            Secret::JwtSecret => "WORKFORCE_JWT_SECRET",
            Secret::VaultKey => "WORKFORCE_VAULT_KEY",
            Secret::PostgresPassword => "DESK_POSTGRES_PASSWORD",
            Secret::MemoryKey => "DESK_MEMORY_KEY",
        }
    }

    /// 32 random bytes: base64 for the vault key (the format the vault
    /// expects), URL-safe base64 for the rest.
    fn generate(self) -> String {
        let mut bytes = [0u8; 32];
        rand::rng().fill(&mut bytes);
        match self {
            Secret::VaultKey => base64::engine::general_purpose::STANDARD.encode(bytes),
            _ => base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes),
        }
    }
}

pub trait SecretStore {
    fn get(&self, secret: Secret) -> Result<Option<String>>;
    fn set(&self, secret: Secret, value: &str) -> Result<()>;

    /// The secret, created on first use.
    fn get_or_create(&self, secret: Secret) -> Result<String> {
        if let Some(v) = self.get(secret)? {
            return Ok(v);
        }
        let v = secret.generate();
        self.set(secret, &v)?;
        Ok(v)
    }
}

/// The system's own store: the keychain on macOS, Credential Manager on
/// Windows, the Secret Service on a Linux desktop.
pub struct Keyring;

impl Keyring {
    /// An item by account name, for secrets beyond [`Secret`] (one device
    /// token per paired hub).
    pub fn get_account(&self, account: &str) -> Result<Option<String>> {
        match keyring::Entry::new(KEYRING_SERVICE, account)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e)
                .with_context(|| format!("reading {account} from {}", KeyStore::System.name())),
        }
    }

    pub fn set_account(&self, account: &str, value: &str) -> Result<()> {
        keyring::Entry::new(KEYRING_SERVICE, account)?
            .set_password(value)
            .with_context(|| format!("saving {account} to {}", KeyStore::System.name()))
    }

    pub fn delete_account(&self, account: &str) -> Result<()> {
        match keyring::Entry::new(KEYRING_SERVICE, account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e)
                .with_context(|| format!("removing {account} from {}", KeyStore::System.name())),
        }
    }

    /// Whether the store answers within `within`: a Linux session may have
    /// no Secret Service, or one that never replies.
    pub fn answers(within: Duration) -> bool {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let answered =
                keyring::Entry::new(KEYRING_SERVICE, "probe").and_then(|e| e.get_password());
            let _ = tx.send(matches!(answered, Ok(_) | Err(keyring::Error::NoEntry)));
        });
        rx.recv_timeout(within).unwrap_or(false)
    }
}

/// Secrets in a private file: inside WSL, on a Linux session with no
/// Secret Service, and for development runs with `DESK_HOME` set (a rebuilt,
/// unsigned binary is a new keychain identity, so every build would
/// otherwise stop at a keychain prompt).
pub struct FileSecrets {
    path: PathBuf,
}
impl FileSecrets {
    pub fn new(paths: &Paths) -> Self {
        Self {
            path: paths.root.join("secrets.toml"),
        }
    }

    fn read(&self) -> Result<toml::Table> {
        match std::fs::read_to_string(&self.path) {
            Ok(s) => Ok(toml::from_str(&s)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(toml::Table::new()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn get_account(&self, account: &str) -> Result<Option<String>> {
        Ok(self
            .read()?
            .get(account)
            .and_then(|v| v.as_str())
            .map(str::to_string))
    }

    pub fn set_account(&self, account: &str, value: &str) -> Result<()> {
        let mut t = self.read()?;
        t.insert(account.into(), toml::Value::String(value.into()));
        write_private(&self.path, &toml::to_string(&t)?)
    }

    pub fn delete_account(&self, account: &str) -> Result<()> {
        let mut t = self.read()?;
        if t.remove(account).is_some() {
            write_private(&self.path, &toml::to_string(&t)?)?;
        }
        Ok(())
    }
}

/// Where a secret store is, as Settings → Help says it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyStore {
    /// The system's own store ([`Keyring`]).
    System,
    File,
}

impl KeyStore {
    /// The system store's name on this platform, or the file's.
    pub fn name(self) -> &'static str {
        match self {
            KeyStore::File => "Desk's private file",
            KeyStore::System if cfg!(target_os = "macos") => "the keychain",
            KeyStore::System if cfg!(windows) => "Credential Manager",
            KeyStore::System => "your keyring",
        }
    }
}

/// The choice a Linux session made once, kept so a later session where the
/// Secret Service answers (or stops answering) still finds the secrets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct KeysChoice {
    store: KeyStore,
}

fn read_keys_choice(path: &Path) -> Result<Option<KeyStore>> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(Some(
            toml::from_str::<KeysChoice>(&s)
                .with_context(|| format!("reading {}", path.display()))?
                .store,
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

/// The store `keys.toml` names, or, the first time, the system's when it
/// `answers` and else the file, kept there.
fn chosen(paths: &Paths, answers: impl FnOnce() -> bool) -> Result<KeyStore> {
    if let Some(store) = read_keys_choice(&paths.keys())? {
        return Ok(store);
    }
    let store = if answers() {
        KeyStore::System
    } else {
        KeyStore::File
    };
    write_private(&paths.keys(), &toml::to_string(&KeysChoice { store })?)?;
    Ok(store)
}

/// How long a Linux session's Secret Service gets to answer.
const KEYRING_PROBE: Duration = Duration::from_secs(2);

/// Where secrets live.
pub enum Secrets {
    Keyring(Keyring),
    File(FileSecrets),
}

impl Secrets {
    /// The store for the secrets of a process on `host`:
    /// - `DESK_HOME` set (development): a private file;
    /// - inside WSL: a private file (no session bus or keyring there by
    ///   default, and the distro's files are already the person's);
    /// - macOS and Windows: the keychain or Credential Manager;
    /// - a Linux desktop: the Secret Service when it answers the first time,
    ///   else a private file, chosen once and kept in `keys.toml`.
    pub fn for_host(paths: &Paths, host: &Host) -> Result<Self> {
        let store = match (std::env::var_os("DESK_HOME"), host) {
            (Some(_), _) | (None, Host::Wsl(_)) => KeyStore::File,
            (None, Host::Native) if cfg!(any(target_os = "macos", windows)) => KeyStore::System,
            (None, Host::Native) => chosen(paths, || Keyring::answers(KEYRING_PROBE))?,
        };
        Ok(Self::of(paths, store))
    }

    pub fn of(paths: &Paths, store: KeyStore) -> Self {
        match store {
            KeyStore::System => Secrets::Keyring(Keyring),
            KeyStore::File => Secrets::File(FileSecrets::new(paths)),
        }
    }

    pub fn store(&self) -> KeyStore {
        match self {
            Secrets::Keyring(_) => KeyStore::System,
            Secrets::File(_) => KeyStore::File,
        }
    }

    pub fn get_account(&self, account: &str) -> Result<Option<String>> {
        match self {
            Secrets::Keyring(k) => k.get_account(account),
            Secrets::File(f) => f.get_account(account),
        }
    }

    pub fn set_account(&self, account: &str, value: &str) -> Result<()> {
        match self {
            Secrets::Keyring(k) => k.set_account(account, value),
            Secrets::File(f) => f.set_account(account, value),
        }
    }

    pub fn delete_account(&self, account: &str) -> Result<()> {
        match self {
            Secrets::Keyring(k) => k.delete_account(account),
            Secrets::File(f) => f.delete_account(account),
        }
    }

    /// Deletes the local hub's secrets and Desk's token for it.
    pub fn forget_backend(&self) -> Result<()> {
        for s in Secret::ALL {
            self.delete_account(s.account())?;
        }
        self.delete_account(&device_token_account(LOCAL_HUB_ID))
    }
}

impl SecretStore for Secrets {
    fn get(&self, secret: Secret) -> Result<Option<String>> {
        self.get_account(secret.account())
    }

    fn set(&self, secret: Secret, value: &str) -> Result<()> {
        self.set_account(secret.account(), value)
    }
}

/// The account holding a hub's paired-device token.
pub fn device_token_account(hub_id: &str) -> String {
    format!("hub-{hub_id}-device-token")
}

pub const LOCAL_HUB_ID: &str = "local";

/// A name the system gave, if it gave one that says anything.
fn named<E>(name: std::result::Result<String, E>) -> Option<String> {
    name.ok()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
}

/// What this computer is called, as its system names it to people: the
/// name WSL's launcher passes in from Windows, else its device name, else
/// its host name.
pub fn computer_name() -> Option<String> {
    named(std::env::var(host::COMPUTER_NAME_ENV))
        .or_else(|| named(whoami::devicename()))
        .or_else(|| named(whoami::hostname()))
}

/// Who uses this computer, as its system names them: their full name, else
/// their account's.
pub fn person_name() -> Option<String> {
    named(whoami::realname()).or_else(|| named(whoami::username()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Memory(RefCell<HashMap<&'static str, String>>);

    impl SecretStore for Memory {
        fn get(&self, s: Secret) -> Result<Option<String>> {
            Ok(self.0.borrow().get(s.account()).cloned())
        }
        fn set(&self, s: Secret, v: &str) -> Result<()> {
            self.0.borrow_mut().insert(s.account(), v.to_string());
            Ok(())
        }
    }

    #[test]
    fn secrets_are_created_once_and_kept() {
        let store = Memory::default();
        let a = store.get_or_create(Secret::GatewayToken).unwrap();
        assert_eq!(store.get_or_create(Secret::GatewayToken).unwrap(), a);
        assert_ne!(store.get_or_create(Secret::JwtSecret).unwrap(), a);
        let key = store.get_or_create(Secret::VaultKey).unwrap();
        let raw = base64::engine::general_purpose::STANDARD
            .decode(key)
            .unwrap();
        assert_eq!(raw.len(), 32);
    }

    #[test]
    fn file_secrets_are_private_and_persist() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        let f = FileSecrets::new(&paths);
        assert_eq!(f.get_account("a").unwrap(), None);
        f.set_account("a", "1").unwrap();
        f.set_account("b", "2").unwrap();
        assert_eq!(
            FileSecrets::new(&paths)
                .get_account("a")
                .unwrap()
                .as_deref(),
            Some("1")
        );
        f.delete_account("a").unwrap();
        assert_eq!(f.get_account("a").unwrap(), None);
        assert_private(&dir.path().join("secrets.toml"));
    }

    #[cfg(unix)]
    fn assert_private(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[cfg(not(unix))]
    fn assert_private(path: &Path) {
        assert!(path.is_file());
    }

    #[test]
    fn a_linux_session_keeps_the_store_it_first_chose() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        assert_eq!(chosen(&paths, || false).unwrap(), KeyStore::File);
        // A keyring that answers later doesn't move the secrets.
        assert_eq!(chosen(&paths, || true).unwrap(), KeyStore::File);
        assert_private(&paths.keys());
        let other = tempfile::tempdir().unwrap();
        let paths = Paths::at(other.path());
        assert_eq!(chosen(&paths, || true).unwrap(), KeyStore::System);
        assert_eq!(chosen(&paths, || false).unwrap(), KeyStore::System);
    }

    #[test]
    fn wsl_keeps_its_secrets_in_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        let wsl = Host::Wsl(host::Wsl {
            distro: "Ubuntu".into(),
            user: "sarah".into(),
            home: "/home/sarah".into(),
            automount: host::DEFAULT_AUTOMOUNT.into(),
        });
        assert_eq!(
            Secrets::for_host(&paths, &wsl).unwrap().store(),
            KeyStore::File
        );
        assert!(!paths.keys().exists());
    }

    #[test]
    fn the_backends_secrets_are_forgotten_and_others_kept() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Secrets::of(&Paths::at(dir.path()), KeyStore::File);
        for s in Secret::ALL {
            secrets.get_or_create(s).unwrap();
        }
        secrets
            .set_account(&device_token_account(LOCAL_HUB_ID), "local")
            .unwrap();
        secrets
            .set_account(&device_token_account("acme"), "remote")
            .unwrap();
        secrets.forget_backend().unwrap();
        for s in Secret::ALL {
            assert_eq!(secrets.get(s).unwrap(), None);
        }
        assert_eq!(
            secrets
                .get_account(&device_token_account(LOCAL_HUB_ID))
                .unwrap(),
            None
        );
        assert_eq!(
            secrets
                .get_account(&device_token_account("acme"))
                .unwrap()
                .as_deref(),
            Some("remote")
        );
    }

    #[test]
    fn ports_round_trip_through_a_private_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hub/state.toml");
        assert_eq!(read_ports(&path).unwrap(), None);
        let ports = HubPorts {
            postgres: 1,
            admin: 2,
            gateway: 3,
            memory: 4,
        };
        write_ports(&path, &ports).unwrap();
        assert_eq!(read_ports(&path).unwrap(), Some(ports));
        assert_private(&path);
    }

    #[test]
    fn ports_saved_before_the_memory_store_still_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.toml");
        std::fs::write(&path, "postgres = 1\nadmin = 2\ngateway = 3\n").unwrap();
        assert_eq!(
            read_ports(&path).unwrap(),
            Some(HubPorts {
                postgres: 1,
                admin: 2,
                gateway: 3,
                memory: 0,
            })
        );
    }
}
