//! The local hub's admin surface, brokered. The page never holds the hub's
//! gateway (admin) token: it asks for one of `DeskHub`'s own requests by
//! method and path, and this side checks it against the allowlist in
//! [`routes`], adds the token and sends it to the hub on this computer. Its
//! sockets (session and terminal PTYs, the event stream) are held here too,
//! in [`socket`].
//!
//! What the page holds for hubs is each one's paired-device token (see
//! `hubs.rs`): scoped to the person and the device, and refused by the
//! hub's shell-grade desk routes.

pub mod routes;
pub mod socket;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use desk_core::backend::{Backend, Connection};
use percent_encoding::percent_decode_str;
use reqwest::header::{CONTENT_TYPE, HeaderMap};
use reqwest::{Method, StatusCode, Url};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody};

use crate::CommandResult;

/// The kinds of body the page sends: `DeskHub`'s JSON, its text files
/// (identity files, an agent's TOML), and an agent's picture.
const BODY_TYPES: &[&str] = &[
    "application/json",
    "text/plain",
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "application/octet-stream",
];

/// The largest body the page sends: a picture, at most.
const MAX_BODY: usize = 16 * 1024 * 1024;

/// Reads the local hub's connection; blocking (on Windows it asks WSL).
type Source = Arc<dyn Fn() -> eyre::Result<Option<Connection>> + Send + Sync>;

/// The local hub as the broker reaches it. Deliberately not `Debug`.
#[derive(Clone)]
struct Local {
    base: Url,
    bearer: Arc<str>,
}

/// The local hub as last read: once, and again when the hub turns the token
/// away (Desk Helper renews it).
type Kept = Arc<Mutex<Option<Local>>>;

pub struct Broker {
    source: Source,
    local: Kept,
    client: reqwest::Client,
    pub sockets: socket::Sockets,
}

/// The hub's answer, as the page reads it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: String,
}

impl Broker {
    /// The broker for `backend`'s hub; none until Windows has one.
    pub fn new(backend: Option<Backend>) -> Self {
        Self::with_source(Arc::new(move || match &backend {
            Some(b) => b.connection(),
            None => Err(eyre::eyre!(crate::NOT_SET_UP)),
        }))
    }

    fn with_source(source: Source) -> Self {
        let client = reqwest::Client::builder()
            // The token goes to the hub on this computer and nowhere else:
            // never through a proxy, never after a redirect.
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("an HTTP client");
        Self {
            source,
            local: Kept::default(),
            client,
            sockets: socket::Sockets::default(),
        }
    }

    async fn local(&self) -> Result<Local, String> {
        read(&self.source, &self.local).await
    }

    fn forget(&self) {
        *self.local.lock().expect("local") = None;
    }

    /// One of `DeskHub`'s requests, sent as the hub's admin.
    pub async fn fetch(
        &self,
        method: &str,
        target: &str,
        body: Option<(String, Vec<u8>)>,
    ) -> Result<Answer, String> {
        let allowed = routes::http(method, target).map_err(|e| e.to_string())?;
        if let Some((kind, bytes)) = &body {
            if !BODY_TYPES.contains(&kind.as_str()) {
                return Err(format!("Desk doesn't send {kind} to this computer's hub."));
            }
            if bytes.len() > MAX_BODY {
                return Err("That's too big to send to this computer's hub.".into());
            }
        }
        let method = Method::from_bytes(allowed.method.as_bytes()).map_err(|e| e.to_string())?;
        let send = |local: Local| {
            let url = at(&local.base, &allowed.path, allowed.query.as_deref());
            let mut request = self
                .client
                .request(method.clone(), url?)
                .bearer_auth(&local.bearer);
            if let Some((kind, bytes)) = &body {
                request = request
                    .header(CONTENT_TYPE, kind.as_str())
                    .body(bytes.clone());
            }
            Ok::<_, String>(request.send())
        };
        let unreachable = |e: reqwest::Error| {
            format!(
                "Desk couldn't reach this computer's hub: {}",
                e.without_url()
            )
        };
        let mut response = send(self.local().await?)?.await.map_err(unreachable)?;
        // A refused token is read again once: the hub may have a new one.
        // The hub refused before doing anything, so sending again is safe.
        if response.status() == StatusCode::UNAUTHORIZED {
            self.forget();
            response = send(self.local().await?)?.await.map_err(unreachable)?;
        }
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let bytes = response.bytes().await.map_err(unreachable)?;
        Ok(Answer {
            status,
            content_type,
            body: String::from_utf8_lossy(&bytes).into_owned(),
        })
    }

    /// Opens one of the page's sockets for webview `owner`.
    pub async fn open_socket(
        &self,
        owner: &str,
        target: &str,
        events: socket::Events,
    ) -> Result<u32, String> {
        let allowed = routes::socket(target).map_err(|e| e.to_string())?;
        let page = self.sockets.page(owner);
        let local = self.local().await?;
        let mut url = at(&local.base, &allowed.path, None)?;
        url.set_scheme("ws")
            .map_err(|_| "This computer's hub has no socket address.".to_string())?;
        let (source, kept) = (Arc::clone(&self.source), Arc::clone(&self.local));
        let bearer: socket::Bearer = Arc::new(move |fresh| {
            let (source, kept) = (Arc::clone(&source), Arc::clone(&kept));
            Box::pin(async move {
                if fresh {
                    *kept.lock().expect("local") = None;
                }
                read(&source, &kept).await.map(|l| l.bearer)
            })
        });
        self.sockets.open(owner, page, url, bearer, events)
    }
}

/// The local hub as kept, or read now (and kept) if it isn't.
async fn read(source: &Source, kept: &Kept) -> Result<Local, String> {
    if let Some(l) = kept.lock().expect("local").clone() {
        return Ok(l);
    }
    let source = Arc::clone(source);
    let conn = tauri::async_runtime::spawn_blocking(move || source())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "This computer's hub isn't running yet.".to_string())?;
    let local = Local {
        base: loopback(&conn.gateway_url)?,
        bearer: conn.admin_token.into(),
    };
    *kept.lock().expect("local") = Some(local.clone());
    Ok(local)
}

/// The hub's address when it is on this computer: plain `http` to a
/// loopback address, with nothing else in it. The admin token goes nowhere
/// else. An address, not a name: nothing a resolver answers decides where
/// the token goes (Desk writes the hub's as `127.0.0.1`).
fn loopback(gateway_url: &str) -> Result<Url, String> {
    let refuse = || "This computer's hub isn't at an address on this computer.".to_string();
    let url = Url::parse(gateway_url).map_err(|_| refuse())?;
    let local_host = url
        .host_str()
        .unwrap_or_default()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<std::net::IpAddr>()
        .is_ok_and(|ip| ip.is_loopback());
    if url.scheme() != "http"
        || !local_host
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(refuse());
    }
    Ok(url)
}

/// `base` at `path` and `query`, exactly as allowed: a URL the parser would
/// normalise into another path isn't sent.
fn at(base: &Url, path: &str, query: Option<&str>) -> Result<Url, String> {
    let mut url = base.clone();
    url.set_path(path);
    url.set_query(query);
    if url.path() != path
        || url.query() != query
        || url.host() != base.host()
        || url.port() != base.port()
    {
        return Err(format!("Desk doesn't send {path} to this computer's hub."));
    }
    Ok(url)
}

/// A request header the page sent, percent-decoded.
fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| percent_decode_str(v).decode_utf8().ok())
        .map(|v| v.into_owned())
}

/// One of `DeskHub`'s requests to the local hub: the method and path (with
/// its query) in `x-desk-method` and `x-desk-path`, the body raw with its
/// kind in `x-desk-type`. The hub's token is added here; the page has none.
#[tauri::command]
pub async fn local_hub_fetch(
    broker: tauri::State<'_, Broker>,
    request: tauri::ipc::Request<'_>,
) -> CommandResult<Answer> {
    let headers = request.headers();
    let method = header(headers, "x-desk-method").ok_or("The request didn't say its method.")?;
    let path = header(headers, "x-desk-path").ok_or("The request didn't say its path.")?;
    let body = match (header(headers, "x-desk-type"), request.body()) {
        (Some(kind), InvokeBody::Raw(bytes)) => Some((kind, bytes.clone())),
        (None, InvokeBody::Raw(bytes)) if bytes.is_empty() => None,
        (None, InvokeBody::Json(serde_json::Value::Null)) => None,
        (None, InvokeBody::Json(v)) if v.as_object().is_some_and(|o| o.is_empty()) => None,
        _ => return Err("The request's body didn't say what it is.".into()),
    };
    broker.fetch(&method, &path, body).await
}

/// Opens one of the page's sockets to the local hub; its frames, and then
/// its close, arrive on `events`.
#[tauri::command]
pub async fn local_hub_socket_open(
    webview: tauri::Webview,
    broker: tauri::State<'_, Broker>,
    path: String,
    events: Channel<InvokeResponseBody>,
) -> CommandResult<u32> {
    let events: socket::Events = Arc::new(move |body| {
        let _ = events.send(body);
    });
    broker.open_socket(webview.label(), &path, events).await
}

/// Sends the raw body down socket `x-desk-socket`, as a text frame or a
/// binary one (`x-desk-frame`).
#[tauri::command]
pub fn local_hub_socket_send(
    webview: tauri::Webview,
    broker: tauri::State<'_, Broker>,
    request: tauri::ipc::Request<'_>,
) -> CommandResult<()> {
    let headers = request.headers();
    let id: u32 = header(headers, "x-desk-socket")
        .and_then(|v| v.parse().ok())
        .ok_or("The frame didn't say its connection.")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("The frame carried nothing.".into());
    };
    let frame = match header(headers, "x-desk-frame").as_deref() {
        Some("binary") => socket::Out::Binary(bytes.clone()),
        Some("text") => socket::Out::Text(
            String::from_utf8(bytes.clone()).map_err(|_| "A text frame must be text.")?,
        ),
        _ => return Err("The frame didn't say its kind.".into()),
    };
    broker.sockets.send(webview.label(), id, frame)
}

/// The page has taken `bytes` more of what socket `id` gave it: the hub's
/// socket is read again while it has room.
#[tauri::command]
pub fn local_hub_socket_ack(
    webview: tauri::Webview,
    broker: tauri::State<'_, Broker>,
    id: u32,
    bytes: usize,
) {
    broker.sockets.ack(webview.label(), id, bytes);
}

#[tauri::command]
pub fn local_hub_socket_close(webview: tauri::Webview, broker: tauri::State<'_, Broker>, id: u32) {
    broker.sockets.close(webview.label(), id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const SENTINEL: &str = "SENTINEL-ADMIN-0f1e2d";

    /// A request as the hub saw it.
    #[derive(Debug, Clone)]
    struct Seen {
        line: String,
        headers: String,
        body: Vec<u8>,
    }

    /// A hub on a loopback port answering each request with the next of
    /// `answers`, and telling what it was sent.
    async fn hub(
        answers: Vec<&'static str>,
    ) -> (String, tokio::sync::mpsc::UnboundedReceiver<Seen>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            for answer in answers {
                let (mut s, _) = listener.accept().await.unwrap();
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let head_end = loop {
                    let n = s.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i;
                    }
                };
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let length = head
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                while buf.len() < head_end + 4 + length {
                    let n = s.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                }
                let (line, headers) = head.split_once("\r\n").unwrap_or((&head, ""));
                let _ = tx.send(Seen {
                    line: line.to_string(),
                    headers: headers.to_ascii_lowercase(),
                    body: buf[head_end + 4..].to_vec(),
                });
                s.write_all(answer.as_bytes()).await.unwrap();
                s.shutdown().await.unwrap();
            }
        });
        (url, rx)
    }

    fn broker_at(url: &str, tokens: Vec<&'static str>) -> Broker {
        // What `run` installs before anything makes a client.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let url = url.to_string();
        let tokens = Arc::new(Mutex::new(tokens.into_iter()));
        Broker::with_source(Arc::new(move || {
            Ok(Some(Connection {
                gateway_url: url.clone(),
                admin_token: tokens
                    .lock()
                    .unwrap()
                    .next()
                    .unwrap_or(SENTINEL)
                    .to_string(),
                device_token: Some("device".into()),
            }))
        }))
    }

    const OK_JSON: &str = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n[]";

    #[tokio::test]
    async fn an_allowed_request_reaches_the_hub_with_the_token_added() {
        let (url, mut seen) = hub(vec![OK_JSON]).await;
        let broker = broker_at(&url, vec![]);
        let answer = broker
            .fetch(
                "PATCH",
                "/api/desk/sessions/s1",
                Some(("application/json".into(), br#"{"name":"x"}"#.to_vec())),
            )
            .await
            .unwrap();
        assert_eq!(answer.status, 200);
        assert_eq!(answer.content_type.as_deref(), Some("application/json"));
        assert_eq!(answer.body, "[]");
        let got = seen.recv().await.unwrap();
        assert_eq!(got.line, "PATCH /api/desk/sessions/s1 HTTP/1.1");
        assert!(got.headers.contains(&format!(
            "authorization: bearer {}",
            SENTINEL.to_ascii_lowercase()
        )));
        assert!(got.headers.contains("content-type: application/json"));
        assert_eq!(got.body, br#"{"name":"x"}"#);
        assert!(!serde_json::to_string(&answer).unwrap().contains(SENTINEL));
    }

    #[tokio::test]
    async fn a_path_and_query_go_as_written() {
        let (url, mut seen) = hub(vec![OK_JSON, OK_JSON]).await;
        let broker = broker_at(&url, vec![]);
        broker
            .fetch("GET", "/api/desk/rooms/search?q=a+b%21&limit=5", None)
            .await
            .unwrap();
        assert_eq!(
            seen.recv().await.unwrap().line,
            "GET /api/desk/rooms/search?q=a+b%21&limit=5 HTTP/1.1"
        );
        broker
            .fetch("DELETE", "/api/desk/state/grid%2Fa%20b", None)
            .await
            .unwrap();
        assert_eq!(
            seen.recv().await.unwrap().line,
            "DELETE /api/desk/state/grid%2Fa%20b HTTP/1.1"
        );
    }

    #[tokio::test]
    async fn a_refused_request_never_reaches_the_hub() {
        let (url, mut seen) = hub(vec![OK_JSON]).await;
        let broker = broker_at(&url, vec![]);
        for (m, p) in [
            ("GET", "/api/vault/speech/openai/api_key"),
            ("POST", "/api/admin/reset-model"),
            ("GET", "/api/desk/sessions?token=x"),
            ("PATCH", "/api/desk/sessions/%2e%2e"),
        ] {
            let e = broker.fetch(m, p, None).await.unwrap_err();
            assert!(e.contains("doesn't send"), "{e}");
        }
        let e = broker
            .fetch(
                "POST",
                "/api/agents",
                Some(("text/html".into(), b"<p>".to_vec())),
            )
            .await
            .unwrap_err();
        assert!(e.contains("text/html"));
        assert!(
            tokio::time::timeout(Duration::from_millis(200), seen.recv())
                .await
                .is_err(),
            "nothing was sent"
        );
    }

    #[tokio::test]
    async fn a_redirect_is_answered_not_followed() {
        let (url, mut seen) = hub(vec![
            "HTTP/1.1 302 Found\r\nlocation: http://127.0.0.1:9/steal\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
        ])
        .await;
        let answer = broker_at(&url, vec![])
            .fetch("GET", "/api/desk/sessions", None)
            .await
            .unwrap();
        assert_eq!(answer.status, 302);
        seen.recv().await.unwrap();
    }

    #[tokio::test]
    async fn a_refused_token_is_read_again_once() {
        let (url, mut seen) = hub(vec![
            "HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
            OK_JSON,
        ])
        .await;
        let broker = broker_at(&url, vec!["old-token", "new-token"]);
        let answer = broker
            .fetch("GET", "/api/desk/sessions", None)
            .await
            .unwrap();
        assert_eq!(answer.status, 200);
        assert!(
            seen.recv()
                .await
                .unwrap()
                .headers
                .contains("bearer old-token")
        );
        assert!(
            seen.recv()
                .await
                .unwrap()
                .headers
                .contains("bearer new-token")
        );
    }

    #[tokio::test]
    async fn the_token_only_goes_to_this_computer() {
        for url in [
            "https://127.0.0.1:3",
            "http://hub.example.com:3",
            "http://10.0.0.1:3",
            "http://user:pw@127.0.0.1:3",
            "http://127.0.0.1:3/prefix",
            "http://127.0.0.1:3/?x=1",
            "http://localhost:3",
            "http://0.0.0.0:3",
            "not a url",
        ] {
            let e = broker_at(url, vec![])
                .fetch("GET", "/api/desk/sessions", None)
                .await
                .unwrap_err();
            assert!(
                e.contains("isn't at an address on this computer"),
                "{url}: {e}"
            );
        }
        for url in [
            "http://127.0.0.1:3",
            "http://127.0.0.1:3/",
            "http://[::1]:3",
        ] {
            assert!(loopback(url).is_ok(), "{url}");
        }
    }

    #[tokio::test]
    async fn a_socket_takes_the_allowlist_too() {
        let broker = broker_at("http://127.0.0.1:9", vec![]);
        let none: socket::Events = Arc::new(|_| {});
        for p in ["/ws/desk", "/api/desk/events?token=x", "/api/desk/sessions"] {
            assert!(
                broker.open_socket("main", p, none.clone()).await.is_err(),
                "{p}"
            );
        }
        assert_eq!(broker.sockets.count(), 0);
    }
}
