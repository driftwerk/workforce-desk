//! A group's boss on this computer's hub (Sarah, Acme's boss) and its
//! group's sessions on the person's machines (remote bosses §4.3): she
//! reaches them through the relay ([`crate::crew_relay`]), and each machine
//! decides her calls under its grant for the group, which names her
//! `local:<agent>`. This writes those grants, and only those.
//!
//! - **What each grant says comes from this computer's hub**
//!   (`GET /api/desk/machine-grants`, on [`crate::broker::routes`]'s
//!   native-only list): the boss's own level, switches and Sees there, and
//!   that machine's sessions of the group alone. Same rules, no wider
//!   powers. Nothing here adds to it; what can't be one of those grants is
//!   not carried ([`carried`]): a boss on another hub, folders,
//!   repositories, memory search, a resume, a field the hub doesn't send.
//! - **Asked natively once per group**, Cancel the default, before a boss
//!   first runs the group's machine sessions (the design's migration
//!   question): "Oversee this group" never said machines, and a boss made
//!   before this didn't reach them. A yes holds for the sessions the
//!   person puts in the group from then on, as at home; a no holds until a
//!   machine session the person wasn't asked about joins it. What is kept
//!   (`local_bosses.json`, private) is each group's answer, and nothing
//!   else.
//! - **Never a group bossed from another hub** ([`crate::bosses`]'s): not
//!   one Desk linked such a boss for, nor one whose grant on the machine
//!   names such a boss. One boss per group. Only grants naming a boss here
//!   (or none, while one is changing) are written or deleted, each with
//!   that group's changes held as [`crate::bosses`] holds them.
//! - **Narrowing first**, on every machine before anything widens: each
//!   grant no longer wanted (its boss taken off, its sessions moved out,
//!   the group deleted, or the person said no) is deleted, and each one
//!   that changes is first written as no more than both what it was and
//!   what it will be ([`meet`]). Then what is wanted is written. So a
//!   session moving between two groups is out of one before it is in the
//!   other, and a new boss is never written over the old one's.
//! - **Never resumed**: a grant a machine or Desk stopped stays stopped,
//!   and the engine's own pause stays; only the person lets them go on.
//! - **Kept alive** while Desk is open ([`keep_alive`]): the hub is read
//!   every [`POLL_EVERY`], and soon after the sidebar changes; each machine
//!   is written when what it should hold changed, and every [`KEEP_EVERY`]
//!   to renew what it holds (a grant is renewed past half its life).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::bosses::{self, Engine};

/// Where this computer's hub says what each machine should hold.
pub const WANTED_PATH: &str = "/api/desk/machine-grants";
/// What is kept of the person's answers, under Desk's own folder.
pub const KEPT_FILE: &str = "local_bosses.json";
/// The grant shape the engines read.
const GRANT_VERSION: u64 = 1;
/// How often the hub is read while Desk is open.
const POLL_EVERY: Duration = Duration::from_secs(30);
/// How often each machine is visited even when nothing changed.
const KEEP_EVERY: Duration = Duration::from_secs(30 * 60);
/// The least time between two runs, however often the sidebar changes.
const AT_MOST_EVERY: Duration = Duration::from_secs(5);

/// Wakes keeping alive before its time: the sidebar changed.
pub static WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();

// ── What the hub says ───────────────────────────────────────────────────

/// One grant a machine should hold, as the hub says it.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WantedGrant {
    pub group: String,
    pub agent: String,
    #[serde(default)]
    pub agent_name: String,
    pub grant: Value,
}

/// What one machine should hold, and its sessions the sidebar lists.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
pub struct MachineWanted {
    #[serde(default)]
    pub grants: Vec<WantedGrant>,
    #[serde(default)]
    pub listed: Vec<String>,
}

/// What every machine should hold, by machine id.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Wanted {
    pub grant_version: u64,
    #[serde(default)]
    pub machines: BTreeMap<String, MachineWanted>,
}

/// What a grant this carries may say, and nothing else.
const GRANT_KEYS: [&str; 10] = [
    "grantVersion",
    "name",
    "boss",
    "level",
    "sees",
    "recall",
    "folders",
    "repos",
    "members",
    "act",
];

/// Whether `g` is one of the grants Desk carries: for a group (never
/// Ungrouped), naming the hub's own agent `local:<agent>`, of the version
/// the engines read, with no folders, repositories or memory search, its
/// members sessions' ids, and no field but [`GRANT_KEYS`].
pub fn carried(g: &WantedGrant) -> bool {
    let v = &g.grant;
    let Some(o) = v.as_object() else {
        return false;
    };
    let empty = |k: &str| v[k].as_array().is_some_and(Vec::is_empty);
    bosses::group_id_ok(&g.group)
        && g.group != "ungrouped"
        && bosses::name_ok(&g.agent)
        && v["boss"].as_str() == Some(format!("local:{}", g.agent).as_str())
        && v["grantVersion"].as_u64() == Some(GRANT_VERSION)
        && o.keys().all(|k| GRANT_KEYS.contains(&k.as_str()))
        && v["name"].as_str().is_some_and(|n| !n.trim().is_empty())
        && level_rank(&v["level"]).is_some()
        && sees_rank(&v["sees"]).is_some()
        && v["recall"] == false
        && empty("folders")
        && empty("repos")
        && v["act"].is_object()
        && v["members"]
            .as_array()
            .is_some_and(|m| m.iter().all(|s| s.as_str().is_some_and(bosses::uuid_ok)))
}

fn level_rank(v: &Value) -> Option<u8> {
    Some(match v.as_str()? {
        "watch" => 0,
        "suggest" => 1,
        "act" => 2,
        "full" => 3,
        _ => return None,
    })
}

fn sees_rank(v: &Value) -> Option<u8> {
    Some(match v.as_str()? {
        "status" => 0,
        "replies" => 1,
        "everything" => 2,
        _ => return None,
    })
}

fn members_of(v: &Value) -> BTreeSet<String> {
    v["members"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

// ── What narrows ────────────────────────────────────────────────────────

/// A grant no more than both `held` (what the machine has) and `wanted`:
/// the lower level and Sees, the sessions both name, each switch on only
/// where both have it on, the smaller of each number (a budget only where
/// both give one), and no boss unless both name the same one. Written
/// before `wanted`, so nothing is ever more than either on the way.
pub fn meet(held: &Value, wanted: &Value) -> Value {
    let lower = |k: &str, rank: fn(&Value) -> Option<u8>| match (rank(&held[k]), rank(&wanted[k])) {
        (Some(h), Some(w)) if h <= w => held[k].clone(),
        (Some(_), Some(_)) => wanted[k].clone(),
        // One the machine has that can't be read is the least.
        _ => json!(if k == "level" { "watch" } else { "status" }),
    };
    let same_or_none = |k: &str| {
        if held[k] == wanted[k] {
            wanted[k].clone()
        } else {
            json!([])
        }
    };
    let members: Vec<String> = members_of(held)
        .intersection(&members_of(wanted))
        .cloned()
        .collect();
    let mut act = serde_json::Map::new();
    if let (Some(h), Some(w)) = (held["act"].as_object(), wanted["act"].as_object()) {
        for (k, wv) in w {
            match (h.get(k), wv) {
                (Some(Value::Bool(a)), Value::Bool(b)) => {
                    act.insert(k.clone(), Value::Bool(*a && *b));
                }
                (Some(hv), wv) if hv.is_number() && wv.is_number() => {
                    let (a, b) = (hv.as_f64().unwrap_or(0.0), wv.as_f64().unwrap_or(0.0));
                    act.insert(k.clone(), if a <= b { hv.clone() } else { wv.clone() });
                }
                _ => {}
            }
        }
    }
    json!({
        "grantVersion": GRANT_VERSION,
        "name": wanted["name"],
        "boss": if held["boss"] == wanted["boss"] { wanted["boss"].clone() } else { Value::Null },
        "level": lower("level", level_rank),
        "sees": lower("sees", sees_rank),
        "recall": held["recall"] == true && wanted["recall"] == true,
        "folders": same_or_none("folders"),
        "repos": same_or_none("repos"),
        "members": members,
        "act": act,
    })
}

/// Whether the machine's `held` grant says what `says` does, apart from
/// when it was written.
fn says_same(held: &Value, says: &Value) -> bool {
    held["grantVersion"].as_u64() == Some(GRANT_VERSION)
        && [
            "name", "boss", "level", "sees", "recall", "folders", "repos", "act",
        ]
        .iter()
        .all(|k| held[*k] == says[*k])
        && members_of(held) == members_of(says)
}

/// Whether a grant the machine holds is one this writes: its boss is one
/// on this computer's hub, or it names none (what a change of boss writes
/// first). A grant naming a boss on another hub never is.
fn ours(held: &Value) -> bool {
    match &held["boss"] {
        Value::Null => true,
        Value::String(b) => b.starts_with("local:"),
        _ => false,
    }
}

/// Whether `held` is past half its life at `now`, so renewed.
fn renewal_due(held: &Value, now: DateTime<Utc>) -> bool {
    let at = |k: &str| {
        held[k]
            .as_str()
            .and_then(|t| t.parse::<DateTime<Utc>>().ok())
    };
    match (at("issuedAt"), at("expiresAt")) {
        (Some(issued), Some(expires)) => expires - now < (expires - issued) / 2,
        _ => true,
    }
}

// ── What the person said ────────────────────────────────────────────────

/// The person's answer for one group's boss.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Said {
    pub agent: String,
    pub yes: bool,
    /// The machine sessions (`<machine>/<id>`) they were asked about.
    pub sessions: Vec<String>,
    pub at: DateTime<Utc>,
}

/// Every group's answer, by group id.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Kept {
    #[serde(default)]
    pub groups: BTreeMap<String, Said>,
}

/// One read-and-write of what is kept at a time.
static KEPT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn read_kept(path: &Path) -> Kept {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "what Desk keeps of its local bosses can't be read");
            Kept::default()
        }),
        Err(_) => Kept::default(),
    }
}

async fn keep_said(path: &Path, group: &str, said: Said) -> Result<(), String> {
    let _one = KEPT.lock().await;
    let mut kept = read_kept(path);
    kept.groups.insert(group.to_string(), said);
    let text = serde_json::to_string_pretty(&kept).map_err(|e| e.to_string())?;
    desk_core::write_private(path, &text).map_err(|e| format!("Desk couldn't keep the answer: {e}"))
}

/// Where a group's boss stands with the person.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Consent {
    Yes,
    No,
    Ask,
}

/// What `kept` says of `agent` running `sessions`, group `group`'s machine
/// sessions now: a yes for this boss holds; a no holds while it covers
/// every one of them; else the person is asked.
pub fn consent(kept: &Kept, group: &str, agent: &str, sessions: &BTreeSet<String>) -> Consent {
    match kept.groups.get(group) {
        Some(s) if s.agent == agent && s.yes => Consent::Yes,
        Some(s) if s.agent == agent && sessions.iter().all(|x| s.sessions.contains(x)) => {
            Consent::No
        }
        _ => Consent::Ask,
    }
}

/// Each group's machine sessions in `wanted`, by group: who would run
/// them, as the person knows them, their level and Sees, and the
/// sessions by machine.
#[derive(Debug, Clone, PartialEq)]
struct Asked {
    agent: String,
    agent_name: String,
    group_name: String,
    level: String,
    sessions: BTreeMap<String, BTreeSet<String>>,
}

fn by_group(wanted: &Wanted) -> BTreeMap<String, Asked> {
    let mut out: BTreeMap<String, Asked> = BTreeMap::new();
    for (m, mw) in &wanted.machines {
        for g in mw.grants.iter().filter(|g| carried(g)) {
            let a = out.entry(g.group.clone()).or_insert_with(|| Asked {
                agent: g.agent.clone(),
                agent_name: g.agent_name.clone(),
                group_name: g.grant["name"].as_str().unwrap_or(&g.group).to_string(),
                level: g.grant["level"].as_str().unwrap_or("watch").to_string(),
                sessions: BTreeMap::new(),
            });
            if a.agent != g.agent {
                continue;
            }
            a.sessions
                .entry(m.clone())
                .or_default()
                .extend(members_of(&g.grant));
        }
    }
    out
}

impl Asked {
    fn flat(&self) -> BTreeSet<String> {
        self.sessions
            .iter()
            .flat_map(|(m, s)| s.iter().map(move |id| format!("{m}/{id}")))
            .collect()
    }

    fn boss(&self) -> String {
        bosses::capital(if self.agent_name.trim().is_empty() {
            &self.agent
        } else {
            &self.agent_name
        })
    }
}

fn level_words(level: &str) -> &'static str {
    match level {
        "suggest" => "suggesting only",
        "act" => "acting within Desk",
        "full" => "at Act fully",
        _ => "watching only",
    }
}

/// The question that lets `a` run its group's machine sessions, from what
/// will be written alone.
fn question(a: &Asked, names: &BTreeMap<String, String>) -> (String, String, String) {
    let boss = a.boss();
    let n: usize = a.sessions.values().map(BTreeSet::len).sum();
    let wheres: Vec<String> = a
        .sessions
        .keys()
        .map(|m| bosses::quoted(names.get(m).map_or(m.as_str(), String::as_str)))
        .collect();
    let wheres: Vec<&str> = wheres.iter().map(String::as_str).collect();
    let sessions = if n == 1 { "session" } else { "sessions" };
    let body = format!(
        "{boss} oversees {} on this computer. Let {boss} run its {n} {sessions} on {} too, as {boss} runs its sessions here: {}, seeing everything, terminals included?\n\n{boss}'s calls reach them through Desk while this computer is awake and Desk is open, and each machine decides each one at no more than {boss}'s settings here. Stop overseeing ends it there too.",
        bosses::quoted(&a.group_name),
        bosses::and(&wheres),
        level_words(&a.level),
    );
    (
        format!("Let {boss} run machine sessions"),
        body,
        format!("Let {boss} Run Them"),
    )
}

/// Asks the person about the first group whose boss they haven't answered
/// for, and keeps the answer. Whether they said yes.
pub async fn ask_one(
    kept_at: &Path,
    wanted: &Wanted,
    names: &BTreeMap<String, String>,
    remote: &BTreeSet<String>,
    ask: impl bosses::Ask,
) -> Result<bool, String> {
    let kept = {
        let _one = KEPT.lock().await;
        read_kept(kept_at)
    };
    let Some((group, a)) = by_group(wanted).into_iter().find(|(g, a)| {
        !remote.contains(g) && consent(&kept, g, &a.agent, &a.flat()) == Consent::Ask
    }) else {
        return Ok(false);
    };
    let (title, body, yes) = question(&a, names);
    let said = ask(title, body, yes).await?;
    keep_said(
        kept_at,
        &group,
        Said {
            agent: a.agent.clone(),
            yes: said,
            sessions: a.flat().into_iter().collect(),
            at: Utc::now(),
        },
    )
    .await?;
    tracing::info!(group = %group, yes = said, "the person answered whether a local boss runs its machine sessions");
    Ok(said)
}

// ── Writing ─────────────────────────────────────────────────────────────

/// What a run did, for the log.
#[derive(Debug, Default, PartialEq)]
pub struct Synced {
    /// Whether anything was narrowed or deleted: a boss on another hub may
    /// now be written where it couldn't be.
    pub narrowed: bool,
    pub written: usize,
    pub failed: Vec<(String, String)>,
}

/// One step on one machine.
#[derive(Debug, Clone, PartialEq)]
enum Step {
    Delete,
    Write(Value),
}

/// Steps, each with its group.
type Steps = Vec<(String, Step)>;

/// The machine's grants: each by its group.
async fn held_on(engine: &impl Engine) -> Result<BTreeMap<String, Value>, String> {
    let a = engine.call("GET", "/api/desk/grants", None).await?;
    if !bosses::ok(a.status) {
        return Err(format!(
            "Desk on {} didn't say its grants: {}",
            engine.name(),
            bosses::said(a.status, a.body.as_bytes())
        ));
    }
    let v: Value = serde_json::from_str(&a.body)
        .map_err(|_| format!("Desk on {} didn't say its grants.", engine.name()))?;
    Ok(v["grants"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|g| Some((g["group"].as_str()?.to_string(), g.clone())))
        .collect())
}

/// Writes `says` as `group`'s grant on `engine`, once the machine's copy is
/// read again and is still one this writes: the same revision when it
/// says nothing new and is past half its life (a renewal), nothing when it
/// isn't, else one past what the machine has. Never a resume. Whether it
/// was written.
async fn write(
    engine: &impl Engine,
    group: &str,
    says: &Value,
    listed: &BTreeSet<String>,
) -> Result<bool, String> {
    for tries in 1..=2 {
        let (have, held) = bosses::revision_on(engine, group).await?;
        if !held.is_null() && !ours(&held) {
            return Ok(false);
        }
        let members = members_of(says);
        // Born there in the group, and listed elsewhere now: taken out.
        let leaving: Vec<String> = held["born"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|s| listed.contains(*s) && !members.contains(*s))
            .map(str::to_string)
            .collect();
        let same = !held.is_null() && leaving.is_empty() && says_same(&held, says);
        if same && !renewal_due(&held, Utc::now()) {
            return Ok(false);
        }
        let mut body = says.clone();
        body["revision"] = json!(if same { have } else { have + 1 });
        body["leaving"] = json!(leaving);
        let body = Zeroizing::new(body.to_string());
        let a = engine
            .call(
                "PUT",
                &format!("/api/desk/grants/{}", bosses::seg(group)),
                Some(&body),
            )
            .await?;
        if bosses::ok(a.status) {
            return Ok(true);
        }
        if a.status == 409 && tries < 2 {
            continue;
        }
        return Err(format!(
            "Desk on {} didn't take {group}'s grant: {}",
            engine.name(),
            bosses::said(a.status, a.body.as_bytes())
        ));
    }
    unreachable!("the loop returns")
}

/// Deletes `group`'s grant on `engine`, once the machine's copy is read
/// again and is still one this writes.
async fn delete(engine: &impl Engine, group: &str) -> Result<bool, String> {
    let (_, held) = bosses::revision_on(engine, group).await?;
    if held.is_null() || !ours(&held) {
        return Ok(false);
    }
    bosses::delete_grant(engine, group).await.map(|()| true)
}

/// The machine's steps, narrowing (`first`) and the rest: each grant this
/// writes that isn't wanted any more deleted; each that changes written
/// as no more than both first ([`meet`]); then what is wanted.
fn plan(
    held: &BTreeMap<String, Value>,
    wanted: &BTreeMap<String, Value>,
    remote: &BTreeSet<String>,
) -> (Steps, Steps) {
    let mut first = Vec::new();
    for (group, h) in held.iter().filter(|(_, h)| ours(h)) {
        match wanted.get(group) {
            Some(w) if !remote.contains(group) => {
                // What narrows is written now; what then widens, after.
                let m = meet(h, w);
                if !says_same(h, &m) {
                    first.push((group.clone(), Step::Write(m)));
                }
            }
            _ => first.push((group.clone(), Step::Delete)),
        }
    }
    let then = wanted
        .iter()
        .filter(|(g, _)| !remote.contains(*g))
        .filter(|(g, _)| held.get(*g).is_none_or(ours))
        .map(|(g, w)| (g.clone(), Step::Write(w.clone())))
        .collect();
    (first, then)
}

/// Does `steps` on `engine`, each with its group's changes held as
/// [`crate::bosses`] holds them, and a group Desk linked a boss on another
/// hub for left alone (it is only ever narrowed: its grant deleted).
async fn run(
    bosses_at: &Path,
    engine: &impl Engine,
    steps: &[(String, Step)],
    listed: &BTreeSet<String>,
    out: &mut Synced,
    narrowing: bool,
) {
    for (group, step) in steps {
        let ops = bosses::ops_of(bosses_at, group);
        // A change to the group under way: next time.
        let Ok(_op) = ops.try_lock() else {
            continue;
        };
        let remote = bosses::load(bosses_at).await.groups.contains_key(group);
        let done = match step {
            Step::Delete => delete(engine, group).await,
            Step::Write(_) if remote => delete(engine, group).await,
            Step::Write(says) => write(engine, group, says, listed).await,
        };
        match done {
            Ok(true) => {
                out.written += 1;
                out.narrowed |= narrowing || matches!(step, Step::Delete) || remote;
            }
            Ok(false) => {}
            Err(why) => out.failed.push((engine.name().to_string(), why)),
        }
    }
}

/// Brings every machine's grants for this computer's group bosses to what
/// `wanted` says, as far as the person said yes: narrowing on every
/// machine first, then the rest (see the module).
pub async fn sync<E: Engine>(
    bosses_at: &Path,
    kept_at: &Path,
    wanted: &Wanted,
    machines: &[(String, Result<E, String>)],
) -> Synced {
    let mut out = Synced::default();
    let remote: BTreeSet<String> = bosses::load(bosses_at).await.groups.into_keys().collect();
    let kept = {
        let _one = KEPT.lock().await;
        read_kept(kept_at)
    };
    let groups = by_group(wanted);
    let mut plans = Vec::new();
    for (id, engine) in machines {
        let engine = match engine {
            Ok(e) => e,
            Err(why) => {
                out.failed.push((id.clone(), why.clone()));
                continue;
            }
        };
        let held = match held_on(engine).await {
            Ok(h) => h,
            Err(why) => {
                out.failed.push((engine.name().to_string(), why));
                continue;
            }
        };
        let mw = wanted.machines.get(id);
        let desired: BTreeMap<String, Value> = mw
            .into_iter()
            .flat_map(|m| m.grants.iter())
            .filter(|g| carried(g))
            .filter(|g| {
                groups.get(&g.group).is_some_and(|a| {
                    a.agent == g.agent
                        && consent(&kept, &g.group, &a.agent, &a.flat()) == Consent::Yes
                })
            })
            .map(|g| (g.group.clone(), g.grant.clone()))
            .collect();
        let listed: BTreeSet<String> = mw
            .map(|m| m.listed.iter().cloned().collect())
            .unwrap_or_default();
        let (first, then) = plan(&held, &desired, &remote);
        plans.push((engine, listed, first, then));
    }
    for (engine, listed, first, _) in &plans {
        run(bosses_at, *engine, first, listed, &mut out, true).await;
    }
    for (engine, listed, _, then) in &plans {
        run(bosses_at, *engine, then, listed, &mut out, false).await;
    }
    out
}

// ── The native side's wiring ────────────────────────────────────────────

fn kept_path() -> Result<std::path::PathBuf, String> {
    desk_core::Paths::new()
        .map(|p| p.root.join(KEPT_FILE))
        .map_err(|e| e.to_string())
}

/// What this computer's hub says each machine should hold; none when it
/// can't say (an older hub, or not reached): then nothing is written.
async fn read_wanted(local: &crate::broker::Broker) -> Option<Wanted> {
    let a = local.fetch_native("GET", WANTED_PATH).await.ok()?;
    if !bosses::ok(a.status) {
        return None;
    }
    let w: Wanted = serde_json::from_str(&a.body).ok()?;
    (w.grant_version == GRANT_VERSION).then_some(w)
}

/// What was last brought to the machines, and when every machine was last
/// visited.
static LAST: Mutex<Option<(String, Instant)>> = Mutex::new(None);

/// One run: the hub read; each machine visited when what it should hold
/// changed, when woken, or every [`KEEP_EVERY`]; then the person asked
/// about one group they haven't answered for.
async fn once(app: &tauri::AppHandle, woken: bool) {
    use tauri::Manager;
    let local = app.state::<crate::broker::Broker>();
    let machines = app.state::<crate::machines::MachineIo>();
    let Some(wanted) = read_wanted(&local).await else {
        return;
    };
    let (Ok(kept_at), Ok(bosses_at)) = (kept_path(), bosses::kept_path()) else {
        return;
    };
    let ids = machines.ids();
    let remote: BTreeSet<String> = bosses::load(&bosses_at).await.groups.into_keys().collect();
    let kept = {
        let _one = KEPT.lock().await;
        read_kept(&kept_at)
    };
    let now = format!(
        "{}\n{:?}\n{:?}\n{:?}",
        serde_json::to_string(&wanted).unwrap_or_default(),
        remote,
        kept,
        ids
    );
    let due = {
        let last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        woken
            || last
                .as_ref()
                .is_none_or(|(was, at)| *was != now || at.elapsed() >= KEEP_EVERY)
    };
    let engines = bosses::engines_now(&local, &machines, &ids);
    if due {
        let synced = sync(&bosses_at, &kept_at, &wanted, &engines.machines).await;
        if synced.narrowed {
            // A boss on another hub refused before may fit now.
            bosses::WAKE.notify_one();
        }
        for (machine, why) in &synced.failed {
            tracing::warn!(machine = %machine, why = %why, "a local boss's machine grant wasn't brought up to date; trying again");
        }
        let all_done = synced.failed.is_empty();
        *LAST.lock().unwrap_or_else(|e| e.into_inner()) = all_done.then(|| (now, Instant::now()));
    }
    let names: BTreeMap<String, String> = engines
        .machines
        .iter()
        .filter_map(|(id, e)| Some((id.clone(), e.as_ref().ok()?.name().to_string())))
        .collect();
    match ask_one(
        &kept_at,
        &wanted,
        &names,
        &remote,
        bosses::native_ask(app.clone()),
    )
    .await
    {
        Ok(true) => {
            sync(&bosses_at, &kept_at, &wanted, &engines.machines).await;
            *LAST.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
        Ok(false) => {}
        // Another question is open, or one was cancelled lately: later.
        Err(why) => tracing::debug!(why = %why, "a local boss's question waits"),
    }
}

/// Keeps every machine's grants for this computer's group bosses up to
/// date while Desk is open: a minute after it starts, then every
/// [`POLL_EVERY`], and soon after the sidebar changes.
pub fn keep_alive(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Once Desk Helper has had time to start this computer's hub.
        tokio::time::sleep(Duration::from_secs(60)).await;
        let mut woken = false;
        loop {
            once(&app, woken).await;
            woken = tokio::select! {
                () = tokio::time::sleep(POLL_EVERY) => false,
                () = WAKE.notified() => true,
            };
            tokio::time::sleep(AT_MOST_EVERY).await;
        }
    });
}

#[cfg(test)]
mod tests;
