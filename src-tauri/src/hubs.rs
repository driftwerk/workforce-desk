//! The hubs Desk talks to. The list lives in `hubs.json`; each hub's
//! paired-device token lives in the keychain. The local hub is always
//! first, once `desk-hubd` has paired Desk with it.

use desk_core::{LOCAL_HUB_ID, Paths, Secrets, device_token_account, read_ports};
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

pub fn accounts(paths: &Paths) -> Result<Vec<HubAccount>> {
    let mut out = Vec::new();
    if let (Some(ports), Some(token)) = (
        read_ports(&paths.hub_state())?,
        Secrets::for_paths(paths).get_account(&device_token_account(LOCAL_HUB_ID))?,
    ) {
        out.push(HubAccount {
            id: LOCAL_HUB_ID.into(),
            label: "Local".into(),
            url: ports.gateway_url(),
            local: true,
            token,
        });
    }
    for r in read_records(paths)? {
        if let Some(token) = Secrets::for_paths(paths).get_account(&device_token_account(&r.id))? {
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

/// Keeps a remote hub Desk has just been paired with.
pub fn save(paths: &Paths, label: &str, url: &str, token: &str) -> Result<HubRecord> {
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
    Secrets::for_paths(paths).set_account(&device_token_account(&record.id), token)?;
    let mut records: Vec<_> = read_records(paths)?
        .into_iter()
        .filter(|r| r.id != record.id)
        .collect();
    records.push(record.clone());
    write_records(paths, &records)?;
    Ok(record)
}

pub fn remove(paths: &Paths, id: &str) -> Result<()> {
    let records: Vec<_> = read_records(paths)?
        .into_iter()
        .filter(|r| r.id != id)
        .collect();
    write_records(paths, &records)?;
    Secrets::for_paths(paths).delete_account(&device_token_account(id))
}

#[cfg(test)]
mod tests {
    use super::*;

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
