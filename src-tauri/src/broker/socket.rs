//! The page's sockets to hubs, held on this side: the local hub's admin
//! sockets (session and terminal PTYs, the event stream) and every paired
//! hub's conversations and links. The page sees their frames through a
//! `Channel` and sends its own one at a time, and the hub's token goes in
//! the handshake's header, never in a URL (and so never in an access log).
//! A hub older than that is sent it in the URL only after it has turned
//! the header away; see [`Legacy`].
//!
//! What the hub sends is paced by what the page takes: a socket whose page
//! hasn't acknowledged [`WINDOW`] bytes isn't read until it does, so a
//! terminal flooding output waits on the hub (which skips a viewer that
//! falls behind to its current screen) instead of piling up in the page.
//! Binary frames the hub has already sent go to the page together, so a
//! flood costs the page one message per [`BATCH`], not one per frame.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::{BoxFuture, FutureExt};
use futures_util::{SinkExt, StreamExt};
use reqwest::Url;
use tauri::ipc::InvokeResponseBody;
use tokio::sync::{Notify, mpsc};
use tokio_tungstenite::Connector;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode, header::AUTHORIZATION};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

/// The most of the local hub's admin sockets the page may hold open at
/// once, in all its windows.
pub const MAX_SOCKETS: usize = 96;
/// The most one window may hold: a grid's nine panes, its event stream and
/// room to reconnect, so no window can leave the others without.
pub const MAX_PER_WINDOW: usize = 32;
/// The most conversations and links to hubs the page may hold open at once:
/// a DM with every agent and a line for each room member.
pub const MAX_HUB_SOCKETS: usize = 192;
/// The most of those one window may hold.
pub const MAX_HUB_PER_WINDOW: usize = 128;
/// Frames the page has sent that the hub hasn't taken yet.
const OUTBOX: usize = 1024;
/// How long a socket the page closed waits for the hub to close too.
const CLOSE_WAIT: Duration = Duration::from_secs(2);
/// How long the hub has to take a socket.
const HANDSHAKE: Duration = if cfg!(test) {
    Duration::from_millis(500)
} else {
    Duration::from_secs(10)
};
/// The most a socket gives the page that it hasn't acknowledged.
pub const WINDOW: usize = 1 << 20;
/// The most of a socket's binary frames given to the page as one.
pub const BATCH: usize = 256 << 10;

/// Where a socket's frames go: the page's `Channel` in the app.
pub type Events = Arc<dyn Fn(InvokeResponseBody) + Send + Sync>;

/// The hub's token for a handshake: the one read, or (`true`) read again
/// because the hub turned the last one away.
pub type Bearer = Arc<dyn Fn(bool) -> BoxFuture<'static, Result<Arc<str>, String>> + Send + Sync>;

/// Which share of sockets one counts against: the local hub's admin
/// sockets, or conversations and links to hubs. A page with many
/// conversations open can't leave its terminals without, nor the other way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pool {
    Local,
    Hubs,
}

impl Pool {
    fn limits(self) -> (usize, usize) {
        match self {
            Pool::Local => (MAX_SOCKETS, MAX_PER_WINDOW),
            Pool::Hubs => (MAX_HUB_SOCKETS, MAX_HUB_PER_WINDOW),
        }
    }
}

/// The hubs, by id, that have been found to read a socket's token only
/// from its URL: older than reading it from the handshake's header.
#[derive(Default)]
pub struct LegacyHubs(Mutex<HashSet<String>>);

impl LegacyHubs {
    fn known(&self, hub: &str) -> bool {
        self.0.lock().expect("legacy").contains(hub)
    }

    fn remember(&self, hub: &str) {
        if self.0.lock().expect("legacy").insert(hub.to_string()) {
            tracing::warn!(
                hub,
                "this workspace reads a socket's token only from its URL: it is older than Desk expects, and its access log may keep the token"
            );
        }
    }

    fn forget(&self, hub: &str) {
        self.0.lock().expect("legacy").remove(hub);
    }
}

/// A hub that may be older than reading a socket's token from the header:
/// which one, and where that is remembered.
#[derive(Clone)]
pub struct Legacy {
    pub hub: String,
    pub hubs: Arc<LegacyHubs>,
}

/// A socket to open: where, with which token, counted in which pool.
pub struct Dial {
    pub url: Url,
    pub bearer: Bearer,
    pub pool: Pool,
    /// For a paired hub's socket: the token may go in the URL to a hub that
    /// turned the header away (none for the local hub's admin sockets,
    /// whose hub is always new enough).
    pub legacy: Option<Legacy>,
}

/// What the page sends down a socket.
#[derive(Debug)]
pub enum Out {
    Text(String),
    Binary(Vec<u8>),
}

enum Said {
    Frame(Out),
    Close,
}

/// What a socket has given the page and the page hasn't taken yet.
#[derive(Default)]
struct Credit {
    unacked: AtomicUsize,
    acked: Notify,
}

impl Credit {
    fn room(&self) -> bool {
        self.unacked.load(Ordering::Acquire) < WINDOW
    }
}

struct Handle {
    /// The webview that opened it; only it may use or close it.
    owner: String,
    pool: Pool,
    out: mpsc::Sender<Said>,
    credit: Arc<Credit>,
    events: Events,
    task: tauri::async_runtime::JoinHandle<()>,
}

type Registry = Arc<Mutex<HashMap<u32, Handle>>>;

/// The sockets the page has open.
#[derive(Default)]
pub struct Sockets {
    open: Registry,
    next: AtomicU32,
    /// How often each window has let its sockets go (its page loaded
    /// again): a socket asked for by the page before is no one's after.
    loads: Mutex<HashMap<String, u64>>,
}

/// Takes socket `id` off the registry when its task ends, however it ends:
/// done, aborted or panicked.
struct Forget {
    registry: Registry,
    id: u32,
}

impl Drop for Forget {
    fn drop(&mut self) {
        // The handle is dropped once the lock is released, never under it.
        let handle = self
            .registry
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.id);
        drop(handle);
    }
}

impl Sockets {
    /// Which of webview `owner`'s pages is loaded: give it to [`open`].
    ///
    /// [`open`]: Self::open
    pub fn page(&self, owner: &str) -> u64 {
        self.loads
            .lock()
            .expect("loads")
            .get(owner)
            .copied()
            .unwrap_or(0)
    }

    /// Opens one of the local hub's admin sockets; see [`dial`].
    ///
    /// [`dial`]: Self::dial
    pub fn open(
        &self,
        owner: &str,
        page: u64,
        url: Url,
        bearer: Bearer,
        events: Events,
    ) -> Result<u32, String> {
        let dial = Dial {
            url,
            bearer,
            pool: Pool::Local,
            legacy: None,
        };
        self.dial(owner, page, dial, events)
    }

    /// Opens `dial` with the hub's token in its handshake for webview
    /// `owner`, asked for by its page `page`; its frames, and then its
    /// close, go to `events`.
    pub fn dial(&self, owner: &str, page: u64, dial: Dial, events: Events) -> Result<u32, String> {
        let (tx, rx) = mpsc::channel(OUTBOX);
        let credit = Arc::new(Credit::default());
        let mut open = self.open.lock().expect("sockets");
        // A page that has gone since it asked would never hear it, and a
        // terminal's viewer nobody sees would keep the keyboard.
        if self.page(owner) != page {
            return Err("That page has gone.".into());
        }
        let pool = dial.pool;
        let (total, per_window) = pool.limits();
        let pooled = open.values().filter(|h| h.pool == pool);
        if pooled.clone().count() >= total
            || pooled.filter(|h| h.owner == owner).count() >= per_window
        {
            return Err(match pool {
                Pool::Local => "Desk has too many connections to this computer's hub open.",
                Pool::Hubs => "Desk has too many conversations open.",
            }
            .into());
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        // Held while spawning: the task's removal of itself waits for this
        // insert, however soon it ends.
        let forget = Forget {
            registry: Arc::clone(&self.open),
            id,
        };
        let task = tauri::async_runtime::spawn({
            let events = Arc::clone(&events);
            let credit = Arc::clone(&credit);
            async move {
                let _forget = forget;
                relay(dial, rx, events, credit).await;
            }
        });
        open.insert(
            id,
            Handle {
                owner: owner.to_string(),
                pool,
                out: tx,
                credit,
                events,
                task,
            },
        );
        Ok(id)
    }

    /// Sends `frame` down socket `id`, after whatever was sent before it.
    pub fn send(&self, owner: &str, id: u32, frame: Out) -> Result<(), String> {
        let open = self.open.lock().expect("sockets");
        let handle = open
            .get(&id)
            .filter(|h| h.owner == owner)
            .ok_or_else(|| "That connection is closed.".to_string())?;
        handle
            .out
            .try_send(Said::Frame(frame))
            .map_err(|e| match e {
                mpsc::error::TrySendError::Full(_) => {
                    "This computer's hub isn't keeping up.".to_string()
                }
                mpsc::error::TrySendError::Closed(_) => "That connection is closed.".to_string(),
            })
    }

    /// The page has taken `bytes` more of what socket `id` gave it.
    pub fn ack(&self, owner: &str, id: u32, bytes: usize) {
        let open = self.open.lock().expect("sockets");
        if let Some(h) = open.get(&id).filter(|h| h.owner == owner) {
            let unacked = &h.credit.unacked;
            let mut n = unacked.load(Ordering::Acquire);
            while let Err(now) = unacked.compare_exchange_weak(
                n,
                n.saturating_sub(bytes),
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                n = now;
            }
            h.credit.acked.notify_one();
        }
    }

    /// Closes socket `id` once what was sent before has gone; its close
    /// reaches the page as the hub's would. A socket whose outbox is full
    /// closes at once.
    pub fn close(&self, owner: &str, id: u32) {
        let mut open = self.open.lock().expect("sockets");
        let Some(h) = open.get(&id).filter(|h| h.owner == owner) else {
            return;
        };
        if h.out.try_send(Said::Close).is_ok() {
            return;
        }
        let h = open.remove(&id).expect("just found");
        drop(open);
        h.task.abort();
        (h.events)(closed(1000, ""));
    }

    /// Drops every socket webview `owner` holds at once: it is loading a
    /// page again, or gone, and nothing would hear them.
    pub fn close_owned(&self, owner: &str) {
        let gone: Vec<Handle> = {
            let mut open = self.open.lock().expect("sockets");
            *self
                .loads
                .lock()
                .expect("loads")
                .entry(owner.to_string())
                .or_default() += 1;
            let ids: Vec<u32> = open
                .iter()
                .filter(|(_, h)| h.owner == owner)
                .map(|(id, _)| *id)
                .collect();
            ids.iter().filter_map(|id| open.remove(id)).collect()
        };
        for h in gone {
            h.task.abort();
        }
    }

    #[cfg(test)]
    pub fn count(&self) -> usize {
        self.open.lock().expect("sockets").len()
    }
}

fn event(value: serde_json::Value) -> InvokeResponseBody {
    InvokeResponseBody::Json(value.to_string())
}

fn closed(code: u16, reason: &str) -> InvokeResponseBody {
    event(
        serde_json::json!({ "type": "close", "code": code, "reason": reason, "clean": code != 1006 }),
    )
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Where a handshake carries the token.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Carry {
    /// `Authorization: Bearer`, marked sensitive.
    Header,
    /// `?token=`: only to a hub that turned the header away.
    Query,
}

/// Why one handshake didn't open a socket.
enum Failed {
    Late,
    Refused(StatusCode),
    Other,
    Unsendable,
    /// The proxy this computer goes through wouldn't tunnel to the hub.
    Proxy(super::tunnel::Refused),
}

impl Failed {
    /// What the page is told: the status the hub answered, never the
    /// request (which, to an older hub, has the token in its URL).
    fn said(&self, pool: Pool) -> String {
        let hub = match pool {
            Pool::Local => "This computer's hub",
            Pool::Hubs => "The workspace",
        };
        match self {
            Failed::Late => format!("{hub} didn't answer in time."),
            Failed::Refused(status) => format!("{hub} refused the connection ({status})."),
            Failed::Other => format!("Desk couldn't reach {}.", hub.to_lowercase()),
            Failed::Unsendable => format!("{hub} has a token Desk can't send."),
            Failed::Proxy(super::tunnel::Refused::Status(status)) => {
                format!(
                    "This computer's proxy refused to reach {} ({status}).",
                    hub.to_lowercase()
                )
            }
            Failed::Proxy(super::tunnel::Refused::Unsupported(kind)) => {
                format!(
                    "Desk can't reach {} through a {kind} proxy.",
                    hub.to_lowercase()
                )
            }
            Failed::Proxy(_) => "Desk couldn't reach this computer's proxy.".into(),
        }
    }
}

/// The TLS a `wss` socket is opened with: the system's trust store, as
/// Desk's other requests to hubs use.
fn tls() -> Result<Arc<rustls::ClientConfig>, Failed> {
    use rustls_platform_verifier::ConfigVerifierExt;
    static CONFIG: std::sync::OnceLock<Arc<rustls::ClientConfig>> = std::sync::OnceLock::new();
    if let Some(c) = CONFIG.get() {
        return Ok(c.clone());
    }
    let config = rustls::ClientConfig::with_platform_verifier().map_err(|e| {
        tracing::warn!(error = %e, "no TLS for sockets");
        Failed::Other
    })?;
    Ok(CONFIG.get_or_init(|| Arc::new(config)).clone())
}

/// One handshake to `url` with `token` carried as `carry` says.
async fn attempt(url: &Url, token: &str, carry: Carry) -> Result<Ws, Failed> {
    let mut url = url.clone();
    if carry == Carry::Query {
        url.query_pairs_mut().append_pair("token", token);
    }
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| Failed::Other)?;
    if carry == Carry::Header {
        let mut auth =
            HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| Failed::Unsendable)?;
        auth.set_sensitive(true);
        request.headers_mut().insert(AUTHORIZATION, auth);
    }
    let connector = match url.scheme() {
        "wss" => Some(Connector::Rustls(tls()?)),
        _ => None,
    };
    let connect = async {
        let opened = match super::tunnel::system_proxy_for(&url) {
            // Through the proxy's tunnel, TLS to the hub inside it.
            Some(proxy) => {
                let host = url.host_str().ok_or(Failed::Other)?;
                let port = url.port_or_known_default().ok_or(Failed::Other)?;
                let stream = super::tunnel::connect(&proxy, host, port)
                    .await
                    .map_err(Failed::Proxy)?;
                tokio_tungstenite::client_async_tls_with_config(request, stream, None, connector)
                    .await
            }
            None => {
                tokio_tungstenite::connect_async_tls_with_config(request, None, false, connector)
                    .await
            }
        };
        match opened {
            Ok((ws, _)) => Ok(ws),
            Err(WsError::Http(r)) => Err(Failed::Refused(r.status())),
            Err(_) => Err(Failed::Other),
        }
    };
    tokio::time::timeout(HANDSHAKE, connect)
        .await
        .unwrap_or(Err(Failed::Late))
}

/// The socket `dial` names, its handshake carrying the hub's token in the
/// header: read again once if the hub turns it away (Desk Helper renews
/// the local hub's; a hub paired again has a new one). A paired hub that
/// still turns it away is asked once more with it in the URL, as hubs
/// before header auth read it; if that opens, the hub is remembered as one
/// of those, and asked that way from then on.
async fn handshake(dial: &Dial) -> Result<Ws, Failed> {
    let legacy = dial.legacy.as_ref();
    if let Some(l) = legacy.filter(|l| l.hubs.known(&l.hub)) {
        let token = (dial.bearer)(false).await.map_err(|_| Failed::Other)?;
        return attempt(&dial.url, &token, Carry::Query)
            .await
            .inspect_err(|_| {
                // Perhaps upgraded since: the header is tried first next time.
                l.hubs.forget(&l.hub);
            });
    }
    let mut fresh = false;
    loop {
        let token = (dial.bearer)(fresh).await.map_err(|_| Failed::Other)?;
        match attempt(&dial.url, &token, Carry::Header).await {
            Err(Failed::Refused(StatusCode::UNAUTHORIZED)) if !fresh => fresh = true,
            Err(Failed::Refused(StatusCode::UNAUTHORIZED)) if legacy.is_some() => {
                let ws = attempt(&dial.url, &token, Carry::Query).await?;
                if let Some(l) = legacy {
                    l.hubs.remember(&l.hub);
                }
                return Ok(ws);
            }
            other => return other,
        }
    }
}

/// Gives the page `body`, counting `n` bytes of it against the window.
fn give(events: &Events, credit: &Credit, n: usize, body: InvokeResponseBody) {
    credit.unacked.fetch_add(n, Ordering::AcqRel);
    events(body);
}

/// Gives the page the binary frames gathered so far, as one.
fn flush(events: &Events, credit: &Credit, batch: &mut Vec<u8>) {
    if !batch.is_empty() {
        let bytes = std::mem::take(batch);
        give(events, credit, bytes.len(), InvokeResponseBody::Raw(bytes));
    }
}

async fn relay(dial: Dial, mut said: mpsc::Receiver<Said>, events: Events, credit: Arc<Credit>) {
    let mut ws = match handshake(&dial).await {
        Ok(ws) => ws,
        Err(why) => {
            events(event(serde_json::json!({ "type": "error" })));
            events(closed(1006, &why.said(dial.pool)));
            return;
        }
    };
    events(event(serde_json::json!({ "type": "open" })));
    let mut batch = Vec::new();
    let (code, reason) = 'relay: loop {
        let room = credit.room();
        tokio::select! {
            heard = ws.next(), if room => {
                // This frame, and those the hub has already sent after it.
                let mut heard = Some(heard);
                while let Some(h) = heard.take() {
                    match h {
                        Some(Ok(Message::Binary(b))) => batch.extend_from_slice(&b),
                        Some(Ok(Message::Text(t))) => {
                            flush(&events, &credit, &mut batch);
                            let n = t.len();
                            give(&events, &credit, n, event(serde_json::json!({ "type": "text", "data": t.as_str(), "n": n })));
                        }
                        // Its pong is queued; flushing sends it.
                        Some(Ok(Message::Ping(_))) => { let _ = ws.flush().await; }
                        Some(Ok(Message::Close(frame))) => {
                            flush(&events, &credit, &mut batch);
                            let _ = ws.flush().await;
                            break 'relay frame.map_or((1005, String::new()), |f| (u16::from(f.code), f.reason.to_string()));
                        }
                        Some(Ok(_)) => {}
                        Some(Err(_)) | None => {
                            flush(&events, &credit, &mut batch);
                            break 'relay (1006, String::new());
                        }
                    }
                    if batch.len() < BATCH && credit.unacked.load(Ordering::Acquire) + batch.len() < WINDOW {
                        heard = ws.next().now_or_never();
                    }
                }
                flush(&events, &credit, &mut batch);
            },
            // The page has taken some: read the hub again.
            () = credit.acked.notified(), if !room => {}
            out = said.recv() => match out {
                Some(Said::Frame(Out::Text(t))) => {
                    if ws.send(Message::Text(t.into())).await.is_err() { break (1006, String::new()); }
                }
                Some(Said::Frame(Out::Binary(b))) => {
                    if ws.send(Message::Binary(b.into())).await.is_err() { break (1006, String::new()); }
                }
                Some(Said::Close) | None => {
                    let _ = ws.close(None).await;
                    let _ = tokio::time::timeout(CLOSE_WAIT, async { while ws.next().await.is_some() {} }).await;
                    break (1000, String::new());
                }
            },
        }
    };
    events(closed(code, &reason));
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};

    /// What a socket told the page.
    #[derive(Debug, Clone, PartialEq)]
    enum Heard {
        Json(serde_json::Value),
        Bytes(Vec<u8>),
    }

    type Heards = tokio::sync::mpsc::UnboundedReceiver<Heard>;

    fn recorder() -> (Events, Heards) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let events: Events = Arc::new(move |body| {
            let _ = tx.send(match body {
                InvokeResponseBody::Json(s) => Heard::Json(serde_json::from_str(&s).unwrap()),
                InvokeResponseBody::Raw(b) => Heard::Bytes(b),
            });
        });
        (events, rx)
    }

    /// The token, the same however often it is read.
    fn token(t: &'static str) -> Bearer {
        Arc::new(move |_| Box::pin(async move { Ok(Arc::from(t)) }))
    }

    async fn next(rx: &mut Heards) -> Heard {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("in time")
            .expect("a frame")
    }

    /// The JSON the page is told next, skipping nothing.
    async fn said(rx: &mut Heards) -> serde_json::Value {
        match next(rx).await {
            Heard::Json(v) => v,
            Heard::Bytes(b) => panic!("bytes {b:?}"),
        }
    }

    async fn listener() -> (TcpListener, Url) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!(
            "ws://{}/api/desk/sessions/s1/pty",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        (listener, url)
    }

    fn authorization(req: &Request) -> String {
        req.headers()
            .get(AUTHORIZATION)
            .map(|v| v.to_str().unwrap().to_string())
            .unwrap_or_default()
    }

    /// A hub that echoes, after saying what Authorization and URI the
    /// handshake carried.
    // The handshake callback's error type is tungstenite's own.
    #[allow(clippy::result_large_err)]
    async fn echo_hub() -> Url {
        let (listener, url) = listener().await;
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut seen = (String::new(), String::new());
            let mut ws =
                tokio_tungstenite::accept_hdr_async(stream, |req: &Request, res: Response| {
                    seen = (authorization(req), req.uri().to_string());
                    Ok(res)
                })
                .await
                .unwrap();
            ws.send(Message::Text(format!("{}|{}", seen.0, seen.1).into()))
                .await
                .unwrap();
            while let Some(Ok(m)) = ws.next().await {
                if m.is_close() {
                    break;
                }
                if m.is_binary() || m.is_text() {
                    ws.send(m).await.unwrap();
                }
            }
        });
        url
    }

    #[tokio::test]
    async fn frames_go_both_ways_in_order_with_the_token_only_in_the_header() {
        let url = echo_hub().await;
        let sockets = Sockets::default();
        let (events, mut rx) = recorder();
        let id = sockets
            .open("main", 0, url, token("SENTINEL-ADMIN"), events)
            .unwrap();
        assert_eq!(said(&mut rx).await, serde_json::json!({ "type": "open" }));
        let hello = said(&mut rx).await;
        assert_eq!(
            hello["data"],
            "Bearer SENTINEL-ADMIN|/api/desk/sessions/s1/pty"
        );
        assert_eq!(hello["n"], hello["data"].as_str().unwrap().len());
        for i in 0..50u8 {
            sockets.send("main", id, Out::Binary(vec![i, i])).unwrap();
        }
        sockets
            .send("main", id, Out::Text("{\"type\":\"ping\"}".into()))
            .unwrap();
        // The binary frames arrive in order, some of them together, and
        // before the text frame sent after them.
        let mut bytes = Vec::new();
        while bytes.len() < 100 {
            match next(&mut rx).await {
                Heard::Bytes(b) => bytes.extend(b),
                other => panic!("{other:?}"),
            }
        }
        assert_eq!(bytes, (0..50u8).flat_map(|i| [i, i]).collect::<Vec<_>>());
        assert_eq!(
            said(&mut rx).await,
            serde_json::json!({ "type": "text", "data": "{\"type\":\"ping\"}", "n": 15 })
        );
        // Another window can neither use, acknowledge nor close it.
        assert!(sockets.send("grid-1", id, Out::Text("x".into())).is_err());
        sockets.close("grid-1", id);
        sockets.close("main", id);
        let close = said(&mut rx).await;
        assert_eq!(close["type"], "close");
        assert_eq!(close["clean"], true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(sockets.count(), 0, "a closed socket is forgotten");
        assert!(sockets.send("main", id, Out::Text("x".into())).is_err());
    }

    #[tokio::test]
    async fn a_refused_handshake_says_why_and_closes() {
        let (listener, url) = listener().await;
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 2048];
            let _ = tokio::io::AsyncReadExt::read(&mut s, &mut buf).await;
            s.write_all(b"HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n")
                .await
                .unwrap();
        });
        let sockets = Sockets::default();
        let (events, mut rx) = recorder();
        sockets
            .open("main", 0, url, token("SENTINEL-ADMIN"), events)
            .unwrap();
        assert_eq!(said(&mut rx).await, serde_json::json!({ "type": "error" }));
        let close = said(&mut rx).await;
        assert_eq!(close["code"], 1006);
        let reason = close["reason"].as_str().unwrap();
        assert!(reason.contains("403"), "{reason}");
        assert!(!reason.contains("SENTINEL"));
    }

    /// The hub turns the first token away: it is read again, once.
    // The handshake callback's error type is tungstenite's own.
    #[allow(clippy::result_large_err)]
    #[tokio::test]
    async fn a_refused_token_is_read_again_once() {
        let (listener, url) = listener().await;
        let (seen_tx, mut seen) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let seen_tx = seen_tx.clone();
                let _ = tokio_tungstenite::accept_hdr_async(
                    stream,
                    move |req: &Request, res: Response| {
                        let auth = authorization(req);
                        let _ = seen_tx.send(auth.clone());
                        if auth == "Bearer new" {
                            Ok(res)
                        } else {
                            let mut no = ErrorResponse::new(None);
                            *no.status_mut() = StatusCode::UNAUTHORIZED;
                            Err(no)
                        }
                    },
                )
                .await;
            }
        });
        let reads = Arc::new(Mutex::new(Vec::new()));
        let bearer: Bearer = {
            let reads = Arc::clone(&reads);
            Arc::new(move |fresh| {
                reads.lock().unwrap().push(fresh);
                Box::pin(async move { Ok(Arc::from(if fresh { "new" } else { "old" })) })
            })
        };
        let sockets = Sockets::default();
        let (events, mut rx) = recorder();
        sockets
            .open("main", 0, url.clone(), bearer, events)
            .unwrap();
        assert_eq!(said(&mut rx).await["type"], "open");
        assert_eq!(*reads.lock().unwrap(), [false, true]);
        assert_eq!(seen.recv().await.unwrap(), "Bearer old");
        assert_eq!(seen.recv().await.unwrap(), "Bearer new");
        // And only once: a hub that keeps refusing is said to.
        let (events, mut rx) = recorder();
        sockets.open("main", 0, url, token("old"), events).unwrap();
        assert_eq!(said(&mut rx).await["type"], "error");
        assert!(
            said(&mut rx).await["reason"]
                .as_str()
                .unwrap()
                .contains("401")
        );
        assert_eq!(seen.recv().await.unwrap(), "Bearer old");
        assert_eq!(seen.recv().await.unwrap(), "Bearer old");
        assert!(seen.try_recv().is_err());
    }

    #[tokio::test]
    async fn a_hub_that_never_answers_is_given_up_on() {
        // It takes the connection and says nothing.
        let (_silent, url) = listener().await;
        let sockets = Sockets::default();
        let (events, mut rx) = recorder();
        sockets.open("main", 0, url, token("t"), events).unwrap();
        assert_eq!(said(&mut rx).await["type"], "error");
        let close = said(&mut rx).await;
        assert_eq!(close["code"], 1006);
        assert!(close["reason"].as_str().unwrap().contains("in time"));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(sockets.count(), 0);
    }

    #[tokio::test]
    async fn a_reloaded_page_drops_its_sockets_and_only_its_own() {
        let sockets = Sockets::default();
        let mut ids = vec![];
        for owner in ["main", "main", "grid-1"] {
            let url = echo_hub().await;
            let (events, _rx) = recorder();
            ids.push(sockets.open(owner, 0, url, token("t"), events).unwrap());
        }
        sockets.close_owned("main");
        assert_eq!(sockets.count(), 1);
        assert!(
            sockets
                .send("grid-1", ids[2], Out::Text("x".into()))
                .is_ok()
        );
        // A socket the old page asked for, opening after the new page has
        // loaded, isn't opened; the new page's are.
        let (events, _rx) = recorder();
        assert!(
            sockets
                .open("main", 0, echo_hub().await, token("t"), events.clone())
                .is_err()
        );
        let page = sockets.page("main");
        assert_eq!(page, 1);
        assert!(
            sockets
                .open("main", page, echo_hub().await, token("t"), events)
                .is_ok()
        );
        assert_eq!(sockets.page("grid-1"), 0);
    }

    #[tokio::test]
    async fn there_is_a_limit_to_how_many_and_to_one_window() {
        let sockets = Sockets::default();
        // A hub that never answers a handshake: each waits, and counts meanwhile.
        let (_silent, url) = listener().await;
        let open = |owner: &str| {
            let (events, _rx) = recorder();
            sockets.open(owner, sockets.page(owner), url.clone(), token("t"), events)
        };
        for _ in 0..MAX_PER_WINDOW {
            open("main").unwrap();
        }
        assert!(open("main").is_err(), "one window has its share");
        for w in 1.. {
            let window = format!("grid-{w}");
            if sockets.count() == MAX_SOCKETS {
                assert!(open(&window).is_err(), "and all of them theirs");
                break;
            }
            open(&window).unwrap();
        }
        sockets.close_owned("main");
        assert!(open("main").is_ok());
    }

    #[tokio::test]
    async fn a_close_that_cant_wait_its_turn_closes_at_once() {
        // The hub never answers, so nothing the page sends leaves.
        let (_silent, url) = listener().await;
        let sockets = Sockets::default();
        let (events, mut rx) = recorder();
        let id = sockets.open("main", 0, url, token("t"), events).unwrap();
        while sockets.send("main", id, Out::Text("x".into())).is_ok() {}
        sockets.close("main", id);
        assert_eq!(sockets.count(), 0, "it is forgotten");
        let close = said(&mut rx).await;
        assert_eq!(close["type"], "close");
        assert_eq!(close["code"], 1000);
    }

    /// A hub flooding a terminal: `total` bytes in 8 KiB frames, as fast as
    /// the socket takes them. It tells what the page sent it.
    async fn flooding_hub(total: usize) -> (Url, tokio::sync::mpsc::UnboundedReceiver<String>) {
        let (listener, url) = listener().await;
        let (heard_tx, heard) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            let (mut tx, mut rx) = ws.split();
            tokio::spawn(async move {
                while let Some(Ok(m)) = rx.next().await {
                    if let Message::Text(t) = m {
                        let _ = heard_tx.send(t.to_string());
                    }
                }
            });
            let frame = vec![b'y'; 8192];
            for _ in 0..total / frame.len() {
                if tx
                    .send(Message::Binary(frame.clone().into()))
                    .await
                    .is_err()
                {
                    return;
                }
            }
            let _ = tx.close().await;
        });
        (url, heard)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_flood_waits_for_the_page_and_reaches_it_in_batches() {
        const TOTAL: usize = 16 << 20;
        let (url, mut hub_heard) = flooding_hub(TOTAL).await;
        let sockets = Sockets::default();
        let (events, mut rx) = recorder();
        let id = sockets.open("main", 0, url, token("t"), events).unwrap();
        assert_eq!(said(&mut rx).await["type"], "open");
        // A page that takes nothing is given no more than its window.
        let mut given = 0;
        let mut messages = 0;
        loop {
            match tokio::time::timeout(Duration::from_millis(300), rx.recv()).await {
                Ok(Some(Heard::Bytes(b))) => {
                    assert!(b.len() <= BATCH + 8192);
                    given += b.len();
                    messages += 1;
                }
                Ok(other) => panic!("{other:?}"),
                Err(_) => break,
            }
        }
        assert!(given >= WINDOW / 2, "the window is used: {given}");
        assert!(given <= WINDOW + BATCH, "and not passed: {given}");
        // What the page sends still goes meanwhile: a Ctrl-C reaches it.
        sockets
            .send("main", id, Out::Text("interrupt".into()))
            .unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), hub_heard.recv())
                .await
                .unwrap()
                .unwrap(),
            "interrupt"
        );
        // A page that takes what it is given gets the rest, a batch at a time.
        sockets.ack("grid-1", id, given);
        assert!(
            tokio::time::timeout(Duration::from_millis(200), rx.recv())
                .await
                .is_err(),
            "another window's acknowledgement counts for nothing"
        );
        // A page slower than the hub: it takes what it was given now and
        // then, half a window at a time; meanwhile the hub's frames wait
        // and then come together.
        sockets.ack("main", id, given);
        let mut owed = 0;
        loop {
            match next(&mut rx).await {
                Heard::Bytes(b) => {
                    given += b.len();
                    messages += 1;
                    owed += b.len();
                    if owed >= WINDOW / 2 {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                        sockets.ack("main", id, std::mem::take(&mut owed));
                    }
                }
                Heard::Json(v) => {
                    assert_eq!(v["type"], "close");
                    break;
                }
            }
        }
        assert_eq!(given, TOTAL);
        assert!(
            messages <= TOTAL / (32 << 10),
            "{messages} messages for {} frames",
            TOTAL / 8192
        );
    }
}
