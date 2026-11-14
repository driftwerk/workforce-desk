//! A group's boss on another hub (remote bosses, RBD1): the person makes an
//! agent of a paired team hub (Allan on Driftwerk) the boss of one of their
//! sidebar groups, entirely from Desk, and Desk's native side does the rest.
//!
//! - **Asked natively first**, with Cancel the default, for anything that
//!   gives the boss more: linking it, a higher level, more it sees, a higher
//!   budget, letting it go on after a pause. What narrows (a lower level,
//!   Pause, Stop) isn't asked. The question is built here from what will be
//!   written, never from what the page says it is.
//! - **The group comes from the hub.** Its name and its sessions, split by
//!   engine (this computer's, each machine's), are read from this
//!   computer's hub's layout, never from the page.
//! - **Per engine**, in turn: its key (`GET /api/desk/engine-key`); a link
//!   minted on the boss's hub with this Desk's device token there
//!   (`POST /api/me/desk-boss-links`); the link handed to the engine
//!   (`PUT /api/desk/boss-links/{group}`); and the group's grant written to
//!   it (`PUT /api/desk/grants/{group}`). Each engine route is on
//!   [`crate::broker::routes::native_boss`], which no page request is
//!   checked against, and the mint is refused to the page
//!   (`hub_io::page_refused`). A link not handed over is revoked where it
//!   was made; a grant not written takes its link off the engine too.
//! - **The token never reaches the page**, a log, an error or a file here:
//!   it goes from the boss's hub's answer to the engine's request, held in
//!   [`Zeroizing`] memory. What is kept here (`bosses.json`, private) is
//!   which links were made, their ids and expiry, and the last grant
//!   written to each engine, so it can be renewed and taken back.
//! - **Kept alive** while Desk is open ([`keep_alive`]): every grant renewed
//!   (they last 72 hours) or written anew when the group's sessions
//!   changed, each link's token renewed with under 10 days left (or made
//!   anew once expired), and an engine new to the group linked. At Act and
//!   above, a session the person didn't say the boss may run isn't granted
//!   until they do.
//! - **Pause** stops the group's grant on every engine (never the
//!   engine-wide pause, which would stop every boss there), and keeping
//!   alive sends each engine its stop until it has taken it, renewing
//!   nothing. **Stop** sends every engine its stop at once, then revokes
//!   every token, takes each link off its engine and deletes each grant;
//!   until all of it is done, keeping alive tries those steps alone again.
//! - **Nothing is held across a request**: what is kept is read and
//!   written under a lock held for the file alone, and one change to a
//!   group runs at a time. Pause and Stop send their stops before waiting
//!   for it.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::CommandResult;
use crate::broker::{Broker, NativeAnswer};
use crate::hub_io::{HubIo, agent_id_ok, words_of};
use crate::machines::MachineIo;

/// What this computer is called to the person.
const HERE: &str = if cfg!(target_os = "macos") {
    "this Mac"
} else {
    "this computer"
};

/// What this computer's engine is called among the person's engines.
pub const LOCAL_ENGINE: &str = "local";
/// What is kept of the links made, under Desk's own folder.
pub const KEPT_FILE: &str = "bosses.json";
/// Where a paired Desk mints, lists and revokes its boss links.
const LINKS_PATH: &str = "/api/me/desk-boss-links";
/// The grant shape the engines read.
const GRANT_VERSION: u32 = 1;
/// A link's token is renewed with less than this left.
const RENEW_UNDER: Duration = Duration::days(10);
/// How often the grants and links are kept alive while Desk is open.
const KEEP_EVERY: std::time::Duration = std::time::Duration::from_secs(30 * 60);
/// The most Act fully's daily budget may be, as the hub has it.
pub const MAX_FULL_BUDGET_USD: f64 = 10_000.0;
/// The longest group name a boss hub takes.
const GROUP_NAME_MAX: usize = 64;

// ── What the person chooses ─────────────────────────────────────────────

/// How much the boss may do, as a grant says it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Watch,
    Suggest,
    Act,
    Full,
}

impl Level {
    fn words(self) -> &'static str {
        match self {
            Self::Watch => "Watch only",
            Self::Suggest => "Suggest",
            Self::Act => "Act within Desk",
            Self::Full => "Act fully",
        }
    }
}

/// What the boss sees of the group's sessions, as a grant says it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Sees {
    Status,
    Replies,
    Everything,
}

impl Sees {
    fn words(self) -> &'static str {
        match self {
            Self::Status => "their status",
            Self::Replies => "their status and replies",
            Self::Everything => "everything, terminals and transcripts included",
        }
    }
}

/// What the person chose for the group's boss.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Choice {
    pub level: Level,
    pub sees: Sees,
    /// Act fully's daily budget in real money; none below Act fully.
    #[serde(default)]
    pub budget_usd_per_day: Option<f64>,
}

impl Choice {
    /// Refuses what can't be written, in plain words; a budget below Act
    /// fully is dropped.
    fn checked(mut self) -> Result<Self, String> {
        if self.level != Level::Full {
            self.budget_usd_per_day = None;
            return Ok(self);
        }
        match self.budget_usd_per_day {
            Some(b) if b.is_finite() && b > 0.0 && b <= MAX_FULL_BUDGET_USD => {}
            _ => {
                return Err(format!(
                    "Act fully needs a daily budget above $0 and up to ${MAX_FULL_BUDGET_USD:.0}."
                ));
            }
        }
        if self.sees == Sees::Status {
            return Err("Act fully needs the boss to see replies.".into());
        }
        Ok(self)
    }

    /// The level's own switches, as the hub's `served_oversight` reads
    /// them: Act's, at Act and Act fully, with Act fully's budget.
    fn act(&self) -> Value {
        let mut act = serde_json::Map::new();
        if self.level >= Level::Act {
            for k in [
                "nudge",
                "resume_restart",
                "read_only_approvals",
                "hand_out_work",
                "interrupt",
                "answer_sessions",
            ] {
                act.insert(k.into(), Value::Bool(true));
            }
        }
        if let Some(b) = self.budget_usd_per_day {
            act.insert("budget_usd_per_day".into(), json!(b));
        }
        Value::Object(act)
    }

    /// Whether this gives the boss more than `was`: a higher level, more
    /// seen, or a higher budget (or one new) at Act fully.
    pub fn widens(&self, was: &Choice) -> bool {
        let more_money = self.level == Level::Full
            && match (self.budget_usd_per_day, was.budget_usd_per_day) {
                (Some(now), Some(then)) => now > then || was.level != Level::Full,
                (Some(_), None) => true,
                _ => false,
            };
        self.level > was.level || self.sees > was.sees || more_money
    }
}

// ── What is kept here ───────────────────────────────────────────────────

/// One engine's link and grant, as Desk made them. Never its token.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineLink {
    pub name: String,
    pub link_id: String,
    /// The token's record on the boss's hub, to renew and revoke it by.
    pub token_id: String,
    pub expires_at: DateTime<Utc>,
    /// The revision of the grant last written, and what it said.
    pub revision: i64,
    pub written: Value,
    #[serde(default)]
    pub reached_at: Option<DateTime<Utc>>,
    /// Why it couldn't be reached last time, in plain words.
    #[serde(default)]
    pub problem: Option<String>,
    /// Whether it took its stop since the group was paused or stopped.
    #[serde(default)]
    pub stopped: bool,
}

/// An engine the group's boss couldn't be linked on, and why.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotLinked {
    pub name: String,
    pub why: String,
}

/// A group's boss on another hub, as Desk linked it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupLink {
    /// The paired hub's id: the name the grants give it.
    pub hub: String,
    pub hub_label: String,
    /// The address Desk reached the hub at when it linked the boss: what a
    /// question names when the hub can't be reached now.
    #[serde(default)]
    pub hub_base: String,
    pub agent: String,
    pub choice: Choice,
    /// The person paused it: nothing is renewed, and each engine is sent
    /// its stop until it has taken it.
    #[serde(default)]
    pub paused: bool,
    /// The person stopped it: only Stop's steps are tried again, until
    /// every engine is clear and every token revoked.
    #[serde(default)]
    pub stopping: bool,
    /// By engine id: `local`, or a machine's.
    pub engines: BTreeMap<String, EngineLink>,
    /// The sessions, by engine, the person last said the boss may run. At
    /// Act and above no other session is granted until they say so.
    #[serde(default)]
    pub confirmed: BTreeMap<String, Vec<String>>,
    /// Tokens made on the boss's hub that no engine holds (a link not
    /// handed over, or one renewed): revoked until the hub says they're
    /// gone. Each is kept before it is handed over, so none is lost.
    #[serde(default)]
    pub orphans: Vec<String>,
    /// Engines it couldn't be linked on, and why: offered again.
    #[serde(default)]
    pub unlinked: BTreeMap<String, NotLinked>,
}

impl GroupLink {
    fn new(at: &HubAt, agent: &str, choice: &Choice) -> Self {
        Self {
            hub: at.id.clone(),
            hub_label: at.label.clone(),
            hub_base: at.base.clone(),
            agent: agent.to_string(),
            choice: choice.clone(),
            paused: false,
            stopping: false,
            engines: BTreeMap::new(),
            confirmed: BTreeMap::new(),
            orphans: Vec::new(),
            unlinked: BTreeMap::new(),
        }
    }

    /// The boss as a grant names it.
    fn boss_key(&self) -> String {
        format!("remote:{}/{}", self.hub, self.agent)
    }

    /// The sessions on `engine` the boss may run now: below Act every one
    /// in the group; at Act and above only those the person said.
    fn allowed(&self, group: &Group, engine: &str) -> Vec<String> {
        let now = group.members.get(engine).cloned().unwrap_or_default();
        if self.choice.level < Level::Act {
            return now;
        }
        let said = self.confirmed.get(engine);
        now.into_iter()
            .filter(|s| said.is_some_and(|c| c.contains(s)))
            .collect()
    }

    /// How many of the group's sessions wait on the person to let the
    /// boss run them.
    fn waiting(&self, group: &Group) -> usize {
        group.count()
            - group
                .members
                .keys()
                .map(|e| self.allowed(group, e).len())
                .sum::<usize>()
    }
}

/// Every group's boss on another hub, by group id.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Kept {
    #[serde(default)]
    pub groups: BTreeMap<String, GroupLink>,
}

/// One read-and-write of what is kept at a time: held for the file alone,
/// never across a request.
static KEPT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn read_kept(path: &Path) -> Kept {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "what Desk keeps of its bosses can't be read");
            Kept::default()
        }),
        Err(_) => Kept::default(),
    }
}

fn write_kept(path: &Path, kept: &Kept) -> Result<(), String> {
    let text = serde_json::to_string_pretty(kept).map_err(|e| e.to_string())?;
    desk_core::write_private(path, &text)
        .map_err(|e| format!("Desk couldn't keep what it linked: {e}"))
}

/// What is kept, as it is now.
async fn load(kept_at: &Path) -> Kept {
    let _one = KEPT.lock().await;
    read_kept(kept_at)
}

/// Group `group`'s boss, as kept now.
async fn load_group(kept_at: &Path, group: &str) -> Option<GroupLink> {
    load(kept_at).await.groups.remove(group)
}

/// Changes group `group`'s record: read afresh, `f` changes only what its
/// caller owns, and written back at once, so no change made meanwhile is
/// lost. Nothing when the group has no record.
async fn change_group<R>(
    kept_at: &Path,
    group: &str,
    f: impl FnOnce(&mut GroupLink) -> R,
) -> Result<Option<R>, String> {
    let _one = KEPT.lock().await;
    let mut kept = read_kept(kept_at);
    let Some(entry) = kept.groups.get_mut(group) else {
        return Ok(None);
    };
    let r = f(entry);
    write_kept(kept_at, &kept)?;
    Ok(Some(r))
}

/// One change to a group's boss at a time. Pause and Stop send their stops
/// before they wait for it; keeping alive passes over a group being
/// changed.
static OPS: std::sync::Mutex<BTreeMap<String, Arc<tokio::sync::Mutex<()>>>> =
    std::sync::Mutex::new(BTreeMap::new());

fn ops_of(kept_at: &Path, group: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut ops = OPS.lock().unwrap_or_else(|e| e.into_inner());
    // Those no change holds or waits on: a group whose record went keeps
    // none. (Every other holder clones under this lock.)
    ops.retain(|_, m| Arc::strong_count(m) > 1);
    ops.entry(format!("{}\n{group}", kept_at.display()))
        .or_default()
        .clone()
}

// ── What it talks to ────────────────────────────────────────────────────

/// An engine: this computer's hub, or a machine's through its forward.
pub trait Engine: Sync {
    fn id(&self) -> &str;
    /// As the person knows it: "this Mac", or the machine's name.
    fn name(&self) -> &str;
    fn call(
        &self,
        method: &str,
        target: &str,
        body: Option<&Zeroizing<String>>,
    ) -> impl Future<Output = Result<NativeAnswer, String>> + Send;
}

/// The boss's hub, reached with this Desk's device token there.
pub trait BossHub: Sync {
    fn call(
        &self,
        method: &str,
        target: &str,
        body: Option<&Zeroizing<String>>,
    ) -> impl Future<Output = Result<(u16, Zeroizing<Vec<u8>>), String>> + Send;
}

/// The boss's hub, as Desk knows it.
#[derive(Debug, Clone)]
pub struct HubAt {
    pub id: String,
    pub label: String,
    /// Its `https` origin as Desk dials it ([`canonical`]).
    pub base: String,
}

/// `url` as a boss hub names itself in a challenge, as the hub's
/// `canonical_hub` has it: its `https` origin, the host lower-cased, the
/// port only when it isn't 443, no user, path, query or fragment.
pub fn canonical(url: &str) -> Option<String> {
    let u = url::Url::parse(url.trim()).ok()?;
    let plain = u.scheme() == "https"
        && u.username().is_empty()
        && u.password().is_none()
        && u.query().is_none()
        && u.fragment().is_none()
        && matches!(u.path(), "" | "/");
    let host = u.host_str().filter(|_| plain)?.to_ascii_lowercase();
    Some(match u.port() {
        Some(p) => format!("https://{host}:{p}"),
        None => format!("https://{host}"),
    })
}

/// A path segment, escaped.
fn seg(s: &str) -> String {
    const KEEP: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'~');
    percent_encoding::utf8_percent_encode(s, KEEP).to_string()
}

fn ok(status: u16) -> bool {
    (200..300).contains(&status)
}

/// A hub's words for its refusal, or its status.
fn said(status: u16, body: &[u8]) -> String {
    words_of(body).unwrap_or_else(|| format!("it answered {status}"))
}

fn json_of(body: &str) -> Option<Value> {
    serde_json::from_str(body).ok()
}

/// "a", "a and b", "a, b and c".
fn and(names: &[&str]) -> String {
    match names {
        [] => String::new(),
        [one] => (*one).to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

fn capital(s: &str) -> String {
    let mut c = s.chars();
    c.next()
        .map(|f| f.to_uppercase().chain(c).collect())
        .unwrap_or_default()
}

/// Whether `id` can name a group on an engine: as `grant::group_id_ok`.
fn group_id_ok(id: &str) -> bool {
    !id.trim().is_empty() && id.len() <= 100 && !id.contains('/') && !id.contains(':')
}

/// Whether `id` can name a hub, an engine or an agent in a link and a
/// grant, as the engines' `name_ok` takes one.
fn name_ok(id: &str) -> bool {
    (1..=100).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

// ── The group, from the hub's layout ────────────────────────────────────

/// A group as this computer's hub keeps it: its name, and its sessions by
/// engine (`local` for this computer's).
#[derive(Debug, Clone, PartialEq)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub members: BTreeMap<String, Vec<String>>,
    /// The sessions, by engine, the layout lists elsewhere: in another
    /// group, or Ungrouped. One born in this group and listed there has
    /// been taken out of it.
    pub elsewhere: BTreeMap<String, Vec<String>>,
}

impl Group {
    fn count(&self) -> usize {
        self.members.values().map(Vec::len).sum()
    }
}

/// The sessions an item list names, by engine.
fn sessions_in(items: &Value, into: &mut BTreeMap<String, Vec<String>>) {
    for item in items.as_array().into_iter().flatten() {
        let Some(key) = item.as_str().and_then(|k| k.strip_prefix("session:")) else {
            continue;
        };
        let (engine, session) = match key.split_once('/') {
            Some((m, s)) => (m.to_string(), s),
            None => (LOCAL_ENGINE.to_string(), key),
        };
        if uuid_ok(session) {
            into.entry(engine).or_default().push(session.to_string());
        }
    }
    for list in into.values_mut() {
        list.sort();
        list.dedup();
    }
}

/// Group `id` in `layout` (`GET /api/desk/layout`), or why it can't have a
/// boss on another hub.
pub fn group_of(layout: &Value, id: &str) -> Result<Group, String> {
    if id == "ungrouped" {
        return Err(
            "Ungrouped's boss stays on this computer: put the sessions in a group first.".into(),
        );
    }
    if !group_id_ok(id) {
        return Err("That group can't have a boss on another hub.".into());
    }
    let groups = layout["groups"].as_array();
    let g = groups
        .and_then(|gs| gs.iter().find(|g| g["id"] == id))
        .ok_or("That group isn't in the sidebar any more.")?;
    let name = g["name"].as_str().unwrap_or(id).trim().to_string();
    let mut members = BTreeMap::new();
    sessions_in(&g["items"], &mut members);
    let mut elsewhere = BTreeMap::new();
    for other in groups.into_iter().flatten().filter(|o| o["id"] != id) {
        sessions_in(&other["items"], &mut elsewhere);
    }
    sessions_in(&layout["ungrouped"]["items"], &mut elsewhere);
    Ok(Group {
        id: id.to_string(),
        name: if name.is_empty() {
            id.to_string()
        } else {
            name
        },
        members,
        elsewhere,
    })
}

fn uuid_ok(s: &str) -> bool {
    s.len() == 36
        && s.chars().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

async fn read_layout(here: &impl Engine) -> Result<Value, String> {
    let a = here.call("GET", "/api/desk/layout", None).await?;
    if !ok(a.status) {
        return Err(format!(
            "Desk couldn't read its sidebar: {}",
            said(a.status, a.body.as_bytes())
        ));
    }
    json_of(&a.body).ok_or_else(|| "Desk couldn't read its sidebar.".into())
}

async fn layout_group(here: &impl Engine, id: &str) -> Result<Group, String> {
    group_of(&read_layout(here).await?, id)
}

/// The engines a group is linked on: each that holds its sessions, this
/// computer's first; this computer's alone while it has none.
fn engines_of(group: &Group) -> Vec<String> {
    let mut ids: Vec<String> = group
        .members
        .iter()
        .filter(|(_, s)| !s.is_empty())
        .map(|(e, _)| e.clone())
        .collect();
    ids.sort_by_key(|e| e != LOCAL_ENGINE);
    if ids.is_empty() {
        ids.push(LOCAL_ENGINE.into());
    }
    ids
}

// ── The questions ───────────────────────────────────────────────────────

/// The longest a name the page can set is said in a native question.
const QUOTED_MAX: usize = 40;

/// A name the page can set (a group's, a hub's, a machine's) as a native
/// question says it: no control, direction or invisible characters, on one
/// line, at most [`QUOTED_MAX`] characters, in quotes. So no name can push
/// what the question asks out of sight, or pass for another part of it.
fn quoted(s: &str) -> String {
    let plain: String = s
        .chars()
        .map(|c| match c {
            c if c.is_control() => ' ',
            '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2069}' => ' ',
            '\u{feff}' => ' ',
            '"' | '“' | '”' | '«' | '»' => '\'',
            c => c,
        })
        .collect();
    let one = plain.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = one.chars().take(QUOTED_MAX).collect();
    if one.chars().count() > QUOTED_MAX {
        out = out.trim_end().to_string();
        out.push('…');
    }
    if out.is_empty() {
        out.push('?');
    }
    format!("“{out}”")
}

/// The boss's hub as a question names it: its label in Desk, and the host
/// Desk reaches it at, which the page can't change.
fn hub_words(at: &HubAt) -> String {
    match url::Url::parse(&at.base)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
    {
        Some(host) => format!("{} ({host})", quoted(&at.label)),
        None => quoted(&at.label),
    }
}

/// What the boss may do, first in every question, from what will be
/// written alone.
fn terms(c: &Choice) -> String {
    match (c.level, c.budget_usd_per_day) {
        (Level::Full, Some(b)) => format!(
            "{}, up to ${b:.2} a day of real money, seeing {}.",
            c.level.words(),
            c.sees.words()
        ),
        _ => format!("{}, seeing {}.", c.level.words(), c.sees.words()),
    }
}

/// "3 sessions in “Acme”, on devbox and this Mac".
fn sessions_phrase(group: &Group, names: &BTreeMap<String, String>) -> String {
    let n = group.count();
    let name = quoted(&group.name);
    if n == 0 {
        return format!("{name}, which has no sessions yet, on {HERE}");
    }
    // Machines first, this computer last, as the person reads it.
    let mut wheres: Vec<String> = group
        .members
        .iter()
        .filter(|(e, s)| e.as_str() != LOCAL_ENGINE && !s.is_empty())
        .map(|(e, _)| quoted(names.get(e).map_or(e.as_str(), String::as_str)))
        .collect();
    if group
        .members
        .get(LOCAL_ENGINE)
        .is_some_and(|s| !s.is_empty())
    {
        wheres.push(HERE.into());
    }
    let wheres: Vec<&str> = wheres.iter().map(String::as_str).collect();
    let sessions = if n == 1 { "session" } else { "sessions" };
    format!("{n} {sessions} in {name}, on {}", and(&wheres))
}

/// The one line that says what Act fully leaves to Desk.
pub fn full_line(boss: &str) -> String {
    format!(
        "Once {boss} allows a request, Desk's ship and irreversible checks no longer apply; its hold, breaker and agent-settings checks still do."
    )
}

fn what_it_means(boss: &str, hub: &str, group: &str, c: &Choice) -> String {
    let level = match c.level {
        Level::Watch => {
            format!("{boss} can look and tell you what they see. They can't do anything.")
        }
        Level::Suggest => format!("{boss} suggests; you decide each one, in Desk or Slack."),
        Level::Act => format!(
            "{boss} runs the sessions you give them. Pushes to main, merges, publishes and deploys come to you."
        ),
        Level::Full => format!(
            "{boss} decides every request the sessions ask, on {hub} with its own model, within the daily budget. {}",
            full_line(boss)
        ),
    };
    format!(
        "{level}\n\n{hub} receives what {boss} sees of {group}, and its model reads it. Stop {boss} in Desk ends it on every engine."
    )
}

// ── Probing a hub ───────────────────────────────────────────────────────

/// Whether a paired hub takes bosses from Desk, as the page is told.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Offer {
    /// Its agents can be bosses (each still says at its mint whether it
    /// takes boss work).
    Takes,
    /// It doesn't, now: its words, said for the person.
    Not { why: String },
}

/// What `hub` says to `GET /api/me/desk-boss-links`.
pub async fn offer(hub: &impl BossHub, label: &str) -> Offer {
    match hub.call("GET", LINKS_PATH, None).await {
        Ok((status, _)) if ok(status) => Offer::Takes,
        Ok((404, body)) if words_of(&body).is_some_and(|w| w.contains("boss work")) => Offer::Not {
            why: format!("{label} doesn't take bosses from Desk yet: its admin turns it on."),
        },
        Ok((401 | 403, _)) => Offer::Not {
            why: format!(
                "Desk's pairing with {label} has ended: pair it again in Settings → Hubs."
            ),
        },
        Ok((404 | 405, _)) => Offer::Not {
            why: format!(
                "{label}'s hub is older than this Desk: bosses from Desk need its next update."
            ),
        },
        Ok((status, body)) => Offer::Not {
            why: format!(
                "{label} didn't say whether it takes bosses: {}.",
                said(status, &body)
            ),
        },
        Err(_) => Offer::Not {
            why: format!("Desk can't reach {label} now."),
        },
    }
}

// ── Linking one engine ──────────────────────────────────────────────────

/// What a mint answered: the token, held until handed over.
struct Minted {
    token_id: String,
    link_id: String,
    token: Zeroizing<String>,
    expires_at: DateTime<Utc>,
    hub: Option<String>,
}

/// Whether a token can go into a request body as it is: no character JSON
/// would escape, so it is never copied out of [`Zeroizing`] memory to be.
fn token_ok(t: &str) -> bool {
    !t.is_empty()
        && t.len() <= 512
        && t.chars()
            .all(|c| c.is_ascii_graphic() && c != '"' && c != '\\')
}

fn minted_of(body: &[u8]) -> Option<Minted> {
    let mut v: Value = serde_json::from_slice(body).ok()?;
    // The token is taken out of the answer, not copied.
    let token = match v.get_mut("token").map(Value::take) {
        Some(Value::String(s)) => Zeroizing::new(s),
        _ => return None,
    };
    let id_ok = |s: &str| {
        !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    };
    let token_id = v["id"].as_str().filter(|s| id_ok(s))?.to_string();
    let link_id = v["link_id"].as_str().filter(|s| id_ok(s))?.to_string();
    let expires_at = v["expires_at"].as_str()?.parse().ok()?;
    let hub = v["hub"].as_str().map(str::to_string);
    Some(Minted {
        token_id,
        link_id,
        token,
        expires_at,
        hub,
    })
}

/// This engine's public key.
async fn engine_key(engine: &impl Engine) -> Result<String, String> {
    let a = engine.call("GET", "/api/desk/engine-key", None).await?;
    if !ok(a.status) {
        return Err(format!(
            "Desk on {} didn't say its key: {}",
            engine.name(),
            said(a.status, a.body.as_bytes())
        ));
    }
    json_of(&a.body)
        .and_then(|v| v["publicKey"].as_str().map(str::to_string))
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| format!("Desk on {} didn't say its key.", engine.name()))
}

/// Revokes token `id` on the boss's hub. Gone already (404) counts as
/// done; a 401 from a hub Desk is still paired with doesn't (the token is
/// kept, and revoked later): only a pairing Desk forgot took its tokens
/// with it ([`Revoke::PairingGone`]).
async fn revoke(hub: &impl BossHub, id: &str) -> Result<(), String> {
    match hub
        .call("DELETE", &format!("{LINKS_PATH}/{}", seg(id)), None)
        .await
    {
        Ok((status, _)) if ok(status) || status == 404 => Ok(()),
        Ok((status, body)) => {
            tracing::warn!(status, "a boss link wasn't revoked; trying again later");
            Err(said(status, &body))
        }
        Err(e) => {
            tracing::warn!(error = %e, "a boss link wasn't revoked; trying again later");
            Err(e)
        }
    }
}

/// Why a mint made nothing.
enum MintError {
    /// The agent doesn't take boss work from Desk: no other engine is asked.
    Declined(String),
    /// The token to renew is gone (expired, or revoked): mint a new one.
    Gone,
    Other(String),
}

impl MintError {
    fn words(self) -> String {
        match self {
            Self::Declined(w) | Self::Other(w) => w,
            Self::Gone => "The boss's hub no longer has that link.".into(),
        }
    }
}

/// Mints a link for `engine` (renewing `renews`), and checks the hub named
/// itself at the address Desk dials. A token it can't use is revoked.
async fn mint(
    engine: &impl Engine,
    hub: &impl BossHub,
    at: &HubAt,
    agent: &str,
    group: &Group,
    renews: Option<&str>,
) -> Result<Minted, MintError> {
    let key = engine_key(engine).await.map_err(MintError::Other)?;
    let name: String = group.name.chars().take(GROUP_NAME_MAX).collect();
    let ask = Zeroizing::new(
        json!({
            "agent_id": agent,
            "group": { "key": group.id, "name": name },
            "engine": { "id": engine.id(), "name": engine.name(), "public_key": key },
            "renews": renews,
        })
        .to_string(),
    );
    let (status, body) = hub
        .call("POST", LINKS_PATH, Some(&ask))
        .await
        .map_err(MintError::Other)?;
    if !ok(status) {
        let words = words_of(&body).unwrap_or_else(|| format!("it answered {status}"));
        return Err(match status {
            403 if words.contains("doesn't take boss work") => MintError::Declined(format!(
                "{} doesn't take boss work from Desk: {}'s admin turns it on in {}'s settings.",
                capital(agent),
                at.label,
                capital(agent)
            )),
            404 if renews.is_some() => MintError::Gone,
            _ => MintError::Other(format!(
                "{} didn't link {} to {}: {words}",
                at.label,
                capital(agent),
                engine.name()
            )),
        });
    }
    let minted = minted_of(&body).ok_or_else(|| {
        MintError::Other(format!("{} didn't make a link Desk can use.", at.label))
    })?;
    drop(body);
    // The engine dials, and signs for, the name the hub gave itself: it must
    // be the address Desk is paired with it at (the RB4 review's note).
    let wrong = match minted.hub.as_deref() {
        Some(named) if named == at.base => {
            (!token_ok(&minted.token)).then(|| format!("{} made a link Desk can't use.", at.label))
        }
        Some(named) => Some(format!(
            "{} calls itself {named}, but Desk is paired with it at {}: its admin sets its public address to the one Desk uses.",
            at.label, at.base
        )),
        None => Some(format!(
            "{} has no public address set, so engines can't reach it: its admin sets one.",
            at.label
        )),
    };
    if let Some(why) = wrong {
        let _ = revoke(hub, &minted.token_id).await;
        return Err(MintError::Other(why));
    }
    Ok(minted)
}

/// The body that hands `minted` to an engine, built in [`Zeroizing`]
/// memory with the token put in as it is ([`token_ok`]).
fn handed_body(at: &HubAt, minted: &Minted, engine: &str, agent: &str) -> Zeroizing<String> {
    let rest = json!({
        "hub": at.id,
        "hubUrl": at.base,
        "canonicalHub": at.base,
        "linkId": minted.link_id,
        "tokenId": minted.token_id,
        "expiresAt": minted.expires_at,
        "engineId": engine,
        "agentId": agent,
    })
    .to_string();
    let mut out = Zeroizing::new(String::with_capacity(rest.len() + minted.token.len() + 16));
    out.push_str(&rest[..rest.len() - 1]);
    out.push_str(",\"token\":\"");
    out.push_str(&minted.token);
    out.push_str("\"}");
    out
}

/// Hands `minted` to `engine` for group `group`.
async fn hand(
    engine: &impl Engine,
    at: &HubAt,
    minted: &Minted,
    agent: &str,
    group: &str,
) -> Result<(), String> {
    let body = handed_body(at, minted, engine.id(), agent);
    let put = engine
        .call(
            "PUT",
            &format!("/api/desk/boss-links/{}", seg(group)),
            Some(&body),
        )
        .await;
    drop(body);
    match put {
        Ok(a) if ok(a.status) => Ok(()),
        Ok(a) => Err(format!(
            "Desk on {} didn't keep the link: {}",
            engine.name(),
            said(a.status, a.body.as_bytes())
        )),
        Err(e) => Err(e),
    }
}

/// Takes link `link` off `engine` for group `group`.
async fn take_link_off(engine: &impl Engine, group: &str, link: &str) -> Result<(), String> {
    let path = format!("/api/desk/boss-links/{}/{}", seg(group), seg(link));
    match engine.call("DELETE", &path, None).await {
        Ok(a) if ok(a.status) || a.status == 404 => Ok(()),
        Ok(a) => Err(said(a.status, a.body.as_bytes())),
        Err(why) => Err(why),
    }
}

/// Keeps `token` among the group's orphans before it is handed over, so a
/// Desk that stops meanwhile still revokes it.
async fn keep_orphan(kept_at: &Path, group: &str, token: &str) -> Result<(), String> {
    change_group(kept_at, group, |l| {
        if !l.orphans.iter().any(|t| t == token) {
            l.orphans.push(token.to_string());
        }
    })
    .await
    .map(|_| ())
}

/// Revokes `token`, an orphan of the group, and forgets it once it's gone.
async fn revoke_orphan(kept_at: &Path, hub: &impl BossHub, group: &str, token: &str) {
    if revoke(hub, token).await.is_ok() {
        let _ = change_group(kept_at, group, |l| l.orphans.retain(|t| t != token)).await;
    }
}

// ── Grants ──────────────────────────────────────────────────────────────

/// What a grant says, apart from its revision and what leaves it.
fn grant_says(boss_key: &str, choice: &Choice, name: &str, members: Vec<String>) -> Value {
    json!({
        "grantVersion": GRANT_VERSION,
        "name": name,
        "boss": boss_key,
        "level": choice.level,
        "sees": choice.sees,
        "recall": false,
        "folders": [],
        "repos": [],
        "members": members,
        "act": choice.act(),
    })
}

/// The revision the engine has for `group` (its grant's, or what a deleted
/// one left; 0 for none), and its grant.
async fn revision_on(engine: &impl Engine, group: &str) -> Result<(i64, Value), String> {
    let a = engine.call("GET", "/api/desk/grants", None).await?;
    if !ok(a.status) {
        return Err(format!(
            "Desk on {} didn't say its grants: {}",
            engine.name(),
            said(a.status, a.body.as_bytes())
        ));
    }
    let v = json_of(&a.body)
        .ok_or_else(|| format!("Desk on {} didn't say its grants.", engine.name()))?;
    let held = v["grants"]
        .as_array()
        .and_then(|gs| gs.iter().find(|g| g["group"] == group))
        .cloned()
        .unwrap_or(Value::Null);
    let have = held["revision"]
        .as_i64()
        .or_else(|| v["left"][group]["revision"].as_i64())
        .unwrap_or(0);
    Ok((have, held))
}

/// The sessions born in the group on an engine that the layout now lists
/// elsewhere: taken out of it.
fn leaving(held: &Value, group: &Group, engine: &str) -> Vec<String> {
    let elsewhere = group.elsewhere.get(engine);
    held["born"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|s| elsewhere.is_some_and(|e| e.iter().any(|x| x == s)))
        .map(str::to_string)
        .collect()
}

/// Writes `says` to `engine` as `group`'s grant: at `same` (the revision
/// last written) when it says nothing new, which only renews it, else at
/// one past what the engine has. `resume` lets a stopped grant go on: only
/// after the person said so natively. A write another one overtook is
/// tried once more, past what the engine has then. The revision written.
async fn write_grant(
    engine: &impl Engine,
    group: &Group,
    says: &Value,
    same: Option<i64>,
    resume: bool,
) -> Result<i64, String> {
    let mut tries = 0;
    loop {
        tries += 1;
        let (have, held) = revision_on(engine, &group.id).await?;
        let revision = match same {
            Some(r) if r == have && !resume && tries == 1 => r,
            _ => have + 1,
        };
        let mut body = says.clone();
        body["revision"] = json!(revision);
        body["leaving"] = json!(leaving(&held, group, engine.id()));
        if resume {
            body["resume"] = json!(true);
        }
        let body = Zeroizing::new(body.to_string());
        let a = engine
            .call(
                "PUT",
                &format!("/api/desk/grants/{}", seg(&group.id)),
                Some(&body),
            )
            .await?;
        if ok(a.status) {
            return Ok(revision);
        }
        if a.status == 409 && tries < 2 {
            continue;
        }
        return Err(format!(
            "Desk on {} didn't take the grant: {}",
            engine.name(),
            said(a.status, a.body.as_bytes())
        ));
    }
}

/// Stops `group`'s grant on `engine` at once, as Desk's Stop.
async fn stop_on(engine: &impl Engine, group: &str) -> Result<(), String> {
    let body = Zeroizing::new(json!({ "group": group, "from": "desk" }).to_string());
    let a = engine
        .call("POST", "/api/desk/bosses/stop", Some(&body))
        .await?;
    if ok(a.status) {
        Ok(())
    } else {
        Err(format!(
            "Desk on {} didn't stop it: {}",
            engine.name(),
            said(a.status, a.body.as_bytes())
        ))
    }
}

/// Deletes `group`'s grant on `engine` (what it leaves keeps its stop).
async fn delete_grant(engine: &impl Engine, group: &str) -> Result<(), String> {
    match engine
        .call("DELETE", &format!("/api/desk/grants/{}", seg(group)), None)
        .await
    {
        Ok(a) if ok(a.status) || a.status == 404 => Ok(()),
        Ok(a) => Err(said(a.status, a.body.as_bytes())),
        Err(why) => Err(why),
    }
}

// ── The commands' work ──────────────────────────────────────────────────

/// Where each engine of a group stands after a change, for the page.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Done {
    /// The person said no: nothing was sent.
    pub cancelled: bool,
    /// The engines it was done on, by name.
    pub done: Vec<String>,
    pub failed: Vec<Failed>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Failed {
    pub engine: String,
    pub why: String,
}

impl Done {
    fn cancelled() -> Self {
        Self {
            cancelled: true,
            ..Self::default()
        }
    }

    fn fail(&mut self, engine: &str, why: String) {
        self.failed.push(Failed {
            engine: engine.to_string(),
            why,
        });
    }
}

/// The engines of a group: this computer's, and each machine that holds
/// its sessions (`Err` with why one can't be reached).
pub struct Engines<E> {
    pub here: E,
    pub machines: Vec<(String, Result<E, String>)>,
}

impl<E: Engine> Engines<E> {
    fn names(&self) -> BTreeMap<String, String> {
        let mut names: BTreeMap<String, String> = self
            .machines
            .iter()
            .map(|(id, e)| {
                (
                    id.clone(),
                    e.as_ref().map_or(id.clone(), |e| e.name().to_string()),
                )
            })
            .collect();
        names.insert(LOCAL_ENGINE.into(), HERE.into());
        names
    }

    fn name_of(&self, id: &str) -> String {
        self.names().remove(id).unwrap_or_else(|| id.to_string())
    }

    fn get(&self, id: &str) -> Result<&E, String> {
        if id == LOCAL_ENGINE {
            return Ok(&self.here);
        }
        match self.machines.iter().find(|(m, _)| m == id) {
            Some((_, Ok(e))) => Ok(e),
            Some((_, Err(why))) => Err(why.clone()),
            None => Err(format!("{id} isn't one of Desk's machines any more.")),
        }
    }
}

/// The native question, Cancel first: `Ok(true)` only on its yes; `Err`
/// when it can't be asked now.
pub trait Ask: FnOnce(String, String, String) -> Self::Answer {
    type Answer: Future<Output = Result<bool, String>>;
}

impl<A, F> Ask for A
where
    A: FnOnce(String, String, String) -> F,
    F: Future<Output = Result<bool, String>>,
{
    type Answer = F;
}

/// The question that makes `agent` on `at` the boss of `group` at
/// `choice`, in place of `replaces`.
fn link_question(
    at: &HubAt,
    agent: &str,
    group: &Group,
    names: &BTreeMap<String, String>,
    choice: &Choice,
    replaces: Option<&GroupLink>,
) -> String {
    let boss = capital(agent);
    let instead = replaces.map_or(String::new(), |r| {
        format!(
            ", in place of {} on {}",
            capital(&r.agent),
            quoted(&r.hub_label)
        )
    });
    format!(
        "{}\n\nLet {boss} on {} boss {}{instead}?\n\n{}",
        terms(choice),
        hub_words(at),
        sessions_phrase(group, names),
        what_it_means(&boss, &quoted(&at.label), &quoted(&group.name), choice)
    )
}

/// What one engine's linking did.
enum Linked {
    Yes,
    No(String),
    /// The agent declined boss work: no other engine is asked.
    Declined(String),
}

/// Links engine `id` for group `group`: a new link minted (its token kept
/// among the orphans first), handed over, and the grant written; then kept
/// as the engine's. What fails is undone: the link taken off, the token
/// revoked.
#[allow(clippy::too_many_arguments)]
async fn link_engine<E: Engine, H: BossHub>(
    kept_at: &Path,
    engines: &Engines<E>,
    hub: &H,
    at: &HubAt,
    entry: &GroupLink,
    group: &Group,
    id: &str,
    resume: bool,
) -> Linked {
    let engine = match engines.get(id) {
        Ok(e) => e,
        Err(why) => return Linked::No(why),
    };
    if !name_ok(engine.id()) {
        return Linked::No(format!(
            "{}'s id can't name an engine in a link.",
            engine.name()
        ));
    }
    let minted = match mint(engine, hub, at, &entry.agent, group, None).await {
        Ok(m) => m,
        Err(MintError::Declined(why)) => return Linked::Declined(why),
        Err(e) => return Linked::No(e.words()),
    };
    if let Err(why) = keep_orphan(kept_at, &group.id, &minted.token_id).await {
        let _ = revoke(hub, &minted.token_id).await;
        return Linked::No(why);
    }
    if let Err(why) = hand(engine, at, &minted, &entry.agent, &group.id).await {
        revoke_orphan(kept_at, hub, &group.id, &minted.token_id).await;
        return Linked::No(why);
    }
    let says = grant_says(
        &entry.boss_key(),
        &entry.choice,
        &group.name,
        entry.allowed(group, id),
    );
    match write_grant(engine, group, &says, None, resume).await {
        Ok(revision) => {
            let link = EngineLink {
                name: engine.name().to_string(),
                link_id: minted.link_id.clone(),
                token_id: minted.token_id.clone(),
                expires_at: minted.expires_at,
                revision,
                written: says,
                reached_at: Some(Utc::now()),
                problem: None,
                stopped: false,
            };
            let kept = change_group(kept_at, &group.id, |l| {
                l.orphans.retain(|t| *t != minted.token_id);
                l.unlinked.remove(id);
                l.engines.insert(id.to_string(), link);
            })
            .await;
            match kept {
                Ok(_) => Linked::Yes,
                Err(why) => Linked::No(why),
            }
        }
        Err(why) => {
            // Not granted: the link comes off the engine, and is revoked.
            let _ = take_link_off(engine, &group.id, &minted.link_id).await;
            revoke_orphan(kept_at, hub, &group.id, &minted.token_id).await;
            Linked::No(why)
        }
    }
}

/// Makes `agent` on `at` the boss of group `group_id` at `choice`, once
/// the person says yes natively (see the module). A group with another
/// boss on another hub has it stopped first, in the same question;
/// `old_hub` says who revokes that boss's tokens ([`Revoke`]).
#[allow(clippy::too_many_arguments)]
pub async fn link<E, H>(
    kept_at: &Path,
    engines: &Engines<E>,
    hub: &H,
    at: &HubAt,
    old_hub: Revoke<'_, H>,
    group_id: &str,
    agent: &str,
    choice: Choice,
    ask: impl Ask,
) -> Result<Done, String>
where
    E: Engine,
    H: BossHub,
{
    let choice = choice.checked()?;
    if !agent_id_ok(agent) {
        return Err(format!("{agent:?} can't name an agent."));
    }
    if !name_ok(&at.id) || ["home", "local"].contains(&at.id.as_str()) {
        return Err(format!(
            "Desk can't make bosses of {}'s agents: its name in Desk can't be used for one.",
            at.label
        ));
    }
    if canonical(&at.base).as_deref() != Some(at.base.as_str()) {
        return Err(format!(
            "Desk reaches {} at an address an engine can't link to: a boss's hub is reached over https at its own name.",
            at.label
        ));
    }
    let group = layout_group(&engines.here, group_id).await?;
    let replaces = load_group(kept_at, group_id).await;
    if let Some(other) = &replaces
        && other.hub == at.id
        && other.agent == agent
    {
        return Err(format!(
            "{} already bosses {}: change it in the group's Boss sheet.",
            capital(agent),
            group.name
        ));
    }
    let boss = capital(agent);
    let question = link_question(
        at,
        agent,
        &group,
        &engines.names(),
        &choice,
        replaces.as_ref(),
    );
    if !ask(
        format!("Make {boss} a boss"),
        question,
        format!("Make {boss} the Boss"),
    )
    .await?
    {
        return Ok(Done::cancelled());
    }
    let ops = ops_of(kept_at, group_id);
    let _op = ops.lock().await;
    // What the person was asked to replace is what is there: another boss
    // made meanwhile isn't overwritten unasked.
    let there = load_group(kept_at, group_id).await;
    let who = |l: &GroupLink| (l.hub.clone(), l.agent.clone());
    if there.as_ref().map(who) != replaces.as_ref().map(who) && there.is_some() {
        return Err(format!(
            "{}'s boss changed while you were asked: open its Boss sheet again.",
            group.name
        ));
    }
    if there.is_some() {
        let stopped = stop_all(kept_at, engines, old_hub, group_id).await?;
        if !stopped.failed.is_empty() {
            return Err(format!(
                "Desk couldn't stop {}'s boss everywhere yet, so {boss} isn't linked: {}",
                group.name,
                stopped
                    .failed
                    .iter()
                    .map(|f| format!("{}: {}", f.engine, f.why))
                    .collect::<Vec<_>>()
                    .join(" ")
            ));
        }
    }
    // What the person was asked about is what the boss may run.
    let mut entry = GroupLink::new(at, agent, &choice);
    entry.confirmed = group.members.clone();
    {
        let _one = KEPT.lock().await;
        let mut kept = read_kept(kept_at);
        kept.groups.insert(group_id.to_string(), entry.clone());
        write_kept(kept_at, &kept)?;
    }
    let mut done = Done::default();
    let mut declined: Option<String> = None;
    for id in engines_of(&group) {
        let shown = engines.name_of(&id);
        let outcome = match &declined {
            Some(why) => Linked::No(why.clone()),
            // A new link lets a grant stopped before go on: the person said so.
            None => link_engine(kept_at, engines, hub, at, &entry, &group, &id, true).await,
        };
        let why = match outcome {
            Linked::Yes => {
                done.done.push(shown);
                continue;
            }
            Linked::No(why) => why,
            Linked::Declined(why) => {
                declined = Some(why.clone());
                why
            }
        };
        let _ = change_group(kept_at, group_id, |l| {
            l.unlinked.insert(
                id.clone(),
                NotLinked {
                    name: shown.clone(),
                    why: why.clone(),
                },
            );
        })
        .await;
        done.fail(&shown, why);
    }
    // Nothing linked and nothing to revoke: nothing kept.
    {
        let _one = KEPT.lock().await;
        let mut kept = read_kept(kept_at);
        if kept
            .groups
            .get(group_id)
            .is_some_and(|l| l.engines.is_empty() && l.orphans.is_empty())
        {
            kept.groups.remove(group_id);
            write_kept(kept_at, &kept)?;
        }
    }
    tracing::info!(group = %group_id, hub = %at.id, done = done.done.len(), failed = done.failed.len(), "linked a boss on another hub");
    Ok(done)
}

/// Changes how much group `group_id`'s boss may do and see. Asked first
/// when it gives more: a higher level, more seen, more money, or, at Act
/// and above, sessions the person hasn't let the boss run yet. Nothing
/// that narrows is asked, nor waits on a question.
pub async fn set<E, H>(
    kept_at: &Path,
    engines: &Engines<E>,
    hub: Option<(&H, &HubAt)>,
    group_id: &str,
    choice: Choice,
    ask: impl Ask,
) -> Result<Done, String>
where
    E: Engine,
    H: BossHub,
{
    let choice = choice.checked()?;
    let layout = read_layout(&engines.here).await?;
    let group = group_of(&layout, group_id)?;
    let link = load_group(kept_at, group_id)
        .await
        .ok_or_else(|| format!("{} has no boss on another hub.", group.name))?;
    let boss = capital(&link.agent);
    let mut after = link.clone();
    after.choice = choice.clone();
    let more_sessions = after.waiting(&group) > 0;
    let asked = choice.widens(&link.choice) || more_sessions;
    if asked {
        let at = HubAt {
            id: link.hub.clone(),
            label: link.hub_label.clone(),
            base: hub.map_or_else(|| link.hub_base.clone(), |(_, at)| at.base.clone()),
        };
        let question = format!(
            "{}\n\nLet {boss} on {} boss {}?\n\n{}",
            terms(&choice),
            hub_words(&at),
            sessions_phrase(&group, &engines.names()),
            what_it_means(&boss, &quoted(&at.label), &quoted(&group.name), &choice)
        );
        if !ask(format!("Give {boss} more"), question, "Save".into()).await? {
            return Ok(Done::cancelled());
        }
    }
    let ops = ops_of(kept_at, group_id);
    let _op = ops.lock().await;
    change_group(kept_at, group_id, |l| {
        l.choice = choice.clone();
        // What the person was just asked about, or, below Act, the group.
        if asked || choice.level < Level::Act {
            l.confirmed = group.members.clone();
        }
    })
    .await?
    .ok_or_else(|| format!("{} has no boss on another hub.", group.name))?;
    let mut done = Done::default();
    sync(kept_at, engines, hub, group_id, &layout, false, &mut done).await;
    Ok(done)
}

/// Sends `group`'s stop to every engine it is linked on, all at once.
async fn stops<E: Engine>(
    engines: &Engines<E>,
    group: &str,
    ids: &[String],
) -> Vec<(String, Result<(), String>)> {
    let sent = ids.iter().map(|id| async move {
        let r = match engines.get(id) {
            Ok(e) => stop_on(e, group).await,
            Err(why) => Err(why),
        };
        (id.clone(), r)
    });
    futures_util::future::join_all(sent).await
}

/// Pauses group `group_id`'s boss on every engine, at once. Paused is only
/// said once every engine has taken its stop; until then keeping alive
/// sends it again, and renews nothing.
pub async fn pause<E: Engine>(
    kept_at: &Path,
    engines: &Engines<E>,
    group_id: &str,
) -> Result<Done, String> {
    let link = load_group(kept_at, group_id)
        .await
        .ok_or("That group has no boss on another hub.")?;
    let ids: Vec<String> = link.engines.keys().cloned().collect();
    // At once, before waiting on anything.
    stops(engines, group_id, &ids).await;
    let ops = ops_of(kept_at, group_id);
    let _op = ops.lock().await;
    // Again, past any change that was under way: on every engine linked
    // now, those it linked meanwhile too.
    let ids: Vec<String> = load_group(kept_at, group_id)
        .await
        .map(|l| l.engines.into_keys().collect())
        .unwrap_or(ids);
    let sent = stops(engines, group_id, &ids).await;
    let mut done = Done::default();
    change_group(kept_at, group_id, |l| {
        l.paused = true;
        for (id, r) in &sent {
            let Some(e) = l.engines.get_mut(id) else {
                continue;
            };
            match r {
                Ok(()) => {
                    e.stopped = true;
                    e.problem = None;
                    done.done.push(e.name.clone());
                }
                Err(why) => {
                    e.problem = Some(why.clone());
                    done.fail(&e.name, why.clone());
                }
            }
        }
    })
    .await?;
    Ok(done)
}

/// Lets group `group_id`'s paused boss go on, once the person says so.
pub async fn resume<E, H>(
    kept_at: &Path,
    engines: &Engines<E>,
    hub: Option<(&H, &HubAt)>,
    group_id: &str,
    ask: impl Ask,
) -> Result<Done, String>
where
    E: Engine,
    H: BossHub,
{
    let layout = read_layout(&engines.here).await?;
    let group = group_of(&layout, group_id)?;
    let link = load_group(kept_at, group_id)
        .await
        .ok_or_else(|| format!("{} has no boss on another hub.", group.name))?;
    if link.stopping {
        return Err(format!(
            "{} was stopped: make a boss of it again.",
            capital(&link.agent)
        ));
    }
    let boss = capital(&link.agent);
    let at = HubAt {
        id: link.hub.clone(),
        label: link.hub_label.clone(),
        base: hub.map_or_else(|| link.hub_base.clone(), |(_, at)| at.base.clone()),
    };
    let question = format!(
        "{}\n\nLet {boss} on {} go on bossing {}?\n\n{}",
        terms(&link.choice),
        hub_words(&at),
        sessions_phrase(&group, &engines.names()),
        what_it_means(
            &boss,
            &quoted(&at.label),
            &quoted(&group.name),
            &link.choice
        )
    );
    if !ask(format!("Let {boss} go on"), question, "Go On".into()).await? {
        return Ok(Done::cancelled());
    }
    let ops = ops_of(kept_at, group_id);
    let _op = ops.lock().await;
    change_group(kept_at, group_id, |l| {
        l.paused = false;
        l.confirmed = group.members.clone();
        for e in l.engines.values_mut() {
            e.stopped = false;
        }
    })
    .await?;
    let mut done = Done::default();
    sync(kept_at, engines, hub, group_id, &layout, true, &mut done).await;
    if !done.failed.is_empty() {
        // Not every engine let it go on: it stays paused, and says where.
        let _ = change_group(kept_at, group_id, |l| l.paused = true).await;
        pause_quietly(kept_at, engines, group_id).await;
    }
    Ok(done)
}

/// Stops again the engines that went on, when another didn't.
async fn pause_quietly<E: Engine>(kept_at: &Path, engines: &Engines<E>, group_id: &str) {
    let Some(link) = load_group(kept_at, group_id).await else {
        return;
    };
    let ids: Vec<String> = link.engines.keys().cloned().collect();
    let sent = stops(engines, group_id, &ids).await;
    let _ = change_group(kept_at, group_id, |l| {
        for (id, r) in sent {
            if let Some(e) = l.engines.get_mut(&id) {
                e.stopped = r.is_ok();
            }
        }
    })
    .await;
}

/// Stop: ends group `group_id`'s boss on another hub. Every engine's stop
/// is sent first, all at once, before waiting on anything; then every
/// token is revoked, each link taken off its engine and each grant
/// deleted. What couldn't be done is said, and tried again by keeping
/// alive (and by Stop pressed again) until it is: nothing else is.
/// `hub` says who revokes the tokens ([`Revoke`]).
pub async fn unlink<E, H>(
    kept_at: &Path,
    engines: &Engines<E>,
    hub: Revoke<'_, H>,
    group_id: &str,
) -> Result<Done, String>
where
    E: Engine,
    H: BossHub,
{
    let Some(link) = load_group(kept_at, group_id).await else {
        return Ok(Done::default());
    };
    let ids: Vec<String> = link.engines.keys().cloned().collect();
    stops(engines, group_id, &ids).await;
    let ops = ops_of(kept_at, group_id);
    let _op = ops.lock().await;
    stop_all(kept_at, engines, hub, group_id).await
}

/// Who revokes a stopped boss's tokens.
pub enum Revoke<'a, H> {
    /// The boss's hub, paired and reached.
    By(&'a H),
    /// Desk is no longer paired with it: its tokens went with the pairing.
    PairingGone,
    /// Paired, but not reached now: every token is kept, and revoked once
    /// it is.
    Later,
}

impl<'a, H> Revoke<'a, H> {
    /// Paired and reached, or not reached now.
    pub fn from(hub: Option<&'a H>) -> Self {
        hub.map_or(Self::Later, Self::By)
    }
}

/// Stop's steps, with the group's changes held: marked stopping, then
/// each engine stopped, every token revoked, each link taken off and each
/// grant deleted; what is done is forgotten.
async fn stop_all<E, H>(
    kept_at: &Path,
    engines: &Engines<E>,
    hub: Revoke<'_, H>,
    group_id: &str,
) -> Result<Done, String>
where
    E: Engine,
    H: BossHub,
{
    let Some(link) = change_group(kept_at, group_id, |l| {
        l.stopping = true;
        l.paused = true;
        l.clone()
    })
    .await?
    else {
        return Ok(Done::default());
    };
    let ids: Vec<String> = link.engines.keys().cloned().collect();
    let stopped = stops(engines, group_id, &ids).await;
    // Every token: each engine's, and those no engine holds.
    let tokens: Vec<String> = link
        .engines
        .values()
        .map(|l| l.token_id.clone())
        .chain(link.orphans.iter().cloned())
        .collect();
    let revoked: Vec<(String, Result<(), String>)> = match hub {
        Revoke::By(h) => {
            futures_util::future::join_all(
                tokens
                    .iter()
                    .map(|t| async move { (t.clone(), revoke(h, t).await) }),
            )
            .await
        }
        Revoke::PairingGone => tokens.iter().map(|t| (t.clone(), Ok(()))).collect(),
        Revoke::Later => tokens
            .iter()
            .map(|t| {
                let why = format!("Desk can't reach {} now.", link.hub_label);
                (t.clone(), Err(why))
            })
            .collect(),
    };
    let cleared = futures_util::future::join_all(link.engines.iter().map(|(id, l)| async move {
        let mut problems: Vec<String> = Vec::new();
        match engines.get(id) {
            Ok(e) => {
                if let Err(why) = take_link_off(e, group_id, &l.link_id).await {
                    problems.push(why);
                }
                if let Err(why) = delete_grant(e, group_id).await {
                    problems.push(why);
                }
            }
            Err(why) => problems.push(why),
        }
        (id.clone(), problems)
    }))
    .await;
    let mut done = Done::default();
    let gone = change_group(kept_at, group_id, |l| {
        for (id, r) in &stopped {
            if let Some(e) = l.engines.get_mut(id) {
                e.stopped |= r.is_ok();
            }
        }
        for (t, r) in &revoked {
            if r.is_ok() {
                l.orphans.retain(|o| o != t);
            } else if l.engines.values().any(|e| e.token_id == *t) && !l.orphans.contains(t) {
                // Its engine may be cleared before it is: kept to revoke.
                l.orphans.push(t.clone());
            }
        }
        for (id, problems) in &cleared {
            let name = l.engines.get(id).map_or(id.clone(), |e| e.name.clone());
            if problems.is_empty() {
                l.engines.remove(id);
                done.done.push(name);
            } else {
                let why = problems.join(" ");
                if let Some(e) = l.engines.get_mut(id) {
                    e.problem = Some(why.clone());
                }
                done.fail(&name, why);
            }
        }
        l.unlinked.clear();
        let left = l.orphans.len();
        if left > 0 && done.failed.is_empty() {
            done.fail(
                &l.hub_label,
                format!(
                    "{} didn't revoke {left} of its links yet: Desk tries again.",
                    l.hub_label
                ),
            );
        }
        l.engines.is_empty() && l.orphans.is_empty()
    })
    .await?;
    if gone == Some(true) {
        let _one = KEPT.lock().await;
        let mut kept = read_kept(kept_at);
        kept.groups.remove(group_id);
        write_kept(kept_at, &kept)?;
    }
    tracing::info!(group = %group_id, done = done.done.len(), failed = done.failed.len(), "stopped a boss on another hub");
    Ok(done)
}

/// Brings group `group_id`'s boss up to date on every engine, as the
/// person last said: what keeping alive, Try again, and each change do.
///
/// - **Stopping:** Stop's steps alone, again.
/// - **Paused:** each engine that hasn't taken its stop is sent it again;
///   no grant is written and no token renewed.
/// - **Otherwise:** tokens no engine holds are revoked; each linked
///   engine's grant written (the same revision when it says nothing new,
///   which only renews it), and its token renewed with under
///   [`RENEW_UNDER`] left, or made anew once expired; and each engine that
///   holds sessions the boss may run, and isn't linked, linked.
///
/// `resume` (a grant stopped before goes on) only after the person said so
/// natively. `hub` is none when Desk can't reach the boss's hub: nothing
/// is minted or revoked then.
async fn sync<E, H>(
    kept_at: &Path,
    engines: &Engines<E>,
    hub: Option<(&H, &HubAt)>,
    group_id: &str,
    layout: &Value,
    resume: bool,
    done: &mut Done,
) where
    E: Engine,
    H: BossHub,
{
    let Some(entry) = load_group(kept_at, group_id).await else {
        return;
    };
    if entry.stopping {
        match stop_all(
            kept_at,
            engines,
            Revoke::from(hub.map(|(h, _)| h)),
            group_id,
        )
        .await
        {
            Ok(d) => *done = d,
            Err(why) => done.fail(&entry.hub_label, why),
        }
        return;
    }
    if let Some((h, _)) = hub {
        for t in &entry.orphans {
            revoke_orphan(kept_at, h, group_id, t).await;
        }
    }
    if entry.paused {
        let ids: Vec<String> = entry
            .engines
            .iter()
            .filter(|(_, e)| !e.stopped)
            .map(|(id, _)| id.clone())
            .collect();
        let sent = stops(engines, group_id, &ids).await;
        let _ = change_group(kept_at, group_id, |l| {
            for (id, r) in sent {
                if let Some(e) = l.engines.get_mut(&id) {
                    match r {
                        Ok(()) => {
                            e.stopped = true;
                            e.problem = None;
                        }
                        Err(why) => e.problem = Some(why),
                    }
                }
            }
        })
        .await;
        return;
    }
    let Ok(group) = group_of(layout, group_id) else {
        // The group is gone from the sidebar: its grants expire on their
        // own; Stop in Desk ends them now.
        return;
    };
    if entry.choice.level >= Level::Act {
        // What left the group is no longer the person's say-so: back in,
        // it waits on them again.
        let _ = change_group(kept_at, group_id, |l| {
            for (e, said) in l.confirmed.iter_mut() {
                let now = group.members.get(e);
                said.retain(|s| now.is_some_and(|n| n.contains(s)));
            }
        })
        .await;
    }
    let boss_key = entry.boss_key();
    let now = Utc::now();
    for (id, l) in &entry.engines {
        let engine = match engines.get(id) {
            Ok(e) => e,
            Err(why) => {
                done.fail(&l.name, why.clone());
                let _ = change_group(kept_at, group_id, |g| {
                    if let Some(e) = g.engines.get_mut(id) {
                        e.problem = Some(why);
                    }
                })
                .await;
                continue;
            }
        };
        let says = grant_says(
            &boss_key,
            &entry.choice,
            &group.name,
            entry.allowed(&group, id),
        );
        let same = (says == l.written).then_some(l.revision);
        let written = write_grant(engine, &group, &says, same, resume).await;
        let failed = written.as_ref().err().cloned();
        let _ = change_group(kept_at, group_id, |g| {
            if let Some(e) = g.engines.get_mut(id) {
                match written {
                    Ok(r) => {
                        e.revision = r;
                        e.written = says;
                        e.reached_at = Some(now);
                        e.problem = None;
                    }
                    Err(why) => e.problem = Some(why),
                }
            }
        })
        .await;
        if let Some(why) = failed {
            done.fail(&l.name, why);
            continue;
        }
        if let Some((h, at)) = hub
            && l.expires_at - now < RENEW_UNDER
            && let Err(why) = renew(kept_at, engine, h, at, &entry, &group, id, l, now).await
        {
            let _ = change_group(kept_at, group_id, |g| {
                if let Some(e) = g.engines.get_mut(id) {
                    e.problem = Some(why.clone());
                }
            })
            .await;
            done.fail(&l.name, why);
            continue;
        }
        done.done.push(l.name.clone());
    }
    let Some((h, at)) = hub else {
        return;
    };
    // Engines with sessions the boss may run, not linked yet: a machine new
    // to the group, or one that failed before.
    for id in engines_of(&group) {
        if entry.engines.contains_key(&id) || entry.allowed(&group, &id).is_empty() {
            continue;
        }
        let shown = engines.name_of(&id);
        // One the person linked before, which failed, goes on as they said:
        // the group isn't paused here.
        let goes_on = resume || entry.unlinked.contains_key(&id);
        let why = match link_engine(kept_at, engines, h, at, &entry, &group, &id, goes_on).await {
            Linked::Yes => {
                done.done.push(shown);
                continue;
            }
            Linked::No(why) | Linked::Declined(why) => why,
        };
        let _ = change_group(kept_at, group_id, |l| {
            l.unlinked.insert(
                id.clone(),
                NotLinked {
                    name: shown.clone(),
                    why: why.clone(),
                },
            );
        })
        .await;
        done.fail(&shown, why);
    }
}

/// Renews engine `id`'s token: minted again (as a renewal while it lasts,
/// anew once it's gone), handed over, the old link taken off the engine
/// when the new one is another, and the old token revoked. The old token
/// is kept, as an orphan, until it is; a new one not handed over is
/// revoked, and the old one stays the engine's.
#[allow(clippy::too_many_arguments)]
async fn renew<E: Engine, H: BossHub>(
    kept_at: &Path,
    engine: &E,
    hub: &H,
    at: &HubAt,
    entry: &GroupLink,
    group: &Group,
    id: &str,
    l: &EngineLink,
    now: DateTime<Utc>,
) -> Result<(), String> {
    let renews = (l.expires_at > now).then_some(l.token_id.as_str());
    let minted = match mint(engine, hub, at, &entry.agent, group, renews).await {
        Ok(m) => m,
        Err(MintError::Gone) => mint(engine, hub, at, &entry.agent, group, None)
            .await
            .map_err(MintError::words)?,
        Err(e) => return Err(e.words()),
    };
    if let Err(why) = keep_orphan(kept_at, &group.id, &minted.token_id).await {
        if revoke(hub, &minted.token_id).await.is_err() {
            tracing::warn!(token_id = %minted.token_id, group = %group.id, "a renewed boss link was neither kept nor revoked: it lives until it expires");
        }
        return Err(why);
    }
    if let Err(why) = hand(engine, at, &minted, &entry.agent, &group.id).await {
        revoke_orphan(kept_at, hub, &group.id, &minted.token_id).await;
        return Err(why);
    }
    if minted.link_id != l.link_id {
        let _ = take_link_off(engine, &group.id, &l.link_id).await;
    }
    let old = l.token_id.clone();
    change_group(kept_at, &group.id, |g| {
        g.orphans.retain(|t| *t != minted.token_id);
        if old != minted.token_id && !g.orphans.contains(&old) {
            g.orphans.push(old.clone());
        }
        if let Some(e) = g.engines.get_mut(id) {
            e.token_id = minted.token_id.clone();
            e.link_id = minted.link_id.clone();
            e.expires_at = minted.expires_at;
        }
    })
    .await?;
    if old != minted.token_id {
        revoke_orphan(kept_at, hub, &group.id, &old).await;
    }
    Ok(())
}

/// Try again: group `group_id`'s boss brought up to date on every engine,
/// linking those it failed on. Nothing it gives the boss is new: what the
/// person said stands.
pub async fn retry<E, H>(
    kept_at: &Path,
    engines: &Engines<E>,
    hub: Option<(&H, &HubAt)>,
    group_id: &str,
) -> Result<Done, String>
where
    E: Engine,
    H: BossHub,
{
    let layout = read_layout(&engines.here).await?;
    let ops = ops_of(kept_at, group_id);
    let _op = ops.lock().await;
    let mut done = Done::default();
    sync(kept_at, engines, hub, group_id, &layout, false, &mut done).await;
    Ok(done)
}

/// Lets every boss on engine `id` go on after its own pause (`desk-helper
/// bosses stop` there), once the person says so.
pub async fn unpause_engine<E: Engine>(
    engines: &Engines<E>,
    id: &str,
    ask: impl Ask,
) -> Result<Done, String> {
    let engine = engines.get(id)?;
    let name = quoted(engine.name());
    let question = format!(
        "Every boss on {name} was paused there. Let them go on?\n\nEach goes on only as far as its own grant says; a group you paused or stopped in Desk stays as it is."
    );
    if !ask(
        format!("Let the bosses on {name} go on"),
        question,
        "Go On".into(),
    )
    .await?
    {
        return Ok(Done::cancelled());
    }
    let mut done = Done::default();
    match engine.call("DELETE", "/api/desk/bosses/paused", None).await {
        Ok(a) if ok(a.status) => done.done.push(engine.name().to_string()),
        Ok(a) => done.fail(engine.name(), said(a.status, a.body.as_bytes())),
        Err(why) => done.fail(engine.name(), why),
    }
    Ok(done)
}

/// Stops every group whose boss is on hub `hub`, once Desk forgot it: its
/// tokens went with the pairing, so none is revoked.
pub async fn hub_gone<E: Engine, H: BossHub>(kept_at: &Path, engines: &Engines<E>, hub: &str) {
    let groups: Vec<String> = load(kept_at)
        .await
        .groups
        .into_iter()
        .filter(|(_, l)| l.hub == hub)
        .map(|(g, _)| g)
        .collect();
    for g in groups {
        if let Err(e) = unlink::<E, H>(kept_at, engines, Revoke::PairingGone, &g).await {
            tracing::warn!(error = %e, "a removed hub's boss wasn't stopped everywhere");
        }
    }
}

// ── Status ──────────────────────────────────────────────────────────────

/// One engine of a group's boss, as the page shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub engine: String,
    pub name: String,
    /// Whether a link is held there; when not, `problem` says why.
    pub linked: bool,
    /// Its session count in the group.
    pub sessions: usize,
    /// Whether its grant serves the boss now; none when it couldn't be read.
    pub live: Option<bool>,
    /// Why not, in the engine's words.
    pub why: Option<String>,
    /// Every boss there is paused by its own `desk-helper bosses stop`.
    pub engine_paused: bool,
    /// It took its stop since the group was paused.
    pub stopped: bool,
    pub expires_at: Option<DateTime<Utc>>,
    pub reached_at: Option<DateTime<Utc>>,
    pub problem: Option<String>,
    /// Other groups on this engine the same boss runs below Act fully, or
    /// without a budget, by name and level: Act fully needs all of them at
    /// it.
    pub below_full: Vec<String>,
    /// Real money the boss spent on the group here today, at Act fully, as
    /// the engine's ledger has it (`spentTodayUsd`); none below Act fully,
    /// or from a hub too old to say it.
    pub spent_today_usd: Option<f64>,
}

/// A group's boss on another hub, as the page shows it: never a token.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub hub: String,
    pub hub_label: String,
    pub agent: String,
    /// As the engines name it among their parties (`<hub>/<agent>`).
    pub party: String,
    pub choice: Choice,
    /// Paused, and every engine took its stop.
    pub paused: bool,
    /// Paused, but not every engine has taken its stop yet.
    pub pausing: bool,
    /// Stopped, but not every engine is clear yet.
    pub stopping: bool,
    /// The group's sessions the boss doesn't run until the person says so.
    pub waiting: usize,
    /// Real money the boss spent on the group today, every engine at Act
    /// fully added up; none when one of them didn't say ("not known").
    pub spent_today_usd: Option<f64>,
    pub engines: Vec<EngineStatus>,
}

/// What a grant's level is called to the person.
fn level_words(v: &Value) -> &'static str {
    serde_json::from_value::<Level>(v.clone()).map_or("Watch only", Level::words)
}

/// Group `group_id`'s boss on another hub, each engine asked how it
/// stands now; none when it has none.
pub async fn status<E: Engine>(
    kept_at: &Path,
    engines: &Engines<E>,
    group_id: &str,
) -> Option<Status> {
    let l = load_group(kept_at, group_id).await?;
    let group = layout_group(&engines.here, group_id).await.ok();
    let boss_key = l.boss_key();
    let mut shown = Vec::new();
    for (id, e) in &l.engines {
        let mut s = EngineStatus {
            engine: id.clone(),
            name: e.name.clone(),
            linked: true,
            sessions: e.written["members"].as_array().map_or(0, Vec::len),
            live: None,
            why: None,
            engine_paused: false,
            stopped: e.stopped,
            expires_at: Some(e.expires_at),
            reached_at: e.reached_at,
            problem: e.problem.clone(),
            below_full: Vec::new(),
            spent_today_usd: None,
        };
        match engines.get(id) {
            Ok(engine) => match engine.call("GET", "/api/desk/grants", None).await {
                Ok(a) if ok(a.status) => {
                    let v = json_of(&a.body).unwrap_or(Value::Null);
                    s.engine_paused = v["paused"].is_object();
                    for g in v["grants"].as_array().into_iter().flatten() {
                        if g["group"] == group_id {
                            s.live = g["live"].as_bool();
                            s.why = g["why"].as_str().map(str::to_string);
                            s.spent_today_usd = g["spentTodayUsd"]
                                .as_f64()
                                .filter(|u| u.is_finite() && *u >= 0.0);
                        } else if g["boss"] == boss_key.as_str()
                            && g["live"] == true
                            && (g["level"] != "full"
                                || g["act"]["budget_usd_per_day"]
                                    .as_f64()
                                    .is_none_or(|b| b <= 0.0))
                        {
                            let name = g["name"].as_str().unwrap_or("another group");
                            s.below_full
                                .push(format!("{name} ({})", level_words(&g["level"])));
                        }
                    }
                    if s.live.is_none() {
                        s.live = Some(false);
                        s.why = Some(format!("Desk on {} holds no grant for this group.", e.name));
                    }
                }
                Ok(a) => s.problem = Some(said(a.status, a.body.as_bytes())),
                Err(why) => s.problem = Some(why),
            },
            Err(why) => s.problem = Some(why),
        }
        shown.push(s);
    }
    for (id, n) in &l.unlinked {
        if l.engines.contains_key(id) {
            continue;
        }
        shown.push(EngineStatus {
            engine: id.clone(),
            name: n.name.clone(),
            linked: false,
            sessions: group
                .as_ref()
                .and_then(|g| g.members.get(id))
                .map_or(0, Vec::len),
            live: Some(false),
            why: None,
            engine_paused: false,
            stopped: false,
            expires_at: None,
            reached_at: None,
            problem: Some(n.why.clone()),
            below_full: Vec::new(),
            spent_today_usd: None,
        });
    }
    let all_stopped = l.engines.values().all(|e| e.stopped);
    // Known only when every engine holding a link at Act fully says it.
    let spent_today_usd = (l.choice.level == Level::Full)
        .then(|| {
            shown
                .iter()
                .filter(|s| s.linked)
                .map(|s| s.spent_today_usd)
                .sum::<Option<f64>>()
        })
        .flatten();
    Some(Status {
        hub: l.hub.clone(),
        hub_label: l.hub_label.clone(),
        agent: l.agent.clone(),
        party: format!("{}/{}", l.hub, l.agent),
        choice: l.choice.clone(),
        paused: l.paused && !l.stopping && all_stopped,
        pausing: l.paused && !l.stopping && !all_stopped,
        stopping: l.stopping,
        waiting: group.as_ref().map_or(0, |g| l.waiting(g)),
        spent_today_usd,
        engines: shown,
    })
}

// ── Keeping it alive ────────────────────────────────────────────────────

/// Keeps every group's boss up to date ([`sync`]), passing over a group
/// being changed, and one whose hub Desk can't reach (it is renewed again
/// once it can; a hub Desk forgot has its groups stopped).
pub async fn keep<E, H>(
    kept_at: &Path,
    engines: &Engines<E>,
    hub_of: impl Fn(&str) -> Option<(H, HubAt)>,
) -> Result<(), String>
where
    E: Engine,
    H: BossHub,
{
    let kept = load(kept_at).await;
    if kept.groups.is_empty() {
        return Ok(());
    }
    let layout = read_layout(&engines.here).await?;
    for (group_id, entry) in &kept.groups {
        let ops = ops_of(kept_at, group_id);
        let Ok(_op) = ops.try_lock() else {
            continue;
        };
        let hub = hub_of(&entry.hub);
        if hub.is_none() && !entry.paused && !entry.stopping {
            continue;
        }
        let mut done = Done::default();
        sync(
            kept_at,
            engines,
            hub.as_ref().map(|(h, at)| (h, at)),
            group_id,
            &layout,
            false,
            &mut done,
        )
        .await;
    }
    Ok(())
}

// ── The native side's wiring ────────────────────────────────────────────

/// An engine as the commands reach it: this computer's hub through its
/// broker, a machine's through its own.
pub struct Via<'a> {
    id: String,
    name: String,
    broker: Reached<'a>,
}

enum Reached<'a> {
    Here(&'a Broker),
    There(Arc<Broker>),
}

impl Engine for Via<'_> {
    fn id(&self) -> &str {
        &self.id
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn call(
        &self,
        method: &str,
        target: &str,
        body: Option<&Zeroizing<String>>,
    ) -> impl Future<Output = Result<NativeAnswer, String>> + Send {
        let broker: &Broker = match &self.broker {
            Reached::Here(b) => b,
            Reached::There(b) => b,
        };
        broker.fetch_boss(method, target, body)
    }
}

/// The boss's hub, with this Desk's device token there.
pub struct PairedHub<'a> {
    io: &'a HubIo,
    hub: String,
}

impl BossHub for PairedHub<'_> {
    fn call(
        &self,
        method: &str,
        target: &str,
        body: Option<&Zeroizing<String>>,
    ) -> impl Future<Output = Result<(u16, Zeroizing<Vec<u8>>), String>> + Send {
        let body = body.map(|b| ("application/json".to_string(), b.as_bytes().to_vec()));
        async move {
            let (meta, bytes) = self.io.fetch(&self.hub, method, target, body).await?;
            Ok((meta.status, Zeroizing::new(bytes)))
        }
    }
}

/// This computer's engine and every machine's, as the commands reach them.
fn engines_now<'a>(local: &'a Broker, machines: &MachineIo, ids: &[String]) -> Engines<Via<'a>> {
    let here = Via {
        id: LOCAL_ENGINE.into(),
        name: HERE.into(),
        broker: Reached::Here(local),
    };
    let machines = ids
        .iter()
        .filter(|id| id.as_str() != LOCAL_ENGINE)
        .map(|id| {
            let reached = machines.link(id).and_then(|link| {
                let name = link.machine().name.clone();
                machines.broker(id).map(|b| Via {
                    id: id.clone(),
                    name,
                    broker: Reached::There(b),
                })
            });
            (id.clone(), reached)
        })
        .collect();
    Engines { here, machines }
}

/// The machines a group's sessions are on, and those it was linked on.
async fn machine_ids(local: &Broker, kept_at: &Path, group: Option<&str>) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    if let Ok(a) = local.fetch_boss("GET", "/api/desk/layout", None).await
        && let Some(layout) = json_of(&a.body)
    {
        for g in layout["groups"].as_array().into_iter().flatten() {
            if group.is_some_and(|id| g["id"] != id) {
                continue;
            }
            for item in g["items"].as_array().into_iter().flatten() {
                if let Some((m, _)) = item
                    .as_str()
                    .and_then(|k| k.strip_prefix("session:"))
                    .and_then(|k| k.split_once('/'))
                {
                    ids.push(m.to_string());
                }
            }
        }
    }
    let kept = {
        let _one = KEPT.lock().await;
        read_kept(kept_at)
    };
    for (g, l) in &kept.groups {
        if group.is_none_or(|id| id == g) {
            ids.extend(l.engines.keys().cloned());
        }
    }
    ids.sort();
    ids.dedup();
    ids.retain(|id| id != LOCAL_ENGINE);
    ids
}

fn kept_path() -> Result<PathBuf, String> {
    desk_core::Paths::new()
        .map(|p| p.root.join(KEPT_FILE))
        .map_err(|e| e.to_string())
}

async fn hub_at(io: &HubIo, hub: &str) -> Result<HubAt, String> {
    let (base, label) = io.boss_hub(hub).await?;
    let base =
        canonical(base.as_str()).unwrap_or_else(|| base.as_str().trim_end_matches('/').to_string());
    Ok(HubAt {
        id: hub.to_string(),
        label,
        base,
    })
}

// ── Asking natively ─────────────────────────────────────────────────────

/// How long a Cancel quietens the question, doubling with each in a row,
/// so script asking in a loop gets refusals, not a stream of dialogs.
const QUIET_AFTER_CANCEL: std::time::Duration = std::time::Duration::from_secs(10);
const MAX_QUIET: std::time::Duration = std::time::Duration::from_secs(15 * 60);

#[derive(Debug, Default)]
struct AskState {
    open: bool,
    cancels: u32,
    quiet_until: Option<std::time::Instant>,
}

/// One question about a boss at a time, and none for a while after a
/// Cancel.
#[derive(Debug)]
pub struct BossGate {
    state: std::sync::Mutex<AskState>,
    quiet: std::time::Duration,
}

/// The question is open until this drops.
#[derive(Debug)]
pub struct Asking<'a>(&'a BossGate);

impl BossGate {
    pub const fn with_quiet(quiet: std::time::Duration) -> Self {
        Self {
            state: std::sync::Mutex::new(AskState {
                open: false,
                cancels: 0,
                quiet_until: None,
            }),
            quiet,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, AskState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn start(&self) -> Result<Asking<'_>, String> {
        let mut st = self.lock();
        if st.open {
            return Err("Desk is already asking about a boss.".into());
        }
        if let Some(left) = st
            .quiet_until
            .and_then(|u| u.checked_duration_since(std::time::Instant::now()))
            .filter(|l| !l.is_zero())
        {
            return Err(format!(
                "That was cancelled. Try again in {} seconds.",
                left.as_secs().max(1)
            ));
        }
        st.open = true;
        Ok(Asking(self))
    }

    pub fn answered(&self, agreed: bool) {
        let mut st = self.lock();
        if agreed {
            st.cancels = 0;
            st.quiet_until = None;
        } else {
            st.cancels = st.cancels.saturating_add(1);
            let wait = self
                .quiet
                .saturating_mul(1 << (st.cancels - 1).min(16))
                .min(MAX_QUIET);
            st.quiet_until = Some(std::time::Instant::now() + wait);
        }
    }
}

impl Drop for Asking<'_> {
    fn drop(&mut self) {
        self.0.lock().open = false;
    }
}

static GATE: BossGate = BossGate::with_quiet(QUIET_AFTER_CANCEL);

/// The native question's answer, once the person gives it.
type Answered = std::pin::Pin<Box<dyn Future<Output = Result<bool, String>> + Send>>;

/// The native question, Cancel first: true only on its yes. The gate is
/// held around the question alone, never the requests after it, so a
/// Cancel quietens questions, not Pause, Stop or a narrowing.
fn native_ask(app: tauri::AppHandle) -> impl FnOnce(String, String, String) -> Answered {
    move |title, question, yes| {
        Box::pin(async move {
            let _asking = GATE.start()?;
            let confirm = crate::pair_gate::NativeConfirm(app);
            let said =
                tauri::async_runtime::spawn_blocking(move || confirm.ask(&title, question, &yes))
                    .await
                    .unwrap_or(false);
            GATE.answered(said);
            Ok(said)
        })
    }
}

// ── Commands ────────────────────────────────────────────────────────────

/// Whether paired hub `hub` takes bosses from Desk.
#[tauri::command]
pub async fn boss_offer(io: tauri::State<'_, HubIo>, hub: String) -> CommandResult<Offer> {
    let at = hub_at(&io, &hub).await?;
    let paired = PairedHub { io: &io, hub };
    Ok(offer(&paired, &at.label).await)
}

/// Group `group`'s boss on another hub, each engine asked; none when it
/// has none.
#[tauri::command]
pub async fn boss_status(
    local: tauri::State<'_, Broker>,
    machines: tauri::State<'_, MachineIo>,
    group: String,
) -> CommandResult<Option<Status>> {
    let kept_at = kept_path()?;
    let ids = machine_ids(&local, &kept_at, Some(&group)).await;
    let engines = engines_now(&local, &machines, &ids);
    Ok(status(&kept_at, &engines, &group).await)
}

/// Who revokes the tokens of a boss on a paired hub, as the commands
/// find it ([`Revoke`]).
enum Revoker<'a> {
    Reached(PairedHub<'a>),
    PairingGone,
    Later,
}

impl<'a> Revoker<'a> {
    /// The hub, when Desk reaches it; none, when Desk is no longer paired
    /// with it; later, otherwise.
    async fn of(io: &'a HubIo, hub: &str) -> Self {
        if hub_at(io, hub).await.is_ok() {
            Self::Reached(PairedHub {
                io,
                hub: hub.to_string(),
            })
        } else if io.is_paired(hub).await {
            Self::Later
        } else {
            Self::PairingGone
        }
    }

    fn revoke(&self) -> Revoke<'_, PairedHub<'a>> {
        match self {
            Self::Reached(h) => Revoke::By(h),
            Self::PairingGone => Revoke::PairingGone,
            Self::Later => Revoke::Later,
        }
    }
}

/// The paired hub group `group`'s boss is on, when Desk can reach it.
async fn boss_hub_of(io: &HubIo, kept_at: &Path, group: &str) -> Option<HubAt> {
    let hub = load_group(kept_at, group).await?.hub;
    hub_at(io, &hub).await.ok()
}

/// Makes `agent` on paired hub `hub` group `group`'s boss ([`link`]).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn boss_link(
    app: tauri::AppHandle,
    local: tauri::State<'_, Broker>,
    machines: tauri::State<'_, MachineIo>,
    io: tauri::State<'_, HubIo>,
    group: String,
    hub: String,
    agent: String,
    choice: Choice,
) -> CommandResult<Done> {
    let kept_at = kept_path()?;
    let at = hub_at(&io, &hub).await?;
    let ids = machine_ids(&local, &kept_at, Some(&group)).await;
    let engines = engines_now(&local, &machines, &ids);
    let paired = PairedHub { io: &io, hub };
    // Who revokes the tokens of the boss it replaces.
    let old = match load_group(&kept_at, &group).await {
        Some(l) => Revoker::of(&io, &l.hub).await,
        None => Revoker::Later,
    };
    link(
        &kept_at,
        &engines,
        &paired,
        &at,
        old.revoke(),
        &group,
        &agent,
        choice,
        native_ask(app),
    )
    .await
}

/// Changes how much group `group`'s boss may do and see ([`set`]).
#[tauri::command]
pub async fn boss_set(
    app: tauri::AppHandle,
    local: tauri::State<'_, Broker>,
    machines: tauri::State<'_, MachineIo>,
    io: tauri::State<'_, HubIo>,
    group: String,
    choice: Choice,
) -> CommandResult<Done> {
    let kept_at = kept_path()?;
    let ids = machine_ids(&local, &kept_at, Some(&group)).await;
    let engines = engines_now(&local, &machines, &ids);
    let at = boss_hub_of(&io, &kept_at, &group).await;
    let paired = at.as_ref().map(|at| PairedHub {
        io: &io,
        hub: at.id.clone(),
    });
    let hub = paired.as_ref().zip(at.as_ref());
    set(&kept_at, &engines, hub, &group, choice, native_ask(app)).await
}

/// Pauses group `group`'s boss on every engine ([`pause`]).
#[tauri::command]
pub async fn boss_pause(
    local: tauri::State<'_, Broker>,
    machines: tauri::State<'_, MachineIo>,
    group: String,
) -> CommandResult<Done> {
    let kept_at = kept_path()?;
    let ids = machine_ids(&local, &kept_at, Some(&group)).await;
    let engines = engines_now(&local, &machines, &ids);
    let done = pause(&kept_at, &engines, &group).await?;
    if !done.failed.is_empty() {
        // Sent again soon, not in a quarter of an hour.
        WAKE.notify_one();
    }
    Ok(done)
}

/// Lets group `group`'s paused boss go on ([`resume`]).
#[tauri::command]
pub async fn boss_resume(
    app: tauri::AppHandle,
    local: tauri::State<'_, Broker>,
    machines: tauri::State<'_, MachineIo>,
    io: tauri::State<'_, HubIo>,
    group: String,
) -> CommandResult<Done> {
    let kept_at = kept_path()?;
    let ids = machine_ids(&local, &kept_at, Some(&group)).await;
    let engines = engines_now(&local, &machines, &ids);
    let at = boss_hub_of(&io, &kept_at, &group).await;
    let paired = at.as_ref().map(|at| PairedHub {
        io: &io,
        hub: at.id.clone(),
    });
    let hub = paired.as_ref().zip(at.as_ref());
    resume(&kept_at, &engines, hub, &group, native_ask(app)).await
}

/// Try again: group `group`'s boss brought up to date and linked where it
/// failed, as the person last said ([`retry`]).
#[tauri::command]
pub async fn boss_retry(
    local: tauri::State<'_, Broker>,
    machines: tauri::State<'_, MachineIo>,
    io: tauri::State<'_, HubIo>,
    group: String,
) -> CommandResult<Done> {
    let kept_at = kept_path()?;
    let ids = machine_ids(&local, &kept_at, Some(&group)).await;
    let engines = engines_now(&local, &machines, &ids);
    let at = boss_hub_of(&io, &kept_at, &group).await;
    let paired = at.as_ref().map(|at| PairedHub {
        io: &io,
        hub: at.id.clone(),
    });
    let hub = paired.as_ref().zip(at.as_ref());
    retry(&kept_at, &engines, hub, &group).await
}

/// Stop: ends group `group`'s boss on another hub ([`unlink`]).
#[tauri::command]
pub async fn boss_unlink(
    local: tauri::State<'_, Broker>,
    machines: tauri::State<'_, MachineIo>,
    io: tauri::State<'_, HubIo>,
    group: String,
) -> CommandResult<Done> {
    let kept_at = kept_path()?;
    let Some(link) = load_group(&kept_at, &group).await else {
        return Ok(Done::default());
    };
    let ids = machine_ids(&local, &kept_at, Some(&group)).await;
    let engines = engines_now(&local, &machines, &ids);
    // A hub Desk is no longer paired with took its tokens with it.
    let who = Revoker::of(&io, &link.hub).await;
    let done = unlink(&kept_at, &engines, who.revoke(), &group).await?;
    if !done.failed.is_empty() {
        WAKE.notify_one();
    }
    Ok(done)
}

/// Lets every boss on engine `engine` go on after its own pause, once the
/// person says so ([`unpause_engine`]).
#[tauri::command]
pub async fn boss_unpause_engine(
    app: tauri::AppHandle,
    local: tauri::State<'_, Broker>,
    machines: tauri::State<'_, MachineIo>,
    group: String,
    engine: String,
) -> CommandResult<Done> {
    let kept_at = kept_path()?;
    let ids = machine_ids(&local, &kept_at, Some(&group)).await;
    let engines = engines_now(&local, &machines, &ids);
    unpause_engine(&engines, &engine, native_ask(app)).await
}

/// The sidebar changed: keeping alive runs soon, so a session that joins or
/// leaves a group with a boss is granted or taken out without waiting.
#[tauri::command]
pub fn boss_layout_changed() {
    WAKE.notify_one();
}

/// Wakes keeping alive before its time.
static WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();

/// The least time between two runs of keeping alive, however often the
/// sidebar changes.
const KEEP_AT_MOST_EVERY: std::time::Duration = std::time::Duration::from_secs(10);

/// Desk is about to forget paired hub `hub`: every group whose boss is
/// there is stopped while the hub can still revoke its tokens. When some
/// can't be ended, the person is asked natively whether to remove it
/// anyway; a no keeps the hub. What is left is stopped once it's
/// forgotten ([`hub_removed`]).
pub async fn hub_removing(app: &tauri::AppHandle, hub: &str) -> CommandResult<()> {
    use tauri::Manager;
    let Ok(kept_at) = kept_path() else {
        return Ok(());
    };
    if !kept_at.exists() {
        return Ok(());
    }
    let on_hub = |kept: Kept| -> Vec<(String, GroupLink)> {
        kept.groups
            .into_iter()
            .filter(|(_, l)| l.hub == hub)
            .collect()
    };
    let groups = on_hub(load(&kept_at).await);
    if groups.is_empty() {
        return Ok(());
    }
    let io = app.state::<HubIo>();
    if let Revoker::Reached(paired) = Revoker::of(&io, hub).await {
        let local = app.state::<Broker>();
        let machines = app.state::<MachineIo>();
        let ids = machine_ids(&local, &kept_at, None).await;
        let engines = engines_now(&local, &machines, &ids);
        for (g, _) in &groups {
            if let Err(e) = unlink(&kept_at, &engines, Revoke::By(&paired), g).await {
                tracing::warn!(error = %e, "a boss on a hub being removed wasn't stopped everywhere");
            }
        }
    }
    // What is left still holds links the hub didn't end: the person says
    // whether to forget them anyway.
    let left = on_hub(load(&kept_at).await);
    let Some((_, first)) = left.first() else {
        return Ok(());
    };
    let label = quoted(&first.hub_label);
    let mut bosses: Vec<String> = left.iter().map(|(_, l)| capital(&l.agent)).collect();
    bosses.sort();
    bosses.dedup();
    let bosses: Vec<&str> = bosses.iter().map(String::as_str).collect();
    let question = format!(
        "Desk can't reach {label} to end {}'s links. Remove it anyway?\n\nTheir links stay live on {label} until they expire, or until someone there revokes them.",
        and(&bosses)
    );
    let ask = native_ask(app.clone());
    if ask(format!("Remove {label}"), question, "Remove Anyway".into()).await? {
        Ok(())
    } else {
        Err(format!(
            "{label} is kept: Desk ends its links once it can reach it."
        ))
    }
}

/// Desk forgot paired hub `hub`: every group whose boss is there is
/// stopped ([`hub_gone`]).
pub fn hub_removed(app: tauri::AppHandle, hub: String) {
    use tauri::Manager;
    tauri::async_runtime::spawn(async move {
        let Ok(kept_at) = kept_path() else {
            return;
        };
        if !kept_at.exists() {
            return;
        }
        let local = app.state::<Broker>();
        let machines = app.state::<MachineIo>();
        let ids = machine_ids(&local, &kept_at, None).await;
        let engines = engines_now(&local, &machines, &ids);
        hub_gone::<_, PairedHub<'_>>(&kept_at, &engines, &hub).await;
    });
}

/// Keeps every group's boss on another hub alive while Desk is open
/// ([`keep`]): a minute after it starts, then every [`KEEP_EVERY`], and
/// soon after the sidebar changes.
pub fn keep_alive(app: tauri::AppHandle) {
    use tauri::Manager;
    tauri::async_runtime::spawn(async move {
        // Once Desk Helper has had time to start this computer's hub.
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        loop {
            if let Ok(kept_at) = kept_path()
                && kept_at.exists()
            {
                let local = app.state::<Broker>();
                let machines = app.state::<MachineIo>();
                let io = app.state::<HubIo>();
                let ids = machine_ids(&local, &kept_at, None).await;
                let engines = engines_now(&local, &machines, &ids);
                let hubs: BTreeMap<String, HubAt> = {
                    let names: Vec<String> = load(&kept_at)
                        .await
                        .groups
                        .values()
                        .map(|l| l.hub.clone())
                        .collect();
                    let mut hubs = BTreeMap::new();
                    for h in names {
                        if let Ok(at) = hub_at(&io, &h).await {
                            hubs.insert(h, at);
                        } else if !io.is_paired(&h).await {
                            // Forgotten while Desk wasn't looking: its
                            // tokens went with the pairing.
                            hub_gone::<_, PairedHub<'_>>(&kept_at, &engines, &h).await;
                        }
                    }
                    hubs
                };
                let io: &HubIo = &io;
                let hub_of = |id: &str| {
                    hubs.get(id).map(|at| {
                        (
                            PairedHub {
                                io,
                                hub: id.to_string(),
                            },
                            at.clone(),
                        )
                    })
                };
                if let Err(e) = keep(&kept_at, &engines, hub_of).await {
                    tracing::warn!(error = %e, "couldn't keep the bosses on other hubs alive; trying again later");
                }
            }
            tokio::select! {
                () = tokio::time::sleep(KEEP_EVERY) => {}
                () = WAKE.notified() => {}
            }
            tokio::time::sleep(KEEP_AT_MOST_EVERY).await;
        }
    });
}

#[cfg(test)]
mod tests;
