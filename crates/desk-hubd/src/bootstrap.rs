//! Makes Desk a paired device of its own local hub, linked to the person
//! who owns this computer, so chat works (`/ws` refuses the admin token). Uses the
//! hub's existing admin endpoints; idempotent, so it runs on every start.

use std::time::Duration;

use desk_core::host::Host;
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

/// `program`'s output, when it succeeds with some. Only starting it holds
/// back desk-hubd's other spawns; it is waited for after.
fn command(program: &str, args: &[&str]) -> Option<String> {
    let child = crate::handover::spawning(|| {
        std::process::Command::new(program)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
    })
    .ok()?;
    let out = child.wait_with_output().ok()?;
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

/// How pairing waits for a hub that is slow to come up (the first start of
/// a new binary on macOS can take minutes).
struct Retry {
    first: Duration,
    max: Duration,
    warn_after: Duration,
}

impl Default for Retry {
    fn default() -> Self {
        Self {
            first: Duration::from_secs(2),
            max: Duration::from_secs(30),
            warn_after: Duration::from_secs(120),
        }
    }
}

/// Polls the hub until it answers, backing off from `first` to `max`. It
/// never gives up: whoever runs it stops it when the hub process exits.
async fn wait_for_hub(hub: &Hub, retry: &Retry) {
    let started = std::time::Instant::now();
    let mut delay = retry.first;
    let mut warned = false;
    loop {
        if let Ok((200, _)) = hub
            .call(reqwest::Method::GET, "/api/pair/devices", &hub.admin, None)
            .await
        {
            if warned {
                tracing::info!(
                    waited_secs = started.elapsed().as_secs(),
                    "the local hub came up; pairing Desk with it"
                );
            }
            return;
        }
        if !warned && started.elapsed() >= retry.warn_after {
            warned = true;
            tracing::warn!("still waiting for the local hub to come up");
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(retry.max);
    }
}

/// Waits for the hub, then makes sure Desk holds a device token for it that
/// resolves to the owner.
pub async fn run(paths: &Paths, gateway: &str, admin_token: &str) -> Result<()> {
    let hub = Hub {
        // The admin token goes to the hub on this computer only: never
        // through a proxy, never after a redirect.
        http: reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build()?,
        base: gateway.trim_end_matches('/').to_string(),
        admin: admin_token.to_string(),
    };
    wait_for_hub(&hub, &Retry::default()).await;
    // `git` runs to say who the person is: off the async threads.
    let person = tokio::task::spawn_blocking(person).await?;
    let owner = ensure_owner(&hub, paths, &person).await?;
    let env = std::env::vars().collect();
    let secrets = Secrets::for_host(paths, &Host::running_here(&env))?;
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
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A hub that refuses connections for `slow_for`, then answers 200 to
    /// everything. Returns its address and how many requests it has seen.
    async fn slow_hub(
        slow_for: Duration,
    ) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        let probe = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = probe.local_addr().unwrap();
        drop(probe); // nothing listens yet: connections are refused
        let served = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = served.clone();
        tokio::spawn(async move {
            tokio::time::sleep(slow_for).await;
            let l = tokio::net::TcpListener::bind(addr).await.unwrap();
            loop {
                let (mut sock, _) = l.accept().await.unwrap();
                count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf).await;
                let _ = sock
                    .write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}",
                    )
                    .await;
            }
        });
        (format!("http://{addr}"), served)
    }

    fn test_hub(base: String) -> Hub {
        let _ = rustls::crypto::ring::default_provider().install_default();
        Hub {
            http: reqwest::Client::builder().no_proxy().build().unwrap(),
            base,
            admin: "t".into(),
        }
    }

    fn quick() -> Retry {
        Retry {
            first: Duration::from_millis(20),
            max: Duration::from_millis(100),
            warn_after: Duration::from_millis(150),
        }
    }

    /// A hub that takes far longer than the old two-minute budget would
    /// allow (scaled down) is still waited for.
    #[tokio::test]
    async fn pairing_keeps_waiting_for_a_slow_hub() {
        let (base, served) = slow_hub(Duration::from_millis(700)).await;
        let started = std::time::Instant::now();
        tokio::time::timeout(
            Duration::from_secs(10),
            wait_for_hub(&test_hub(base), &quick()),
        )
        .await
        .expect("pairing gave up on a hub that was only slow");
        assert!(started.elapsed() >= Duration::from_millis(700));
        assert_eq!(served.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    /// A hub that is up answers the first poll without any waiting.
    #[tokio::test]
    async fn a_ready_hub_is_paired_at_once() {
        let (base, _) = slow_hub(Duration::ZERO).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        let started = std::time::Instant::now();
        wait_for_hub(&test_hub(base), &Retry::default()).await;
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    /// The wait has no end of its own: it is stopped from outside, which is
    /// how a hub that exits ends it.
    #[tokio::test]
    async fn the_wait_ends_only_when_stopped() {
        let (base, _) = slow_hub(Duration::from_secs(3600)).await;
        let waiting = tokio::spawn({
            let hub = test_hub(base);
            async move { wait_for_hub(&hub, &quick()).await }
        });
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(!waiting.is_finished());
        waiting.abort();
        assert!(waiting.await.unwrap_err().is_cancelled());
    }

    /// A command's output is waited for without holding back desk-hubd's
    /// other spawns: only starting it is.
    #[test]
    fn a_command_is_waited_for_outside_the_spawn_lock() {
        let waiting = std::thread::spawn(|| command("/bin/sh", &["-c", "sleep 1; echo done"]));
        std::thread::sleep(Duration::from_millis(200));
        let started = std::time::Instant::now();
        crate::handover::spawning(|| ());
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "a spawn waited for a running command"
        );
        assert_eq!(waiting.join().unwrap().as_deref(), Some("done"));
    }

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
