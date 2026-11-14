//! The local hub's admin surface, brokered. The page never holds the hub's
//! gateway (admin) token: it asks for one of `DeskHub`'s own requests by
//! method and path, and this side checks it against the allowlist in
//! [`routes`], adds the token and sends it to the hub on this computer. Its
//! sockets (session and terminal PTYs, the event stream) are held here too,
//! in [`socket`].
//!
//! A machine's hub (a computer of the person's own, reached over SSH) is
//! brokered the same way, by a broker of its own: its tokens are read over
//! SSH and kept in memory (`desk_machine::Link`), and go only through the
//! forward's Unix socket here.
//!
//! Every other hub request the page makes (to the local hub as the person,
//! with its paired-device token, and to every paired hub) goes through
//! `hub_io`, which holds those tokens the same way.

pub mod routes;
pub mod socket;
pub mod tunnel;

use std::sync::{Arc, Mutex};

use desk_core::backend::{Backend, Connection};
use percent_encoding::percent_decode_str;
use reqwest::header::{CONTENT_TYPE, HeaderMap};
use reqwest::{Method, StatusCode, Url};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody};

use crate::CommandResult;

/// The kinds of body the page sends: `DeskHub`'s JSON, its text files
/// (identity files, an agent's TOML), and an agent's picture.
pub(crate) const BODY_TYPES: &[&str] = &[
    "application/json",
    "text/plain",
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "application/octet-stream",
];

/// The largest body the page sends: a picture, at most.
pub(crate) const MAX_BODY: usize = 16 * 1024 * 1024;

/// Reads the hub's connection; blocking (on Windows it asks WSL, for a
/// machine it asks over SSH).
type Source = Arc<dyn Fn() -> eyre::Result<Option<Connection>> + Send + Sync>;

/// Which hub a broker reaches, as the page is told of it.
#[derive(Clone)]
struct Place {
    /// "this computer's hub", "devbox".
    hub: Arc<str>,
    /// Said while there is no hub there yet.
    idle: Arc<str>,
    /// What the page may ask of it.
    routes: fn(&str, &str) -> Result<routes::Allowed, routes::Refused>,
    pool: socket::Pool,
}

/// A machine's hub as its broker reaches it (`desk_machine::Link`): never
/// kept by the broker, so every request and socket goes to where the
/// forward is now, never to a port here it held before. Blocking.
pub trait Reached: Send + Sync + 'static {
    /// The tokens as last read, at the forward's address as it is now.
    fn connection(&self) -> Result<Option<Connection>, String>;
    /// The tokens and the gateway read again over SSH.
    fn read(&self) -> Result<Option<Connection>, String>;
    /// Forgets the tokens: the next connection reads them again.
    fn forget(&self);
    /// The machine's gateway port, as last read.
    fn gateway(&self) -> Option<u16>;
    /// The forward's Unix socket here, the only way to the machine's hub;
    /// none for a stand-in reached over loopback TCP in tests.
    fn socket(&self) -> Option<std::path::PathBuf>;
}

impl Reached for desk_machine::Link {
    fn connection(&self) -> Result<Option<Connection>, String> {
        desk_machine::Link::connection(self)
    }
    fn read(&self) -> Result<Option<Connection>, String> {
        desk_machine::Link::read(self)
    }
    fn forget(&self) {
        desk_machine::Link::forget(self)
    }
    fn gateway(&self) -> Option<u16> {
        desk_machine::Link::gateway(self)
    }
    fn socket(&self) -> Option<std::path::PathBuf> {
        Some(desk_machine::Link::socket(self).to_path_buf())
    }
}

impl Place {
    fn local() -> Self {
        Self {
            hub: "Desk's helper".into(),
            idle: "Desk isn't ready yet. Try again in a moment.".into(),
            routes: routes::http,
            pool: socket::Pool::Local,
        }
    }
}

/// The local hub as the broker reaches it. Deliberately not `Debug`.
#[derive(Clone)]
struct Local {
    base: Url,
    bearer: Arc<str>,
}

/// The local hub as last read: once, and again when the hub turns the token
/// away (Desk Helper renews it) or can't be reached where it was (Desk
/// Helper gave it new ports).
type Kept = Arc<Mutex<Option<Local>>>;

pub struct Broker {
    source: Source,
    place: Place,
    /// For a machine's hub: where it is and its tokens, read each time.
    machine: Option<Arc<dyn Reached>>,
    /// The forward's socket its requests and sockets go through.
    unix: Option<std::path::PathBuf>,
    local: Kept,
    /// Reading it again when it can't be reached where it was.
    reread: Arc<crate::reread::Reread>,
    client: reqwest::Client,
    sockets: Arc<socket::Sockets>,
}

/// The hub's answer, as the page reads it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: String,
}

/// The hub's answer to a request only the native side makes (an account's
/// sign-in handed over): never shown to the page, never printed (no
/// `Debug`, no `Serialize`), and wiped from memory once dropped.
pub struct NativeAnswer {
    pub status: u16,
    pub body: zeroize::Zeroizing<String>,
}

/// Why a request got no answer: whether the hub may have had it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unanswered {
    /// Nothing reached the hub: it did nothing.
    NotSent(String),
    /// The hub may have had it, and done it.
    MaybeSent(String),
}

impl Unanswered {
    pub fn said(self) -> String {
        match self {
            Self::NotSent(s) | Self::MaybeSent(s) => s,
        }
    }
}

/// A body of JSON.
fn json(bytes: Vec<u8>) -> (String, Vec<u8>) {
    ("application/json".to_string(), bytes)
}

impl Broker {
    /// The broker for `backend`'s hub; none until Windows has one. Its
    /// sockets are kept with every other hub socket the page holds.
    pub fn new(backend: Option<Backend>, sockets: Arc<socket::Sockets>) -> Self {
        Self::with_source(
            Arc::new(move || match &backend {
                Some(b) => b.connection(),
                None => Err(eyre::eyre!(crate::NOT_SET_UP)),
            }),
            sockets,
        )
    }

    /// The broker for machine `link`'s hub, its sockets counted in a pool
    /// of their own (`pool`, a number no other broker has).
    pub fn machine(
        link: Arc<desk_machine::Link>,
        sockets: Arc<socket::Sockets>,
        pool: u32,
    ) -> Result<Self, String> {
        let name = link.machine().name.clone();
        Self::machine_with(&name, link, sockets, pool, false)
    }

    /// A machine's broker reaching it through `machine`'s socket; refused
    /// without one, unless it is a stand-in on loopback TCP (`tcp`, the
    /// tests').
    fn machine_with(
        name: &str,
        machine: Arc<dyn Reached>,
        sockets: Arc<socket::Sockets>,
        pool: u32,
        tcp: bool,
    ) -> Result<Self, String> {
        let mut broker = Self::with_source(
            Arc::new(|| Err(eyre::eyre!("a machine is read through its link"))),
            sockets,
        );
        // Through the forward's socket and nothing else, whatever host its
        // address names.
        let socket = machine.socket();
        if socket.is_none() && !tcp {
            return Err(format!("Desk has no connection to {name}."));
        }
        #[cfg(unix)]
        if let Some(socket) = socket {
            broker.client = desk_core::net::machine(&socket);
            broker.unix = Some(socket);
        }
        #[cfg(not(unix))]
        let _ = socket;
        broker.machine = Some(machine);
        broker.place = Place {
            hub: name.into(),
            idle: format!("{name} is up, but Desk isn't running there.").into(),
            routes: routes::machine_http,
            pool: socket::Pool::Machine(pool),
        };
        Ok(broker)
    }

    fn with_source(source: Source, sockets: Arc<socket::Sockets>) -> Self {
        Self {
            source,
            place: Place::local(),
            machine: None,
            unix: None,
            local: Kept::default(),
            reread: Arc::default(),
            // The token goes to the hub on this computer and nowhere else:
            // never through a proxy, never after a redirect.
            client: desk_core::net::loopback(),
            sockets,
        }
    }

    async fn local(&self) -> Result<Local, String> {
        match &self.machine {
            Some(m) => through(m, self.unix.is_some(), &self.place.idle).await,
            None => read(&self.source, &self.local, &self.place.idle).await,
        }
    }

    fn forget(&self) {
        match &self.machine {
            Some(m) => m.forget(),
            None => *self.local.lock().expect("local") = None,
        }
    }

    /// Reads where the hub is again after nothing answered where it was:
    /// once however many failed together, at most once every
    /// [`crate::reread::GAP`].
    async fn reread(&self) {
        self.reread
            .run(|| async {
                match &self.machine {
                    Some(m) => {
                        let m = Arc::clone(m);
                        let _ = tauri::async_runtime::spawn_blocking(move || m.read()).await;
                    }
                    None => {
                        self.forget();
                        let _ = self.local().await;
                    }
                }
            })
            .await;
    }

    /// One of `DeskHub`'s requests, sent as the hub's admin.
    pub async fn fetch(
        &self,
        method: &str,
        target: &str,
        body: Option<(String, Vec<u8>)>,
    ) -> Result<Answer, String> {
        let allowed = (self.place.routes)(method, target).map_err(|e| e.to_string())?;
        self.send_allowed(allowed, body).await
    }

    /// One of the native side's own requests to this computer's hub
    /// ([`routes::native_local`]): never the page's, and never a machine's.
    pub async fn fetch_native(&self, method: &str, target: &str) -> Result<NativeAnswer, String> {
        if self.machine.is_some() {
            return Err("Desk asks that of its own helper alone.".into());
        }
        let allowed = routes::native_local(method, target).map_err(|e| e.to_string())?;
        let Answer { status, body, .. } = self.send_allowed(allowed, None).await?;
        Ok(NativeAnswer {
            status,
            body: zeroize::Zeroizing::new(body),
        })
    }

    /// One of the native side's requests about a group's boss on another
    /// hub ([`routes::native_boss`]), to this computer's hub or, through
    /// its forward, a machine's: never the page's. `body` is JSON, which
    /// may hold a link token; the answer is kept as a native one is.
    pub async fn fetch_boss(
        &self,
        method: &str,
        target: &str,
        body: Option<&zeroize::Zeroizing<String>>,
    ) -> Result<NativeAnswer, String> {
        let allowed = routes::native_boss(method, target).map_err(|e| e.to_string())?;
        let body = body.map(|b| ("application/json".to_string(), b.as_bytes().to_vec()));
        let Answer { status, body, .. } = self.send_allowed(allowed, body).await?;
        Ok(NativeAnswer {
            status,
            body: zeroize::Zeroizing::new(body),
        })
    }

    /// A boss's relayed call taken from, or its answer posted to, this
    /// computer's hub ([`routes::relay_local`]): the native side's alone,
    /// never a machine's, its answer read up to `most` bytes.
    pub async fn relay_local(
        &self,
        method: &str,
        target: &str,
        body: Option<Vec<u8>>,
        most: usize,
    ) -> Result<Answer, Unanswered> {
        if self.machine.is_some() {
            return Err(Unanswered::NotSent(
                "Desk takes relayed calls from its own helper alone.".into(),
            ));
        }
        let allowed =
            routes::relay_local(method, target).map_err(|e| Unanswered::NotSent(e.to_string()))?;
        self.send_capped(allowed, body.map(json), most).await
    }

    /// A boss's relayed call sent to this machine's hub
    /// ([`routes::relay_machine`]): the native side's alone, never this
    /// computer's, its answer read up to `most` bytes.
    pub async fn relay_machine(
        &self,
        method: &str,
        target: &str,
        body: Option<Vec<u8>>,
        most: usize,
    ) -> Result<Answer, Unanswered> {
        if self.machine.is_none() {
            return Err(Unanswered::NotSent(
                "Desk relays a boss's calls to its machines alone.".into(),
            ));
        }
        let allowed = routes::relay_machine(method, target)
            .map_err(|e| Unanswered::NotSent(e.to_string()))?;
        self.send_capped(allowed, body.map(json), most).await
    }

    async fn send_allowed(
        &self,
        allowed: routes::Allowed,
        body: Option<(String, Vec<u8>)>,
    ) -> Result<Answer, String> {
        self.send_capped(allowed, body, usize::MAX)
            .await
            .map_err(Unanswered::said)
    }

    /// `allowed` sent, its answer read up to `most` bytes; when no answer
    /// comes, whether the hub may have had the request.
    async fn send_capped(
        &self,
        allowed: routes::Allowed,
        body: Option<(String, Vec<u8>)>,
        most: usize,
    ) -> Result<Answer, Unanswered> {
        use Unanswered::{MaybeSent, NotSent};
        let hub = &self.place.hub;
        if let Some((kind, bytes)) = &body {
            if !BODY_TYPES.contains(&kind.as_str()) {
                return Err(NotSent(format!("Desk doesn't send {kind} to {hub}.")));
            }
            if bytes.len() > MAX_BODY {
                return Err(NotSent(format!("That's too big to send to {hub}.")));
            }
        }
        let method =
            Method::from_bytes(allowed.method.as_bytes()).map_err(|e| NotSent(e.to_string()))?;
        let send = |local: Local| {
            let url = at(&local.base, &allowed.path, allowed.query.as_deref()).map_err(NotSent);
            let mut request = self
                .client
                .request(method.clone(), url?)
                .bearer_auth(&local.bearer);
            // Through the forward: the Host the hub is at on the machine.
            if self.unix.is_some()
                && let Some(host) = desk_core::net::machine_host(&local.base)
            {
                request = request.header(reqwest::header::HOST, host);
            }
            if let Some((kind, bytes)) = &body {
                request = request
                    .header(CONTENT_TYPE, kind.as_str())
                    .body(bytes.clone());
            }
            Ok::<_, Unanswered>(request.send())
        };
        // Refused before it was sent, nothing got it; otherwise the hub
        // may have.
        let unreachable = |e: reqwest::Error| {
            let nothing_sent = e.is_connect() || e.is_builder();
            let said = format!("Desk couldn't reach {hub}: {}", e.without_url());
            if nothing_sent {
                NotSent(said)
            } else {
                MaybeSent(said)
            }
        };
        let local = self.local().await.map_err(NotSent)?;
        let mut response = match send(local.clone())?.await {
            Ok(r) => r,
            // Desk Helper may have moved the hub to new ports: where it is
            // is read again, and the request sent there if it moved (it
            // never reached the old address).
            Err(e) if e.is_connect() => {
                self.reread().await;
                let now = self.local().await.map_err(NotSent)?;
                // A machine's forward refused it: nothing got it, and the
                // forward is up again now (or `local` failed).
                if now.base == local.base && self.machine.is_none() {
                    return Err(unreachable(e));
                }
                send(now)?.await.map_err(unreachable)?
            }
            // Through a machine's forward, ssh took the connection and
            // closed it before any answer. Sent again only when the
            // machine's gateway turns out to have moved, so ssh's channel
            // had nothing to reach: the forward ending under a request that
            // got through (a new port here once it is back) is not that.
            // Only a request that changes nothing (GET, HEAD) is: anything
            // else may have been done before the hub moved.
            Err(e)
                if self.machine.is_some()
                    && e.is_request()
                    && !e.is_timeout()
                    && matches!(method, Method::GET | Method::HEAD) =>
            {
                let machine = self.machine.as_ref().expect("a machine");
                let gateway = machine.gateway();
                self.reread().await;
                let now = self.local().await.map_err(MaybeSent)?;
                if machine.gateway() == gateway {
                    return Err(unreachable(e));
                }
                send(now)?.await.map_err(unreachable)?
            }
            Err(e) => return Err(unreachable(e)),
        };
        // A refused token is read again once: the hub may have a new one.
        // The hub refused before doing anything, so sending again is safe.
        if response.status() == StatusCode::UNAUTHORIZED {
            self.forget();
            response = send(self.local().await.map_err(NotSent)?)?
                .await
                .map_err(unreachable)?;
        }
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let read = |e: reqwest::Error| {
            MaybeSent(format!("Desk couldn't reach {hub}: {}", e.without_url()))
        };
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(read)? {
            if bytes.len().saturating_add(chunk.len()) > most {
                return Err(MaybeSent(format!("{hub}'s answer is too large.")));
            }
            bytes.extend_from_slice(&chunk);
        }
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
        if self.reread.is_stale() {
            self.reread().await;
        }
        let local = self.local().await?;
        let mut url = at(&local.base, &allowed.path, None)?;
        url.set_scheme("ws")
            .map_err(|_| "Desk's helper has no socket address.".to_string())?;
        let (source, kept) = (Arc::clone(&self.source), Arc::clone(&self.local));
        let (idle, machine) = (Arc::clone(&self.place.idle), self.machine.clone());
        let forwarded = self.unix.is_some();
        let bearer: socket::Bearer = Arc::new(move |fresh| {
            let (source, kept) = (Arc::clone(&source), Arc::clone(&kept));
            let (idle, machine) = (Arc::clone(&idle), machine.clone());
            Box::pin(async move {
                if let Some(m) = machine {
                    if fresh {
                        m.forget();
                    }
                    return through(&m, forwarded, &idle).await.map(|l| l.bearer);
                }
                if fresh {
                    *kept.lock().expect("local") = None;
                }
                read(&source, &kept, &idle).await.map(|l| l.bearer)
            })
        });
        // Desk Helper may have moved the hub: read again for the next one.
        let reread = Arc::clone(&self.reread);
        let unreachable: socket::Unreachable = Arc::new(move || reread.mark_stale());
        let dial = socket::Dial {
            url,
            bearer,
            pool: self.place.pool,
            legacy: None,
            unreachable: Some(unreachable),
            unix: self.unix.clone(),
        };
        self.sockets.dial(owner, page, dial, events)
    }
}

/// A machine's hub where its forward is now, with its tokens as kept (or
/// read now over SSH). Through the forward's socket its address is checked
/// as one that resolves nowhere (`<id>.machine.invalid`), so no client not
/// bound to the socket could reach anything with it; a stand-in reached
/// over TCP (the tests') must be on this computer's loopback.
async fn through(machine: &Arc<dyn Reached>, forwarded: bool, idle: &str) -> Result<Local, String> {
    let m = Arc::clone(machine);
    let conn = tauri::async_runtime::spawn_blocking(move || m.connection())
        .await
        .map_err(|e| e.to_string())??
        .ok_or_else(|| idle.to_string())?;
    let base = if forwarded {
        desk_core::net::machine_url(&conn.gateway_url)?
    } else {
        loopback(&conn.gateway_url)?
    };
    Ok(Local {
        base,
        bearer: conn.admin_token.into(),
    })
}

/// The hub as kept, or read now (and kept) if it isn't.
async fn read(source: &Source, kept: &Kept, idle: &str) -> Result<Local, String> {
    if let Some(l) = kept.lock().expect("local").clone() {
        return Ok(l);
    }
    let source = Arc::clone(source);
    let conn = tauri::async_runtime::spawn_blocking(move || source())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?
        .ok_or_else(|| idle.to_string())?;
    let local = Local {
        base: loopback(&conn.gateway_url)?,
        bearer: conn.admin_token.into(),
    };
    *kept.lock().expect("local") = Some(local.clone());
    Ok(local)
}

/// The hub's address when it is on this computer: plain `http` to a
/// loopback address, with nothing else in it. The admin token goes nowhere
/// else (Desk writes the hub's as `127.0.0.1`).
fn loopback(gateway_url: &str) -> Result<Url, String> {
    desk_core::net::loopback_url(gateway_url)
}

/// `base` at `path` and `query`, exactly as allowed: a URL the parser would
/// normalise into another path isn't sent.
fn at(base: &Url, path: &str, query: Option<&str>) -> Result<Url, String> {
    desk_core::net::at(base, path, query)
        .map_err(|_| format!("Desk doesn't send {path} to its helper."))
}

/// A request header the page sent, percent-decoded.
pub(crate) fn header(headers: &HeaderMap, name: &str) -> Option<String> {
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
    let (method, path, body) = brokered(&request)?;
    broker.fetch(&method, &path, body).await
}

/// The method, path and body of one of `DeskHub`'s brokered requests.
pub(crate) type Brokered = (String, String, Option<(String, Vec<u8>)>);

/// A brokered request as the page sends it: see [`local_hub_fetch`].
pub(crate) fn brokered(request: &tauri::ipc::Request<'_>) -> Result<Brokered, String> {
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
    Ok((method, path, body))
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

/// Sends the raw body down socket `x-desk-socket` (any hub's), as a text
/// frame or a binary one (`x-desk-frame`).
#[tauri::command]
pub fn socket_send(
    webview: tauri::Webview,
    sockets: tauri::State<'_, Arc<socket::Sockets>>,
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
    sockets.send(webview.label(), id, frame)
}

/// The page has taken `bytes` more of what socket `id` gave it: the hub's
/// socket is read again while it has room.
#[tauri::command]
pub fn socket_ack(
    webview: tauri::Webview,
    sockets: tauri::State<'_, Arc<socket::Sockets>>,
    id: u32,
    bytes: usize,
) {
    sockets.ack(webview.label(), id, bytes);
}

#[tauri::command]
pub fn socket_close(
    webview: tauri::Webview,
    sockets: tauri::State<'_, Arc<socket::Sockets>>,
    id: u32,
) {
    sockets.close(webview.label(), id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
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
        Broker::with_source(
            Arc::new(move || {
                Ok(Some(Connection {
                    gateway_url: url.clone(),
                    admin_token: tokens
                        .lock()
                        .unwrap()
                        .next()
                        .unwrap_or(SENTINEL)
                        .to_string(),
                    device_token: Some("device".into()),
                    version: None,
                }))
            }),
            Arc::default(),
        )
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

    /// An address nothing listens on any more.
    fn gone_address() -> String {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", l.local_addr().unwrap())
    }

    /// A broker whose hub is wherever `at` says, and how often it read it.
    fn broker_following(
        at: Arc<Mutex<String>>,
        gap: Duration,
    ) -> (Broker, Arc<std::sync::atomic::AtomicUsize>) {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = Arc::clone(&reads);
        let mut broker = Broker::with_source(
            Arc::new(move || {
                counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(Some(Connection {
                    gateway_url: at.lock().unwrap().clone(),
                    admin_token: SENTINEL.into(),
                    device_token: Some("device".into()),
                    version: None,
                }))
            }),
            Arc::default(),
        );
        broker.reread = Arc::new(crate::reread::Reread::every(gap));
        (broker, reads)
    }

    /// Desk Helper moved the hub to a new port: a request its old address
    /// can't take reads where it is now and goes there.
    #[tokio::test]
    async fn a_hub_that_moved_is_asked_where_it_is_now() {
        let (url, mut seen) = hub(vec![OK_JSON]).await;
        let at = Arc::new(Mutex::new(url.clone()));
        let (broker, reads) = broker_following(Arc::clone(&at), Duration::ZERO);
        // Read once, kept.
        *at.lock().unwrap() = gone_address();
        let first = broker.fetch("GET", "/api/desk/sessions", None).await;
        assert!(first.unwrap_err().contains("couldn't reach"));
        *at.lock().unwrap() = url;
        let answer = broker
            .fetch("GET", "/api/desk/sessions", None)
            .await
            .unwrap();
        assert_eq!(answer.status, 200);
        assert_eq!(
            seen.recv().await.unwrap().line,
            "GET /api/desk/sessions HTTP/1.1"
        );
        // Read again only when its address failed: once for each failure.
        assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    /// A socket to the hub's old address fails; the next one the page opens
    /// goes to where the hub is now.
    #[tokio::test]
    async fn a_socket_after_the_hub_moved_opens_where_it_is_now() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    if let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await {
                        use futures_util::StreamExt;
                        while ws.next().await.is_some() {}
                    }
                });
            }
        });
        let at = Arc::new(Mutex::new(gone_address()));
        let (broker, _) = broker_following(Arc::clone(&at), Duration::ZERO);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let events: socket::Events = Arc::new(move |body| {
            if let InvokeResponseBody::Json(s) = body {
                let v: serde_json::Value = serde_json::from_str(&s).unwrap();
                let _ = tx.send(v["type"].as_str().unwrap_or_default().to_string());
            }
        });
        async fn said(rx: &mut tokio::sync::mpsc::UnboundedReceiver<String>) -> String {
            tokio::time::timeout(Duration::from_secs(10), rx.recv())
                .await
                .unwrap()
                .unwrap()
        }
        broker
            .open_socket("main", "/api/desk/events", events.clone())
            .await
            .unwrap();
        assert_eq!(said(&mut rx).await, "error");
        assert_eq!(said(&mut rx).await, "close");
        *at.lock().unwrap() = url;
        broker
            .open_socket("main", "/api/desk/events", events)
            .await
            .unwrap();
        assert_eq!(said(&mut rx).await, "open");
    }

    /// What ssh does with a connection to its forward when nothing listens
    /// where the forward goes on the machine: takes it, then closes it.
    async fn forward_to_nothing() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((s, _)) = listener.accept().await {
                drop(s);
            }
        });
        url
    }

    /// A machine as its broker reaches it: the forward at `at`, the
    /// gateway it reaches, and what reading again over SSH finds.
    struct FakeMachine {
        at: Mutex<String>,
        gateway: Mutex<u16>,
        next: Mutex<Option<(String, u16)>>,
        reads: std::sync::atomic::AtomicUsize,
        socket: Option<std::path::PathBuf>,
    }

    impl Reached for FakeMachine {
        fn connection(&self) -> Result<Option<Connection>, String> {
            Ok(Some(Connection {
                gateway_url: self.at.lock().unwrap().clone(),
                admin_token: SENTINEL.into(),
                device_token: Some("device".into()),
                version: None,
            }))
        }
        fn read(&self) -> Result<Option<Connection>, String> {
            self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if let Some((at, gateway)) = self.next.lock().unwrap().take() {
                *self.at.lock().unwrap() = at;
                *self.gateway.lock().unwrap() = gateway;
            }
            self.connection()
        }
        fn forget(&self) {}
        fn gateway(&self) -> Option<u16> {
            Some(*self.gateway.lock().unwrap())
        }
        fn socket(&self) -> Option<std::path::PathBuf> {
            self.socket.clone()
        }
    }

    fn fake_machine(at: &str) -> Arc<FakeMachine> {
        Arc::new(FakeMachine {
            at: Mutex::new(at.into()),
            gateway: Mutex::new(4226),
            next: Mutex::default(),
            reads: Default::default(),
            socket: None,
        })
    }

    fn machine_broker(machine: &Arc<FakeMachine>) -> Broker {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let mut broker = Broker::machine_with(
            "devbox",
            Arc::clone(machine) as Arc<dyn Reached>,
            Arc::default(),
            7,
            true,
        )
        .unwrap();
        broker.reread = Arc::new(crate::reread::Reread::every(Duration::ZERO));
        broker
    }

    /// A hub that takes a request and closes without answering, as when
    /// ssh's forward ends under a request that got through; and how many
    /// it took.
    async fn hub_that_drops() -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let took = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = Arc::clone(&took);
        tokio::spawn(async move {
            while let Ok((mut s, _)) = listener.accept().await {
                let mut buf = [0u8; 4096];
                if s.read(&mut buf).await.unwrap_or(0) > 0 {
                    counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
                drop(s);
            }
        });
        (url, took)
    }

    /// The machine's gateway moved: through the forward that shows as a
    /// connection taken and closed, which reads again over SSH (the forward
    /// is rebuilt at a new address here) and sends the request there.
    #[tokio::test]
    async fn a_machines_hub_that_moved_behind_its_forward_is_found_again() {
        let (url, mut seen) = hub(vec![OK_JSON]).await;
        let machine = fake_machine(&forward_to_nothing().await);
        *machine.next.lock().unwrap() = Some((url, 4300));
        let answer = machine_broker(&machine)
            .fetch("GET", "/api/desk/sessions", None)
            .await
            .unwrap();
        assert_eq!(answer.status, 200);
        assert_eq!(
            seen.recv().await.unwrap().line,
            "GET /api/desk/sessions HTTP/1.1"
        );
        assert_eq!(machine.reads.load(std::sync::atomic::Ordering::SeqCst), 1);
        // This computer's hub isn't behind a forward: a connection taken
        // and closed there may have reached it, and isn't sent again.
        let closed = forward_to_nothing().await;
        let e = broker_at(&closed, vec![])
            .fetch("POST", "/api/desk/sessions", None)
            .await
            .unwrap_err();
        assert!(e.contains("couldn't reach Desk's helper"), "{e}");
    }

    /// A request got through, then the forward ended before the answer and
    /// came back on a new port here, the gateway where it was: the hub may
    /// have done it, so it isn't sent again.
    #[tokio::test]
    async fn a_request_the_hub_may_have_taken_is_never_sent_twice() {
        let (dropped, took) = hub_that_drops().await;
        let (back, mut seen) = hub(vec![OK_JSON]).await;
        let machine = fake_machine(&dropped);
        *machine.next.lock().unwrap() = Some((back, 4226));
        let e = machine_broker(&machine)
            .fetch(
                "POST",
                "/api/desk/sessions",
                Some(("application/json".into(), b"{}".to_vec())),
            )
            .await
            .unwrap_err();
        assert!(e.contains("couldn't reach devbox"), "{e}");
        assert_eq!(took.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(
            tokio::time::timeout(Duration::from_millis(200), seen.recv())
                .await
                .is_err(),
            "not sent again"
        );
    }

    /// Even when the gateway moved, a request that changes something isn't
    /// sent again after ssh took it and closed it: only a GET or HEAD is.
    #[tokio::test]
    async fn only_a_request_that_changes_nothing_is_sent_again() {
        let (dropped, took) = hub_that_drops().await;
        let (moved, mut seen) = hub(vec![OK_JSON]).await;
        let machine = fake_machine(&dropped);
        *machine.next.lock().unwrap() = Some((moved, 4300));
        let e = machine_broker(&machine)
            .fetch(
                "PATCH",
                "/api/desk/sessions/s1",
                Some(("application/json".into(), b"{}".to_vec())),
            )
            .await
            .unwrap_err();
        assert!(e.contains("couldn't reach devbox"), "{e}");
        assert_eq!(took.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(
            tokio::time::timeout(Duration::from_millis(200), seen.recv())
                .await
                .is_err(),
            "not sent again"
        );
    }

    /// A machine's broker is never made without the forward's socket (a
    /// stand-in over TCP is the tests' only), and through the socket it
    /// takes only an address that resolves nowhere: a real one here, which
    /// a client not bound to the socket would reach, is refused.
    #[tokio::test]
    async fn a_machines_broker_goes_only_through_its_socket() {
        let machine = fake_machine("http://127.0.0.1:4226");
        let refused = Broker::machine_with(
            "devbox",
            Arc::clone(&machine) as Arc<dyn Reached>,
            Arc::default(),
            7,
            false,
        );
        assert!(refused.is_err());
        let as_machine = Arc::clone(&machine) as Arc<dyn Reached>;
        let e = through(&as_machine, true, "idle").await.err().unwrap();
        assert!(e.contains("isn't at an address Desk gave it"), "{e}");
        *machine.at.lock().unwrap() = desk_core::net::machine_base("devbox", 4226);
        let local = through(&as_machine, true, "idle").await.unwrap();
        assert_eq!(local.base.host_str(), Some("devbox.machine.invalid"));
    }

    /// Through the forward's socket a request reaches the hub whatever its
    /// address names, and carries the Host the hub is at on the machine.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_request_goes_through_the_socket_with_the_machines_host() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hub.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let (tx, mut heard) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = s.read(&mut buf).await.unwrap();
            let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase());
            s.write_all(OK_JSON.as_bytes()).await.unwrap();
        });
        let machine = Arc::new(FakeMachine {
            at: Mutex::new(desk_core::net::machine_base("devbox", 4226)),
            gateway: Mutex::new(4226),
            next: Mutex::default(),
            reads: Default::default(),
            socket: Some(path),
        });
        let broker = Broker::machine_with("devbox", machine, Arc::default(), 7, false).unwrap();
        let answer = broker
            .fetch("GET", "/api/desk/sessions", None)
            .await
            .unwrap();
        assert_eq!(answer.status, 200);
        let head = heard.recv().await.unwrap();
        assert!(
            head.starts_with("get /api/desk/sessions http/1.1"),
            "{head}"
        );
        assert!(head.contains("host: 127.0.0.1:4226"), "{head}");
        assert!(head.contains(&format!("bearer {}", SENTINEL.to_ascii_lowercase())));
    }

    /// Nothing about a machine's address is kept by its broker: each
    /// request goes to where the forward is now, never to a port here it
    /// held before (which something else could have taken since).
    #[tokio::test]
    async fn a_machines_address_is_never_kept() {
        let (first, mut seen_first) = hub(vec![OK_JSON]).await;
        let (second, mut seen_second) = hub(vec![OK_JSON]).await;
        let machine = fake_machine(&first);
        let broker = machine_broker(&machine);
        broker
            .fetch("GET", "/api/desk/sessions", None)
            .await
            .unwrap();
        seen_first.recv().await.unwrap();
        *machine.at.lock().unwrap() = second;
        broker
            .fetch("GET", "/api/desk/sessions", None)
            .await
            .unwrap();
        seen_second.recv().await.unwrap();
        assert_eq!(machine.reads.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    /// A machine's broker takes the same list as this computer's, and the
    /// machine's folders and a terminal's programs; its errors name it.
    #[tokio::test]
    async fn a_machine_is_asked_only_what_the_list_allows() {
        let (url, mut seen) = hub(vec![OK_JSON, OK_JSON]).await;
        let broker = machine_broker(&fake_machine(&url));
        broker
            .fetch("GET", "/api/desk/folders?path=%2Fhome%2Fdev", None)
            .await
            .unwrap();
        assert_eq!(
            seen.recv().await.unwrap().line,
            "GET /api/desk/folders?path=%2Fhome%2Fdev HTTP/1.1"
        );
        for (m, p) in [
            ("GET", "/api/vault/speech/openai/api_key"),
            ("POST", "/api/admin/reset-model"),
            ("GET", "/api/desk/folders?path=x&token=y"),
        ] {
            assert!(broker.fetch(m, p, None).await.is_err(), "{m} {p}");
        }
        let e = broker
            .fetch(
                "POST",
                "/api/agents",
                Some(("text/html".into(), b"<p>".to_vec())),
            )
            .await
            .unwrap_err();
        assert!(e.contains("to devbox"), "{e}");
        assert!(
            broker_at(&url, vec![])
                .fetch("GET", "/api/desk/folders", None)
                .await
                .is_err(),
            "not this computer's"
        );
    }

    /// A machine's address must be this computer's loopback, as the local
    /// hub's: its token goes nowhere else.
    #[tokio::test]
    async fn a_machines_token_only_goes_to_this_computer() {
        for url in [
            "http://203.0.113.7:4226",
            "https://127.0.0.1:3",
            "http://localhost:3",
        ] {
            let e = machine_broker(&fake_machine(url))
                .fetch("GET", "/api/desk/sessions", None)
                .await
                .unwrap_err();
            assert!(
                e.contains("isn't at an address on this computer"),
                "{url}: {e}"
            );
        }
    }

    /// A hub that is down isn't read again for every request that fails:
    /// once for those failing together, then not within the gap.
    #[tokio::test]
    async fn a_hub_that_is_down_is_read_again_at_most_once_a_gap() {
        let at = Arc::new(Mutex::new(gone_address()));
        let (broker, reads) = broker_following(at, Duration::from_secs(60));
        let broker = Arc::new(broker);
        assert!(
            broker
                .fetch("GET", "/api/desk/sessions", None)
                .await
                .is_err()
        );
        let read = || reads.load(std::sync::atomic::Ordering::SeqCst);
        assert_eq!(read(), 2, "read, then once again");
        let all: Vec<_> = (0..6)
            .map(|_| {
                let b = Arc::clone(&broker);
                tokio::spawn(async move { b.fetch("GET", "/api/desk/sessions", None).await })
            })
            .collect();
        for t in all {
            assert!(t.await.unwrap().is_err());
        }
        assert_eq!(read(), 2);
    }

    /// The relay's requests go only where each is sent: this computer's
    /// to its hub, a machine's to its; neither reaches anything else.
    #[tokio::test]
    async fn the_relay_reaches_its_own_hub_alone() {
        let (url, mut seen) = hub(vec![OK_JSON]).await;
        let local = broker_at(&url, vec![]);
        let e = local
            .relay_machine("POST", "/api/desk/crew/served", Some(b"{}".to_vec()), 1024)
            .await
            .unwrap_err();
        assert!(matches!(e, Unanswered::NotSent(_)), "{e:?}");
        let e = local
            .relay_local(
                "POST",
                "/api/desk/accounts/0f0e0d0c-0b0a-4909-8807-060504030201/hand-over",
                None,
                1024,
            )
            .await
            .unwrap_err();
        assert!(matches!(e, Unanswered::NotSent(_)), "{e:?}");
        let machine = machine_broker(&fake_machine(&url));
        let e = machine
            .relay_local("GET", "/api/desk/crew/relay", None, 1024)
            .await
            .unwrap_err();
        assert!(matches!(e, Unanswered::NotSent(_)), "{e:?}");
        assert!(
            tokio::time::timeout(Duration::from_millis(100), seen.recv())
                .await
                .is_err(),
            "nothing was sent"
        );
        let answer = local
            .relay_local("GET", "/api/desk/crew/relay", None, 1024)
            .await
            .unwrap();
        assert_eq!(answer.status, 200);
        let got = seen.recv().await.unwrap();
        assert_eq!(got.line, "GET /api/desk/crew/relay HTTP/1.1");
        assert!(got.headers.contains(&format!(
            "authorization: bearer {}",
            SENTINEL.to_ascii_lowercase()
        )));
    }

    /// A poll or a post the hub turns away for its token (401) is sent
    /// again once with the token read again.
    #[tokio::test]
    async fn the_relay_reads_a_refused_token_again() {
        const NO: &str =
            "HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
        const GONE: &str = "HTTP/1.1 204 No Content\r\nconnection: close\r\n\r\n";
        let (url, mut seen) = hub(vec![NO, OK_JSON, NO, GONE]).await;
        let broker = broker_at(&url, vec!["old", "new", "newer"]);
        let polled = broker
            .relay_local("GET", "/api/desk/crew/relay", None, 1024)
            .await
            .unwrap();
        assert_eq!(polled.status, 200);
        let posted = broker
            .relay_local(
                "POST",
                "/api/desk/crew/relay/0f0e0d0c-0b0a-4909-8807-060504030201",
                Some(br#"{"status":"ok","body":{}}"#.to_vec()),
                1024,
            )
            .await
            .unwrap();
        assert_eq!(posted.status, 204);
        for token in ["old", "new", "new", "newer"] {
            let got = seen.recv().await.unwrap();
            assert!(
                got.headers.contains(&format!("bearer {token}")),
                "{token}: {}",
                got.headers
            );
        }
    }

    /// Whether a relayed call may have reached the machine is said: not
    /// when nothing listens, maybe when the request was taken and dropped,
    /// and an answer over the cap isn't read.
    #[tokio::test]
    async fn the_relay_says_whether_a_call_may_have_arrived() {
        let gone = gone_address();
        let e = machine_broker(&fake_machine(&gone))
            .relay_machine("POST", "/api/desk/crew/served", Some(b"{}".to_vec()), 1024)
            .await
            .unwrap_err();
        assert!(matches!(e, Unanswered::NotSent(_)), "{e:?}");
        let (dropped, took) = hub_that_drops().await;
        let e = machine_broker(&fake_machine(&dropped))
            .relay_machine("POST", "/api/desk/crew/served", Some(b"{}".to_vec()), 1024)
            .await
            .unwrap_err();
        assert!(matches!(e, Unanswered::MaybeSent(_)), "{e:?}");
        assert_eq!(
            took.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "sent once"
        );
        const BIG: &str = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 10\r\nconnection: close\r\n\r\n0123456789";
        let (url, _seen) = hub(vec![BIG]).await;
        let e = machine_broker(&fake_machine(&url))
            .relay_machine("POST", "/api/desk/crew/served", Some(b"{}".to_vec()), 9)
            .await
            .unwrap_err();
        assert_eq!(
            e,
            Unanswered::MaybeSent("devbox's answer is too large.".into())
        );
    }
}
