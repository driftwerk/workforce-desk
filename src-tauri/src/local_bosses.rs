//! A group's boss on this computer's hub (Sarah, Acme's boss) and its
//! group's sessions on the person's machines (remote bosses §4.3): she
//! reaches them through the relay ([`crate::crew_relay`]), and each machine
//! decides her calls under its grant for the group, which names her
//! `local:<agent>`. This writes those grants, and only those.
//!
//! - **What each grant says comes from this computer's hub**
//!   ([`WANTED_PATH`], on [`crate::broker::routes`]'s native-only list,
//!   asking for its plans' grants too, which an older Desk isn't sent): the boss's own level, switches and Sees there, and
//!   that machine's sessions of the group alone. Same rules, no wider
//!   powers. Nothing here adds to it; what can't be one of those grants is
//!   not carried ([`carried`]): a boss on another hub, folders,
//!   repositories, memory search, a resume, a field the hub doesn't send.
//!   Act fully is carried only with its daily budget ([`capped`]); the hub
//!   counts that budget once across this computer and every machine, and
//!   each machine acts fully only while the hub says so, every second.
//! - **Asked natively once per group**, Cancel the default, before a boss
//!   first runs the group's machine sessions (the design's migration
//!   question): "Oversee this group" never said machines, and a boss made
//!   before this didn't reach them. A yes holds for the sessions the
//!   person puts in the group from then on, as at home, up to the level it
//!   was asked at: a higher one asks again. A no holds until a machine
//!   session the person wasn't asked about joins the group, or the boss's
//!   level or switches change at home. An agent made again with the same
//!   id is another boss, and is asked again. What is kept
//!   (`local_bosses.json`, private) is each group's answer, and nothing
//!   else.
//! - **A plan's grant is never asked about**: the hub's main overseer runs
//!   no group, so each of its running plans has a grant of its own on each
//!   machine its tickets work on (`plan-<plan>`, marked as that plan's),
//!   from before the first of them starts there, which starts in it run by
//!   that boss ([`crate::crew_relay`]). The person approved the plan, which
//!   said where each ticket runs, so it is written as the hub says it,
//!   capped as any grant is (Act fully with its one budget), and nothing of
//!   it is kept; a stop Desk made of one is never lifted from here.
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
//! - **A stop is lifted only by the person's yes**: one Desk made before
//!   their yes for the group goes with the first write after it; one made
//!   on the machine itself (`desk-helper bosses stop`) never does, and is
//!   said in the log. The engine's own pause is never touched.
//! - **A day at a time**: each grant is written to last 24 hours (or the
//!   machine's own most, when less), so one left behind while Desk was
//!   closed soon ends by itself.
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
pub const WANTED_PATH: &str = "/api/desk/machine-grants?plans=1";
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
    /// When the agent was made on this computer's hub: one made again with
    /// the same id is asked about again. None from a hub that can't say.
    #[serde(default)]
    pub agent_since: Option<String>,
    /// The plan whose ticket sessions it holds, when it is a plan's grant.
    #[serde(default)]
    pub plan: Option<String>,
    pub grant: Value,
}

/// What a plan's grant id starts with.
const PLAN_KEY: &str = "plan-";

/// The plan `group` is the grant of, when it is a plan's: its id in the
/// hub's own spelling (lowercase), as the hub reads it.
pub(crate) fn plan_of(group: &str) -> Option<&str> {
    group
        .strip_prefix(PLAN_KEY)
        .filter(|p| bosses::uuid_ok(p) && *p == p.to_ascii_lowercase())
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
    /// Whether its plans' grants are said ([`WANTED_PATH`] asks for them):
    /// until they are, those a machine holds are left as they are.
    #[serde(default)]
    pub plans_known: bool,
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
/// Ungrouped), or a plan's grant marked as that plan's and no other,
/// naming the hub's own agent `local:<agent>`, of the version the engines
/// read, with no folders, repositories or memory search, its members
/// sessions' ids, and no field but [`GRANT_KEYS`].
pub fn carried(g: &WantedGrant) -> bool {
    let v = &g.grant;
    let Some(o) = v.as_object() else {
        return false;
    };
    let empty = |k: &str| v[k].as_array().is_some_and(Vec::is_empty);
    bosses::group_id_ok(&g.group)
        && g.group != "ungrouped"
        && plan_of(&g.group) == g.plan.as_deref()
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
    /// When that agent was made, as the hub said: an agent made again with
    /// the same id is another boss.
    #[serde(default)]
    pub since: Option<String>,
    pub yes: bool,
    /// The machine sessions (`<machine>/<id>`) they were asked about.
    pub sessions: Vec<String>,
    /// The level and switches they were asked about: a yes holds up to that
    /// level; a no, while both stay as they were.
    #[serde(default = "watch")]
    pub level: String,
    #[serde(default)]
    pub act: Value,
    pub at: DateTime<Utc>,
    /// The last yes for this boss, kept apart from a later no: a Cancel
    /// on a question for a higher level leaves the grant at what was said
    /// yes to.
    #[serde(default)]
    pub last_yes: Option<Yes>,
    /// Desk stopped the grant after the last yes: the person is asked
    /// again, and a fresh yes lifts the stop.
    #[serde(default)]
    pub ask_again: bool,
}

/// A yes: the level it was said to, and when.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Yes {
    pub level: String,
    pub at: DateTime<Utc>,
}

impl Said {
    /// Whether this answer was for `a`'s boss: the same agent, made at the
    /// same time.
    fn of(&self, a: &Asked) -> bool {
        self.agent == a.agent && self.since == a.since
    }

    /// The last yes for this boss, if there is one.
    fn yes_said(&self) -> Option<Yes> {
        self.last_yes.clone().or_else(|| {
            self.yes.then(|| Yes {
                level: self.level.clone(),
                at: self.at,
            })
        })
    }
}

fn watch() -> String {
    "watch".into()
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

/// What `kept` says of group `group`'s boss running its machine sessions
/// as `a` has them now:
/// - a stop Desk made after the last yes asks again;
/// - the last yes for this boss holds up to the level it was asked at
///   (the sessions the person puts in the group later are its, as at
///   home), whatever no came after it for a higher level;
/// - a no holds while every session, the level and the switches are as
///   they were asked about, so changing the boss's settings at home asks
///   again;
/// - else the person is asked.
fn consent(kept: &Kept, group: &str, a: &Asked) -> Consent {
    let rank = |l: &str| level_rank(&json!(l)).unwrap_or(0);
    match kept.groups.get(group) {
        Some(s) if !s.of(a) || s.ask_again => Consent::Ask,
        Some(s)
            if s.yes_said()
                .is_some_and(|y| rank(&a.level) <= rank(&y.level)) =>
        {
            Consent::Yes
        }
        Some(s)
            if !s.yes
                && s.level == a.level
                && s.act == a.act
                && a.flat().iter().all(|x| s.sessions.contains(x)) =>
        {
            Consent::No
        }
        _ => Consent::Ask,
    }
}

/// When the person last said yes to group `group`'s boss here, and the
/// level they said it at, if they did: what is written is never above it,
/// while a higher one waits on them being asked again.
fn yes_of(kept: &Kept, group: &str, a: &Asked) -> Option<Yes> {
    kept.groups
        .get(group)
        .filter(|s| s.of(a))
        .and_then(Said::yes_said)
}

/// Act fully's daily budget `grant` carries, in dollars: above 0 and up to
/// Act fully's most.
fn budget_of(grant: &Value) -> Option<f64> {
    grant["act"]["budget_usd_per_day"]
        .as_f64()
        .filter(|u| u.is_finite() && *u > 0.0 && *u <= MOST_BUDGET_USD)
}

/// The most Act fully's daily budget may be.
const MOST_BUDGET_USD: f64 = 10_000.0;

/// `grant` as Desk carries it to a machine: Act fully only with a daily
/// budget, which the hub counts once across this computer and every
/// machine; else no higher than Act, and no budget.
fn capped(grant: Value) -> Value {
    if grant["level"] == "full" && budget_of(&grant).is_some() {
        return grant;
    }
    let mut grant = at_most(grant, "act");
    if let Some(act) = grant["act"].as_object_mut() {
        act.remove("budget_usd_per_day");
    }
    grant
}

/// `grant` with its level no higher than `said`.
fn at_most(mut grant: Value, said: &str) -> Value {
    let said = json!(said);
    if level_rank(&said).unwrap_or(0) < level_rank(&grant["level"]).unwrap_or(0) {
        grant["level"] = said;
    }
    grant
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
    act: Value,
    since: Option<String>,
    sessions: BTreeMap<String, BTreeSet<String>>,
}

fn by_group(wanted: &Wanted) -> BTreeMap<String, Asked> {
    let mut out: BTreeMap<String, Asked> = BTreeMap::new();
    for (m, mw) in &wanted.machines {
        for g in mw.grants.iter().filter(|g| carried(g) && g.plan.is_none()) {
            // What the person is asked about is what will be written.
            let grant = capped(g.grant.clone());
            let a = out.entry(g.group.clone()).or_insert_with(|| Asked {
                agent: g.agent.clone(),
                agent_name: g.agent_name.clone(),
                group_name: grant["name"].as_str().unwrap_or(&g.group).to_string(),
                level: grant["level"].as_str().unwrap_or("watch").to_string(),
                act: grant["act"].clone(),
                since: g.agent_since.clone(),
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

    /// The boss as a native question names it: quoted, as every name the
    /// page can set is ([`bosses::quoted`]).
    fn boss(&self) -> String {
        bosses::quoted(&bosses::capital(if self.agent_name.trim().is_empty() {
            &self.agent
        } else {
            &self.agent_name
        }))
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

/// How `a` would run them, in words: at Act fully, with its one daily
/// budget.
fn how_words(a: &Asked) -> String {
    match (a.level.as_str(), budget_of(&json!({"act": a.act}))) {
        // The hub's word for no budget set: Act fully's most.
        ("full", Some(usd)) if usd >= MOST_BUDGET_USD => format!(
            "at Act fully, with no daily budget set (at most ${usd:.2} a day, counted across this computer and every machine)"
        ),
        ("full", Some(usd)) => format!(
            "at Act fully, within one daily budget of ${usd:.2} counted across this computer and every machine"
        ),
        (l, _) => level_words(l).to_string(),
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
        how_words(a),
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
    let Some((group, a)) = by_group(wanted)
        .into_iter()
        .find(|(g, a)| !remote.contains(g) && consent(&kept, g, a) == Consent::Ask)
    else {
        return Ok(false);
    };
    let (title, body, yes) = question(&a, names);
    let said = ask(title, body, yes).await?;
    let at = Utc::now();
    let last_yes = match said {
        true => Some(Yes {
            level: a.level.clone(),
            at,
        }),
        false => kept
            .groups
            .get(&group)
            .filter(|s| s.of(&a))
            .and_then(Said::yes_said),
    };
    keep_said(
        kept_at,
        &group,
        Said {
            agent: a.agent.clone(),
            since: a.since.clone(),
            yes: said,
            sessions: a.flat().into_iter().collect(),
            level: a.level.clone(),
            act: a.act.clone(),
            at,
            last_yes,
            ask_again: false,
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
    /// Each machine (by id) that couldn't be brought up to date, and why.
    pub failed: Vec<(String, String)>,
    /// The machines with a step passed over while its group was being
    /// changed: visited again at the next poll.
    pub waiting: BTreeSet<String>,
    /// The groups, by machine id, whose grant there was stopped on the
    /// machine itself: never lifted from here.
    pub stopped_there: BTreeSet<(String, String)>,
    /// The groups whose grant somewhere Desk stopped after the person's
    /// last yes, with the stop's time: the person is asked again.
    pub stopped_since_yes: BTreeMap<String, DateTime<Utc>>,
}

/// One step on one machine.
#[derive(Debug, Clone, PartialEq)]
enum Step {
    Delete,
    /// A grant to write, and when the person last said yes to it: a stop
    /// Desk made before then is lifted with it. None for what only narrows,
    /// and for a plan's grant.
    Write(Value, Option<DateTime<Utc>>),
}

/// How long each grant written lasts: a day, so one left behind while Desk
/// was closed ends soon. A machine that gives less is written its own.
const GRANT_HOURS: u32 = 24;

/// The `code` an engine refuses a grant longer than it gives with, saying
/// the most it gives as `mostHours`.
const GRANT_TOO_LONG: &str = "grant_too_long";

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

/// The machine's revision for `group` (its grant's, or what a deleted one
/// left; 0 for none), its grant, and the stop it holds (the grant's, or
/// the one a deleted grant left).
async fn held_one(engine: &impl Engine, group: &str) -> Result<(i64, Value, Value), String> {
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
    let held = v["grants"]
        .as_array()
        .and_then(|gs| gs.iter().find(|g| g["group"] == group))
        .cloned()
        .unwrap_or(Value::Null);
    let left = &v["left"][group];
    let have = held["revision"]
        .as_i64()
        .or_else(|| left["revision"].as_i64())
        .unwrap_or(0);
    let stop = match held.is_null() {
        true => left["stopped"].clone(),
        false => held["stopped"].clone(),
    };
    Ok((have, held, stop))
}

/// Whether `stop` is lifted by a yes at `yes`: one Desk made before it,
/// never one made on the machine.
fn lifted(stop: &Value, yes: Option<DateTime<Utc>>) -> bool {
    let at = stop["at"]
        .as_str()
        .and_then(|t| t.parse::<DateTime<Utc>>().ok());
    stop["from"] == "desk" && matches!((at, yes), (Some(at), Some(yes)) if at < yes)
}

/// What a write did.
#[derive(Debug, Default, PartialEq)]
struct Wrote {
    written: bool,
    /// The machine itself stopped the grant: it stays stopped.
    stopped_there: bool,
    /// When Desk stopped it, after the person's yes: asked again.
    stopped_since_yes: Option<DateTime<Utc>>,
}

/// When `stop`, one Desk made, was made at or after the yes at `yes`.
fn desk_stop_since(stop: &Value, yes: Option<DateTime<Utc>>) -> Option<DateTime<Utc>> {
    let at = stop["at"]
        .as_str()
        .and_then(|t| t.parse::<DateTime<Utc>>().ok())?;
    (stop["from"] == "desk" && yes.is_some_and(|y| at >= y)).then_some(at)
}

/// Writes `says` as `group`'s grant on `engine`, once the machine's copy is
/// read again and is still one this writes: the same revision when it
/// says nothing new and is past half its life (a renewal), nothing when it
/// isn't, else one past what the machine has. A stop Desk made before the
/// person's yes (`yes`) is lifted with it; one made on the machine never is.
async fn write(
    engine: &impl Engine,
    group: &str,
    says: &Value,
    listed: &BTreeSet<String>,
    yes: Option<DateTime<Utc>>,
) -> Result<Wrote, String> {
    let mut hours = Some(GRANT_HOURS);
    let mut shortened = false;
    let mut conflicts = 0;
    loop {
        let (have, held, stop) = held_one(engine, group).await?;
        if !held.is_null() && !ours(&held) {
            return Ok(Wrote::default());
        }
        let stopped_there = stop["from"] == "machine";
        let stopped_since_yes = desk_stop_since(&stop, yes);
        let resume = lifted(&stop, yes);
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
        let same = !held.is_null() && !resume && leaving.is_empty() && says_same(&held, says);
        if same && !renewal_due(&held, Utc::now()) {
            return Ok(Wrote {
                written: false,
                stopped_there,
                stopped_since_yes,
            });
        }
        let mut body = says.clone();
        body["revision"] = json!(if same { have } else { have + 1 });
        body["leaving"] = json!(leaving);
        if let Some(h) = hours {
            body["hours"] = json!(h);
        }
        if resume {
            body["resume"] = json!(true);
        }
        let body = Zeroizing::new(body.to_string());
        let a = engine
            .call(
                "PUT",
                &format!("/api/desk/grants/{}", bosses::seg(group)),
                Some(&body),
            )
            .await?;
        if bosses::ok(a.status) {
            if resume {
                tracing::info!(group = %group, machine = %engine.id(), "a stop Desk made before the person's yes was lifted");
            }
            return Ok(Wrote {
                written: true,
                stopped_there,
                stopped_since_yes,
            });
        }
        // A machine that gives a grant less than a day: the most it gives.
        if a.status == 400 && !shortened {
            let said: Value = serde_json::from_str(&a.body).unwrap_or_default();
            if said["code"] == GRANT_TOO_LONG {
                shortened = true;
                hours = said["mostHours"]
                    .as_u64()
                    .and_then(|h| u32::try_from(h).ok())
                    .filter(|h| (1..GRANT_HOURS).contains(h));
                continue;
            }
        }
        if a.status == 409 && conflicts == 0 {
            conflicts += 1;
            continue;
        }
        return Err(format!(
            "Desk on {} didn't take {group}'s grant: {}",
            engine.name(),
            bosses::said(a.status, a.body.as_bytes())
        ));
    }
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
    wanted: &BTreeMap<String, (Value, Option<DateTime<Utc>>)>,
    remote: &BTreeSet<String>,
) -> (Steps, Steps) {
    let mut first = Vec::new();
    for (group, h) in held.iter().filter(|(_, h)| ours(h)) {
        match wanted.get(group) {
            Some((w, _)) if !remote.contains(group) => {
                // What narrows is written now; what then widens, after.
                let m = meet(h, w);
                if !says_same(h, &m) {
                    first.push((group.clone(), Step::Write(m, None)));
                }
            }
            _ => first.push((group.clone(), Step::Delete)),
        }
    }
    let then = wanted
        .iter()
        .filter(|(g, _)| !remote.contains(*g))
        .filter(|(g, _)| held.get(*g).is_none_or(ours))
        .map(|(g, (w, yes))| (g.clone(), Step::Write(w.clone(), *yes)))
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
        // A change to the group under way: at the next poll, not at the
        // next visit.
        let Ok(_op) = ops.try_lock() else {
            out.waiting.insert(engine.id().to_string());
            continue;
        };
        let remote = bosses::load(bosses_at).await.groups.contains_key(group);
        let done = match step {
            Step::Write(says, yes) if !remote => write(engine, group, says, listed, *yes).await,
            _ => delete(engine, group).await.map(|written| Wrote {
                written,
                ..Wrote::default()
            }),
        };
        match done {
            Ok(w) => {
                if w.stopped_there {
                    out.stopped_there
                        .insert((engine.id().to_string(), group.clone()));
                }
                if let Some(at) = w.stopped_since_yes {
                    out.stopped_since_yes.insert(group.clone(), at);
                }
                if w.written {
                    out.written += 1;
                    out.narrowed |= narrowing || !matches!(step, Step::Write(..)) || remote;
                }
            }
            Err(why) => out.failed.push((engine.id().to_string(), why)),
        }
    }
}

/// Brings every machine's grants for this computer's group bosses to what
/// `wanted` says, as far as the person said yes, and its plans' grants as
/// it says them: narrowing on every machine first, then the rest (see the
/// module).
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
            Ok(h) => h
                .into_iter()
                .filter(|(g, _)| wanted.plans_known || plan_of(g).is_none())
                .collect(),
            Err(why) => {
                out.failed.push((id.clone(), why));
                continue;
            }
        };
        let mw = wanted.machines.get(id);
        let desired: BTreeMap<String, (Value, Option<DateTime<Utc>>)> = mw
            .into_iter()
            .flat_map(|m| m.grants.iter())
            .filter(|g| carried(g))
            .filter_map(|g| match g.plan {
                Some(_) => Some((g.group.clone(), (capped(g.grant.clone()), None))),
                None => {
                    let a = groups.get(&g.group).filter(|a| a.agent == g.agent)?;
                    let yes = yes_of(&kept, &g.group, a)?;
                    let grant = capped(at_most(g.grant.clone(), &yes.level));
                    Some((g.group.clone(), (grant, Some(yes.at))))
                }
            })
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
    for (group, at) in &out.stopped_since_yes {
        if let Err(why) = ask_again(kept_at, group, *at).await {
            tracing::warn!(group = %group, why = %why, "a local boss stopped in Desk couldn't be asked about again");
        }
    }
    out
}

/// Has the person asked again about group `group`'s boss, stopped in Desk
/// at `stop` after their last yes, unless they have answered since.
async fn ask_again(kept_at: &Path, group: &str, stop: DateTime<Utc>) -> Result<(), String> {
    let said = {
        let _one = KEPT.lock().await;
        read_kept(kept_at).groups.get(group).cloned()
    };
    let Some(mut said) = said else {
        return Ok(());
    };
    if said.ask_again || said.at > stop {
        return Ok(());
    }
    said.ask_again = true;
    keep_said(kept_at, group, said).await
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

/// Whether a question about a local boss is being asked now.
static ASKING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// What was last brought to each machine (by id), and when.
static LAST: Mutex<BTreeMap<String, (String, Instant)>> = Mutex::new(BTreeMap::new());

/// What was last said of each machine's trouble, so it is said once, when
/// it changes.
static SAID: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());

/// Says `why` of `key` once, when it changes; nothing when it is gone.
fn say_once(key: &str, why: Option<&str>, say: impl FnOnce(&str)) {
    let mut said = SAID.lock().unwrap_or_else(|e| e.into_inner());
    match why {
        Some(w) if said.get(key).map(String::as_str) != Some(w) => {
            say(w);
            said.insert(key.to_string(), w.to_string());
        }
        Some(_) => {}
        None => {
            said.remove(key);
        }
    }
}

/// One run: the hub read; each machine visited when what it should hold
/// changed, when woken, or every [`KEEP_EVERY`] (one that can't be reached
/// holds up no other); then the person asked about one group they haven't
/// answered for.
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
    let common = format!("{remote:?}\n{kept:?}");
    let digest = |id: &str| {
        format!(
            "{}\n{common}",
            serde_json::to_string(&wanted.machines.get(id)).unwrap_or_default()
        )
    };
    let due: Vec<String> = {
        let last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        ids.iter()
            .filter(|id| {
                woken
                    || last
                        .get(id.as_str())
                        .is_none_or(|(was, at)| *was != digest(id) || at.elapsed() >= KEEP_EVERY)
            })
            .cloned()
            .collect()
    };
    if !due.is_empty() {
        let engines = bosses::engines_now(&local, &machines, &due);
        let synced = sync(&bosses_at, &kept_at, &wanted, &engines.machines).await;
        if synced.narrowed {
            // A boss on another hub refused before may fit now.
            bosses::WAKE.notify_one();
        }
        let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        for id in &due {
            let why = synced
                .failed
                .iter()
                .find(|(m, _)| m == id)
                .map(|(_, w)| w.as_str());
            say_once(id, why, |w| {
                tracing::warn!(machine = %id, why = %w, "a local boss's machine grants weren't brought up to date; trying again");
            });
            if why.is_some() || synced.waiting.contains(id) {
                last.remove(id);
            } else {
                last.insert(id.clone(), (digest(id), Instant::now()));
            }
        }
        drop(last);
        for (id, group) in &synced.stopped_there {
            say_once(&format!("stop {id}/{group}"), Some("stopped"), |_| {
                tracing::warn!(machine = %id, group = %group, "a local boss's grant was stopped on the machine itself: it stays stopped until the person lets it go on there");
            });
        }
    }
    let names: BTreeMap<String, String> = ids
        .iter()
        .filter_map(|id| Some((id.clone(), machines.link(id).ok()?.machine().name.clone())))
        .collect();
    // Asked on its own, so nothing that narrows waits on the person: one
    // question at a time, as every boss question is, and none for a while
    // after a Cancel. A yes is written at once.
    if ASKING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let said = ask_one(
            &kept_at,
            &wanted,
            &names,
            &remote,
            bosses::native_ask(app.clone()),
        )
        .await;
        ASKING.store(false, std::sync::atomic::Ordering::SeqCst);
        match said {
            Ok(true) => {
                LAST.lock().unwrap_or_else(|e| e.into_inner()).clear();
                WAKE.notify_one();
            }
            Ok(false) => {}
            // Another question is open, or one was cancelled lately: later.
            Err(why) => tracing::debug!(why = %why, "a local boss's question waits"),
        }
    });
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
