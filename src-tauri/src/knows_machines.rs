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

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
    outside: u64,
}

/// What machine sharing remembers in this run of Desk.
#[derive(Default)]
pub struct KnowsMachines {
    /// The agents each machine was linked with: (machine hub, rule key).
    /// Linked again in each run, which replaces the machine's old token.
    linked: Mutex<HashSet<(String, String)>>,
    /// One pass at a time, so a rule changed twice isn't told out of order.
    pass: tokio::sync::Mutex<()>,
}

impl KnowsMachines {
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
    ) {
        let plain = |s: &str| {
            (1..=64).contains(&s.len())
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        };
        if !plain(hub)
            || !plain(agent)
            || hub == LOCAL
            || crate::hubs::machine_of(hub).is_some()
            || machines.is_empty()
        {
            return;
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
            Ok(None) => return,
            Err(e) => {
                tracing::debug!(%hub, %agent, error = %e, "this computer's hub didn't say what machines share");
                return;
            }
        };
        for m in machines {
            if let Err(e) = self.tell(io, m, hub, agent, &share, choice).await {
                tracing::warn!(machine = %m.name, %hub, %agent, error = %e, "a machine wasn't told what an agent sees");
            }
        }
    }

    async fn tell(
        &self,
        io: &HubIo,
        m: &Machine,
        hub: &str,
        agent: &str,
        share: &Share,
        choice: Option<Choice>,
    ) -> Result<(), String> {
        let places = places_for(share, &m.id);
        let path = format!("/api/desk/knows/{hub}/{agent}");
        // A machine on an older Desk has no rules: nothing to tell it.
        let Some(held) = rule_of(io, &m.hub, &path).await? else {
            return Ok(());
        };
        let key = (m.hub.clone(), format!("{hub}/{agent}"));
        if places.is_empty() && held.places.is_empty() && held.outside == 0 {
            return Ok(());
        }
        if !places.is_empty() && !self.linked.lock().expect("linked").contains(&key) {
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
                    self.linked.lock().expect("linked").insert(key);
                }
                KnowsLinked::Local { .. } => return Ok(()),
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
        if let Some(choice) = choice {
            // Asked again: the PUT may have narrowed it just now.
            let now = rule_of(io, &m.hub, &path).await?.unwrap_or_default();
            if now.outside > 0 {
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
            }
        }
        Ok(())
    }
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
    Ok(Some(Held {
        places,
        transcripts: v["rule"]["transcripts"].as_bool().unwrap_or(false),
        outside: v["heldOutside"]["items"].as_u64().unwrap_or(0),
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
) -> CommandResult<()> {
    let machines = Arc::clone(&machines);
    let list = tauri::async_runtime::spawn_blocking(move || machines_of(&machines))
        .await
        .map_err(|e| e.to_string())?;
    knows.sync(&io, &list, &hub, &agent, choice).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
