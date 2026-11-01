//! The hubs Desk is paired with, as this side reaches them: each one's
//! address and device token, read once and again whenever one is paired or
//! removed or turns a token away, and the clients requests to them share.
//!
//! The page names a hub by id; nothing it sends decides where a request
//! goes or which token it carries. A hub's address is checked each time it
//! is used: `https`, or the hub on this computer by loopback address.

use std::sync::{Arc, Mutex};

use desk_core::Paths;
use desk_core::backend::Backend;
use reqwest::{StatusCode, Url};

use crate::hubs::{self, HubAccount};

/// Reads every hub Desk can reach, with its token; blocking.
type Source = Arc<dyn Fn() -> eyre::Result<Vec<HubAccount>> + Send + Sync>;

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
/// client for where it is.
#[derive(Clone)]
pub struct Reach {
    pub base: Url,
    pub token: Arc<str>,
    pub client: reqwest::Client,
}

pub struct Paired {
    source: Source,
    hubs: Mutex<Option<Arc<Vec<HubAccount>>>>,
    loopback: reqwest::Client,
    remote: reqwest::Client,
}

impl Paired {
    pub fn new(paths: Paths, backend: Option<Backend>) -> Self {
        Self::with_source(Arc::new(move || hubs::accounts(&paths, backend.as_ref())))
    }

    pub(crate) fn with_source(source: Source) -> Self {
        Self {
            source,
            hubs: Mutex::new(None),
            loopback: desk_core::net::loopback(),
            remote: desk_core::net::remote(),
        }
    }

    /// Forgets the hubs read, after one is paired or removed.
    pub fn forget(&self) {
        *self.hubs.lock().expect("hubs") = None;
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
        let client = if desk_core::net::is_loopback(&base) {
            self.loopback.clone()
        } else {
            self.remote.clone()
        };
        Ok(Reach {
            base,
            token: hub.token.into(),
            client,
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
    /// Helper; a hub paired again has a new one).
    pub async fn send(
        self: &Arc<Self>,
        id: &str,
        build: impl Fn(&Reach) -> Option<reqwest::RequestBuilder>,
    ) -> Result<reqwest::Response, Failure> {
        let build = &build;
        let attempt = |reach: Reach| async move {
            let request = build(&reach).ok_or(Failure::Unknown)?;
            request
                .bearer_auth(&*reach.token)
                .send()
                .await
                .map_err(|e| Failure::Unreachable(e.without_url().to_string()))
        };
        let response = attempt(self.reach_async(id).await?).await?;
        if response.status() != StatusCode::UNAUTHORIZED {
            return Ok(response);
        }
        self.forget();
        attempt(self.reach_async(id).await?).await
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
}
