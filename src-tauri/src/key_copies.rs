//! Settings → Connections setting up the person's own connections from a
//! hub they're paired with ("Patchwork has 4 of your connections. Set them
//! up here").
//!
//! The page lists them itself (`GET /api/me/desk-key-copies`: names and
//! sites, never a value). Taking them is the native side's alone: the
//! paired hub's `POST /api/me/desk-key-copies/take` is never the page's
//! (`hub_io::page_refused`), and [`key_copies_take`] hands each
//! connection's fields straight to this computer's hub, which checks it
//! with its service's own test call and keeps it in Desk's vault, or keeps
//! nothing. No value reaches the page, a log, an error or a file here.
//!
//! A pick names the tier it is kept in there: the person's personal one
//! (no `agent`), or theirs through an agent (`agent`), and is matched to the
//! hub's answer by both, so two of one service and key in two tiers never
//! cross.
//!
//! What was copied from where is kept in `key-copies.json` (no values), so
//! that a key changed there later is offered as newer, never written over
//! silently, and only over the connection it was copied into.

use std::collections::BTreeMap;

use desk_core::Paths;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::CommandResult;
use crate::hub_io::{HubIo, words_of};

/// The paired hub's route that answers the values.
pub const TAKE_PATH: &str = "/api/me/desk-key-copies/take";
/// The most connections one press copies, as the hub takes them.
pub const MAX_PICKS: usize = 12;

/// One connection to copy: its service and its key on the paired hub, and
/// for a newer key the connection here it was copied into before.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Pick {
    pub connector: String,
    pub key: String,
    /// The agent it is kept through there; none: the personal tier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub into: Option<String>,
}

/// What became of one pick.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Copied {
    /// Checked and kept here, as `connection`.
    #[serde(rename_all = "camelCase")]
    Saved {
        connector: String,
        key: String,
        agent: Option<String>,
        connection: String,
        name: String,
        account: Option<String>,
    },
    /// Not kept: the check's or the hub's words.
    #[serde(rename_all = "camelCase")]
    Failed {
        connector: String,
        key: String,
        agent: Option<String>,
        error: String,
    },
    /// The paired hub holds it no more.
    #[serde(rename_all = "camelCase")]
    Missing {
        connector: String,
        key: String,
        agent: Option<String>,
    },
}

/// What a press did.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Taken {
    Done {
        results: Vec<Copied>,
    },
    /// The paired hub refused (its admin turned copying off, too often, an
    /// older hub): its words.
    NotAllowed {
        status: u16,
        error: String,
    },
}

/// A connection copied here from a paired hub. No value.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub hub: String,
    pub connector: String,
    pub remote_key: String,
    /// The agent it was copied through there; none: the personal tier (and
    /// every record from before tiers were said).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// The connection's id on this computer's hub.
    pub connection: String,
    /// When the copied key last changed there, as it said.
    pub updated_at: Option<String>,
    /// When this computer's hub kept the copy. A connection kept again
    /// since (by hand, or removed and made anew with the same id) is no
    /// longer the copy, and a newer key never goes over it.
    #[serde(default)]
    pub connected_at: Option<String>,
}

fn file(paths: &Paths) -> std::path::PathBuf {
    paths.root.join("key-copies.json")
}

pub fn read(paths: &Paths) -> Vec<Record> {
    std::fs::read_to_string(file(paths))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write(paths: &Paths, records: &[Record]) -> Result<(), String> {
    let body = serde_json::to_string_pretty(records).map_err(|e| e.to_string())?;
    desk_core::write_private(&file(paths), &body).map_err(|e| e.to_string())
}

/// `records` with `r` in place of the one copied from the same place.
fn upsert(records: &mut Vec<Record>, r: Record) {
    records.retain(|x| {
        !(x.hub == r.hub
            && x.connector == r.connector
            && x.remote_key == r.remote_key
            && x.agent == r.agent)
    });
    records.push(r);
}

/// A connector, key or connection id as hubs make them.
fn plain_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 120
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '~'))
}

/// Why `picks` can't be copied, if they can't.
fn refuse_picks(picks: &[Pick]) -> Option<String> {
    if picks.is_empty() || picks.len() > MAX_PICKS {
        return Some(format!("Pick between 1 and {MAX_PICKS} connections."));
    }
    picks
        .iter()
        .any(|p| {
            !plain_id(&p.connector)
                || !plain_id(&p.key)
                || p.agent.as_deref().is_some_and(|a| !plain_id(a))
                || p.into.as_deref().is_some_and(|i| !plain_id(i))
        })
        .then(|| "That isn't a connection Desk can copy.".to_string())
}

/// `text` with every value of `fields` long enough to be one taken out.
fn scrub(text: &str, fields: &BTreeMap<String, Zeroizing<String>>) -> String {
    fields
        .values()
        .filter(|v| v.len() >= 4)
        .fold(text.to_string(), |t, v| t.replace(v.as_str(), "[secret]"))
}

/// One connection as the paired hub answered it.
struct Copy {
    connector: String,
    key: String,
    agent: Option<String>,
    name: String,
    service: String,
    updated_at: Option<String>,
    fields: BTreeMap<String, Zeroizing<String>>,
}

/// The connections a paired hub no longer holds: (connector, key, agent).
type Missing = Vec<(String, String, Option<String>)>;

/// The copies and the missing in the paired hub's answer, its values held
/// in memory that is cleared when dropped.
fn copies_of(body: &[u8]) -> Option<(Vec<Copy>, Missing)> {
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    let s = |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    let copies = v
        .get("copies")?
        .as_array()?
        .iter()
        .filter_map(|c| {
            Some(Copy {
                connector: s(c, "connector")?,
                key: s(c, "key")?,
                agent: s(c, "agent"),
                name: s(c, "name").unwrap_or_default(),
                service: s(c, "service").unwrap_or_default(),
                updated_at: s(c, "updatedAt"),
                fields: c
                    .get("fields")?
                    .as_object()?
                    .iter()
                    .filter_map(|(k, v)| Some((k.clone(), Zeroizing::new(v.as_str()?.to_string()))))
                    .collect(),
            })
        })
        .collect();
    let missing = v
        .get("missing")
        .and_then(|m| m.as_array())
        .map(|m| {
            m.iter()
                .filter_map(|p| Some((s(p, "connector")?, s(p, "key")?, s(p, "agent"))))
                .collect()
        })
        .unwrap_or_default();
    Some((copies, missing))
}

/// The body this computer's hub is asked to keep `copy` with: for all the
/// person's agents, said to be copied from `from`.
fn keep_body(copy: &Copy, from: &str, new: bool) -> Zeroizing<Vec<u8>> {
    let fields: BTreeMap<&str, &str> = copy
        .fields
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    // A connection named only by its service is named here by its account
    // or site, as connecting by hand names it.
    let name =
        (new && !copy.name.is_empty() && copy.name != copy.service).then_some(copy.name.as_str());
    let body = if new {
        serde_json::json!({ "name": name, "level": "all", "fields": fields, "copied_from": from })
    } else {
        serde_json::json!({ "fields": fields, "copied_from": from })
    };
    Zeroizing::new(serde_json::to_vec(&body).expect("JSON"))
}

/// When each connection on this computer's hub `local` was kept, by
/// connector and id: names and times only, never a value.
async fn kept_here(
    io: &HubIo,
    local: &str,
) -> Result<BTreeMap<(String, String), Option<String>>, String> {
    let (meta, body) = io
        .fetch(local, "GET", "/api/desk/connections", None)
        .await?;
    if !(200..300).contains(&meta.status) {
        return Err(format!("This computer's hub answered {}.", meta.status));
    }
    Ok(connected_times(&body))
}

fn connected_times(body: &[u8]) -> BTreeMap<(String, String), Option<String>> {
    let v: serde_json::Value = serde_json::from_slice(body).unwrap_or_default();
    let mut out = BTreeMap::new();
    for c in v["connectors"].as_array().into_iter().flatten() {
        let Some(connector) = c["id"].as_str() else {
            continue;
        };
        for k in c["connections"].as_array().into_iter().flatten() {
            if let Some(id) = k["id"].as_str() {
                out.insert(
                    (connector.to_string(), id.to_string()),
                    k["connectedAt"].as_str().map(str::to_string),
                );
            }
        }
    }
    out
}

/// Copies `picks` from paired hub `remote` into this computer's hub
/// `local`, recording each in `paths`.
pub async fn take(
    io: &HubIo,
    paths: &Paths,
    remote: &str,
    local: &str,
    picks: Vec<Pick>,
) -> Result<Taken, String> {
    if let Some(why) = refuse_picks(&picks) {
        return Err(why);
    }
    let from = io.remote_label(remote).await?;
    let mut records = read(paths);
    // A newer key goes only over the connection it was copied into, and
    // only while that is still the copy, unchanged here since.
    if picks.iter().any(|p| p.into.is_some()) {
        let here = kept_here(io, local).await?;
        for p in picks.iter().filter(|p| p.into.is_some()) {
            let still = records.iter().any(|r| {
                r.hub == remote
                    && r.connector == p.connector
                    && r.remote_key == p.key
                    && r.agent == p.agent
                    && Some(&r.connection) == p.into.as_ref()
                    && r.connected_at.is_some()
                    && here.get(&(r.connector.clone(), r.connection.clone()))
                        == Some(&r.connected_at)
            });
            if !still {
                return Err(format!(
                    "Desk only updates a connection it copied from {from}, unchanged here since."
                ));
            }
        }
    }
    let ask: Vec<serde_json::Value> = picks
        .iter()
        .map(|p| match &p.agent {
            Some(agent) => {
                serde_json::json!({ "connector": p.connector, "key": p.key, "agent": agent })
            }
            None => serde_json::json!({ "connector": p.connector, "key": p.key }),
        })
        .collect();
    let ask = serde_json::to_vec(&serde_json::json!({ "connections": ask }))
        .map_err(|e| e.to_string())?;
    let (meta, body) = io
        .fetch(
            remote,
            "POST",
            TAKE_PATH,
            Some(("application/json".into(), ask)),
        )
        .await?;
    let body = Zeroizing::new(body);
    if !(200..300).contains(&meta.status) {
        return Ok(Taken::NotAllowed {
            status: meta.status,
            error: words_of(&body)
                .unwrap_or_else(|| format!("{from} didn't hand over your keys ({}).", meta.status)),
        });
    }
    let Some((copies, missing)) = copies_of(&body) else {
        return Ok(Taken::NotAllowed {
            status: meta.status,
            error: format!("{from} answered in a way Desk can't read."),
        });
    };
    drop(body);
    let mut results = Vec::new();
    for copy in copies {
        // Its own tier's pick alone: an older hub, which says no agent,
        // answers only the personal ones.
        let Some(pick) = picks
            .iter()
            .find(|p| p.connector == copy.connector && p.key == copy.key && p.agent == copy.agent)
        else {
            continue;
        };
        let (path, new) = match &pick.into {
            Some(into) => (
                format!("/api/desk/connections/{}/{}", copy.connector, into),
                false,
            ),
            None => (format!("/api/desk/connections/{}", copy.connector), true),
        };
        let kept = io
            .fetch(
                local,
                "POST",
                &path,
                Some((
                    "application/json".into(),
                    keep_body(&copy, &from, new).to_vec(),
                )),
            )
            .await;
        let failed = |error: String| Copied::Failed {
            connector: copy.connector.clone(),
            key: copy.key.clone(),
            agent: copy.agent.clone(),
            error: scrub(&error, &copy.fields),
        };
        let result = match kept {
            Ok((meta, answer)) if (200..300).contains(&meta.status) => {
                let c = serde_json::from_slice::<serde_json::Value>(&answer)
                    .ok()
                    .and_then(|v| v.get("connection").cloned());
                let s = |k: &str| {
                    c.as_ref()
                        .and_then(|c| c.get(k)?.as_str())
                        .map(str::to_string)
                };
                match s("id") {
                    Some(connection) => {
                        upsert(
                            &mut records,
                            Record {
                                hub: remote.to_string(),
                                connector: copy.connector.clone(),
                                remote_key: copy.key.clone(),
                                agent: copy.agent.clone(),
                                connection: connection.clone(),
                                updated_at: copy.updated_at.clone(),
                                connected_at: s("connectedAt"),
                            },
                        );
                        Copied::Saved {
                            connector: copy.connector.clone(),
                            key: copy.key.clone(),
                            agent: copy.agent.clone(),
                            connection,
                            name: s("name").unwrap_or_else(|| copy.name.clone()),
                            account: s("account"),
                        }
                    }
                    None => failed("This computer's hub kept it but didn't say as what.".into()),
                }
            }
            Ok((meta, answer)) => failed(
                words_of(&answer)
                    .unwrap_or_else(|| format!("This computer's hub answered {}.", meta.status)),
            ),
            Err(e) => failed(e),
        };
        results.push(result);
    }
    for (connector, key, agent) in missing {
        results.push(Copied::Missing {
            connector,
            key,
            agent,
        });
    }
    let saved = results
        .iter()
        .filter(|r| matches!(r, Copied::Saved { .. }))
        .count();
    tracing::info!(hub = %remote, saved, of = picks.len(), "connections copied from a paired hub");
    // What was saved stays saved; only a later "newer key" offer needs the
    // record, so a record that couldn't be written is said in the log.
    if saved > 0
        && let Err(e) = write(paths, &records)
    {
        tracing::warn!(error = %e, "copied connections' record wasn't written");
    }
    Ok(Taken::Done { results })
}

/// Copies `picks` from paired hub `remote` into Desk's vault on this
/// computer ([`take`]). Settings → Connections, in the main window only.
#[tauri::command]
pub async fn key_copies_take(
    app: tauri::State<'_, crate::App>,
    io: tauri::State<'_, HubIo>,
    remote: String,
    picks: Vec<Pick>,
) -> CommandResult<Taken> {
    take(&io, &app.paths, &remote, desk_core::LOCAL_HUB_ID, picks).await
}

/// What was copied here from paired hub `remote`: no values.
#[tauri::command]
pub fn key_copies_kept(
    app: tauri::State<'_, crate::App>,
    remote: String,
) -> CommandResult<Vec<Record>> {
    Ok(read(&app.paths)
        .into_iter()
        .filter(|r| r.hub == remote)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pick(connector: &str, key: &str) -> Pick {
        Pick {
            connector: connector.into(),
            key: key.into(),
            agent: None,
            into: None,
        }
    }

    #[test]
    fn only_plain_picks_of_a_few_are_taken() {
        assert!(refuse_picks(&[pick("jira", "default")]).is_none());
        assert!(refuse_picks(&[]).is_some());
        assert!(refuse_picks(&vec![pick("jira", "default"); MAX_PICKS + 1]).is_some());
        for bad in ["../x", "a/b", "", "a b", "a?b", ".", "a.b"] {
            assert!(refuse_picks(&[pick("jira", bad)]).is_some(), "{bad}");
            assert!(refuse_picks(&[pick(bad, "default")]).is_some(), "{bad}");
        }
        let mut into = pick("jira", "default");
        into.into = Some("all/x".into());
        assert!(refuse_picks(&[into.clone()]).is_some());
        // A connection's id here, as this computer's hub makes it.
        into.into = Some("all~~acme".into());
        assert!(refuse_picks(&[into]).is_none());
    }

    #[test]
    fn a_hubs_answer_is_read_and_a_value_never_stays_in_an_error() {
        let body = br#"{"copies":[{"connector":"jira","service":"Jira","key":"default","name":"Jira","updatedAt":"2026-11-01T00:00:00Z","fields":{"api_token":"not-a-real-value","site":"acme.atlassian.net"}}],"missing":[{"connector":"github","key":"acme"}]}"#;
        let (copies, missing) = copies_of(body).unwrap();
        assert_eq!(copies.len(), 1);
        assert_eq!(missing, [("github".to_string(), "acme".to_string(), None)]);
        let said = scrub("Jira said not-a-real-value is wrong", &copies[0].fields);
        assert_eq!(said, "Jira said [secret] is wrong");
        // A connection named only by its service is named here as by hand.
        let body: serde_json::Value =
            serde_json::from_slice(&keep_body(&copies[0], "Patchwork", true)).unwrap();
        assert_eq!(body["name"], serde_json::Value::Null);
        assert_eq!(body["level"], "all");
        assert_eq!(body["copied_from"], "Patchwork");
        assert_eq!(body["fields"]["api_token"], "not-a-real-value");
        let again: serde_json::Value =
            serde_json::from_slice(&keep_body(&copies[0], "Patchwork", false)).unwrap();
        assert!(again.get("level").is_none());
    }

    #[test]
    fn a_record_is_kept_once_per_place_it_came_from() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths {
            root: dir.path().into(),
        };
        assert!(read(&paths).is_empty());
        let r = |connection: &str| Record {
            hub: "patchwork".into(),
            connector: "jira".into(),
            remote_key: "default".into(),
            agent: None,
            connection: connection.into(),
            updated_at: None,
            connected_at: Some("2026-11-01T00:00:00Z".into()),
        };
        let mut records = vec![r("all:default")];
        upsert(&mut records, r("all:acme"));
        assert_eq!(records, [r("all:acme")]);
        write(&paths, &records).unwrap();
        assert_eq!(read(&paths), records);
        let text = std::fs::read_to_string(file(&paths)).unwrap();
        assert!(!text.contains("token"));
    }

    #[test]
    fn when_each_connection_here_was_kept_is_read_by_connector_and_id() {
        let body = br#"{"connectors":[{"id":"jira","connections":[{"id":"all~~default","connectedAt":"2026-11-01T00:00:00Z"},{"id":"all~~old","connectedAt":null}]},{"id":"github","connections":[]}]}"#;
        let times = connected_times(body);
        assert_eq!(times.len(), 2);
        assert_eq!(
            times[&("jira".to_string(), "all~~default".to_string())].as_deref(),
            Some("2026-11-01T00:00:00Z")
        );
        assert_eq!(times[&("jira".to_string(), "all~~old".to_string())], None);
        assert!(connected_times(b"not json").is_empty());
    }

    #[test]
    fn a_pick_through_an_agent_is_its_own_and_its_agent_a_plain_id() {
        let mut through = pick("linear", "default");
        through.agent = Some("allan".into());
        assert!(refuse_picks(&[through.clone(), pick("linear", "default")]).is_none());
        for bad in ["../x", "a/b", "", "a b"] {
            through.agent = Some(bad.into());
            assert!(refuse_picks(&[through.clone()]).is_some(), "{bad}");
        }
        let body = br#"{"copies":[{"connector":"linear","key":"default","agent":"allan","fields":{"api_key":"not-a-real-value"}},{"connector":"linear","key":"default","fields":{"api_key":"not-a-real-value-2"}}],"missing":[{"connector":"jira","key":"acme","agent":"allan"}]}"#;
        let (copies, missing) = copies_of(body).unwrap();
        assert_eq!(copies[0].agent.as_deref(), Some("allan"));
        assert_eq!(copies[1].agent, None);
        assert_eq!(
            missing,
            [(
                "jira".to_string(),
                "acme".to_string(),
                Some("allan".to_string())
            )]
        );
    }

    #[test]
    fn a_record_through_an_agent_is_kept_beside_the_personal_one() {
        let r = |agent: Option<&str>, connection: &str| Record {
            hub: "driftwerk".into(),
            connector: "linear".into(),
            remote_key: "default".into(),
            agent: agent.map(str::to_string),
            connection: connection.into(),
            updated_at: None,
            connected_at: None,
        };
        let mut records = vec![r(None, "all~~default")];
        upsert(&mut records, r(Some("allan"), "all~~driftwerk"));
        assert_eq!(records.len(), 2);
        upsert(&mut records, r(Some("allan"), "all~~again"));
        assert_eq!(
            records,
            [r(None, "all~~default"), r(Some("allan"), "all~~again")]
        );
        // A record from before tiers were said is the personal one's.
        let old: Vec<Record> = serde_json::from_str(
            r#"[{"hub":"driftwerk","connector":"linear","remoteKey":"default","connection":"all~~default","updatedAt":null}]"#,
        )
        .unwrap();
        assert_eq!(old[0].agent, None);
        assert!(!serde_json::to_string(&old[0]).unwrap().contains("agent"));
    }
}
