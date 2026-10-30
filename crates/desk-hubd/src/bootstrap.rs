//! Makes Desk a paired device of its own local hub, linked to the person
//! who owns the Mac, so chat works (`/ws` refuses the admin token). Uses the
//! hub's existing admin endpoints; idempotent, so it runs on every start.

use std::time::Duration;

use desk_core::{LOCAL_HUB_ID, Paths, Secrets, device_token_account};
use eyre::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const DEVICE_KIND: &str = "desktop_device";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Owner {
    pub identity_id: String,
}

#[derive(Debug, Clone)]
pub struct Person {
    pub display_name: String,
    pub email: Option<String>,
    pub device_name: String,
}

fn command(program: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(program)
        .args(args)
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !s.is_empty()).then_some(s)
}

/// The computer's owner as its system and git know them.
pub fn person() -> Person {
    let host = desk_core::computer_name().unwrap_or_else(|| "this computer".into());
    Person {
        display_name: desk_core::person_name().unwrap_or_else(|| "you".into()),
        email: command("git", &["config", "--global", "user.email"]),
        device_name: format!("Desk on {host}"),
    }
}

struct Hub {
    http: reqwest::Client,
    base: String,
    admin: String,
}

impl Hub {
    async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        token: &str,
        body: Option<Value>,
    ) -> Result<(u16, Value)> {
        let mut req = self
            .http
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(token);
        if let Some(b) = body {
            req = req.json(&b);
        }
        let res = req
            .send()
            .await
            .with_context(|| format!("calling {path}"))?;
        let status = res.status().as_u16();
        let value = res.json::<Value>().await.unwrap_or(Value::Null);
        Ok((status, value))
    }

    async fn admin(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        let (status, v) = self.call(method, path, &self.admin, body).await?;
        if !(200..300).contains(&status) {
            eyre::bail!("{path} answered {status}: {v}");
        }
        Ok(v)
    }
}

fn read_owner(paths: &Paths) -> Result<Option<Owner>> {
    match std::fs::read_to_string(paths.hub().join("owner.toml")) {
        Ok(s) => Ok(Some(toml::from_str(&s)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// An identity already holding `email`, matched exactly (search is fuzzy).
fn find_by_email(found: &Value, email: &str) -> Option<String> {
    found["identities"].as_array()?.iter().find_map(|i| {
        let same = i["email"]
            .as_str()
            .is_some_and(|e| e.eq_ignore_ascii_case(email));
        same.then(|| i["id"].as_str().map(str::to_string)).flatten()
    })
}

/// The device Desk paired before, still valid.
fn find_device(devices: &Value, name: &str) -> Option<String> {
    devices["devices"].as_array()?.iter().find_map(|d| {
        let ours = d["device_name"] == name && d["revoked"] != true;
        ours.then(|| d["id"].as_str().map(str::to_string)).flatten()
    })
}

async fn ensure_owner(hub: &Hub, paths: &Paths, person: &Person) -> Result<Owner> {
    if let Some(o) = read_owner(paths)? {
        let path = format!("/api/identities/{}", o.identity_id);
        if hub
            .call(reqwest::Method::GET, &path, &hub.admin, None)
            .await?
            .0
            == 200
        {
            return Ok(o);
        }
    }
    let existing = match &person.email {
        Some(email) => {
            let q = format!("/api/identities?search={}", urlencode(email));
            find_by_email(&hub.admin(reqwest::Method::GET, &q, None).await?, email)
        }
        None => None,
    };
    let identity_id = match existing {
        Some(id) => id,
        None => hub
            .admin(
                reqwest::Method::POST,
                "/api/identities",
                Some(json!({ "display_name": person.display_name, "email": person.email, "role": "system_admin" })),
            )
            .await?["id"]
            .as_str()
            .ok_or_else(|| eyre::eyre!("identity create returned no id"))?
            .to_string(),
    };
    let owner = Owner { identity_id };
    desk_core::write_private(&paths.hub().join("owner.toml"), &toml::to_string(&owner)?)?;
    Ok(owner)
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

async fn device_token(hub: &Hub, owner: &Owner, person: &Person) -> Result<String> {
    let devices = hub
        .admin(reqwest::Method::GET, "/api/pair/devices", None)
        .await?;
    if let Some(id) = find_device(&devices, &person.device_name) {
        let v = hub
            .admin(
                reqwest::Method::POST,
                &format!("/api/pair/devices/{id}/rotate"),
                None,
            )
            .await?;
        if let Some(t) = v["token"].as_str() {
            return Ok(t.to_string());
        }
    }
    let code = hub
        .admin(
            reqwest::Method::POST,
            "/api/pair/device",
            Some(json!({ "device_name": person.device_name, "identity_hint": owner.identity_id, "device_kind": DEVICE_KIND })),
        )
        .await?["code"]
        .as_str()
        .ok_or_else(|| eyre::eyre!("pairing returned no code"))?
        .to_string();
    let approved = hub
        .admin(
            reqwest::Method::POST,
            &format!("/api/pair/approve/{code}"),
            None,
        )
        .await?;
    let token = approved["token"]
        .as_str()
        .ok_or_else(|| eyre::eyre!("approval returned no token"))?
        .to_string();
    // Collect the stored copy so it doesn't sit in the pairing store.
    let _ = hub
        .http
        .get(format!("{}/api/pair/device/status/{code}", hub.base))
        .send()
        .await;
    Ok(token)
}

/// Waits for the hub, then makes sure Desk holds a device token for it that
/// resolves to the owner.
pub async fn run(paths: &Paths, gateway: &str, admin_token: &str) -> Result<()> {
    let hub = Hub {
        http: reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()?,
        base: gateway.trim_end_matches('/').to_string(),
        admin: admin_token.to_string(),
    };
    let mut ready = false;
    for _ in 0..120 {
        if let Ok((200, _)) = hub
            .call(reqwest::Method::GET, "/api/pair/devices", &hub.admin, None)
            .await
        {
            ready = true;
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    if !ready {
        eyre::bail!("the local hub did not come up for pairing");
    }
    let person = person();
    let owner = ensure_owner(&hub, paths, &person).await?;
    let secrets = Secrets::for_paths(paths);
    let account = device_token_account(LOCAL_HUB_ID);
    if let Some(token) = secrets.get_account(&account)?
        && let Ok((200, me)) = hub
            .call(reqwest::Method::GET, "/api/me", &token, None)
            .await
        && me["id"].as_str() == Some(owner.identity_id.as_str())
    {
        tracing::info!("Desk's pairing with its local hub is current");
        return Ok(());
    }
    let token = device_token(&hub, &owner, &person).await?;
    secrets.set_account(&account, &token)?;
    tracing::info!("Desk is paired with its local hub");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_matches_are_exact() {
        let found = json!({"identities": [
            {"id": "a", "email": "kingsley.h@other.com"},
            {"id": "b", "email": "Kingsley@example.com"}
        ]});
        assert_eq!(
            find_by_email(&found, "kingsley@example.com").as_deref(),
            Some("b")
        );
        assert_eq!(find_by_email(&found, "nobody@example.com"), None);
    }

    #[test]
    fn a_revoked_device_is_not_reused() {
        let devices = json!({"devices": [
            {"id": "d1", "device_name": "Desk on Ash", "revoked": true},
            {"id": "d2", "device_name": "Desk on Ash", "revoked": false},
            {"id": "d3", "device_name": "iPhone", "revoked": false}
        ]});
        assert_eq!(find_device(&devices, "Desk on Ash").as_deref(), Some("d2"));
        assert_eq!(find_device(&devices, "Desk on Oak"), None);
    }

    #[test]
    fn query_values_are_encoded() {
        assert_eq!(urlencode("k+h@example.com"), "k%2Bh%40example.com");
    }
}
