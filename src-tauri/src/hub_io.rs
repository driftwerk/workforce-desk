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
        self.paired.reread_local_if_stale().await;
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
                    paired.forget_token(&id);
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
        // This computer's hub may have moved to new ports: read again for
        // the next socket when it can't be reached. A workspace elsewhere
        // isn't, which would only read every hub's token again.
        let unreachable = match &reach.machine {
            // A machine's gateway may have moved: its tokens and where it
            // is are read again over SSH for the next socket.
            Some(link) => {
                let link = Arc::clone(link);
                Some(Arc::new(move || link.forget()) as socket::Unreachable)
            }
            None => reach.local.then(|| {
                let paired = Arc::clone(&self.paired);
                Arc::new(move || paired.local_unreachable()) as socket::Unreachable
            }),
        };
        let dial = Dial {
            url,
            bearer,
            pool: Pool::Hubs,
            unreachable,
            unix: reach.unix.clone(),
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

    /// Mints a token for board sync on paired hub `remote` (named `name`)
    /// with this Desk's device token there, and hands it to hub `local`,
    /// this computer's, as its sync hub `id`. The token goes from one hub to
    /// the other here and nowhere else: what the page is told never holds
    /// it. A hub that doesn't let devices mint says so in its words, and the
    /// page asks the person to paste one made there instead.
    pub async fn mint_for_sync(
        &self,
        remote: &str,
        local: &str,
        id: &str,
        name: &str,
    ) -> Result<Minted, String> {
        if !sync_hub_id_ok(id) {
            return Err(format!("{id:?} can't name a hub."));
        }
        if crate::hubs::machine_of(remote).is_some() {
            return Err("A machine's hub doesn't sync boards for others.".into());
        }
        let there = self
            .paired
            .reach_async(remote)
            .await
            .map_err(|e| e.to_string())?;
        if there.local {
            return Err("Desk syncs this computer's boards with its own keys, not a token.".into());
        }
        let here = self
            .paired
            .reach_async(local)
            .await
            .map_err(|e| e.to_string())?;
        if !here.local {
            return Err("Desk keeps a workspace's token only on this computer.".into());
        }
        // The address the local hub will keep it under, checked as the local
        // hub checks it, before anything is minted.
        sync_hub_url_ok(&there.base)?;
        let url = there.base.as_str().trim_end_matches('/').to_string();
        let (meta, bytes) = self.fetch(remote, "POST", MINT_PATH, None).await?;
        if !(200..300).contains(&meta.status) {
            return Ok(Minted::NotAllowed {
                status: meta.status,
                error: words_of(&bytes)
                    .unwrap_or_else(|| format!("{name} didn't make a token ({}).", meta.status)),
            });
        }
        let minted = serde_json::from_slice::<serde_json::Value>(&bytes).ok();
        // Its id, to revoke it by if this computer's hub can't keep it.
        let token_id = minted
            .as_ref()
            .and_then(|v| v.get("id")?.as_str().map(str::to_string))
            .filter(|i| !i.is_empty() && i.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
        let token = minted.and_then(|v| {
            v.get("token")?
                .as_str()
                .map(|t| zeroize::Zeroizing::new(t.to_string()))
        });
        drop(zeroize::Zeroizing::new(bytes));
        let Some(token) = token else {
            return Ok(Minted::NotAllowed {
                status: meta.status,
                error: format!("{name} didn't make a token Desk can use."),
            });
        };
        let body = zeroize::Zeroizing::new(
            serde_json::to_vec(
                &serde_json::json!({ "name": name, "url": url, "token": token.as_str() }),
            )
            .map_err(|e| e.to_string())?,
        );
        drop(token);
        let kept = self
            .fetch(
                local,
                "PUT",
                &format!("/api/desk/sync-hubs/{id}"),
                Some(("application/json".into(), body.to_vec())),
            )
            .await;
        let answer = match kept {
            Ok((meta, answer)) if (200..300).contains(&meta.status) => answer,
            failed => {
                let reason = match failed {
                    Ok((meta, answer)) => {
                        words_of(&answer).unwrap_or_else(|| format!("it answered {}", meta.status))
                    }
                    Err(e) => e,
                };
                // Not left live on the remote hub, unkept: revoked there with
                // the device token, on the device-only route that revokes
                // only what this device minted. (A hub older than it
                // answers 404 or 405; the token then lasts until this
                // device mints again, which replaces it, or is unpaired.)
                if let Some(token_id) = token_id {
                    let _ = self
                        .fetch(remote, "DELETE", &format!("{MINT_PATH}/{token_id}"), None)
                        .await;
                }
                let reason = reason.trim().trim_end_matches('.');
                return Err(format!(
                    "{name} made a token but Desk couldn't keep it: {reason}. The board needs a new token."
                ));
            }
        };
        let offers = serde_json::from_slice::<serde_json::Value>(&answer)
            .ok()
            .and_then(|v| v.get("offers").cloned())
            .unwrap_or(serde_json::Value::Null);
        Ok(Minted::Kept { offers })
    }

    /// Mints a Desk work token for agent `agent` on paired hub `remote`,
    /// with this Desk's device token there and this computer's engine key
    /// `engine_key` (`GET /api/desk/engine-key`, asked by the native side),
    /// and hands it to hub `local`, this computer's, to share the person's
    /// work with that agent by (Sees K5). As with [`Self::mint_for_sync`],
    /// the token goes from one hub to the other here and nowhere else, and
    /// one this computer's hub couldn't keep is revoked where it was made.
    pub async fn link_knows<K, F>(
        &self,
        remote: &str,
        local: &str,
        agent: &str,
        engine_key: K,
        engine: (&str, &str),
    ) -> Result<KnowsLinked, String>
    where
        K: FnOnce() -> F,
        F: std::future::Future<Output = Result<String, String>>,
    {
        if !agent_id_ok(agent) {
            return Err(format!("{agent:?} can't name an agent."));
        }
        if crate::hubs::machine_of(remote).is_some() {
            return Err("A machine's hub keeps no agents of its own.".into());
        }
        if !sync_hub_id_ok(remote) {
            return Err(format!(
                "Desk can't share with agents on {remote:?} yet: its name, from its address, is too long (over 40 characters) or isn't one Desk can use."
            ));
        }
        let there = self
            .paired
            .reach_async(remote)
            .await
            .map_err(|e| e.to_string())?;
        if there.local {
            return Ok(KnowsLinked::Local {
                agent: agent.to_string(),
            });
        }
        let here = self
            .paired
            .reach_async(local)
            .await
            .map_err(|e| e.to_string())?;
        // This computer's hub, or one of the person's machines' (Sees K7):
        // each keeps its own token, under its own engine.
        if !keeps_knows_tokens(local, here.local) {
            return Err(
                "Desk keeps an agent's token only on this computer or a machine of yours.".into(),
            );
        }
        sync_hub_url_ok(&there.base)?;
        let url = there.base.as_str().trim_end_matches('/').to_string();
        // Asked only now: nothing before needed it.
        let engine_key = engine_key().await?;
        let ask = serde_json::to_vec(&serde_json::json!({
            "agent_id": agent,
            "engine": { "id": engine.0, "name": engine.1, "public_key": engine_key },
        }))
        .map_err(|e| e.to_string())?;
        let (meta, bytes) = self
            .fetch(
                remote,
                "POST",
                KNOWS_MINT_PATH,
                Some(("application/json".into(), ask)),
            )
            .await?;
        if !(200..300).contains(&meta.status) {
            return Ok(KnowsLinked::NotAllowed {
                status: meta.status,
                error: words_of(&bytes).unwrap_or_else(|| {
                    format!(
                        "That hub didn't make a token for {agent} ({}).",
                        meta.status
                    )
                }),
            });
        }
        let minted = serde_json::from_slice::<serde_json::Value>(&bytes).ok();
        let token_id = minted
            .as_ref()
            .and_then(|v| v.get("id")?.as_str().map(str::to_string))
            .filter(|i| !i.is_empty() && i.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
        // The agent as its hub names it (case and all): the link is kept,
        // and the rule keyed, by that.
        let named = minted
            .as_ref()
            .and_then(|v| v.get("agentId")?.as_str().map(str::to_string))
            .filter(|a| agent_id_ok(a))
            .unwrap_or_else(|| agent.to_string());
        let token = minted.and_then(|v| {
            v.get("token")?
                .as_str()
                .map(|t| zeroize::Zeroizing::new(t.to_string()))
        });
        drop(zeroize::Zeroizing::new(bytes));
        let Some(token) = token else {
            self.revoke_knows(remote, token_id.as_deref()).await;
            return Ok(KnowsLinked::NotAllowed {
                status: 502,
                error: format!("That hub didn't make a token Desk can use for {agent}."),
            });
        };
        let body = zeroize::Zeroizing::new(
            serde_json::to_vec(&serde_json::json!({ "url": url, "token": token.as_str() }))
                .map_err(|e| e.to_string())?,
        );
        drop(token);
        let kept = self
            .fetch(
                local,
                "PUT",
                &format!("/api/desk/knows-links/{remote}/{named}"),
                Some(("application/json".into(), body.to_vec())),
            )
            .await;
        match kept {
            Ok((meta, _)) if (200..300).contains(&meta.status) => {
                Ok(KnowsLinked::Kept { agent: named })
            }
            failed => {
                let reason = match failed {
                    Ok((meta, answer)) => {
                        words_of(&answer).unwrap_or_else(|| format!("it answered {}", meta.status))
                    }
                    Err(e) => e,
                };
                self.revoke_knows(remote, token_id.as_deref()).await;
                let reason = reason.trim().trim_end_matches('.');
                Err(format!(
                    "That hub made a token for {agent} but Desk couldn't keep it: {reason}. Nothing is shared with it until it's linked again."
                ))
            }
        }
    }

    /// Revokes Desk work token `id` on `remote`, with the device token, on
    /// the device-only route that revokes only what this device minted. (The
    /// next mint for the agent replaces it anyway.)
    async fn revoke_knows(&self, remote: &str, id: Option<&str>) {
        let Some(id) = id else { return };
        match self
            .fetch(remote, "DELETE", &format!("{KNOWS_MINT_PATH}/{id}"), None)
            .await
        {
            Ok((meta, _)) if (200..300).contains(&meta.status) => {}
            Ok((meta, _)) => {
                tracing::warn!(hub = %remote, status = meta.status, "an unkept Desk work token wasn't revoked");
            }
            Err(e) => {
                tracing::warn!(hub = %remote, error = %e, "an unkept Desk work token wasn't revoked");
            }
        }
    }
}

/// Whether hub `id` may keep an agent's Desk work token: this computer's
/// own, or one of the person's machines' (Sees K7), never a paired hub.
fn keeps_knows_tokens(id: &str, local: bool) -> bool {
    local || crate::hubs::machine_of(id).is_some()
}

/// The route a paired Desk mints its own board-sync token on (BH10).
const MINT_PATH: &str = "/api/me/remote-mcp-tokens/desk";

/// The route a paired Desk mints an agent's Desk work token on (Sees K2).
const KNOWS_MINT_PATH: &str = "/api/me/desk-knows-tokens";

/// This computer's engine, as an agent's hub is told of it at mint: its id
/// among the person's engines (a machine's is its own id, K7).
pub const KNOWS_ENGINE_ID: &str = "local";

/// What linking an agent for Desk work did, as the page is told of it:
/// never the token.
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum KnowsLinked {
    /// Kept on this computer's hub, which shares with the agent by it:
    /// `agent` as its hub names it, which its rule is kept by.
    Kept { agent: String },
    /// An agent on this computer's hub: shared with in place, no token.
    /// `agent` as the page named it (the sync finds it by the registry).
    Local { agent: String },
    /// The agent's hub didn't make one (it is older, or its admin turned
    /// Desk work off, or the agent declines it): its words.
    NotAllowed { status: u16, error: String },
}

/// Whether `id` can name an agent, as the hubs take one.
fn agent_id_ok(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// What minting a board-sync token did, as the page is told of it: never
/// the token.
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Minted {
    /// Kept on this computer's hub; what the hub offers, as it said.
    Kept { offers: serde_json::Value },
    /// The hub didn't make one (its admin hasn't allowed it, or it is an
    /// older hub): its words.
    NotAllowed { status: u16, error: String },
}

/// Whether `base` is an address the local hub keeps a sync hub at, as its
/// `check_hub_url` says: `https://`, or `http://` to this computer only,
/// with no credentials, query or fragment.
fn sync_hub_url_ok(base: &Url) -> Result<(), String> {
    let local = matches!(base.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    let ok = (base.scheme() == "https" || (base.scheme() == "http" && local))
        && base.host_str().is_some()
        && base.username().is_empty()
        && base.password().is_none()
        && base.query().is_none()
        && base.fragment().is_none();
    match ok {
        true => Ok(()),
        false => Err(format!(
            "{:?} isn't a hub's address, like https://atlas.example.",
            base.as_str().trim_end_matches('/')
        )),
    }
}

/// Whether `id` can name a sync hub on the local hub: lowercase letters,
/// digits and dashes, at most 40, not starting with a dash.
fn sync_hub_id_ok(id: &str) -> bool {
    (1..=40).contains(&id.len())
        && !id.starts_with('-')
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A hub's words for a refusal: its JSON `error`, else short plain text.
fn words_of(body: &[u8]) -> Option<String> {
    if let Ok(v) = serde_json::from_slice::<serde_json::Value>(body) {
        return v
            .get("error")
            .and_then(|e| e.as_str())
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .map(str::to_string);
    }
    let text = String::from_utf8_lossy(body);
    let text = text.trim();
    (!text.is_empty() && !text.starts_with('<') && text.chars().count() <= 300)
        .then(|| text.to_string())
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
    if page_refused(&method, &path) {
        return Err("Desk asks that of a workspace itself, never for the page.".into());
    }
    let started = std::time::Instant::now();
    let fetched = io.fetch(&hub, &method, &path, body).await;
    if let Some(trace) = knows_trace(&path, &fetched, started.elapsed()) {
        tracing::info!(%hub, %method, path = %split(&path).0, "{trace}");
    }
    let (meta, bytes) = fetched?;
    Ok(tauri::ipc::Response::new(framed(&meta, &bytes)))
}

/// A read of what agents see (Sees) that failed or was slow, in words for
/// Desk's log, so one the page couldn't show leaves a trace. Never the
/// answer's body: its status, or the error, and how long it took.
fn knows_trace(
    path: &str,
    fetched: &Result<(Meta, Vec<u8>), String>,
    took: std::time::Duration,
) -> Option<String> {
    if !split(path).0.starts_with("/api/desk/knows") {
        return None;
    }
    let ms = took.as_millis();
    match fetched {
        Err(e) => Some(format!("a Sees read failed after {ms} ms: {e}")),
        Ok((meta, _)) if meta.status >= 400 => Some(format!(
            "a Sees read was answered {} after {ms} ms",
            meta.status
        )),
        Ok(_) if took >= KNOWS_SLOW => Some(format!("a Sees read took {ms} ms")),
        Ok(_) => None,
    }
}

/// A Sees read slower than this is logged.
const KNOWS_SLOW: std::time::Duration = std::time::Duration::from_secs(3);

/// What only the native side asks of a paired hub, never the page: minting
/// a token (its answer holds it) and keeping one for this computer's hub to
/// send by (an address the page chose would be sent the person's work).
/// Matched on decoded path segments, any case, whatever the query.
fn page_refused(method: &str, target: &str) -> bool {
    let (path, _) = split(target);
    let parts: Option<Vec<String>> = path
        .split('/')
        .filter(|p| !p.is_empty())
        .map(|p| {
            percent_encoding::percent_decode_str(p)
                .decode_utf8()
                .ok()
                .map(|d| d.to_ascii_lowercase())
        })
        .collect();
    // What can't be read can't be checked: refused.
    let Some(parts) = parts else { return true };
    let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
    let method = method.to_ascii_uppercase();
    matches!(
        (method.as_str(), parts.as_slice()),
        ("POST", ["api", "me", "desk-knows-tokens"])
            | ("POST", ["api", "me", "remote-mcp-tokens", "desk"])
            | ("PUT", ["api", "desk", "knows-links", _, _])
            // A boss's relayed calls: the native side's alone, as any
            // method, on any hub (`crate::crew_relay`).
            | (_, ["api", "desk", "crew", "relay" | "served", ..])
    )
}

/// Mints a board-sync token on paired hub `remote` and hands it to the
/// local hub `local` as its sync hub `id` ([`HubIo::mint_for_sync`]).
#[tauri::command]
pub async fn board_sync_mint(
    io: tauri::State<'_, HubIo>,
    remote: String,
    local: String,
    id: String,
    name: String,
) -> CommandResult<Minted> {
    io.mint_for_sync(&remote, &local, &id, &name).await
}

/// Links agent `agent` on paired hub `remote` for the person's Desk work
/// ([`HubIo::link_knows`]): this computer's engine key read by the native
/// side from its own hub, never by the page.
#[tauri::command]
pub async fn knows_link(
    io: tauri::State<'_, HubIo>,
    local: tauri::State<'_, crate::broker::Broker>,
    remote: String,
    agent: String,
) -> CommandResult<KnowsLinked> {
    let key = || async {
        let answer = local.fetch_native("GET", "/api/desk/engine-key").await?;
        engine_key_of(answer.status, &answer.body)
    };
    io.link_knows(
        &remote,
        desk_core::LOCAL_HUB_ID,
        &agent,
        key,
        (KNOWS_ENGINE_ID, ENGINE_NAME),
    )
    .await
}

/// This computer's engine key, from its hub's answer.
pub(crate) fn engine_key_of(status: u16, body: &str) -> Result<String, String> {
    let refused = || "This computer's hub didn't say its engine's key.".to_string();
    if !(200..300).contains(&status) {
        return Err(refused());
    }
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("publicKey")?.as_str().map(str::to_string))
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(refused)
}

/// What this computer's engine is called on an agent's hub.
const ENGINE_NAME: &str = if cfg!(target_os = "macos") {
    "Desk on this Mac"
} else {
    "Desk on this computer"
};

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

/// Why a workspace couldn't be reached, in the person's words: what to
/// check first. The client's own words ("error sending request…") stay in
/// Desk's log, never on screen.
fn unreachable(url: &str, e: reqwest::Error) -> String {
    let host = Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| url.to_string());
    let timed_out = e.is_timeout();
    tracing::info!(%host, error = %e.without_url(), "couldn't reach a workspace to pair with");
    let why = if timed_out {
        "it didn't answer in time"
    } else {
        "check the address, your internet or VPN"
    };
    format!("Can't reach {host}: {why}.")
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
        .map_err(|e| unreachable(url, e))?;
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
    let mut response = client
        .get(target)
        .send()
        .await
        .map_err(|e| unreachable(url, e))?;
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
pub(crate) mod tests {
    use super::*;
    use crate::paired::tests::{account, paired};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};

    /// A hub on a loopback port answering each request with the next of
    /// `answers`, and telling each request's head and body.
    pub(crate) async fn hub(
        answers: Vec<String>,
    ) -> (String, tokio::sync::mpsc::UnboundedReceiver<String>) {
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

    pub(crate) fn io_for(hubs: Vec<crate::hubs::HubAccount>) -> HubIo {
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
    async fn a_workspace_that_cant_be_reached_is_said_plainly_with_what_to_check() {
        // A port nothing listens on: refused at once.
        let free = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = free.local_addr().unwrap().port();
        drop(free);
        let url = format!("http://127.0.0.1:{port}");
        let Err(why) = request_pairing(&url, "Desk", None).await else {
            panic!("nothing listens there");
        };
        assert_eq!(
            why,
            "Can't reach 127.0.0.1: check the address, your internet or VPN."
        );
        assert!(!why.contains("error sending request"));
        let Err(why) = pairing_standing(&url, "ABC1").await else {
            panic!("nothing listens there");
        };
        assert_eq!(
            why,
            "Can't reach 127.0.0.1: check the address, your internet or VPN."
        );
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

    pub(crate) fn status(line: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {line}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    /// A minted token goes from the remote hub to this computer's, with the
    /// remote's address, and what the page is told never holds it.
    #[tokio::test]
    async fn a_minted_token_goes_to_this_computer_s_hub_and_never_to_the_page() {
        let (remote, mut remote_seen) = hub(vec![status(
            "201 Created",
            r#"{"id":"t1","label":"Desk on Sam's Mac","token":"wfr_SENTINEL_MINTED_0123456789","expires_at":"2027-02-01T00:00:00Z","connect":{}}"#,
        )])
        .await;
        let (local, mut local_seen) = hub(vec![ok(
            "application/json",
            r#"{"id":"atlas","name":"Atlas","url":"x","offers":{"jira":true,"linear":false}}"#,
        )])
        .await;
        let io = io_for(vec![
            account("local", &local, true, "LOCAL-DEVICE"),
            account("atlas", &remote, false, "ATLAS-DEVICE"),
        ]);
        let minted = io
            .mint_for_sync("atlas", "local", "atlas", "Atlas")
            .await
            .unwrap();
        assert_eq!(
            minted,
            Minted::Kept {
                offers: serde_json::json!({ "jira": true, "linear": false })
            }
        );
        let told = serde_json::to_string(&minted).unwrap();
        assert!(!told.contains("SENTINEL"), "{told}");
        assert_eq!(
            told,
            r#"{"kind":"kept","offers":{"jira":true,"linear":false}}"#
        );
        let asked = remote_seen.recv().await.unwrap();
        assert!(
            asked.starts_with("POST /api/me/remote-mcp-tokens/desk HTTP/1.1"),
            "{asked}"
        );
        assert!(
            asked
                .to_ascii_lowercase()
                .contains("authorization: bearer atlas-device")
        );
        assert!(!asked.contains("LOCAL-DEVICE"));
        let kept = local_seen.recv().await.unwrap();
        assert!(
            kept.starts_with("PUT /api/desk/sync-hubs/atlas HTTP/1.1"),
            "{kept}"
        );
        assert!(
            kept.to_ascii_lowercase()
                .contains("authorization: bearer local-device")
        );
        let body: serde_json::Value =
            serde_json::from_str(kept.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(
            body,
            serde_json::json!({ "name": "Atlas", "url": remote, "token": "wfr_SENTINEL_MINTED_0123456789" })
        );
    }

    /// A token this computer's hub couldn't keep is revoked on the hub that
    /// made it, with the device token, and the page is told plainly.
    #[tokio::test]
    async fn a_minted_token_this_computer_s_hub_cant_keep_is_revoked() {
        let (remote, mut remote_seen) = hub(vec![
            status(
                "201 Created",
                r#"{"id":"0f6c1a2e-1b2c-4d5e-8f90-a1b2c3d4e5f6","label":"Desk on Sam's Mac","token":"wfr_SENTINEL-unkept-token-here","expires_at":"2027-02-01T00:00:00Z","connect":{}}"#,
            ),
            status("204 No Content", ""),
        ])
        .await;
        let (local, _local_seen) = hub(vec![status(
            "500 Internal Server Error",
            r#"{"error":"Desk couldn't keep the token. Try again."}"#,
        )])
        .await;
        let io = io_for(vec![
            account("local", &local, true, "LOCAL-DEVICE"),
            account("atlas", &remote, false, "ATLAS-DEVICE"),
        ]);
        let e = io
            .mint_for_sync("atlas", "local", "atlas", "Atlas")
            .await
            .unwrap_err();
        assert_eq!(
            e,
            "Atlas made a token but Desk couldn't keep it: Desk couldn't keep the token. Try again. The board needs a new token."
        );
        assert!(!e.contains("SENTINEL"));
        let _mint = remote_seen.recv().await.unwrap();
        let revoke = remote_seen.recv().await.unwrap();
        assert!(
            revoke.starts_with(
                "DELETE /api/me/remote-mcp-tokens/desk/0f6c1a2e-1b2c-4d5e-8f90-a1b2c3d4e5f6 HTTP/1.1"
            ),
            "{revoke}"
        );
        assert!(
            revoke
                .to_ascii_lowercase()
                .contains("authorization: bearer atlas-device")
        );
    }

    /// A hub's address is checked as the local hub checks one, before
    /// anything is minted.
    #[test]
    fn a_sync_hub_s_address_is_checked_as_the_local_hub_checks_it() {
        for ok in [
            "https://atlas.acme.example/",
            "http://127.0.0.1:8080/",
            "http://localhost:9/",
            "http://[::1]:9/",
        ] {
            assert!(sync_hub_url_ok(&Url::parse(ok).unwrap()).is_ok(), "{ok}");
        }
        for bad in [
            "http://atlas.acme.example/",
            "https://sam:pw@atlas.acme.example/",
            "https://atlas.acme.example/?x=1",
            "https://atlas.acme.example/#x",
            "ftp://atlas.acme.example/",
        ] {
            let e = sync_hub_url_ok(&Url::parse(bad).unwrap()).unwrap_err();
            assert!(e.contains("isn't a hub's address"), "{bad}: {e}");
        }
    }

    /// A hub that doesn't let devices mint says so; nothing reaches this
    /// computer's hub, and the page is told the hub's words.
    #[tokio::test]
    async fn a_hub_that_doesnt_let_devices_mint_is_said_and_nothing_is_kept() {
        let words = "this hub's admin hasn't let paired devices make remote MCP tokens (`[remote_mcp] allow_device_tokens`)";
        let (remote, _seen) = hub(vec![status(
            "403 Forbidden",
            &serde_json::json!({ "error": words }).to_string(),
        )])
        .await;
        let (local, mut local_seen) = hub(vec![ok("application/json", "{}")]).await;
        let io = io_for(vec![
            account("local", &local, true, "l"),
            account("atlas", &remote, false, "a"),
        ]);
        assert_eq!(
            io.mint_for_sync("atlas", "local", "atlas", "Atlas")
                .await
                .unwrap(),
            Minted::NotAllowed {
                status: 403,
                error: words.into()
            }
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(200), local_seen.recv())
                .await
                .is_err(),
            "nothing was kept"
        );
    }

    /// Only a remote hub mints, only this computer's keeps, and only under
    /// a name the local hub takes: anything else asks no one.
    #[tokio::test]
    async fn a_mint_goes_only_from_a_remote_hub_to_this_computer_s() {
        let (remote, mut seen) = hub(vec![ok("application/json", "{}")]).await;
        let (local, mut local_seen) = hub(vec![ok("application/json", "{}")]).await;
        let io = io_for(vec![
            account("local", &local, true, "l"),
            account("atlas", &remote, false, "a"),
        ]);
        for (remote, local, id) in [
            ("local", "local", "atlas"),
            ("atlas", "atlas", "atlas"),
            ("machine:devbox", "local", "atlas"),
            ("elsewhere", "local", "atlas"),
            ("atlas", "local", "Atlas"),
            ("atlas", "local", "../vault"),
            ("atlas", "local", ""),
        ] {
            assert!(
                io.mint_for_sync(remote, local, id, "Atlas").await.is_err(),
                "{remote} {local} {id}"
            );
        }
        for rx in [&mut seen, &mut local_seen] {
            assert!(
                tokio::time::timeout(Duration::from_millis(200), rx.recv())
                    .await
                    .is_err(),
                "nothing was sent"
            );
        }
    }

    /// An agent's Desk work token goes from its hub to this computer's,
    /// minted with this computer's engine key, and the page is told only
    /// that it was kept (Sees K5).
    #[tokio::test]
    async fn an_agent_s_desk_work_token_goes_to_this_computer_s_hub_and_never_to_the_page() {
        let (remote, mut remote_seen) = hub(vec![status(
            "201 Created",
            &serde_json::json!({"id": "0f6c1a2e-1b2c-4d5e-8f90-a1b2c3d4e5f6", "token": KNOWS_FAKE, "agentId": "allan", "expiresAt": "2027-02-01T00:00:00Z"}).to_string(),
        )])
        .await;
        let (local, mut local_seen) = hub(vec![status("204 No Content", "")]).await;
        let io = io_for(vec![
            account("local", &local, true, "LOCAL-DEVICE"),
            account("atlas", &remote, false, "ATLAS-DEVICE"),
        ]);
        let linked = io
            .link_knows(
                "atlas",
                "local",
                "Allan",
                key("ed25519:KEY"),
                ("local", "Desk on this Mac"),
            )
            .await
            .unwrap();
        // Kept under the agent as its hub names it.
        assert_eq!(
            linked,
            KnowsLinked::Kept {
                agent: "allan".into()
            }
        );
        let told = serde_json::to_string(&linked).unwrap();
        assert_eq!(told, r#"{"kind":"kept","agent":"allan"}"#);
        let asked = remote_seen.recv().await.unwrap();
        assert!(
            asked.starts_with("POST /api/me/desk-knows-tokens HTTP/1.1"),
            "{asked}"
        );
        assert!(
            asked
                .to_ascii_lowercase()
                .contains("authorization: bearer atlas-device")
        );
        let body: serde_json::Value =
            serde_json::from_str(asked.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(
            body,
            serde_json::json!({
                "agent_id": "Allan",
                "engine": { "id": "local", "name": "Desk on this Mac", "public_key": "ed25519:KEY" }
            })
        );
        let kept = local_seen.recv().await.unwrap();
        assert!(
            kept.starts_with("PUT /api/desk/knows-links/atlas/allan HTTP/1.1"),
            "{kept}"
        );
        assert!(
            kept.to_ascii_lowercase()
                .contains("authorization: bearer local-device")
        );
        let body: serde_json::Value =
            serde_json::from_str(kept.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(
            body,
            serde_json::json!({ "url": remote, "token": KNOWS_FAKE })
        );
    }

    /// Made-up Desk work tokens, built so no scanner takes them for real ones.
    const KNOWS_FAKE: &str = concat!("wfk", "_SENTINEL_", "KNOWS_0123456789");
    const KNOWS_UNKEPT: &str = concat!("wfk", "_SENTINEL-", "unkept");

    fn key(k: &'static str) -> impl FnOnce() -> std::future::Ready<Result<String, String>> {
        move || std::future::ready(Ok(k.to_string()))
    }

    /// Asked for no key: the asks it is given never need one.
    fn no_key() -> std::future::Ready<Result<String, String>> {
        panic!("no key is asked for")
    }

    /// What the page may not ask of a workspace itself, however spelled.
    #[test]
    fn minting_and_keeping_tokens_is_the_native_side_s_alone() {
        for (method, target) in [
            ("POST", "/api/me/desk-knows-tokens"),
            ("post", "/api/me/desk-knows-tokens?x=1"),
            ("POST", "/api/me/desk%2Dknows-tokens"),
            ("POST", "//api/me/Desk-Knows-Tokens/"),
            ("POST", "/api/me/remote-mcp-tokens/desk"),
            ("PUT", "/api/desk/knows-links/atlas/allan"),
            ("PUT", "/api/desk/knows-links/atlas/%61llan"),
            ("PUT", "/api/desk/%ff/x"),
        ] {
            assert!(page_refused(method, target), "{method} {target}");
        }
        for (method, target) in [
            ("GET", "/api/desk/knows"),
            ("PUT", "/api/desk/knows/atlas/allan"),
            ("DELETE", "/api/desk/knows-links/atlas/allan"),
            ("DELETE", "/api/me/desk-knows-tokens/t1"),
            ("GET", "/api/me"),
        ] {
            assert!(!page_refused(method, target), "{method} {target}");
        }
    }

    /// A boss's relayed calls are never the page's, on any hub, however
    /// spelled.
    #[test]
    fn the_relay_is_never_asked_of_a_workspace_for_the_page() {
        for (method, target) in [
            ("GET", "/api/desk/crew/relay"),
            ("get", "/api/desk/crew/relay?token=x"),
            (
                "POST",
                "/api/desk/crew/relay/0f0e0d0c-0b0a-4909-8807-060504030201",
            ),
            ("POST", "//api/Desk/Crew/%72elay/x/"),
            ("POST", "/api/desk/crew/served"),
            ("PUT", "/api/desk/crew/served/x"),
        ] {
            assert!(page_refused(method, target), "{method} {target}");
        }
        assert!(!page_refused("GET", "/api/desk/crew"));
        assert!(!page_refused("GET", "/api/desk/overview"));
    }

    #[test]
    fn this_computer_s_engine_key_is_read_from_its_hub_s_answer() {
        assert_eq!(
            engine_key_of(200, r#"{"publicKey":"ed25519:abc"}"#).unwrap(),
            "ed25519:abc"
        );
        for (status, body) in [
            (403, r#"{"publicKey":"k"}"#),
            (200, "{}"),
            (200, r#"{"publicKey":" "}"#),
            (200, "<p>"),
        ] {
            assert!(engine_key_of(status, body).is_err(), "{status} {body}");
        }
    }

    /// One this computer's hub couldn't keep is revoked where it was made;
    /// a hub that won't make one says so and nothing is kept; an agent on
    /// this computer's hub needs none; and nothing else asks anyone.
    #[tokio::test]
    async fn an_agent_s_token_unkept_is_revoked_and_odd_asks_reach_no_one() {
        let (remote, mut remote_seen) = hub(vec![
            status(
                "201 Created",
                &serde_json::json!({"id": "0f6c1a2e-1b2c-4d5e-8f90-a1b2c3d4e5f6", "token": KNOWS_UNKEPT}).to_string(),
            ),
            status("204 No Content", ""),
            status(
                "403 Forbidden",
                r#"{"error":"Allan doesn't take Desk work."}"#,
            ),
        ])
        .await;
        let (local, mut local_seen) = hub(vec![status(
            "500 Internal Server Error",
            r#"{"error":"Desk couldn't keep the link. Try again."}"#,
        )])
        .await;
        let io = io_for(vec![
            account("local", &local, true, "LOCAL-DEVICE"),
            account("atlas", &remote, false, "ATLAS-DEVICE"),
        ]);
        let e = io
            .link_knows("atlas", "local", "allan", key("k"), ("local", "Desk"))
            .await
            .unwrap_err();
        assert!(e.contains("Desk couldn't keep the link. Try again"), "{e}");
        assert!(!e.contains("SENTINEL"));
        let _mint = remote_seen.recv().await.unwrap();
        let revoke = remote_seen.recv().await.unwrap();
        assert!(
            revoke.starts_with(
                "DELETE /api/me/desk-knows-tokens/0f6c1a2e-1b2c-4d5e-8f90-a1b2c3d4e5f6 HTTP/1.1"
            ),
            "{revoke}"
        );
        let _put = local_seen.recv().await.unwrap();
        assert_eq!(
            io.link_knows("atlas", "local", "allan", key("k"), ("local", "Desk"))
                .await
                .unwrap(),
            KnowsLinked::NotAllowed {
                status: 403,
                error: "Allan doesn't take Desk work.".into()
            }
        );
        let _refused = remote_seen.recv().await.unwrap();
        assert_eq!(
            io.link_knows("local", "local", "allan", no_key, ("local", "Desk"))
                .await
                .unwrap(),
            KnowsLinked::Local {
                agent: "allan".into()
            }
        );
        for (remote, local, agent) in [
            ("atlas", "atlas", "allan"),
            ("machine:devbox", "local", "allan"),
            ("elsewhere", "local", "allan"),
            ("atlas", "local", "../vault"),
            ("atlas", "local", ""),
            ("atlas", "local", "allan/x"),
        ] {
            assert!(
                io.link_knows(remote, local, agent, no_key, ("local", "Desk"))
                    .await
                    .is_err(),
                "{remote} {local} {agent}"
            );
        }
        for rx in [&mut remote_seen, &mut local_seen] {
            // A fake hub whose answers ran out closes its channel: nothing
            // was sent either way.
            assert!(
                !matches!(
                    tokio::time::timeout(Duration::from_millis(200), rx.recv()).await,
                    Ok(Some(_))
                ),
                "nothing more was sent"
            );
        }
    }

    /// A machine of the person's keeps its own token for an agent, as this
    /// computer's hub does; a paired hub never does (Sees K7).
    #[test]
    fn only_this_computer_and_the_persons_machines_keep_an_agents_token() {
        assert!(keeps_knows_tokens("local", true));
        assert!(keeps_knows_tokens("machine:devbox", false));
        assert!(!keeps_knows_tokens("atlas", false));
        assert!(!keeps_knows_tokens("machines:devbox", false));
    }

    #[test]
    fn a_sees_read_that_failed_or_was_slow_is_traced_and_no_other() {
        let ok = |status| {
            Ok((
                Meta {
                    status,
                    content_type: None,
                },
                b"{\"secret\":1}".to_vec(),
            ))
        };
        let quick = Duration::from_millis(40);
        assert_eq!(
            knows_trace("/api/desk/knows/dw/allan", &ok(200), quick),
            None
        );
        assert_eq!(
            knows_trace("/api/desk/knows/dw/allan?x=1", &ok(404), quick).as_deref(),
            Some("a Sees read was answered 404 after 40 ms")
        );
        assert_eq!(
            knows_trace("/api/desk/knows", &Err("unreachable".into()), quick).as_deref(),
            Some("a Sees read failed after 40 ms: unreachable")
        );
        assert_eq!(
            knows_trace("/api/desk/knows", &ok(200), Duration::from_secs(4)).as_deref(),
            Some("a Sees read took 4000 ms")
        );
        assert_eq!(knows_trace("/api/desk/sessions", &ok(500), quick), None);
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

    /// Desk Helper moved this computer's hub: a socket to its old address
    /// fails, and the next one the page opens goes to where it is now.
    #[tokio::test]
    async fn a_socket_after_the_local_hub_moved_opens_where_it_is_now() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let (url, _seen) = ws_hub(true, true).await;
        let gone = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}", l.local_addr().unwrap())
        };
        let at = Arc::new(std::sync::Mutex::new(gone));
        let following = Arc::clone(&at);
        let paired = Arc::new(Paired::with_source(Arc::new(move || {
            let local = following.lock().unwrap().clone();
            Ok(vec![account("local", &local, true, "SENTINEL-DEVICE")])
        })));
        let io = HubIo::new(paired, Arc::default());
        let (events, mut rx) = opened();
        io.open_socket("main", "local", "/ws/desk", events)
            .await
            .unwrap();
        assert_eq!(said(&mut rx).await["type"], "error");
        assert_eq!(said(&mut rx).await["type"], "close");
        *at.lock().unwrap() = url;
        let (events, mut rx) = opened();
        io.open_socket("main", "local", "/ws/desk", events)
            .await
            .unwrap();
        assert_eq!(said(&mut rx).await["type"], "open");
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
