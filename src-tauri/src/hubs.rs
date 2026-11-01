//! The hubs Desk talks to. The list lives in `hubs.json`; each hub's
//! paired-device token lives with the app's secrets. The local hub is always
//! first, once `desk-hubd` has paired Desk with it.

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

#[derive(Debug, Clone, Serialize)]
pub struct HubAccount {
    pub id: String,
    pub label: String,
    pub url: String,
    pub local: bool,
    pub token: String,
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
        out.push(HubAccount {
            id: LOCAL_HUB_ID.into(),
            label: desk_core::computer_name().unwrap_or_else(|| "This computer".into()),
            url: c.gateway_url,
            local: true,
            token,
        });
    }
    for r in read_records(paths)? {
        if let Some(token) = secrets.get_account(&device_token_account(&r.id))? {
            out.push(HubAccount {
                id: r.id,
                label: r.label,
                url: r.url,
                local: false,
                token,
            });
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

fn save_with(
    secrets: &Secrets,
    paths: &Paths,
    label: &str,
    url: &str,
    token: &str,
) -> Result<HubRecord> {
    let url = url.trim_end_matches('/').to_string();
    if !url.starts_with("https://")
        && !url.starts_with("http://127.0.0.1")
        && !url.starts_with("http://localhost")
    {
        eyre::bail!("remote hubs must be https");
    }
    let record = HubRecord {
        id: id_for(&url)?,
        label: label.trim().to_string(),
        url,
    };
    if record.id == LOCAL_HUB_ID {
        eyre::bail!("that name is reserved for the local hub");
    }
    secrets.set_account(&device_token_account(&record.id), token)?;
    let mut records = read_records(paths)?;
    match records.iter_mut().find(|r| r.id == record.id) {
        Some(kept) => *kept = record.clone(),
        None => records.push(record.clone()),
    }
    write_records(paths, &records)?;
    Ok(record)
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
