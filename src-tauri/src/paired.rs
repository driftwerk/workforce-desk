//! The hubs Desk is paired with, as this side reaches them: each one's
//! address and device token, read once and again whenever one is paired or
//! removed or turns a token away, and the clients requests to them share.
//!
//! The page names a hub by id; nothing it sends decides where a request
//! goes or which token it carries. A hub's address is checked each time it
//! is used: `https`, or the hub on this computer by loopback address.
//!
//! A machine's hub (`machine:<id>`) is read from its `desk_machine::Link`,
//! not from the hubs Desk keeps: its device token as read over SSH and held
//! in memory, at the forward's address on this computer's loopback. A token
//! it turns away is read again over SSH, since Desk Helper there renews it
//! at every start.

use std::sync::{Arc, Mutex};

use desk_core::Paths;
use desk_core::backend::Backend;
use reqwest::{StatusCode, Url};

use crate::hubs::{self, HubAccount};

/// Reads every hub Desk can reach, with its token; blocking.
type Source = Arc<dyn Fn() -> eyre::Result<Vec<HubAccount>> + Send + Sync>;

/// Reads only the hub on this computer; blocking (on Windows it asks WSL).
type LocalSource = Arc<dyn Fn() -> eyre::Result<Option<HubAccount>> + Send + Sync>;

/// Why a hub couldn't be asked.
#[derive(Debug)]
pub enum Failure {
    /// No such hub (any more), or nothing Desk would send to it.
    Unknown,
    /// Its address isn't one Desk sends a token to.
    Refused(String),
    /// It couldn't be reached.
    Unreachable(String),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unknown => f.write_str("That workspace isn't connected to Desk any more."),
            Self::Refused(why) => f.write_str(why),
            Self::Unreachable(why) => write!(f, "Couldn't reach the workspace: {why}"),
        }
    }
}

/// A hub, ready to be sent to: its checked address, its token, and the
/// clients for where it is.
#[derive(Clone)]
pub struct Reach {
    pub base: Url,
    pub token: Arc<str>,
    /// The hub on this computer, whose address Desk Helper may change.
    pub local: bool,
    /// A machine's hub, through the forward to it.
    pub machine: Option<Arc<desk_machine::Link>>,
    pub client: reqwest::Client,
    /// For an upload, each bounded by `desk_core::net::upload_timeout`.
    pub uploads: reqwest::Client,
}

/// The clients for one kind of place: requests, and uploads.
struct Clients {
    requests: reqwest::Client,
    uploads: reqwest::Client,
}

impl Clients {
    fn new(on_this_computer: bool) -> Self {
        Self {
            requests: if on_this_computer {
                desk_core::net::loopback()
            } else {
                desk_core::net::remote()
            },
            uploads: desk_core::net::uploading(on_this_computer),
        }
    }
}

pub struct Paired {
    source: Source,
    local_source: LocalSource,
    hubs: Mutex<Option<Arc<Vec<HubAccount>>>>,
    /// Reading the local hub again when it can't be reached where it was.
    pub(crate) reread: crate::reread::Reread,
    loopback: Clients,
    remote: Clients,
    machines: Arc<desk_machine::Machines>,
}

impl Paired {
    pub fn new(
        paths: Paths,
        backend: Option<Backend>,
        machines: Arc<desk_machine::Machines>,
    ) -> Self {
        let local = backend.clone();
        let mut paired = Self::with_sources(
            Arc::new(move || hubs::accounts(&paths, backend.as_ref())),
            Arc::new(move || match &local {
                Some(b) => Ok(b.connection()?.and_then(hubs::local_account)),
                None => Ok(None),
            }),
        );
        paired.machines = machines;
        paired
    }

    /// With `source` for every hub, the local one read from it too.
    #[cfg(test)]
    pub(crate) fn with_source(source: Source) -> Self {
        let all = Arc::clone(&source);
        Self::with_sources(
            source,
            Arc::new(move || Ok(all()?.into_iter().find(|h| h.local))),
        )
    }

    pub(crate) fn with_sources(source: Source, local_source: LocalSource) -> Self {
        Self {
            source,
            local_source,
            hubs: Mutex::new(None),
            reread: crate::reread::Reread::default(),
            loopback: Clients::new(true),
            remote: Clients::new(false),
            machines: Arc::default(),
        }
    }

    /// Forgets what hub `id`'s token was, after it turned it away: a
    /// machine's is read again over SSH, any other's with the hubs.
    pub fn forget_token(&self, id: &str) {
        match hubs::machine_of(id).and_then(|m| self.machines.get(m)) {
            Some(link) => link.forget(),
            None => self.forget(),
        }
    }

    /// Forgets the hubs read, after one is paired or removed.
    pub fn forget(&self) {
        *self.hubs.lock().expect("hubs") = None;
    }

    /// Reads the hub on this computer again (and no other) after nothing
    /// answered where it was: once however many failed together, at most
    /// once every [`crate::reread::GAP`].
    pub async fn reread_local(self: &Arc<Self>) {
        let this = Arc::clone(self);
        self.reread
            .run(|| async move {
                let read = Arc::clone(&this.local_source);
                let Ok(Ok(local)) = tauri::async_runtime::spawn_blocking(move || read()).await
                else {
                    return;
                };
                let mut kept = this.hubs.lock().expect("hubs");
                if let Some(hubs) = kept.as_ref() {
                    let others = hubs.iter().filter(|h| !h.local).cloned();
                    *kept = Some(Arc::new(local.into_iter().chain(others).collect()));
                }
            })
            .await;
    }

    /// Said by a socket to this computer's hub that couldn't connect.
    pub fn local_unreachable(&self) {
        self.reread.mark_stale();
    }

    /// Reads the local hub again first if a socket to it couldn't connect.
    pub async fn reread_local_if_stale(self: &Arc<Self>) {
        if self.reread.is_stale() {
            self.reread_local().await;
        }
    }

    fn all(&self) -> eyre::Result<Arc<Vec<HubAccount>>> {
        let mut kept = self.hubs.lock().expect("hubs");
        if let Some(hubs) = kept.as_ref() {
            return Ok(hubs.clone());
        }
        let read = Arc::new((self.source)()?);
        *kept = Some(read.clone());
        Ok(read)
    }

    /// Hub `id`, read again when it isn't among those already read (it may
    /// have just been paired).
    fn hub(&self, id: &str) -> Option<HubAccount> {
        let find = |hubs: Arc<Vec<HubAccount>>| hubs.iter().find(|h| h.id == id).cloned();
        self.all().ok().and_then(find).or_else(|| {
            self.forget();
            self.all().ok().and_then(find)
        })
    }

    /// How to reach hub `id`; blocking (reading the hubs may ask the
    /// keychain once, or WSL).
    pub fn reach(&self, id: &str) -> Result<Reach, Failure> {
        if let Some(machine) = hubs::machine_of(id) {
            return self.reach_machine(id, machine);
        }
        let hub = self.hub(id).ok_or(Failure::Unknown)?;
        // The local hub only ever on this computer; any other over https,
        // or on this computer too (a hub run for development).
        let base = if hub.local {
            desk_core::net::loopback_url(&hub.url)
        } else {
            desk_core::net::hub_url(&hub.url)
        }
        .map_err(Failure::Refused)?;
        // No proxy for this computer's hub; the system's, if any, for others.
        let clients = if desk_core::net::is_loopback(&base) {
            &self.loopback
        } else {
            &self.remote
        };
        Ok(Reach {
            base,
            token: hub.token.into(),
            local: hub.local,
            machine: None,
            client: clients.requests.clone(),
            uploads: clients.uploads.clone(),
        })
    }

    /// Machine `machine`'s hub, as hub `id`: its tokens as kept or read
    /// now over SSH (blocking), only ever at a loopback address here.
    fn reach_machine(&self, id: &str, machine: &str) -> Result<Reach, Failure> {
        let link = self.machines.get(machine).ok_or(Failure::Unknown)?;
        let connection = link
            .connection()
            .map_err(Failure::Unreachable)?
            .ok_or_else(|| {
                Failure::Unreachable(format!(
                    "{} is up, but Desk isn't running there.",
                    link.machine().name
                ))
            })?;
        let hub = hubs::machine_account(&link, connection).ok_or_else(|| {
            Failure::Unreachable(format!(
                "Desk on {} hasn't paired itself yet.",
                link.machine().name
            ))
        })?;
        debug_assert_eq!(hub.id, id);
        let base = desk_core::net::loopback_url(&hub.url).map_err(Failure::Refused)?;
        Ok(Reach {
            base,
            token: hub.token.into(),
            local: false,
            machine: Some(link),
            client: self.loopback.requests.clone(),
            uploads: self.loopback.uploads.clone(),
        })
    }

    /// [`reach`] off the async runtime's threads.
    ///
    /// [`reach`]: Self::reach
    pub async fn reach_async(self: &Arc<Self>, id: &str) -> Result<Reach, Failure> {
        let (this, id) = (Arc::clone(self), id.to_string());
        tauri::async_runtime::spawn_blocking(move || this.reach(&id))
            .await
            .map_err(|e| Failure::Unreachable(e.to_string()))?
    }

    /// Sends `build`'s request to hub `id` with its token; a token the hub
    /// turns away is read again once (the local hub's is renewed by Desk
    /// Helper; a hub paired again has a new one), and so is the local hub's
    /// address when nothing answers at it (Desk Helper gave it new ports).
    pub async fn send(
        self: &Arc<Self>,
        id: &str,
        build: impl Fn(&Reach) -> Option<reqwest::RequestBuilder>,
    ) -> Result<reqwest::Response, Failure> {
        let build = &build;
        let unreachable = |e: reqwest::Error| Failure::Unreachable(e.without_url().to_string());
        let attempt = |reach: Reach| async move {
            let request = build(&reach).ok_or(Failure::Unknown)?;
            Ok::<_, Failure>(request.bearer_auth(&*reach.token).send().await)
        };
        let reach = self.reach_async(id).await?;
        let response = match attempt(reach.clone()).await? {
            Ok(r) => r,
            // It never reached the old address: sent again only where the
            // hub is now, if it moved.
            Err(e) if reach.local && e.is_connect() => {
                self.reread_local().await;
                let now = self.reach_async(id).await?;
                if now.base == reach.base {
                    return Err(unreachable(e));
                }
                attempt(now).await?.map_err(unreachable)?
            }
            // Through the forward, a hub that moved shows as a connection
            // ssh took and closed: read again over SSH, which rebuilds the
            // forward (at a new address here) if the gateway moved.
            Err(e)
                if reach.machine.is_some()
                    && (e.is_connect() || (e.is_request() && !e.is_timeout())) =>
            {
                let link = Arc::clone(reach.machine.as_ref().expect("a machine"));
                let _ = tauri::async_runtime::spawn_blocking(move || link.read()).await;
                let now = self.reach_async(id).await?;
                if now.base == reach.base {
                    return Err(unreachable(e));
                }
                attempt(now).await?.map_err(unreachable)?
            }
            Err(e) => return Err(unreachable(e)),
        };
        if response.status() != StatusCode::UNAUTHORIZED {
            return Ok(response);
        }
        self.forget_token(id);
        attempt(self.reach_async(id).await?)
            .await?
            .map_err(unreachable)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A hub account as `hubs::accounts` makes them.
    pub fn account(id: &str, url: &str, local: bool, token: &str) -> HubAccount {
        HubAccount {
            id: id.into(),
            label: id.into(),
            url: url.into(),
            local,
            machine: None,
            revision: hubs::revision(token),
            token: token.into(),
        }
    }

    pub fn paired(hubs: Vec<HubAccount>) -> Arc<Paired> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        Arc::new(Paired::with_source(Arc::new(move || Ok(hubs.clone()))))
    }

    #[test]
    fn a_hub_is_reached_only_where_its_token_may_go() {
        let p = paired(vec![
            account("local", "http://127.0.0.1:3", true, "l"),
            account("a", "https://a.example.com", false, "a"),
            account("dev", "http://127.0.0.1:9", false, "d"),
            account("plain", "http://a.example.com", false, "p"),
            account("named", "http://localhost:3", false, "n"),
            account("local-elsewhere", "https://a.example.com", true, "x"),
        ]);
        let loopback = |id: &str| desk_core::net::is_loopback(&p.reach(id).unwrap().base);
        assert!(loopback("local"));
        assert!(!loopback("a"));
        assert_eq!(
            p.reach("a").unwrap().base.as_str(),
            "https://a.example.com/"
        );
        assert!(loopback("dev"));
        for refused in ["plain", "named", "local-elsewhere"] {
            assert!(
                matches!(p.reach(refused), Err(Failure::Refused(_))),
                "{refused}"
            );
        }
        assert!(matches!(p.reach("nobody"), Err(Failure::Unknown)));
    }

    /// Desk Helper moved this computer's hub to a new port: a request its
    /// old address can't take reads where it is now and goes there. A
    /// workspace that can't be reached isn't read again.
    #[tokio::test]
    async fn the_local_hub_is_asked_where_it_is_now() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            while let Ok((mut s, _)) = listener.accept().await {
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf).await;
                let _ = s
                    .write_all(b"HTTP/1.1 204 No Content\r\nconnection: close\r\n\r\n")
                    .await;
            }
        });
        let gone = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}", l.local_addr().unwrap())
        };
        let at = Arc::new(Mutex::new(gone.clone()));
        // Every hub's read (each workspace's token), and the local one's.
        let (reads, local_reads) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let (following, counted) = (Arc::clone(&at), Arc::clone(&reads));
        let (following_local, counted_local) = (Arc::clone(&at), Arc::clone(&local_reads));
        let mut p = Paired::with_sources(
            Arc::new(move || {
                counted.fetch_add(1, Ordering::SeqCst);
                let local = following.lock().unwrap().clone();
                Ok(vec![
                    account("local", &local, true, "l"),
                    account("dev", &gone, false, "d"),
                ])
            }),
            Arc::new(move || {
                counted_local.fetch_add(1, Ordering::SeqCst);
                let local = following_local.lock().unwrap().clone();
                Ok(Some(account("local", &local, true, "l")))
            }),
        );
        p.reread = crate::reread::Reread::every(std::time::Duration::ZERO);
        let p = Arc::new(p);
        let get = |path: &'static str| {
            move |r: &Reach| Some(r.client.get(desk_core::net::at(&r.base, path, None).ok()?))
        };
        assert!(matches!(
            p.send("local", get("/api/me")).await,
            Err(Failure::Unreachable(_))
        ));
        *at.lock().unwrap() = url;
        let answer = p.send("local", get("/api/me")).await.unwrap();
        assert_eq!(answer.status(), StatusCode::NO_CONTENT);
        // Only the local hub was read again; the workspaces once, at first.
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        assert_eq!(local_reads.load(Ordering::SeqCst), 2);
        let before = reads.load(Ordering::SeqCst);
        assert!(matches!(
            p.send("dev", get("/api/me")).await,
            Err(Failure::Unreachable(_))
        ));
        assert_eq!(reads.load(Ordering::SeqCst), before);
        assert_eq!(local_reads.load(Ordering::SeqCst), 2);
    }
}
