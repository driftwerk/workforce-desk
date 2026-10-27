//! What the Desk app and `desk-hubd` share: where Desk keeps its files, the
//! local hub's ports, and its secrets in the macOS keychain.

pub mod shell;

use std::path::{Path, PathBuf};

use base64::Engine;
use eyre::{Context, Result};
use rand::RngExt;
use serde::{Deserialize, Serialize};

pub const KEYCHAIN_SERVICE: &str = "xyz.driftwerk.desk";
pub const LAUNCH_AGENT_LABEL: &str = "xyz.driftwerk.desk.hub";

/// `~/Library/Application Support/Desk` and what lives under it.
#[derive(Debug, Clone)]
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
            .ok_or_else(|| eyre::eyre!("no Application Support folder"))?
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
    pub fn themes(&self) -> PathBuf {
        self.root.join("themes")
    }
    pub fn settings(&self) -> PathBuf {
        self.root.join("settings.json")
    }
    pub fn hubs(&self) -> PathBuf {
        self.root.join("hubs.json")
    }
}

/// Ports chosen on first run and kept, so the app always finds the hub.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct HubPorts {
    pub postgres: u16,
    pub admin: u16,
    pub gateway: u16,
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

/// Writes a file only the user can read, atomically.
pub fn write_private(path: &Path, contents: &str) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    let dir = path
        .parent()
        .ok_or_else(|| eyre::eyre!("{} has no folder", path.display()))?;
    std::fs::create_dir_all(dir)?;
    let tmp = path.with_extension("tmp");
    let mut f = std::fs::File::create(&tmp)?;
    f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    f.write_all(contents.as_bytes())?;
    f.sync_all()?;
    std::fs::rename(&tmp, path).with_context(|| format!("writing {}", path.display()))
}

/// The local hub's secrets, each one keychain item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Secret {
    GatewayToken,
    JwtSecret,
    VaultKey,
    PostgresPassword,
}

impl Secret {
    pub const ALL: [Secret; 4] = [
        Secret::GatewayToken,
        Secret::JwtSecret,
        Secret::VaultKey,
        Secret::PostgresPassword,
    ];

    fn account(self) -> &'static str {
        match self {
            Secret::GatewayToken => "hub-gateway-token",
            Secret::JwtSecret => "hub-jwt-secret",
            Secret::VaultKey => "hub-vault-key",
            Secret::PostgresPassword => "hub-postgres-password",
        }
    }

    /// The hub's environment variable for this secret.
    pub fn env(self) -> &'static str {
        match self {
            Secret::GatewayToken => "WORKFORCE_GATEWAY_TOKEN",
            Secret::JwtSecret => "WORKFORCE_JWT_SECRET",
            Secret::VaultKey => "WORKFORCE_VAULT_KEY",
            Secret::PostgresPassword => "DESK_POSTGRES_PASSWORD",
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

pub struct Keychain;

impl Keychain {
    /// A keychain item by account name, for secrets beyond [`Secret`] (one
    /// device token per paired hub).
    pub fn get_account(&self, account: &str) -> Result<Option<String>> {
        match keyring::Entry::new(KEYCHAIN_SERVICE, account)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e).with_context(|| format!("reading {account} from the keychain")),
        }
    }

    pub fn set_account(&self, account: &str, value: &str) -> Result<()> {
        keyring::Entry::new(KEYCHAIN_SERVICE, account)?
            .set_password(value)
            .with_context(|| format!("saving {account} to the keychain"))
    }

    pub fn delete_account(&self, account: &str) -> Result<()> {
        match keyring::Entry::new(KEYCHAIN_SERVICE, account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e).with_context(|| format!("removing {account} from the keychain")),
        }
    }
}

/// Secrets in a private file, for development runs with `DESK_HOME` set: a
/// rebuilt, unsigned binary is a new keychain identity, so every build
/// would otherwise stop at a keychain prompt.
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

/// Where secrets live: the keychain, or a private file under `DESK_HOME`.
pub enum Secrets {
    Keychain(Keychain),
    File(FileSecrets),
}

impl Secrets {
    pub fn for_paths(paths: &Paths) -> Self {
        if std::env::var_os("DESK_HOME").is_some() {
            Secrets::File(FileSecrets::new(paths))
        } else {
            Secrets::Keychain(Keychain)
        }
    }

    pub fn get_account(&self, account: &str) -> Result<Option<String>> {
        match self {
            Secrets::Keychain(k) => k.get_account(account),
            Secrets::File(f) => f.get_account(account),
        }
    }

    pub fn set_account(&self, account: &str, value: &str) -> Result<()> {
        match self {
            Secrets::Keychain(k) => k.set_account(account, value),
            Secrets::File(f) => f.set_account(account, value),
        }
    }

    pub fn delete_account(&self, account: &str) -> Result<()> {
        match self {
            Secrets::Keychain(k) => k.delete_account(account),
            Secrets::File(f) => f.delete_account(account),
        }
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

/// The keychain account holding a hub's paired-device token.
pub fn device_token_account(hub_id: &str) -> String {
    format!("hub-{hub_id}-device-token")
}

pub const LOCAL_HUB_ID: &str = "local";

impl SecretStore for Keychain {
    fn get(&self, secret: Secret) -> Result<Option<String>> {
        self.get_account(secret.account())
    }

    fn set(&self, secret: Secret, value: &str) -> Result<()> {
        self.set_account(secret.account(), value)
    }
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
        use std::os::unix::fs::PermissionsExt;
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
        let mode = std::fs::metadata(dir.path().join("secrets.toml"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn ports_round_trip_through_a_private_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hub/state.toml");
        assert_eq!(read_ports(&path).unwrap(), None);
        let ports = HubPorts {
            postgres: 1,
            admin: 2,
            gateway: 3,
        };
        write_ports(&path, &ports).unwrap();
        assert_eq!(read_ports(&path).unwrap(), Some(ports));
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
