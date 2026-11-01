//! Every paired hub as the page reaches it: requests and sockets by hub id,
//! the hub's address and token added on this side. The page holds no
//! token, so nothing it runs can send one anywhere; and nothing it sends
//! decides where a request goes, beyond the path on the hub it names.
//!
//! Pairing is the one request to a hub Desk isn't paired with: it asks the
//! address the person typed for a code, and collects the device token once
//! the code is approved, keeping it here (`hubs::save`). The page learns
//! how it went, never the token.

use std::sync::Arc;

use desk_core::Paths;
use reqwest::header::CONTENT_TYPE;
use reqwest::{Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody};

use crate::CommandResult;
use crate::broker::socket::{self, Dial, Legacy, LegacyHubs, Pool, Sockets};
use crate::broker::{BODY_TYPES, MAX_BODY, header};
use crate::pair_gate::PairGate;
use crate::paired::Paired;

/// The most of a hub's answer the page is given.
pub const MAX_ANSWER: usize = 32 * 1024 * 1024;
/// The most a pairing answer may be.
const MAX_PAIRING_ANSWER: usize = 64 * 1024;

/// The methods the page asks hubs with.
const METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE"];

/// The sockets the page opens on a paired hub, and what their URLs may say.
const SOCKETS: &[(&str, &[&str])] = &[
    ("/ws", &["agent_id", "channel", "rich", "desk", "accept"]),
    ("/ws/desk", &[]),
];

/// What the page reaches hubs through.
pub struct HubIo {
    paired: Arc<Paired>,
    sockets: Arc<Sockets>,
    legacy: Arc<LegacyHubs>,
}

/// A hub's answer, as the page is told of it before its body.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub status: u16,
    pub content_type: Option<String>,
}

impl HubIo {
    pub fn new(paired: Arc<Paired>, sockets: Arc<Sockets>) -> Self {
        Self {
            paired,
            sockets,
            legacy: Arc::default(),
        }
    }

    /// `method target` (a path with its query) on hub `hub`, with `body`.
    pub async fn fetch(
        &self,
        hub: &str,
        method: &str,
        target: &str,
        body: Option<(String, Vec<u8>)>,
    ) -> Result<(Meta, Vec<u8>), String> {
        if !METHODS.contains(&method) {
            return Err(format!("Desk doesn't ask a workspace with {method}."));
        }
        let method = Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
        if let Some((kind, bytes)) = &body {
            if !BODY_TYPES.contains(&kind.as_str()) {
                return Err(format!("Desk doesn't send {kind} to a workspace."));
            }
            if bytes.len() > MAX_BODY {
                return Err("That's too big to send to a workspace.".into());
            }
        }
        let (path, query) = split(target);
        // Checked before anything is read or sent.
        desk_core::net::at(
            &Url::parse("https://hub.invalid").expect("a URL"),
            path,
            query,
        )?;
        let body = body.map(|(kind, bytes)| (kind, bytes::Bytes::from(bytes)));
        let mut response = self
            .paired
            .send(hub, |reach| {
                let url = desk_core::net::at(&reach.base, path, query).ok()?;
                let request = reach.client.request(method.clone(), url);
                Some(match &body {
                    Some((kind, bytes)) => request
                        .header(CONTENT_TYPE, kind.as_str())
                        .body(bytes.clone()),
                    None => request,
                })
            })
            .await
            .map_err(|e| e.to_string())?;
        let meta = Meta {
            status: response.status().as_u16(),
            content_type: response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string),
        };
        let bytes = read_capped(&mut response, MAX_ANSWER).await?;
        Ok((meta, bytes))
    }

    /// Opens socket `target` (`/ws` or `/ws/desk`, with the query the page
    /// may give it) on hub `hub` for webview `owner`.
    pub async fn open_socket(
        &self,
        owner: &str,
        hub: &str,
        target: &str,
        events: socket::Events,
    ) -> Result<u32, String> {
        let (path, query) = socket_target(target)?;
        let page = self.sockets.page(owner);
        let reach = self
            .paired
            .reach_async(hub)
            .await
            .map_err(|e| e.to_string())?;
        let mut url = desk_core::net::at(&reach.base, path, query.as_deref())?;
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme)
            .map_err(|_| "That workspace has no socket address.".to_string())?;
        let (paired, id) = (Arc::clone(&self.paired), hub.to_string());
        let bearer: socket::Bearer = Arc::new(move |fresh| {
            let (paired, id) = (Arc::clone(&paired), id.clone());
            Box::pin(async move {
                if fresh {
                    paired.forget();
                }
                paired
                    .reach_async(&id)
                    .await
                    .map(|r| r.token)
                    .map_err(|e| e.to_string())
            })
        });
        let (paired, id) = (Arc::clone(&self.paired), hub.to_string());
        let probe: socket::Probe = Arc::new(move || {
            let (paired, id) = (Arc::clone(&paired), id.clone());
            Box::pin(async move {
                let me = |reach: &crate::paired::Reach| {
                    let url = desk_core::net::at(&reach.base, "/api/me", None).ok()?;
                    Some(reach.client.get(url))
                };
                paired
                    .send(&id, me)
                    .await
                    .is_ok_and(|r| r.status().is_success())
            })
        });
        let dial = Dial {
            url,
            bearer,
            pool: Pool::Hubs,
            legacy: Some(Legacy {
                hub: hub.to_string(),
                hubs: Arc::clone(&self.legacy),
                probe,
            }),
        };
        self.sockets.dial(owner, page, dial, events)
    }

    /// Forgets the hubs read, and which were found old, after one is
    /// paired or removed.
    pub fn forget(&self) {
        self.paired.forget();
        self.legacy.clear();
    }
}

/// `target`'s path and query.
fn split(target: &str) -> (&str, Option<&str>) {
    match target.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (target, None),
    }
}

/// A socket the page may open, its query rebuilt from the keys it may
/// carry: never a token, never a key twice.
fn socket_target(target: &str) -> Result<(&str, Option<String>), String> {
    let refuse = || format!("Desk doesn't open {target} on a workspace.");
    let (path, query) = split(target);
    let (_, allowed) = SOCKETS
        .iter()
        .find(|(p, _)| *p == path)
        .ok_or_else(refuse)?;
    let Some(query) = query else {
        return Ok((path, None));
    };
    let parsed = Url::parse(&format!("https://hub.invalid/?{query}")).map_err(|_| refuse())?;
    let mut rebuilt = Url::parse("https://hub.invalid/").expect("a URL");
    let mut seen = Vec::new();
    for (k, v) in parsed.query_pairs() {
        if !allowed.contains(&k.as_ref()) || seen.contains(&k) {
            return Err(refuse());
        }
        rebuilt.query_pairs_mut().append_pair(&k, &v);
        seen.push(k);
    }
    Ok((path, rebuilt.query().map(str::to_string)))
}

/// `response`'s body, refused past `cap` bytes.
async fn read_capped(response: &mut reqwest::Response, cap: usize) -> Result<Vec<u8>, String> {
    let too_big = || "The workspace's answer is too big.".to_string();
    if response.content_length().is_some_and(|n| n > cap as u64) {
        return Err(too_big());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("The workspace's answer broke off: {}", e.without_url()))?
    {
        if body.len() + chunk.len() > cap {
            return Err(too_big());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// The answer as the page reads it: the length of `meta`'s JSON (four
/// bytes, big-endian), that JSON, then the body's bytes.
fn framed(meta: &Meta, body: &[u8]) -> Vec<u8> {
    let meta = serde_json::to_vec(meta).expect("meta serializes");
    let mut out = Vec::with_capacity(4 + meta.len() + body.len());
    out.extend_from_slice(&u32::try_from(meta.len()).expect("small").to_be_bytes());
    out.extend_from_slice(&meta);
    out.extend_from_slice(body);
    out
}

/// One request to a paired hub: the hub's id in `x-desk-hub`, the method
/// and path (with its query) in `x-desk-method` and `x-desk-path`, the body
/// raw with its kind in `x-desk-type`. Answered as [`framed`] says.
#[tauri::command]
pub async fn hub_fetch(
    io: tauri::State<'_, HubIo>,
    request: tauri::ipc::Request<'_>,
) -> CommandResult<tauri::ipc::Response> {
    let headers = request.headers();
    let hub = header(headers, "x-desk-hub").ok_or("The request didn't say its workspace.")?;
    let method = header(headers, "x-desk-method").ok_or("The request didn't say its method.")?;
    let path = header(headers, "x-desk-path").ok_or("The request didn't say its path.")?;
    let body = match (header(headers, "x-desk-type"), request.body()) {
        (Some(kind), InvokeBody::Raw(bytes)) => Some((kind, bytes.clone())),
        (None, InvokeBody::Raw(bytes)) if bytes.is_empty() => None,
        (None, InvokeBody::Json(serde_json::Value::Null)) => None,
        (None, InvokeBody::Json(v)) if v.as_object().is_some_and(|o| o.is_empty()) => None,
        _ => return Err("The request's body didn't say what it is.".into()),
    };
    let (meta, bytes) = io.fetch(&hub, &method, &path, body).await?;
    Ok(tauri::ipc::Response::new(framed(&meta, &bytes)))
}

/// Opens socket `path` on paired hub `hub`; its frames, and then its
/// close, arrive on `events`.
#[tauri::command]
pub async fn hub_socket_open(
    webview: tauri::Webview,
    io: tauri::State<'_, HubIo>,
    hub: String,
    path: String,
    events: Channel<InvokeResponseBody>,
) -> CommandResult<u32> {
    let events: socket::Events = Arc::new(move |body| {
        let _ = events.send(body);
    });
    io.open_socket(webview.label(), &hub, &path, events).await
}

// ── Pairing ──────────────────────────────────────────────────────────────

/// The kind of device Desk pairs as (`DEVICE_KINDS` in the hub's pairing
/// crate); any other kind pairs and then never resolves to anyone.
const DEVICE_KIND: &str = "desktop_device";

/// What a hub answered a pairing request with: its status and its JSON.
#[derive(Debug, Serialize)]
pub struct PairingAnswer {
    pub status: u16,
    pub body: serde_json::Value,
}

/// Who approved a pairing, as the hub says.
#[derive(Debug, Serialize, PartialEq)]
pub struct PairedAs {
    pub name: Option<String>,
    pub email: Option<String>,
}

/// How a pairing stands. An approved one has been kept: the page is told
/// the hub's id and who approved it, never the token.
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Collected {
    Pending,
    Approved {
        hub: String,
        identity: Option<PairedAs>,
    },
    Rejected,
    Expired,
    /// Approved, but its token had already been collected.
    Used,
}

/// The client for a hub Desk isn't paired with, at `url`: checked as any
/// hub's address is.
fn pairing_client(url: &str) -> Result<(Url, reqwest::Client), String> {
    let base = desk_core::net::hub_url(url)?;
    let client = if desk_core::net::is_loopback(&base) {
        desk_core::net::loopback()
    } else {
        desk_core::net::remote()
    };
    Ok((base, client))
}

/// A hub's answer to a pairing request, read as JSON (none when it isn't).
async fn pairing_json(mut response: reqwest::Response) -> Result<PairingAnswer, String> {
    let status = response.status().as_u16();
    let bytes = read_capped(&mut response, MAX_PAIRING_ANSWER).await?;
    Ok(PairingAnswer {
        status,
        body: serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    })
}

fn unreachable(e: reqwest::Error) -> String {
    format!("Couldn't reach the workspace: {}", e.without_url())
}

/// Asks the hub at `url` for a pairing code, as a desktop device named
/// `device_name`; `identity_hint` (an email) matters only to a hub without
/// browser approval. No token is sent.
pub async fn request_pairing(
    url: &str,
    device_name: &str,
    identity_hint: Option<&str>,
) -> Result<PairingAnswer, String> {
    let (base, client) = pairing_client(url)?;
    let target = desk_core::net::at(&base, "/api/pair/device/request", None)?;
    let mut body = serde_json::json!({ "device_name": device_name, "device_kind": DEVICE_KIND });
    if let Some(hint) = identity_hint.map(str::trim).filter(|h| !h.is_empty()) {
        body["identity_hint"] = hint.into();
    }
    let response = client
        .post(target)
        .json(&body)
        .send()
        .await
        .map_err(unreachable)?;
    pairing_json(response).await
}

/// A pairing code as hubs make them: letters, digits and dashes.
fn code_ok(code: &str) -> bool {
    !code.is_empty()
        && code.len() <= 64
        && code
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn text(v: &serde_json::Value) -> Option<String> {
    v.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[derive(Deserialize)]
struct Status {
    status: String,
    token: Option<String>,
    identity: Option<serde_json::Value>,
}

/// How a pairing code stands, as its hub said. Deliberately neither
/// `Debug` nor `Serialize`: an approved one carries the token.
pub enum Standing {
    Pending,
    Approved {
        token: String,
        identity: Option<PairedAs>,
    },
    Rejected,
    Expired,
    Used,
}

/// How pairing code `code` at `url` stands.
pub async fn pairing_standing(url: &str, code: &str) -> Result<Standing, String> {
    if !code_ok(code) {
        return Err("That isn't a pairing code.".into());
    }
    let (base, client) = pairing_client(url)?;
    let target = desk_core::net::at(&base, &format!("/api/pair/device/status/{code}"), None)?;
    let mut response = client.get(target).send().await.map_err(unreachable)?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(Standing::Expired);
    }
    if !response.status().is_success() {
        return Err(format!(
            "The workspace could not say how the request went ({}).",
            response.status().as_u16()
        ));
    }
    let bytes = read_capped(&mut response, MAX_PAIRING_ANSWER).await?;
    let status: Status = serde_json::from_slice(&bytes)
        .map_err(|_| "The workspace's answer couldn't be read.".to_string())?;
    Ok(match status.status.as_str() {
        "approved" => match status.token.filter(|t| !t.trim().is_empty()) {
            None => Standing::Used,
            Some(token) => Standing::Approved {
                token,
                identity: status.identity.as_ref().and_then(|i| {
                    let who = PairedAs {
                        name: text(&i["display_name"]),
                        email: text(&i["email"]),
                    };
                    (who.name.is_some() || who.email.is_some()).then_some(who)
                }),
            },
        },
        "rejected" => Standing::Rejected,
        _ => Standing::Pending,
    })
}

/// Asks for a pairing code, but only at a hub the person agreed to pair with
/// (see [`PairGate`]): nothing is sent before they have.
#[tauri::command]
pub async fn pair_request(
    gate: tauri::State<'_, PairGate>,
    url: String,
    device_name: String,
    identity_hint: Option<String>,
) -> CommandResult<PairingAnswer> {
    request_confirmed(&gate, &url, &device_name, identity_hint.as_deref()).await
}

/// [`request_pairing`], after `gate` has allowed the address.
async fn request_confirmed(
    gate: &PairGate,
    url: &str,
    device_name: &str,
    identity_hint: Option<&str>,
) -> Result<PairingAnswer, String> {
    gate.allow(url).await?;
    request_pairing(url, device_name, identity_hint).await
}

/// Collects pairing `code` at `url`: once approved, the hub is kept as
/// `label` with its token, and every hub is read again.
#[tauri::command]
pub async fn pair_collect(
    app: tauri::State<'_, crate::App>,
    io: tauri::State<'_, HubIo>,
    gate: tauri::State<'_, PairGate>,
    url: String,
    code: String,
    label: String,
) -> CommandResult<Collected> {
    gate.allow(&url).await?;
    Ok(match pairing_standing(&url, &code).await? {
        Standing::Pending => Collected::Pending,
        Standing::Rejected => Collected::Rejected,
        Standing::Expired => Collected::Expired,
        Standing::Used => Collected::Used,
        Standing::Approved { token, identity } => {
            let paths: Paths = app.paths.clone();
            let kept = url.clone();
            let hub = tauri::async_runtime::spawn_blocking(move || {
                crate::hubs::save(&paths, &label, &url, &token)
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
            gate.spent(&kept);
            io.forget();
            Collected::Approved {
                hub: hub.id,
                identity,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paired::tests::{account, paired};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};

    /// A hub on a loopback port answering each request with the next of
    /// `answers`, and telling each request's head and body.
    async fn hub(answers: Vec<String>) -> (String, tokio::sync::mpsc::UnboundedReceiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            for answer in answers {
                let Ok((mut s, _)) = listener.accept().await else {
                    return;
                };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let head_end = loop {
                    let n = s.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i;
                    }
                    if n == 0 {
                        break buf.len();
                    }
                };
                let length = String::from_utf8_lossy(&buf[..head_end])
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                while buf.len() < head_end + 4 + length {
                    let n = s.read(&mut chunk).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let _ = tx.send(String::from_utf8_lossy(&buf).to_string());
                s.write_all(answer.as_bytes()).await.unwrap();
                s.shutdown().await.unwrap();
            }
        });
        (url, rx)
    }

    fn ok(content_type: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn io_for(hubs: Vec<crate::hubs::HubAccount>) -> HubIo {
        HubIo::new(paired(hubs), Arc::default())
    }

    #[tokio::test]
    async fn a_paired_hub_is_asked_with_its_own_token() {
        let (url, mut seen) = hub(vec![ok("image/png", "\u{1}PNG")]).await;
        let io = io_for(vec![
            account("local", "http://127.0.0.1:9", true, "local-token"),
            account("dev", &url, false, "SENTINEL-DEVICE"),
        ]);
        let (meta, body) = io
            .fetch("dev", "GET", "/api/agents/a%20b/picture?v=2", None)
            .await
            .unwrap();
        assert_eq!(
            meta,
            Meta {
                status: 200,
                content_type: Some("image/png".into())
            }
        );
        assert_eq!(body, "\u{1}PNG".as_bytes());
        let head = seen.recv().await.unwrap();
        assert!(
            head.starts_with("GET /api/agents/a%20b/picture?v=2 HTTP/1.1"),
            "{head}"
        );
        assert!(
            head.to_ascii_lowercase()
                .contains("authorization: bearer sentinel-device")
        );
        assert!(!head.contains("local-token"));
    }

    #[tokio::test]
    async fn a_hub_desk_isnt_paired_with_is_never_asked() {
        let (url, mut seen) = hub(vec![ok("application/json", "{}")]).await;
        let io = io_for(vec![account("dev", &url, false, "t")]);
        // Not a paired hub: an id that isn't one, however it looks.
        for hub in ["elsewhere", &url, "https://evil.example.com"] {
            let e = io.fetch(hub, "GET", "/api/me", None).await.unwrap_err();
            assert!(e.contains("isn't connected"), "{hub}: {e}");
        }
        // A paired hub, but a path that would leave it.
        for path in [
            "//evil.example.com/api/me",
            "https://evil.example.com/api/me",
            "api/me",
            "/api/../vault",
        ] {
            assert!(io.fetch("dev", "GET", path, None).await.is_err(), "{path}");
        }
        assert!(io.fetch("dev", "CONNECT", "/api/me", None).await.is_err());
        assert!(
            io.fetch(
                "dev",
                "POST",
                "/api/me",
                Some(("text/html".into(), b"<p>".to_vec()))
            )
            .await
            .is_err()
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(200), seen.recv())
                .await
                .is_err(),
            "nothing was sent"
        );
    }

    #[tokio::test]
    async fn a_paired_hub_at_an_address_desk_wont_send_to_is_refused() {
        let io = io_for(vec![account("plain", "http://hub.example.com", false, "t")]);
        let e = io.fetch("plain", "GET", "/api/me", None).await.unwrap_err();
        assert!(e.contains("https"), "{e}");
    }

    #[tokio::test]
    async fn pairing_a_new_hub_asks_the_person_first_and_sends_nothing_on_cancel() {
        use crate::pair_gate::tests::gate;
        let (url, mut seen) = hub(vec![ok("application/json", r#"{"code":"AB-12"}"#)]).await;
        let (declined, mock, _dir) = gate(false);
        let err = request_confirmed(&declined, &url, "My Mac", None)
            .await
            .unwrap_err();
        assert_eq!(err, "Pairing was cancelled.");
        assert_eq!(mock.asked.lock().unwrap().len(), 1);
        assert!(seen.try_recv().is_err(), "the hub was never contacted");

        let (agreed, mock, _dir) = gate(true);
        let answer = request_confirmed(&agreed, &url, "My Mac", None)
            .await
            .unwrap();
        assert_eq!(answer.status, 200);
        assert!(
            seen.try_recv()
                .unwrap()
                .contains("/api/pair/device/request")
        );
        assert_eq!(mock.asked.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn pairing_a_hub_desk_has_already_paired_does_not_ask() {
        use crate::pair_gate::tests::{gate, pair};
        let (url, _seen) = hub(vec![ok("application/json", r#"{"code":"AB-12"}"#)]).await;
        let (gate, mock, dir) = gate(false);
        pair(&dir, &url);
        request_confirmed(&gate, &url, "My Mac", None)
            .await
            .unwrap();
        assert_eq!(mock.asked.lock().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn an_answer_too_big_is_refused() {
        let big = "x".repeat(64);
        let (url, _seen) = hub(vec![ok("text/plain", &big)]).await;
        let mut response = reqwest::get(format!("{url}/x")).await.unwrap();
        assert!(read_capped(&mut response, 16).await.is_err());
    }

    #[test]
    fn the_answer_is_framed_for_the_page() {
        let f = framed(
            &Meta {
                status: 201,
                content_type: None,
            },
            b"body",
        );
        let n = u32::from_be_bytes(f[..4].try_into().unwrap()) as usize;
        let meta: serde_json::Value = serde_json::from_slice(&f[4..4 + n]).unwrap();
        assert_eq!(
            meta,
            serde_json::json!({ "status": 201, "contentType": null })
        );
        assert_eq!(&f[4 + n..], b"body");
    }

    #[test]
    fn a_socket_url_carries_only_what_it_may() {
        assert_eq!(socket_target("/ws/desk").unwrap(), ("/ws/desk", None));
        assert_eq!(
            socket_target(
                "/ws?agent_id=a%20b&channel=desk&rich=tables%2Ccharts&desk=1&accept=*%2F*"
            )
            .unwrap(),
            (
                "/ws",
                Some("agent_id=a+b&channel=desk&rich=tables%2Ccharts&desk=1&accept=*%2F*".into())
            )
        );
        for refused in [
            "/ws?token=x",
            "/ws?agent_id=a&token=x",
            "/ws?agent_id=a&agent_id=b",
            "/ws/desk?token=x",
            "/ws/agent",
            "/api/desk/events",
            "//evil/ws",
        ] {
            assert!(socket_target(refused).is_err(), "{refused}");
        }
    }

    /// A hub whose sockets take the token in the header when
    /// `accept_header` (else only in the URL, as before header auth), and
    /// whose `GET /api/me` takes it in the header when `rest_takes_token`
    /// (as every hub's REST does, for a token it hasn't revoked). It tells
    /// each request's path and `Authorization`.
    #[allow(clippy::result_large_err)]
    async fn ws_hub(
        accept_header: bool,
        rest_takes_token: bool,
    ) -> (
        String,
        tokio::sync::mpsc::UnboundedReceiver<(String, String)>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let tx = tx.clone();
                tokio::spawn(async move {
                    let mut head = vec![0u8; 4096];
                    let n = loop {
                        let n = stream.peek(&mut head).await.unwrap();
                        if n == 0 || head[..n].windows(4).any(|w| w == b"\r\n\r\n") {
                            break n;
                        }
                    };
                    let text = String::from_utf8_lossy(&head[..n]).to_string();
                    if text.starts_with("GET /api/me ") {
                        let mut stream = stream;
                        let mut sink = vec![0u8; n];
                        stream.read_exact(&mut sink).await.unwrap();
                        let auth = text
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .starts_with("authorization:")
                                    .then(|| l["authorization:".len()..].trim().to_string())
                            })
                            .unwrap_or_default();
                        let _ = tx.send(("/api/me".into(), auth.clone()));
                        let ok = rest_takes_token && auth == "Bearer SENTINEL-DEVICE";
                        let status = if ok { "200 OK" } else { "401 Unauthorized" };
                        let _ = stream
                            .write_all(
                                format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                                    .as_bytes(),
                            )
                            .await;
                        return;
                    }
                    let ws = tokio_tungstenite::accept_hdr_async(
                        stream,
                        move |req: &Request, res: Response| {
                            let auth = req
                                .headers()
                                .get("authorization")
                                .map(|v| v.to_str().unwrap().to_string())
                                .unwrap_or_default();
                            let uri = req.uri().to_string();
                            let _ = tx.send((uri.clone(), auth.clone()));
                            let by_header = accept_header && auth == "Bearer SENTINEL-DEVICE";
                            let by_query = uri.contains("token=SENTINEL-DEVICE");
                            if by_header || by_query {
                                Ok(res)
                            } else {
                                let mut no = ErrorResponse::new(None);
                                *no.status_mut() = StatusCode::UNAUTHORIZED;
                                Err(no)
                            }
                        },
                    )
                    .await;
                    if let Ok(mut ws) = ws {
                        use futures_util::StreamExt;
                        while ws.next().await.is_some() {}
                    }
                });
            }
        });
        (url, rx)
    }

    fn opened() -> (
        socket::Events,
        tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let events: socket::Events = Arc::new(move |body| {
            if let InvokeResponseBody::Json(s) = body {
                let _ = tx.send(serde_json::from_str(&s).unwrap());
            }
        });
        (events, rx)
    }

    async fn said(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>,
    ) -> serde_json::Value {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .unwrap()
            .unwrap()
    }

    #[tokio::test]
    async fn a_socket_carries_the_token_in_its_header_and_never_its_url() {
        let (url, mut seen) = ws_hub(true, true).await;
        let io = io_for(vec![account("dev", &url, false, "SENTINEL-DEVICE")]);
        let (events, mut rx) = opened();
        io.open_socket(
            "main",
            "dev",
            "/ws?agent_id=scout&channel=desk&desk=1",
            events,
        )
        .await
        .unwrap();
        assert_eq!(said(&mut rx).await["type"], "open");
        let (uri, auth) = seen.recv().await.unwrap();
        assert_eq!(uri, "/ws?agent_id=scout&channel=desk&desk=1");
        assert!(!uri.contains("token"));
        assert_eq!(auth, "Bearer SENTINEL-DEVICE");
        assert!(seen.try_recv().is_err(), "one handshake");
    }

    #[tokio::test]
    async fn an_older_hub_is_sent_the_token_in_the_url_only_after_it_takes_it_in_a_header() {
        let (url, mut seen) = ws_hub(false, true).await;
        let io = io_for(vec![account("old", &url, false, "SENTINEL-DEVICE")]);
        let (events, mut rx) = opened();
        io.open_socket("main", "old", "/ws/desk", events)
            .await
            .unwrap();
        assert_eq!(said(&mut rx).await["type"], "open");
        // The header, the header with the token read again, the hub asked
        // whether it takes the token at all (in a header), then the URL.
        let tried: Vec<_> = (0..4).map(|_| seen.try_recv().unwrap()).collect();
        let header = ("/ws/desk".to_string(), "Bearer SENTINEL-DEVICE".to_string());
        assert_eq!(tried[0], header);
        assert_eq!(tried[1], header);
        assert_eq!(
            tried[2],
            ("/api/me".into(), "Bearer SENTINEL-DEVICE".into())
        );
        assert_eq!(
            tried[3],
            ("/ws/desk?token=SENTINEL-DEVICE".into(), String::new())
        );
        // Remembered: the next socket to that hub goes the old way at once.
        let (events, mut rx) = opened();
        io.open_socket("main", "old", "/ws/desk", events)
            .await
            .unwrap();
        assert_eq!(said(&mut rx).await["type"], "open");
        assert_eq!(
            seen.recv().await.unwrap().0,
            "/ws/desk?token=SENTINEL-DEVICE"
        );
        assert!(seen.try_recv().is_err());
        // Until a hub is paired or removed: then the header is tried first.
        io.forget();
        let (events, mut rx) = opened();
        io.open_socket("main", "old", "/ws/desk", events)
            .await
            .unwrap();
        assert_eq!(said(&mut rx).await["type"], "open");
        assert_eq!(seen.recv().await.unwrap(), header);
    }

    #[tokio::test]
    async fn a_token_the_hub_turns_away_everywhere_never_goes_in_a_url() {
        // A hub that refuses the token in the header on its sockets and its
        // REST alike (revoked, say; or a 401 for any other reason).
        let (url, mut seen) = ws_hub(false, false).await;
        let io = io_for(vec![account("hub", &url, false, "SENTINEL-DEVICE")]);
        for _ in 0..2 {
            let (events, mut rx) = opened();
            io.open_socket("main", "hub", "/ws/desk", events)
                .await
                .unwrap();
            assert_eq!(said(&mut rx).await["type"], "error");
            let closed = said(&mut rx).await;
            assert_eq!(closed["type"], "close");
            assert!(
                closed.to_string().contains("401"),
                "the page is told the hub refused: {closed}"
            );
        }
        let mut tried = Vec::new();
        while let Ok(t) = seen.try_recv() {
            tried.push(t);
        }
        assert!(tried.len() >= 6, "{tried:?}");
        assert!(
            tried.iter().all(|(uri, _)| !uri.contains("token")),
            "{tried:?}"
        );
    }

    #[tokio::test]
    async fn a_socket_to_a_hub_desk_isnt_paired_with_is_never_opened() {
        let (url, mut seen) = ws_hub(true, true).await;
        let io = io_for(vec![account("dev", &url, false, "SENTINEL-DEVICE")]);
        let (events, _rx) = opened();
        assert!(
            io.open_socket("main", "elsewhere", "/ws/desk", events.clone())
                .await
                .is_err()
        );
        assert!(
            io.open_socket("main", "dev", "/ws?token=x", events)
                .await
                .is_err()
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(200), seen.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn pairing_asks_with_no_token_and_keeps_the_one_it_collects() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let (url, mut seen) = hub(vec![
            ok("application/json", r#"{"code":"K7Q2XM","approve_url":"https://x/pair"}"#),
            ok("application/json", r#"{"status":"pending"}"#),
            ok(
                "application/json",
                r#"{"status":"approved","token":"SENTINEL-NEW","identity":{"display_name":" Ash ","email":""}}"#,
            ),
        ])
        .await;
        let asked = request_pairing(&url, "Desk on Ash", Some(" ash@example.com "))
            .await
            .unwrap();
        assert_eq!(asked.status, 200);
        assert_eq!(asked.body["code"], "K7Q2XM");
        let head = seen.recv().await.unwrap();
        assert!(head.starts_with("POST /api/pair/device/request "));
        assert!(!head.to_ascii_lowercase().contains("authorization"));
        let body = head.split("\r\n\r\n").nth(1).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(body).unwrap(),
            serde_json::json!({
                "device_name": "Desk on Ash",
                "device_kind": "desktop_device",
                "identity_hint": "ash@example.com"
            })
        );
        assert!(matches!(
            pairing_standing(&url, "K7Q2XM").await.unwrap(),
            Standing::Pending
        ));
        let Standing::Approved { token, identity } =
            pairing_standing(&url, "K7Q2XM").await.unwrap()
        else {
            panic!("approved");
        };
        assert_eq!(token, "SENTINEL-NEW");
        assert_eq!(
            identity,
            Some(PairedAs {
                name: Some("Ash".into()),
                email: None
            })
        );
        // What the page is told of it.
        let told = Collected::Approved {
            hub: "hub-id".into(),
            identity,
        };
        assert_eq!(
            serde_json::to_value(&told).unwrap(),
            serde_json::json!({ "status": "approved", "hub": "hub-id", "identity": { "name": "Ash", "email": null } })
        );
    }

    #[tokio::test]
    async fn pairing_goes_only_to_a_hub_address() {
        for url in [
            "http://hub.example.com",
            "ftp://x",
            "https://u:p@hub.example.com",
        ] {
            assert!(request_pairing(url, "Desk", None).await.is_err(), "{url}");
        }
        for code in ["", "../x", "a/b", "a?b", &"x".repeat(65)] {
            assert!(
                pairing_standing("https://hub.example.com", code)
                    .await
                    .is_err(),
                "{code}"
            );
        }
    }
}
