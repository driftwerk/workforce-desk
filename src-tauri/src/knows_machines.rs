//! What an agent on another hub sees of the person's work on their machines
//! (Sees K7). This computer's hub keeps each agent's rule and says, for
//! each machine, which of its sessions the rule covers
//! (`GET /api/desk/knows/{hub}/{agent}/machines`). Each machine's hub
//! sends its own: here it is linked to the agent under its own engine,
//! told its part of the rule, and told what the person chose to do with
//! what the agent holds when a rule narrows.
//!
//! Done when the page changes a rule, and every few minutes besides, for
//! sessions that move. Agents on this computer's hub aren't shared with
//! from machines yet: a machine's hub can't reach this computer's.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::CommandResult;
use crate::hub_io::{HubIo, KnowsLinked};

/// How often the machines are told again, for sessions that came or went.
pub const EVERY: Duration = Duration::from_secs(5 * 60);

/// One of the person's machines whose hub Desk reaches now.
#[derive(Debug, Clone, PartialEq)]
pub struct Machine {
    /// Its hub's id here (`machine:<id>`).
    pub hub: String,
    /// Its own id, which rules name its sessions by and its engine is.
    pub id: String,
    pub name: String,
}

/// What to do with what an agent holds that a narrowed rule no longer
/// covers, as the person chose on this computer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Choice {
    Keep,
    Delete,
}

/// A rule's part for the machines, as this computer's hub says it.
#[derive(Debug, Deserialize)]
struct Share {
    everything: bool,
    transcripts: bool,
    #[serde(default)]
    machines: BTreeMap<String, Vec<String>>,
}

/// A machine's rule as it holds it now.
#[derive(Debug, Default)]
struct Held {
    places: Vec<String>,
    transcripts: bool,
    outside: Outside,
}

/// What an agent holds of the person's machines that their rules no longer
/// cover, summed over the machines, as the page says it beside this
/// computer's (`heldOutside`).
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outside {
    pub items: u64,
    pub transcripts: u64,
    pub sessions: u64,
}

impl Outside {
    fn add(&mut self, o: &Outside) {
        self.items += o.items;
        self.transcripts += o.transcripts;
        self.sessions += o.sessions;
    }
}

/// What telling the machines did, as the page is told of it: what the
/// agent holds of them outside the rule now, and whether that grew, so the
/// person is asked what to do with it as for this computer's.
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Told {
    pub held: Outside,
    pub grew: bool,
}

/// How long a machine's link is trusted before it is made again: well
/// inside a token's life on the agent's hub.
const RELINK: Duration = Duration::from_secs(12 * 60 * 60);

/// What machine sharing remembers in this run of Desk.
#[derive(Default)]
pub struct KnowsMachines {
    /// When each machine was linked with each agent: (machine hub, rule
    /// key). Linked again after [`RELINK`], and in each run.
    linked: Mutex<HashMap<(String, String), Instant>>,
    /// One pass at a time, so a rule changed twice isn't told out of order.
    pass: tokio::sync::Mutex<()>,
    /// What couldn't be told, warned of once a run: (machine hub, rule key).
    warned: Mutex<HashSet<(String, String)>>,
}

/// Whether `s` can be a hub's or an agent's id in a path: never `.` or
/// `..`.
fn plain(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !s.chars().all(|c| c == '.')
}

impl KnowsMachines {
    /// Machine hub `hub` is gone: it is linked again from nothing if it
    /// comes back.
    pub fn forget_machine(&self, hub: &str) {
        self.linked
            .lock()
            .expect("linked")
            .retain(|(h, _), _| h != hub);
    }

    /// Tells every machine its part of every rule for an agent on another
    /// hub. What one machine or rule can't be told is skipped and logged.
    pub async fn sync_all(&self, io: &HubIo, machines: &[Machine]) {
        if machines.is_empty() {
            return;
        }
        let rules = match io.fetch(LOCAL, "GET", "/api/desk/knows", None).await {
            Ok((meta, body)) if (200..300).contains(&meta.status) => keys_of(&body),
            Ok((meta, _)) => {
                tracing::debug!(
                    status = meta.status,
                    "this computer's hub didn't list what agents see"
                );
                return;
            }
            Err(e) => {
                tracing::debug!(error = %e, "this computer's hub didn't list what agents see");
                return;
            }
        };
        for key in rules {
            if let Some((hub, agent)) = split_key(&key) {
                self.sync(io, machines, hub, agent, None).await;
            }
        }
    }

    /// Tells every machine its part of agent `agent` on hub `hub`'s rule,
    /// and, with `choice`, what to do with what it holds that the rule
    /// stopped covering there.
    pub async fn sync(
        &self,
        io: &HubIo,
        machines: &[Machine],
        hub: &str,
        agent: &str,
        choice: Option<Choice>,
    ) -> Told {
        let mut told = Told::default();
        if !plain(hub)
            || !plain(agent)
            || hub == LOCAL
            || crate::hubs::machine_of(hub).is_some()
            || machines.is_empty()
        {
            return told;
        }
        let _one = self.pass.lock().await;
        let share = match get_json::<Share>(
            io,
            LOCAL,
            &format!("/api/desk/knows/{hub}/{agent}/machines"),
        )
        .await
        {
            Ok(Some(s)) => s,
            Ok(None) => return told,
            Err(e) => {
                tracing::debug!(%hub, %agent, error = %e, "this computer's hub didn't say what machines share");
                return told;
            }
        };
        for m in machines {
            match self.tell(io, m, hub, agent, &share, choice).await {
                Ok(Some((before, after))) => {
                    told.grew |= after.items > before.items;
                    told.held.add(&after);
                }
                Ok(None) => {}
                Err(e) => {
                    let first = self
                        .warned
                        .lock()
                        .expect("warned")
                        .insert((m.hub.clone(), format!("{hub}/{agent}")));
                    if first {
                        tracing::warn!(machine = %m.name, %hub, %agent, error = %e, "a machine wasn't told what an agent sees");
                    } else {
                        tracing::debug!(machine = %m.name, %hub, %agent, error = %e, "a machine wasn't told what an agent sees");
                    }
                }
            }
        }
        told
    }

    /// Tells machine `m` its part of the rule: what the agent held of it
    /// outside the rule before and after, `None` when it shares nothing
    /// with the agent or can't yet.
    async fn tell(
        &self,
        io: &HubIo,
        m: &Machine,
        hub: &str,
        agent: &str,
        share: &Share,
        choice: Option<Choice>,
    ) -> Result<Option<(Outside, Outside)>, String> {
        let places = places_for(share, &m.id);
        let path = format!("/api/desk/knows/{hub}/{agent}");
        // A machine whose hub keeps no rules, or not each machine's part of
        // one (before Sees K7), is told nothing: it would send as this
        // computer does, the digest and all.
        if get_json::<serde_json::Value>(io, &m.hub, &format!("{path}/machines"))
            .await?
            .is_none()
        {
            return Ok(None);
        }
        let Some(held) = rule_of(io, &m.hub, &path).await? else {
            return Ok(None);
        };
        if places.is_empty() && held.places.is_empty() && held.outside.items == 0 {
            return Ok(None);
        }
        let key = (m.hub.clone(), format!("{hub}/{agent}"));
        let fresh = self
            .linked
            .lock()
            .expect("linked")
            .get(&key)
            .is_some_and(|at| at.elapsed() < RELINK);
        if !places.is_empty() && !fresh {
            // The agent's hub must keep each engine's token apart, or the
            // machine's would replace this computer's there.
            if !keeps_engines_apart(io, hub).await {
                return Err("its agent's hub is older and can't take a machine's work yet".into());
            }
            let engine_key = || async {
                let (meta, body) = io
                    .fetch(&m.hub, "GET", "/api/desk/engine-key", None)
                    .await?;
                crate::hub_io::engine_key_of(meta.status, &String::from_utf8_lossy(&body))
            };
            match io
                .link_knows(hub, &m.hub, agent, engine_key, (&m.id, &m.name))
                .await?
            {
                KnowsLinked::Kept { .. } => {
                    self.linked
                        .lock()
                        .expect("linked")
                        .insert(key.clone(), Instant::now());
                }
                KnowsLinked::Local { .. } => return Ok(None),
                KnowsLinked::NotAllowed { status, error } => {
                    return Err(format!("{status}: {error}"));
                }
            }
        }
        if held.places != places || held.transcripts != share.transcripts {
            let body =
                json!({ "places": places, "transcripts": share.transcripts, "digest": "off" });
            let (meta, answer) = io
                .fetch(
                    &m.hub,
                    "PUT",
                    &path,
                    Some(("application/json".into(), body.to_string().into_bytes())),
                )
                .await?;
            if !(200..300).contains(&meta.status) {
                return Err(words(meta.status, &answer));
            }
        }
        // Asked again: the PUT may have narrowed it just now.
        let mut now = rule_of(io, &m.hub, &path).await?.unwrap_or_default();
        if let Some(choice) = choice
            && now.outside.items > 0
        {
            let body = json!({ "choice": choice });
            let (meta, answer) = io
                .fetch(
                    &m.hub,
                    "POST",
                    &format!("{path}/held"),
                    Some(("application/json".into(), body.to_string().into_bytes())),
                )
                .await?;
            if !(200..300).contains(&meta.status) {
                return Err(words(meta.status, &answer));
            }
            now = rule_of(io, &m.hub, &path).await?.unwrap_or_default();
        }
        Ok(Some((held.outside, now.outside)))
    }
}

/// Whether agent hub `hub` keeps each of the person's engines' tokens and
/// rows apart (Sees K7): it says so, an older one has no such route.
async fn keeps_engines_apart(io: &HubIo, hub: &str) -> bool {
    matches!(
        get_json::<serde_json::Value>(io, hub, "/api/me/desk-knows-tokens/engines").await,
        Ok(Some(v)) if v["engines"] == json!(true)
    )
}

/// What ending sharing is still owed: an agent hub that couldn't be told
/// to end a removed engine's tokens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Owed {
    hub: String,
    engine: String,
}

/// Taking back what a machine, or a hub, was given to share by (Sees): when
/// a machine is removed from Desk, or a hub is, nothing may go on sharing
/// with the token it holds. Each step is the person's own Desk's, with its
/// device tokens; what an agent's hub couldn't be told is kept in a file
/// and told again every few minutes, until it answers.
pub struct Ending {
    file: std::path::PathBuf,
    one: tokio::sync::Mutex<()>,
}

/// How long one call to take sharing back may take: removing a machine or
/// a hub is never held up longer by one that doesn't answer.
const CALL: Duration = Duration::from_secs(20);

/// What ended a token on a hub: done, or to be tried again.
enum Ended {
    Done,
    Later(String),
}

impl Ending {
    pub fn at(paths: &desk_core::Paths) -> Self {
        Self {
            file: paths.root.join("knows-ended.json"),
            one: tokio::sync::Mutex::new(()),
        }
    }

    fn owed(&self) -> Vec<Owed> {
        let text = match std::fs::read_to_string(&self.file) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
            Err(e) => {
                tracing::warn!(error = %e, "what Desk still owes to end sharing couldn't be read");
                return Vec::new();
            }
        };
        serde_json::from_str(&text).unwrap_or_else(|e| {
            // Kept aside, never overwritten: what it held may still be owed.
            tracing::warn!(error = %e, "what Desk still owes to end sharing is unreadable; kept as knows-ended.json.bad");
            let _ = std::fs::rename(&self.file, self.file.with_extension("json.bad"));
            Vec::new()
        })
    }

    fn keep(&self, owed: &[Owed]) {
        let wrote = serde_json::to_string(owed)
            .map_err(|e| e.to_string())
            .and_then(|s| desk_core::write_private(&self.file, &s).map_err(|e| e.to_string()));
        if let Err(e) = wrote {
            tracing::warn!(error = %e, "what Desk still owes to end sharing wasn't kept");
        }
    }

    /// Machine `id` is being removed from Desk. Its own hub, if still
    /// reached, unlinks its agents (each token ended where it was made); and
    /// every agent hub in `hubs` is told to end the tokens this computer
    /// minted for it, which works with the machine gone or unreachable.
    pub async fn machine(&self, io: &HubIo, machine_hub: Option<&str>, id: &str, hubs: &[String]) {
        let _one = self.one.lock().await;
        if let Some(hub) = machine_hub {
            unlink_on(io, hub, "/api/desk/knows-links").await;
        }
        let mut owed = self.owed();
        for hub in hubs {
            match end_engine(io, hub, id).await {
                Ended::Done => {}
                Ended::Later(why) => {
                    tracing::warn!(%hub, machine = %id, error = %why, "a removed machine's Desk work tokens weren't ended yet; tried again");
                    let o = Owed {
                        hub: hub.clone(),
                        engine: id.to_string(),
                    };
                    if !owed.contains(&o) {
                        owed.push(o);
                    }
                }
            }
        }
        self.keep(&owed);
    }

    /// Hub `hub` is being removed from Desk: its agents are unlinked on
    /// this computer's hub and on each machine's (`here`), and every one of
    /// this computer's engines' tokens (`engines`) ended there, while Desk
    /// can still reach it. Not tried again: nothing reaches it afterwards.
    pub async fn hub(&self, io: &HubIo, hub: &str, here: &[String], engines: &[String]) {
        if !plain(hub) {
            return;
        }
        for h in here {
            unlink_on(io, h, &format!("/api/desk/knows-links/{hub}")).await;
        }
        for engine in engines {
            if let Ended::Later(why) = end_engine(io, hub, engine).await {
                tracing::warn!(%hub, %engine, error = %why, "a removed hub's Desk work tokens weren't ended; they end when they expire");
            }
        }
    }

    /// Tells again each hub that couldn't be told, dropping those Desk is
    /// no longer paired with.
    pub async fn retry(&self, io: &HubIo, paired: Option<&[String]>) {
        // Which hubs Desk is paired with couldn't be read: nothing is
        // dropped, nothing told, until it can.
        let Some(paired) = paired else { return };
        let _one = self.one.lock().await;
        let owed = self.owed();
        if owed.is_empty() {
            return;
        }
        let mut still = Vec::new();
        for o in owed {
            if !paired.contains(&o.hub) {
                continue;
            }
            if let Ended::Later(why) = end_engine(io, &o.hub, &o.engine).await {
                tracing::debug!(hub = %o.hub, engine = %o.engine, error = %why, "a removed machine's Desk work tokens aren't ended yet");
                still.push(o);
            }
        }
        self.keep(&still);
    }
}

/// `DELETE path` on hub `hub` (this computer's or a machine's), which
/// unlinks what it names and ends each token on its own hub. Best effort:
/// a hub that can't be reached is left, and said.
async fn unlink_on(io: &HubIo, hub: &str, path: &str) {
    let asked = tokio::time::timeout(CALL, io.fetch(hub, "DELETE", path, None))
        .await
        .unwrap_or_else(|_| Err("it didn't answer in time".to_string()));
    match asked {
        Ok((meta, _)) if (200..300).contains(&meta.status) => {}
        Ok((meta, _)) => {
            tracing::warn!(%hub, status = meta.status, "a hub didn't unlink what it shares by");
        }
        Err(e) => {
            tracing::warn!(%hub, error = %e, "a hub couldn't be asked to unlink what it shares by");
        }
    }
}

/// Ends, on agent hub `hub` and with this computer's device token there,
/// every Desk work token this computer minted for engine `engine`. A hub
/// that no longer knows the device (401, 403) or is older and has no such
/// route (404) has nothing more to end; anything else is tried again.
async fn end_engine(io: &HubIo, hub: &str, engine: &str) -> Ended {
    if !plain(hub) || !plain(engine) || hub == LOCAL || crate::hubs::machine_of(hub).is_some() {
        return Ended::Done;
    }
    let path = format!("/api/me/desk-knows-tokens/engines/{engine}");
    let asked = tokio::time::timeout(CALL, io.fetch(hub, "DELETE", &path, None))
        .await
        .unwrap_or_else(|_| Err("it didn't answer in time".to_string()));
    match asked {
        Ok((meta, _)) if (200..300).contains(&meta.status) => Ended::Done,
        Ok((meta, _)) if matches!(meta.status, 401 | 403 | 404) => {
            tracing::warn!(%hub, %engine, status = meta.status, "an agent's hub wouldn't end a removed engine's Desk work tokens (no such tokens, an older hub, or this computer's device isn't known there); any live ones end when they expire");
            Ended::Done
        }
        Ok((meta, body)) => Ended::Later(words(meta.status, &body)),
        Err(e) => Ended::Later(e),
    }
}

/// The hubs of other workspaces Desk is paired with, by id.
pub fn remote_hubs(paths: &desk_core::Paths) -> Vec<String> {
    paired_hubs(paths).unwrap_or_default()
}

/// The same, or none when the list couldn't be read.
pub fn paired_hubs(paths: &desk_core::Paths) -> Option<Vec<String>> {
    crate::hubs::read_records(paths)
        .ok()
        .map(|r| r.into_iter().map(|r| r.id).collect())
}

/// This computer's hub, by its id here.
const LOCAL: &str = desk_core::LOCAL_HUB_ID;

/// Machine `id`'s places in `share`: everything, or its own sessions the
/// rule covers.
fn places_for(share: &Share, id: &str) -> Vec<String> {
    if share.everything {
        return vec!["all".into()];
    }
    let mut places = share.machines.get(id).cloned().unwrap_or_default();
    places.sort();
    places
}

/// The rule keys (`<hub>/<agent>`) in a `GET /api/desk/knows` answer.
fn keys_of(body: &[u8]) -> Vec<String> {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.get("rules")?.as_array().map(|rules| {
                rules
                    .iter()
                    .filter_map(|r| r.get("agent")?.as_str().map(str::to_string))
                    .collect()
            })
        })
        .unwrap_or_default()
}

fn split_key(key: &str) -> Option<(&str, &str)> {
    key.split_once('/')
        .filter(|(h, a)| !h.is_empty() && !a.is_empty())
}

/// `path` on `hub` read as `T`: `None` when the hub has no such route (an
/// older one) or no such thing.
async fn get_json<T: serde::de::DeserializeOwned>(
    io: &HubIo,
    hub: &str,
    path: &str,
) -> Result<Option<T>, String> {
    let (meta, body) = io.fetch(hub, "GET", path, None).await?;
    if matches!(meta.status, 404 | 405) {
        return Ok(None);
    }
    if !(200..300).contains(&meta.status) {
        return Err(words(meta.status, &body));
    }
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|e| e.to_string())
}

/// A machine's rule at `path`, as it holds it.
async fn rule_of(io: &HubIo, hub: &str, path: &str) -> Result<Option<Held>, String> {
    let Some(v) = get_json::<serde_json::Value>(io, hub, path).await? else {
        return Ok(None);
    };
    let mut places: Vec<String> = v["rule"]["places"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| p.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    places.sort();
    let n = |k: &str| v["heldOutside"][k].as_u64().unwrap_or(0);
    Ok(Some(Held {
        places,
        transcripts: v["rule"]["transcripts"].as_bool().unwrap_or(false),
        outside: Outside {
            items: n("items"),
            transcripts: n("transcripts"),
            sessions: n("sessions"),
        },
    }))
}

fn words(status: u16, body: &[u8]) -> String {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error")?.as_str().map(str::to_string))
        .unwrap_or_else(|| format!("it answered {status}"))
}

/// The machines whose hubs Desk reaches now.
pub fn machines_of(machines: &desk_machine::Machines) -> Vec<Machine> {
    crate::hubs::machine_accounts(machines)
        .into_iter()
        .filter_map(|a| {
            Some(Machine {
                id: a.machine.clone()?,
                name: a.label.clone(),
                hub: a.id.clone(),
            })
        })
        .collect()
}

/// Tells the machines what agent `agent` on hub `hub` sees of them now,
/// after the page changed its rule, with the person's `choice` when it
/// narrowed.
#[tauri::command]
pub async fn knows_machines(
    io: tauri::State<'_, HubIo>,
    knows: tauri::State<'_, Arc<KnowsMachines>>,
    machines: tauri::State<'_, Arc<desk_machine::Machines>>,
    hub: String,
    agent: String,
    choice: Option<Choice>,
) -> CommandResult<Told> {
    let machines = Arc::clone(&machines);
    let list = tauri::async_runtime::spawn_blocking(move || machines_of(&machines))
        .await
        .map_err(|e| e.to_string())?;
    Ok(knows.sync(&io, &list, &hub, &agent, choice).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub_io::tests::{hub, io_for, status};
    use crate::paired::tests::account;

    fn machine(hub: &str) -> Machine {
        Machine {
            hub: hub.into(),
            id: "box".into(),
            name: "box".into(),
        }
    }

    fn rule(places: &[&str], transcripts: bool, outside: u64) -> String {
        status(
            "200 OK",
            &json!({
                "rule": { "places": places, "transcripts": transcripts },
                "heldOutside": { "items": outside, "transcripts": 0, "sessions": u64::from(outside > 0) },
            })
            .to_string(),
        )
    }

    fn json_ok(v: serde_json::Value) -> String {
        status("200 OK", &v.to_string())
    }

    /// Every request a fake hub saw, by its request line.
    fn lines(rx: &mut tokio::sync::mpsc::UnboundedReceiver<String>) -> Vec<String> {
        let mut out = Vec::new();
        while let Ok(r) = rx.try_recv() {
            out.push(
                r.lines()
                    .next()
                    .unwrap_or_default()
                    .replace(" HTTP/1.1", ""),
            );
        }
        out
    }

    #[tokio::test]
    async fn a_machine_is_linked_once_under_its_own_engine_and_told_its_own_sessions() {
        let share = json!({ "everything": false, "transcripts": true, "machines": { "box": ["session:s1"] } });
        let (mac, mut mac_seen) = hub(vec![json_ok(share.clone()), json_ok(share)]).await;
        let (agents, mut agents_seen) = hub(vec![
            json_ok(json!({ "engines": true })),
            status(
                "201 Created",
                &json!({ "id": "0f6c1a2e-1b2c-4d5e-8f90-a1b2c3d4e5f6", "token": "T", "agentId": "allan" }).to_string(),
            ),
        ])
        .await;
        let (boxed, mut box_seen) = hub(vec![
            json_ok(json!({})),
            rule(&[], false, 0),
            json_ok(json!({ "publicKey": "ed25519:K" })),
            status("204 No Content", ""),
            json_ok(json!({})),
            rule(&["session:s1"], true, 0),
            // Told again: nothing changed, nothing linked or set.
            json_ok(json!({})),
            rule(&["session:s1"], true, 0),
            rule(&["session:s1"], true, 0),
        ])
        .await;
        let io = io_for(vec![
            account("local", &mac, true, "MAC"),
            account("dw", &agents, false, "DW"),
            account("box", &boxed, true, "BOX"),
        ]);
        let knows = KnowsMachines::default();
        let told = knows
            .sync(&io, &[machine("box")], "dw", "allan", None)
            .await;
        assert_eq!(told, Told::default());
        assert_eq!(
            lines(&mut box_seen),
            [
                "GET /api/desk/knows/dw/allan/machines",
                "GET /api/desk/knows/dw/allan",
                "GET /api/desk/engine-key",
                "PUT /api/desk/knows-links/dw/allan",
                "PUT /api/desk/knows/dw/allan",
                "GET /api/desk/knows/dw/allan",
            ]
        );
        let asked = lines(&mut agents_seen);
        assert_eq!(
            asked,
            [
                "GET /api/me/desk-knows-tokens/engines",
                "POST /api/me/desk-knows-tokens"
            ]
        );
        knows
            .sync(&io, &[machine("box")], "dw", "allan", None)
            .await;
        assert_eq!(
            lines(&mut box_seen),
            [
                "GET /api/desk/knows/dw/allan/machines",
                "GET /api/desk/knows/dw/allan",
                "GET /api/desk/knows/dw/allan",
            ]
        );
        assert!(lines(&mut agents_seen).is_empty());
        assert_eq!(lines(&mut mac_seen).len(), 2);
    }

    #[tokio::test]
    async fn an_older_agent_hub_or_machine_is_told_nothing() {
        let share = json!({ "everything": true, "transcripts": false, "machines": {} });
        let (mac, _mac_seen) = hub(vec![json_ok(share.clone()), json_ok(share)]).await;
        let (agents, mut agents_seen) = hub(vec![status("405 Method Not Allowed", "")]).await;
        let (boxed, mut box_seen) = hub(vec![
            json_ok(json!({})),
            rule(&[], false, 0),
            // A machine before Sees K7.
            status("404 Not Found", ""),
        ])
        .await;
        let io = io_for(vec![
            account("local", &mac, true, "MAC"),
            account("dw", &agents, false, "DW"),
            account("box", &boxed, true, "BOX"),
        ]);
        let knows = KnowsMachines::default();
        // The agent's hub can't keep a machine's token apart: no mint.
        knows
            .sync(&io, &[machine("box")], "dw", "allan", None)
            .await;
        assert_eq!(
            lines(&mut agents_seen),
            ["GET /api/me/desk-knows-tokens/engines"]
        );
        assert_eq!(
            lines(&mut box_seen),
            [
                "GET /api/desk/knows/dw/allan/machines",
                "GET /api/desk/knows/dw/allan"
            ]
        );
        knows
            .sync(&io, &[machine("box")], "dw", "allan", None)
            .await;
        assert_eq!(
            lines(&mut box_seen),
            ["GET /api/desk/knows/dw/allan/machines"]
        );
    }

    #[tokio::test]
    async fn a_narrowed_rule_says_what_grew_and_the_persons_choice_is_passed_on() {
        let share = json!({ "everything": false, "transcripts": false, "machines": {} });
        let (mac, _mac_seen) = hub(vec![json_ok(share.clone()), json_ok(share)]).await;
        let (boxed, mut box_seen) = hub(vec![
            json_ok(json!({})),
            rule(&["session:s1"], false, 0),
            json_ok(json!({})),
            rule(&[], false, 3),
            // The person chose: deleted there.
            json_ok(json!({})),
            rule(&[], false, 3),
            rule(&[], false, 3),
            json_ok(json!({ "choice": "delete", "covered": 3 })),
            rule(&[], false, 0),
        ])
        .await;
        let io = io_for(vec![
            account("local", &mac, true, "MAC"),
            account("box", &boxed, true, "BOX"),
        ]);
        let knows = KnowsMachines::default();
        let told = knows
            .sync(&io, &[machine("box")], "dw", "allan", None)
            .await;
        assert!(told.grew);
        assert_eq!(told.held.items, 3);
        assert!(lines(&mut box_seen).contains(&"PUT /api/desk/knows/dw/allan".to_string()));
        let told = knows
            .sync(&io, &[machine("box")], "dw", "allan", Some(Choice::Delete))
            .await;
        assert_eq!(told, Told::default());
        let seen = lines(&mut box_seen);
        assert!(
            seen.contains(&"POST /api/desk/knows/dw/allan/held".to_string()),
            "{seen:?}"
        );
        assert!(!seen.contains(&"PUT /api/desk/knows/dw/allan".to_string()));
    }

    #[test]
    fn a_path_segment_is_never_dots_alone() {
        assert!(plain("allan") && plain("dw.example"));
        for bad in ["", ".", "..", "a/b", "a b"] {
            assert!(!plain(bad), "{bad}");
        }
    }

    fn share(everything: bool, machines: &[(&str, &[&str])]) -> Share {
        Share {
            everything,
            transcripts: false,
            machines: machines
                .iter()
                .map(|(m, ps)| (m.to_string(), ps.iter().map(|p| p.to_string()).collect()))
                .collect(),
        }
    }

    #[test]
    fn each_machine_is_given_everything_or_its_own_sessions_alone() {
        let s = share(false, &[("devbox", &["session:b", "session:a"])]);
        assert_eq!(places_for(&s, "devbox"), vec!["session:a", "session:b"]);
        assert!(places_for(&s, "laptop").is_empty());
        assert_eq!(places_for(&share(true, &[]), "laptop"), vec!["all"]);
    }

    #[test]
    fn the_rules_are_read_by_their_keys_and_a_bad_key_is_skipped() {
        let body = br#"{"rules":[{"agent":"dw/allan"},{"agent":"local/ledger"},{"places":[]}]}"#;
        let keys = keys_of(body);
        assert_eq!(keys, vec!["dw/allan", "local/ledger"]);
        assert_eq!(split_key("dw/allan"), Some(("dw", "allan")));
        assert_eq!(split_key("allan"), None);
        assert_eq!(split_key("/allan"), None);
        assert!(keys_of(b"nope").is_empty());
    }

    fn ending() -> (Ending, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        (Ending::at(&desk_core::Paths::at(dir.path())), dir)
    }

    #[tokio::test]
    async fn a_removed_machine_unlinks_and_every_hubs_tokens_for_it_end_and_an_unreached_hub_is_told_again()
     {
        let (boxed, mut box_seen) = hub(vec![status("204 No Content", "")]).await;
        let (dw, mut dw_seen) = hub(vec![
            status("503 Service Unavailable", "{}"),
            json_ok(json!({ "revoked": 2 })),
        ])
        .await;
        let (old, mut old_seen) = hub(vec![status("404 Not Found", "{}")]).await;
        let io = io_for(vec![
            account("local", "http://127.0.0.1:9", true, "MAC"),
            account("dw", &dw, false, "DW"),
            account("old", &old, false, "OLD"),
            account("box", &boxed, true, "BOX"),
        ]);
        let (ending, _dir) = ending();
        let hubs = vec!["dw".to_string(), "old".to_string()];
        ending.machine(&io, Some("box"), "box", &hubs).await;
        // The machine's own hub unlinks; each agent hub ends the tokens of
        // that engine; an older hub with no such route has none to end.
        assert_eq!(lines(&mut box_seen), ["DELETE /api/desk/knows-links"]);
        assert_eq!(
            lines(&mut dw_seen),
            ["DELETE /api/me/desk-knows-tokens/engines/box"]
        );
        assert_eq!(
            lines(&mut old_seen),
            ["DELETE /api/me/desk-knows-tokens/engines/box"]
        );
        // The one that couldn't be reached is owed, and told again.
        assert_eq!(
            ending.owed(),
            [Owed {
                hub: "dw".into(),
                engine: "box".into()
            }]
        );
        ending.retry(&io, Some(&hubs)).await;
        assert_eq!(
            lines(&mut dw_seen),
            ["DELETE /api/me/desk-knows-tokens/engines/box"]
        );
        assert!(ending.owed().is_empty());
    }

    #[tokio::test]
    async fn what_is_owed_to_a_hub_desk_is_no_longer_paired_with_is_dropped() {
        let (dw, mut seen) = hub(vec![status("500 Internal Server Error", "{}")]).await;
        let io = io_for(vec![
            account("local", "http://127.0.0.1:9", true, "MAC"),
            account("dw", &dw, false, "DW"),
        ]);
        let (ending, _dir) = ending();
        ending.machine(&io, None, "box", &["dw".to_string()]).await;
        assert_eq!(ending.owed().len(), 1);
        lines(&mut seen);
        ending.retry(&io, Some(&[])).await;
        assert!(ending.owed().is_empty());
        assert!(lines(&mut seen).is_empty());
        // An id that isn't plain, or a hub that isn't a workspace's, is
        // never asked.
        ending
            .machine(&io, None, "../x", &["dw".to_string(), "local".to_string()])
            .await;
        assert!(lines(&mut seen).is_empty());
    }

    #[tokio::test]
    async fn a_removed_hub_is_unlinked_on_this_computer_and_each_machine_and_its_tokens_end() {
        let (mac, mut mac_seen) = hub(vec![status("204 No Content", "")]).await;
        let (boxed, mut box_seen) = hub(vec![status("202 Accepted", "{}")]).await;
        let (dw, mut dw_seen) = hub(vec![
            json_ok(json!({ "revoked": 1 })),
            json_ok(json!({ "revoked": 1 })),
        ])
        .await;
        let io = io_for(vec![
            account("local", &mac, true, "MAC"),
            account("dw", &dw, false, "DW"),
            account("box", &boxed, true, "BOX"),
        ]);
        let (ending, _dir) = ending();
        ending
            .hub(
                &io,
                "dw",
                &["local".to_string(), "box".to_string()],
                &["local".to_string(), "box".to_string()],
            )
            .await;
        assert_eq!(lines(&mut mac_seen), ["DELETE /api/desk/knows-links/dw"]);
        assert_eq!(lines(&mut box_seen), ["DELETE /api/desk/knows-links/dw"]);
        assert_eq!(
            lines(&mut dw_seen),
            [
                "DELETE /api/me/desk-knows-tokens/engines/local",
                "DELETE /api/me/desk-knows-tokens/engines/box"
            ]
        );
        assert!(ending.owed().is_empty());
    }

    #[tokio::test]
    async fn what_is_owed_survives_an_unreadable_pairing_list_or_file() {
        let (dw, mut seen) = hub(vec![status("500 Internal Server Error", "{}")]).await;
        let io = io_for(vec![
            account("local", "http://127.0.0.1:9", true, "MAC"),
            account("dw", &dw, false, "DW"),
        ]);
        let (ending, _dir) = ending();
        ending.machine(&io, None, "box", &["dw".to_string()]).await;
        lines(&mut seen);
        // The pairing list couldn't be read: nothing is dropped or sent.
        ending.retry(&io, None).await;
        assert_eq!(ending.owed().len(), 1);
        assert!(lines(&mut seen).is_empty());
        // A file that can't be parsed is kept aside, not overwritten.
        std::fs::write(&ending.file, "{ not json").unwrap();
        assert!(ending.owed().is_empty());
        assert_eq!(
            std::fs::read_to_string(ending.file.with_extension("json.bad")).unwrap(),
            "{ not json"
        );
    }

    #[tokio::test]
    async fn a_hub_that_doesnt_know_this_computer_has_nothing_owed() {
        let (dw, _seen) = hub(vec![
            status("401 Unauthorized", "{}"),
            status("403 Forbidden", "{}"),
        ])
        .await;
        let io = io_for(vec![
            account("local", "http://127.0.0.1:9", true, "MAC"),
            account("dw", &dw, false, "DW"),
        ]);
        let (ending, _dir) = ending();
        ending.machine(&io, None, "box", &["dw".to_string()]).await;
        assert!(ending.owed().is_empty());
    }
}
