//! The hubs Desk talks to. The list lives in `hubs.json`; each hub's
//! paired-device token lives with the app's secrets. The local hub is always
//! first, once `desk-hubd` has paired Desk with it.
//!
//! The page is told each hub but never its token: it reaches a hub by id,
//! through `hub_io`, which adds the token on this side.

use desk_core::backend::{Backend, Connection};
use desk_core::host::Host;
use desk_core::{LOCAL_HUB_ID, Paths, Secrets, device_token_account};
use eyre::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HubRecord {
    pub id: String,
    pub label: String,
    pub url: String,
}

/// A hub as Desk reaches it. Serialized for the page without its token;
/// deliberately not `Debug`, which would print it.
#[derive(Clone, Serialize)]
pub struct HubAccount {
    pub id: String,
    pub label: String,
    pub url: String,
    pub local: bool,
    /// Changes whenever the token does, so the page can tell a hub paired
    /// again (or a renewed token) from the one it had; see [`revision`].
    pub revision: String,
    #[serde(skip)]
    pub token: String,
}

impl HubAccount {
    fn new(id: String, label: String, url: String, local: bool, token: String) -> Self {
        Self {
            revision: revision(&token),
            id,
            label,
            url,
            local,
            token,
        }
    }
}

/// An opaque stand-in for `token`: a hash of it under a key this run of
/// Desk picked at random. It tells tokens apart, says nothing about them,
/// and can't be matched with one from another run or another computer.
pub fn revision(token: &str) -> String {
    use sha2::{Digest, Sha256};
    static KEY: std::sync::OnceLock<[u8; 32]> = std::sync::OnceLock::new();
    let key = KEY.get_or_init(|| {
        use rand::RngExt;
        let mut key = [0u8; 32];
        rand::rng().fill(&mut key);
        key
    });
    let digest = Sha256::new()
        .chain_update(key)
        .chain_update(token.as_bytes())
        .finalize();
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

pub fn read_records(paths: &Paths) -> Result<Vec<HubRecord>> {
    match std::fs::read_to_string(paths.hubs()) {
        Ok(s) => Ok(serde_json::from_str(&s)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e.into()),
    }
}

fn write_records(paths: &Paths, records: &[HubRecord]) -> Result<()> {
    desk_core::write_private(&paths.hubs(), &serde_json::to_string_pretty(records)?)
}

/// A stable id from the hub's address: `workforce.example.com` → `workforce-example-com`.
pub fn id_for(url: &str) -> Result<String> {
    let host = url
        .split("://")
        .nth(1)
        .and_then(|rest| rest.split(['/', ':']).next())
        .filter(|h| !h.is_empty())
        .ok_or_else(|| eyre::eyre!("{url} is not a hub address"))?;
    Ok(host
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect())
}

/// The app's own secrets (remote hubs' device tokens), kept on this
/// computer wherever the backend runs.
pub fn app_secrets(paths: &Paths) -> Result<Secrets> {
    Secrets::for_host(paths, &Host::Native)
}

/// Every hub Desk can reach, with its device token: what each page load
/// asks. Secrets are read from the store once per process (`desk_core::vault`),
/// so a reload reads none.
pub fn accounts(paths: &Paths, backend: Option<&Backend>) -> Result<Vec<HubAccount>> {
    let local = match backend {
        Some(b) => b.connection()?,
        None => None,
    };
    accounts_with(paths, local, &app_secrets(paths)?)
}

fn accounts_with(
    paths: &Paths,
    local: Option<Connection>,
    secrets: &Secrets,
) -> Result<Vec<HubAccount>> {
    let mut out = Vec::new();
    if let Some(c) = local
        && let Some(token) = c.device_token
    {
        out.push(HubAccount::new(
            LOCAL_HUB_ID.into(),
            desk_core::computer_name().unwrap_or_else(|| "This computer".into()),
            c.gateway_url,
            true,
            token,
        ));
    }
    for r in read_records(paths)? {
        if let Some(token) = secrets.get_account(&device_token_account(&r.id))? {
            out.push(HubAccount::new(r.id, r.label, r.url, false, token));
        }
    }
    Ok(out)
}

/// Keeps a remote hub Desk has just been paired with. Pairing the same
/// address again (to connect as yourself, say) replaces its token where it
/// is: the id comes from the host, so it — and every grid, group and DM
/// that names its agents — stays the same, and so does its place.
pub fn save(paths: &Paths, label: &str, url: &str, token: &str) -> Result<HubRecord> {
    save_with(&app_secrets(paths)?, paths, label, url, token)
}

pub(crate) fn save_with(
    secrets: &Secrets,
    paths: &Paths,
    label: &str,
    url: &str,
    token: &str,
) -> Result<HubRecord> {
    // https, or a hub on this computer by address: where its token may go.
    let url = desk_core::net::hub_url(url)
        .map_err(|e| eyre::eyre!(e))?
        .as_str()
        .trim_end_matches('/')
        .to_string();
    let record = HubRecord {
        id: id_for(&url)?,
        label: label.trim().to_string(),
        url,
    };
    if record.id == LOCAL_HUB_ID {
        eyre::bail!("that name is reserved for the local hub");
    }
    let mut records = read_records(paths)?;
    // Ids come from the host, and two hosts can make the same one
    // (`a.b-c.example`, `a-b.c.example`): a workspace elsewhere never takes
    // over another's id, and with it the conversations Desk keeps for it.
    if let Some(kept) = records
        .iter()
        .find(|r| r.id == record.id && !same_place(&r.url, &record.url))
    {
        eyre::bail!(
            "Desk is already connected to {} under that name. Remove it from Settings first.",
            kept.url
        );
    }
    secrets.set_account(&device_token_account(&record.id), token)?;
    match records.iter_mut().find(|r| r.id == record.id) {
        Some(kept) => *kept = record.clone(),
        None => records.push(record.clone()),
    }
    write_records(paths, &records)?;
    Ok(record)
}

/// Whether two hub addresses are the same place, as Desk keeps them.
pub(crate) fn same_place(a: &str, b: &str) -> bool {
    match (desk_core::net::hub_url(a), desk_core::net::hub_url(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a.trim_end_matches('/') == b.trim_end_matches('/'),
    }
}

pub fn remove(paths: &Paths, id: &str) -> Result<()> {
    let records: Vec<_> = read_records(paths)?
        .into_iter()
        .filter(|r| r.id != id)
        .collect();
    write_records(paths, &records)?;
    app_secrets(paths)?.delete_account(&device_token_account(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A store that counts what it is asked.
    #[derive(Default)]
    struct Counted {
        items: std::sync::Mutex<std::collections::HashMap<String, String>>,
        calls: std::sync::atomic::AtomicUsize,
    }

    impl desk_core::vault::Items for Counted {
        fn get(&self, account: &str) -> Result<Option<String>> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(self.items.lock().unwrap().get(account).cloned())
        }
        fn set(&self, account: &str, value: &str) -> Result<()> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.items
                .lock()
                .unwrap()
                .insert(account.into(), value.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<()> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.items.lock().unwrap().remove(account);
            Ok(())
        }
    }

    #[test]
    fn reloading_the_page_reads_nothing_from_the_keychain() {
        use desk_core::vault::{KeyOwner, Vault};
        use std::sync::atomic::Ordering;
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        desk_core::write_ports(
            &paths.hub_state(),
            &desk_core::HubPorts {
                postgres: 1,
                admin: 2,
                gateway: 3,
                memory: 4,
            },
        )
        .unwrap();
        // As an older Desk left them: one item per secret, the helper's and
        // a remote hub's.
        let store = std::sync::Arc::new(Counted::default());
        for (k, v) in [
            ("hub-gateway-token", "gateway"),
            ("hub-local-device-token", "local"),
            ("hub-a-example-com-device-token", "remote"),
        ] {
            store.items.lock().unwrap().insert(k.into(), v.into());
        }
        write_records(
            &paths,
            &[HubRecord {
                id: "a-example-com".into(),
                label: "Acme".into(),
                url: "https://a.example.com".into(),
            }],
        )
        .unwrap();
        let secrets = Secrets::Keyring(desk_core::Keyring::with(std::sync::Arc::new(
            Vault::new_as(dir.path(), store.clone(), KeyOwner::App),
        )));
        // What a page load asks: the local hub's connection, then every hub.
        let load = || {
            let c = desk_core::backend::read_connection(&paths, &secrets)
                .unwrap()
                .unwrap();
            assert_eq!(c.admin_token, "gateway");
            let all = accounts_with(&paths, Some(c), &secrets).unwrap();
            assert_eq!(
                all.iter().map(|a| a.token.as_str()).collect::<Vec<_>>(),
                ["local", "remote"]
            );
        };
        load();
        let first = store.calls.load(Ordering::SeqCst);
        assert!(first > 0);
        for _ in 0..5 {
            load();
        }
        assert_eq!(
            store.calls.load(Ordering::SeqCst),
            first,
            "a reload reads nothing"
        );
    }

    /// What `hubs_list` hands the page, serialized as the IPC sends it: each
    /// hub, and no token of any kind: not the local hub's gateway (admin)
    /// token, nor any hub's device token.
    #[test]
    fn the_page_is_never_given_a_token() {
        const SENTINEL: &str = "SENTINEL-ADMIN-7c41";
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        desk_core::write_ports(
            &paths.hub_state(),
            &desk_core::HubPorts {
                postgres: 1,
                admin: 2,
                gateway: 3,
                memory: 4,
            },
        )
        .unwrap();
        let secrets = Secrets::of(&paths, desk_core::KeyStore::File);
        secrets
            .set_account(desk_core::Secret::GatewayToken.account(), SENTINEL)
            .unwrap();
        save_with(
            &secrets,
            &paths,
            "Acme",
            "https://a.example.com",
            "remote-device",
        )
        .unwrap();
        let ipc = |local: Option<Connection>| {
            serde_json::to_string(&accounts_with(&paths, local, &secrets).unwrap()).unwrap()
        };
        // Not yet paired with the local hub: it isn't listed, rather than
        // listed with the admin token.
        let unpaired = desk_core::backend::read_connection(&paths, &secrets)
            .unwrap()
            .unwrap();
        assert_eq!(unpaired.admin_token, SENTINEL);
        let json = ipc(Some(unpaired));
        assert!(!json.contains(SENTINEL), "{json}");
        assert!(!json.contains("\"local\":true"));
        // Paired: the local hub is listed with its device token.
        secrets
            .set_account(&device_token_account(LOCAL_HUB_ID), "local-device")
            .unwrap();
        let paired = desk_core::backend::read_connection(&paths, &secrets)
            .unwrap()
            .unwrap();
        let json = ipc(Some(paired));
        for secret in [SENTINEL, "local-device", "remote-device"] {
            assert!(!json.contains(secret), "{json}");
        }
        let listed: Vec<serde_json::Value> = serde_json::from_str(&json).unwrap();
        assert_eq!(listed[0]["id"], "local");
        assert_eq!(listed[1]["id"], "a-example-com");
        assert!(listed.iter().all(|h| h.get("token").is_none()));
        // The revision tells the tokens apart, and changes with a new one.
        let (local, remote) = (listed[0]["revision"].clone(), listed[1]["revision"].clone());
        assert_ne!(local, remote);
        assert_eq!(local.as_str().unwrap().len(), 16);
        save_with(
            &secrets,
            &paths,
            "Acme",
            "https://a.example.com",
            "remote-again",
        )
        .unwrap();
        let again: Vec<serde_json::Value> =
            serde_json::from_str(&ipc(Some(read_connection_now(&paths, &secrets)))).unwrap();
        assert_eq!(again[0]["revision"], local);
        assert_ne!(again[1]["revision"], remote);
    }

    fn read_connection_now(paths: &Paths, secrets: &Secrets) -> Connection {
        desk_core::backend::read_connection(paths, secrets)
            .unwrap()
            .unwrap()
    }

    #[test]
    fn a_hub_is_kept_only_where_its_token_may_go() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        let secrets = Secrets::of(&paths, desk_core::KeyStore::File);
        for refused in [
            "http://hub.example.com",
            "http://localhost:3",
            "https://user:pw@hub.example.com",
            "https://hub.example.com/prefix",
        ] {
            assert!(
                save_with(&secrets, &paths, "X", refused, "t").is_err(),
                "{refused}"
            );
        }
        assert!(read_records(&paths).unwrap().is_empty());
        let kept = save_with(&secrets, &paths, "Dev", "http://127.0.0.1:8080/", "t").unwrap();
        assert_eq!(kept.url, "http://127.0.0.1:8080");
    }

    #[test]
    fn hub_ids_come_from_the_host() {
        assert_eq!(
            id_for("https://workforce.example.com").unwrap(),
            "workforce-example-com"
        );
        assert_eq!(
            id_for("https://hub.example.com:8443/x").unwrap(),
            "hub-example-com"
        );
        assert!(id_for("not a url").is_err());
    }

    #[test]
    fn pairing_an_address_again_replaces_its_token_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        let secrets = Secrets::of(&paths, desk_core::KeyStore::File);
        let token = |id: &str| secrets.get_account(&device_token_account(id)).unwrap();
        save_with(&secrets, &paths, "Acme", "https://a.example.com", "first").unwrap();
        save_with(&secrets, &paths, "Other", "https://b.example.com", "other").unwrap();
        let again =
            save_with(&secrets, &paths, "Acme", "https://a.example.com/", "second").unwrap();
        assert_eq!(again.id, "a-example-com");
        let ids: Vec<_> = read_records(&paths)
            .unwrap()
            .into_iter()
            .map(|r| (r.id, r.label))
            .collect();
        assert_eq!(
            ids,
            [
                ("a-example-com".to_string(), "Acme".to_string()),
                ("b-example-com".to_string(), "Other".to_string())
            ]
        );
        assert_eq!(token("a-example-com").as_deref(), Some("second"));
        assert_eq!(token("b-example-com").as_deref(), Some("other"));
    }

    #[test]
    fn a_hub_elsewhere_never_takes_over_another_hubs_id() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        let secrets = Secrets::of(&paths, desk_core::KeyStore::File);
        let token = |id: &str| secrets.get_account(&device_token_account(id)).unwrap();
        save_with(&secrets, &paths, "Ours", "https://a.b-c.example", "ours").unwrap();
        for elsewhere in ["https://a-b.c.example", "https://a.b-c.example:8443"] {
            assert_eq!(id_for(elsewhere).unwrap(), "a-b-c-example");
            assert!(
                save_with(&secrets, &paths, "Theirs", elsewhere, "theirs").is_err(),
                "{elsewhere}"
            );
        }
        let kept = read_records(&paths).unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].url, "https://a.b-c.example");
        assert_eq!(token("a-b-c-example").as_deref(), Some("ours"));
        // The same place, however it is written, is paired again in place.
        save_with(&secrets, &paths, "Ours", "https://A.b-c.example/", "again").unwrap();
        assert_eq!(token("a-b-c-example").as_deref(), Some("again"));
    }

    #[test]
    fn records_round_trip_without_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        assert!(read_records(&paths).unwrap().is_empty());
        let r = HubRecord {
            id: "dw".into(),
            label: "Driftwerk".into(),
            url: "https://dw".into(),
        };
        write_records(&paths, std::slice::from_ref(&r)).unwrap();
        assert_eq!(read_records(&paths).unwrap(), vec![r]);
        assert!(
            !std::fs::read_to_string(paths.hubs())
                .unwrap()
                .contains("token")
        );
    }
}
