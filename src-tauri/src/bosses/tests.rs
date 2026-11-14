use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use super::*;

const ACME: &str = "g-acme";
const S1: &str = "11111111-1111-4111-8111-111111111111";
const S2: &str = "22222222-2222-4222-8222-222222222222";
const S3: &str = "33333333-3333-4333-8333-333333333333";
const S4: &str = "44444444-4444-4444-8444-444444444444";
const HUB_URL: &str = "https://driftwerk.example";

/// Made-up link tokens, built so no scanner takes them for real ones.
fn fake_token(n: usize) -> String {
    format!("{}_SENTINEL_{n}", concat!("wf", "b"))
}

fn layout() -> Value {
    json!({
        "groups": [
            { "id": ACME, "name": "Acme", "items": [
                format!("session:{S1}"), format!("session:{S2}"),
                format!("session:devbox/{S3}"), "agent:local/sarah",
            ]},
            { "id": "g-atlas", "name": "Atlas", "items": [] },
        ],
        "ungrouped": { "items": [] },
    })
}

/// What a hub's `PutLink` takes: exactly these (it denies unknown fields).
const LINK_KEYS: [&str; 9] = [
    "hub",
    "hubUrl",
    "canonicalHub",
    "linkId",
    "tokenId",
    "token",
    "expiresAt",
    "engineId",
    "agentId",
];

/// What a hub's `GrantPut` takes (it denies unknown fields), and what it
/// needs.
const GRANT_KEYS: [&str; 14] = [
    "grantVersion",
    "revision",
    "name",
    "boss",
    "level",
    "sees",
    "recall",
    "folders",
    "repos",
    "members",
    "leaving",
    "act",
    "hours",
    "resume",
];

fn keys(v: &Value) -> BTreeSet<String> {
    v.as_object().unwrap().keys().cloned().collect()
}

/// What an engine holds, as a hub would.
#[derive(Default)]
struct Held {
    /// Each grant as written (its body, and `stopped`).
    grants: BTreeMap<String, Value>,
    /// What a deleted grant (or a stop with none) left: its revision and
    /// whether it was stopped.
    left: BTreeMap<String, (i64, bool)>,
    links: BTreeMap<String, String>,
    /// Handed-over bodies, tokens and all: the engine's to keep.
    handed: Vec<Value>,
    asked: Vec<(String, String)>,
    born: Vec<String>,
    paused: bool,
}

struct FakeEngine {
    id: String,
    name: String,
    layout: Mutex<Value>,
    held: Mutex<Held>,
    refuse_link: AtomicBool,
    refuse_grant: AtomicBool,
    /// Can't be reached now.
    down: AtomicBool,
    /// Another write gets in first, once.
    race: AtomicBool,
}

impl FakeEngine {
    fn new(id: &str, name: &str) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            layout: Mutex::new(layout()),
            held: Mutex::default(),
            refuse_link: AtomicBool::new(false),
            refuse_grant: AtomicBool::new(false),
            down: AtomicBool::new(false),
            race: AtomicBool::new(false),
        }
    }
    fn asked(&self) -> Vec<(String, String)> {
        self.held.lock().unwrap().asked.clone()
    }
    fn forget_asked(&self) {
        self.held.lock().unwrap().asked.clear();
    }
    fn grant(&self, g: &str) -> Option<Value> {
        self.held.lock().unwrap().grants.get(g).cloned()
    }
    fn grant_puts(&self) -> usize {
        self.asked()
            .iter()
            .filter(|(m, t)| m == "PUT" && t.starts_with("/api/desk/grants/"))
            .count()
    }
    fn set_items(&self, items: Value) {
        self.layout.lock().unwrap()["groups"][0]["items"] = items;
    }
}

fn answer(status: u16, body: Value) -> NativeAnswer {
    NativeAnswer {
        status,
        body: Zeroizing::new(if body.is_null() {
            String::new()
        } else {
            body.to_string()
        }),
    }
}

/// A grant as `GET /api/desk/grants` shows it.
fn view(group: &str, body: &Value, stopped: bool, born: &[String]) -> Value {
    let mut v = body.clone();
    v.as_object_mut().unwrap().remove("resume");
    v.as_object_mut().unwrap().remove("leaving");
    v["group"] = json!(group);
    v["stopped"] = json!(stopped);
    v["live"] = json!(!stopped);
    v["born"] = json!(born);
    v["why"] = if stopped {
        json!("Acme's boss was stopped in Desk.")
    } else {
        Value::Null
    };
    v
}

/// What a write says, apart from its revision and the go-on.
fn content(body: &Value) -> Value {
    let mut v = body.clone();
    for k in [
        "revision", "resume", "group", "stopped", "live", "why", "born",
    ] {
        v.as_object_mut().unwrap().remove(k);
    }
    v
}

impl Engine for FakeEngine {
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
        // Only what the native side may ask an engine ever reaches it.
        assert!(
            crate::broker::routes::native_boss(method, target).is_ok(),
            "{method} {target}"
        );
        if self.down.load(Ordering::SeqCst) {
            return std::future::ready(Err(format!("{} can't be reached now.", self.name)));
        }
        let body: Option<Value> = body.map(|b| serde_json::from_str(b).unwrap());
        let mut h = self.held.lock().unwrap();
        h.asked.push((method.into(), target.into()));
        let parts: Vec<&str> = target.trim_start_matches('/').split('/').collect();
        let out = match (method, parts.as_slice()) {
            ("GET", ["api", "desk", "layout"]) => answer(200, self.layout.lock().unwrap().clone()),
            ("GET", ["api", "desk", "engine-key"]) => answer(
                200,
                json!({"publicKey": format!("ed25519:KEY-{}", self.id)}),
            ),
            ("PUT", ["api", "desk", "boss-links", g]) => {
                let b = body.unwrap();
                assert_eq!(
                    keys(&b),
                    LINK_KEYS.iter().map(|k| k.to_string()).collect(),
                    "a link's body"
                );
                if self.refuse_link.load(Ordering::SeqCst) {
                    answer(
                        400,
                        json!({"error": "a boss hub is linked at a public address"}),
                    )
                } else {
                    h.links
                        .insert(b["linkId"].as_str().unwrap().into(), (*g).into());
                    h.handed.push(b);
                    answer(204, Value::Null)
                }
            }
            ("DELETE", ["api", "desk", "boss-links", _, l]) => {
                h.links.remove(*l);
                answer(204, Value::Null)
            }
            ("GET", ["api", "desk", "grants"]) => {
                let left: serde_json::Map<String, Value> = h
                    .left
                    .iter()
                    .map(|(g, (r, _))| (g.clone(), json!({"revision": r})))
                    .collect();
                answer(
                    200,
                    json!({
                        "paused": if h.paused { json!({"at": "2026-11-14T00:00:00Z"}) } else { Value::Null },
                        "grants": h.grants.values().map(|g| {
                            let mut g = g.clone();
                            g["born"] = json!(h.born);
                            g
                        }).collect::<Vec<_>>(),
                        "left": left,
                    }),
                )
            }
            ("PUT", ["api", "desk", "grants", g]) => {
                let b = body.unwrap();
                let k = keys(&b);
                assert!(
                    k.iter().all(|x| GRANT_KEYS.contains(&x.as_str())),
                    "a grant's body: {k:?}"
                );
                for need in ["grantVersion", "revision", "name"] {
                    assert!(k.contains(need), "a grant needs {need}");
                }
                let rev = b["revision"].as_i64().unwrap();
                let old = h.grants.get(*g).cloned();
                let floor = h.left.get(*g).copied();
                let have = old
                    .as_ref()
                    .map(|o| o["revision"].as_i64().unwrap())
                    .or(floor.map(|(r, _)| r))
                    .unwrap_or(0);
                let was_stopped = old
                    .as_ref()
                    .map_or(floor.is_some_and(|(_, s)| s), |o| o["stopped"] == true);
                if self.race.swap(false, Ordering::SeqCst) {
                    // Another write got in: the engine is one past.
                    if let Some(o) = h.grants.get_mut(*g) {
                        o["revision"] = json!(have + 1);
                    } else {
                        h.left.insert((*g).into(), (have + 1, was_stopped));
                    }
                    answer(409, json!({"error": "another write got in first"}))
                } else if self.refuse_grant.load(Ordering::SeqCst) {
                    answer(400, json!({"error": "act is an object of switches"}))
                } else if rev < have
                    || (rev == have
                        && old
                            .as_ref()
                            .is_none_or(|o| content(o) != content(&view(g, &b, false, &[]))))
                {
                    answer(
                        409,
                        json!({"error": format!("This engine has revision {have} of that grant: the same one again only renews it.")}),
                    )
                } else {
                    let stopped = was_stopped && b["resume"] != true;
                    let leaving: Vec<String> = b["leaving"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|s| s.as_str().unwrap().to_string())
                        .collect();
                    h.born.retain(|s| !leaving.contains(s));
                    let born = h.born.clone();
                    h.left.remove(*g);
                    h.grants.insert((*g).into(), view(g, &b, stopped, &born));
                    answer(200, json!({"change": "new"}))
                }
            }
            ("DELETE", ["api", "desk", "grants", g]) => {
                if let Some(old) = h.grants.remove(*g) {
                    let r = old["revision"].as_i64().unwrap();
                    h.left.insert((*g).into(), (r, old["stopped"] == true));
                }
                answer(204, Value::Null)
            }
            ("POST", ["api", "desk", "bosses", "stop"]) => {
                let b = body.unwrap();
                assert_eq!(b["from"], "desk");
                let g = b["group"]
                    .as_str()
                    .expect("a group's stop, never every boss's");
                if let Some(v) = h.grants.get_mut(g) {
                    v["stopped"] = json!(true);
                    v["live"] = json!(false);
                } else {
                    let r = h.left.get(g).map_or(0, |(r, _)| *r);
                    h.left.insert(g.into(), (r, true));
                }
                answer(200, json!({}))
            }
            ("DELETE", ["api", "desk", "bosses", "paused"]) => {
                h.paused = false;
                answer(200, json!({}))
            }
            other => panic!("unexpected {other:?}"),
        };
        std::future::ready(Ok(out))
    }
}

#[derive(Clone, Copy, PartialEq)]
enum HubMode {
    Takes,
    Off,
    Declines,
    OtherName,
}

struct FakeHub {
    mode: HubMode,
    asked: Mutex<Vec<(String, String, Option<Value>)>>,
    minted: Mutex<usize>,
    /// The tokens it holds now, by id.
    live: Mutex<BTreeSet<String>>,
    expires_at: Mutex<DateTime<Utc>>,
}

impl FakeHub {
    fn new(mode: HubMode) -> Self {
        Self {
            mode,
            asked: Mutex::default(),
            minted: Mutex::new(0),
            live: Mutex::default(),
            expires_at: Mutex::new(Utc::now() + Duration::days(30)),
        }
    }
    fn asked(&self) -> Vec<(String, String, Option<Value>)> {
        self.asked.lock().unwrap().clone()
    }
    fn mints(&self) -> Vec<Value> {
        self.asked()
            .into_iter()
            .filter(|(m, _, _)| m == "POST")
            .map(|(_, _, b)| b.unwrap())
            .collect()
    }
    fn live(&self) -> BTreeSet<String> {
        self.live.lock().unwrap().clone()
    }
}

fn token_id(n: usize) -> String {
    format!("0000000{n}-0000-4000-8000-000000000000")
}

impl BossHub for FakeHub {
    fn call(
        &self,
        method: &str,
        target: &str,
        body: Option<&Zeroizing<String>>,
    ) -> impl Future<Output = Result<(u16, Zeroizing<Vec<u8>>), String>> + Send {
        let body: Option<Value> = body.map(|b| serde_json::from_str(b).unwrap());
        self.asked
            .lock()
            .unwrap()
            .push((method.into(), target.into(), body.clone()));
        let reply = |s: u16, v: Value| (s, Zeroizing::new(v.to_string().into_bytes()));
        let out = match (method, target) {
            ("GET", LINKS_PATH) => match self.mode {
                HubMode::Off => reply(
                    404,
                    json!({"error": "This hub's admin hasn't let Desk give its agents boss work."}),
                ),
                _ => reply(200, json!({"links": []})),
            },
            ("POST", LINKS_PATH) => {
                let renews = body.unwrap()["renews"].as_str().map(str::to_string);
                match self.mode {
                    HubMode::Declines => reply(
                        403,
                        json!({"error": "That agent doesn't take boss work from Desk."}),
                    ),
                    _ if renews.as_ref().is_some_and(|r| !self.live().contains(r)) => {
                        reply(404, json!({"error": "no such link"}))
                    }
                    _ => {
                        let mut n = self.minted.lock().unwrap();
                        *n += 1;
                        self.live.lock().unwrap().insert(token_id(*n));
                        reply(
                            201,
                            json!({
                                "id": token_id(*n),
                                "link_id": format!("1111111{n}-0000-4000-8000-000000000000"),
                                "token": fake_token(*n),
                                "expires_at": *self.expires_at.lock().unwrap(),
                                "hub": if self.mode == HubMode::OtherName { "https://elsewhere.example" } else { HUB_URL },
                            }),
                        )
                    }
                }
            }
            ("DELETE", t) => {
                let id = t.rsplit('/').next().unwrap();
                self.live.lock().unwrap().remove(id);
                reply(204, json!(null))
            }
            other => panic!("unexpected {other:?}"),
        };
        std::future::ready(Ok(out))
    }
}

fn at() -> HubAt {
    HubAt {
        id: "driftwerk".into(),
        label: "Driftwerk".into(),
        base: HUB_URL.into(),
    }
}

fn suggest() -> Choice {
    Choice {
        level: Level::Suggest,
        sees: Sees::Replies,
        budget_usd_per_day: None,
    }
}

fn act() -> Choice {
    Choice {
        level: Level::Act,
        ..suggest()
    }
}

fn full(budget: f64) -> Choice {
    Choice {
        level: Level::Full,
        sees: Sees::Replies,
        budget_usd_per_day: Some(budget),
    }
}

fn two() -> Engines<FakeEngine> {
    Engines {
        here: FakeEngine::new(LOCAL_ENGINE, HERE),
        machines: vec![("devbox".into(), Ok(FakeEngine::new("devbox", "devbox")))],
    }
}

fn devbox(e: &Engines<FakeEngine>) -> &FakeEngine {
    e.machines[0].1.as_ref().unwrap()
}

type Answer = std::future::Ready<Result<bool, String>>;

fn yes(seen: &Mutex<Vec<String>>) -> impl FnOnce(String, String, String) -> Answer + '_ {
    move |_title, question, _yes| {
        seen.lock().unwrap().push(question);
        std::future::ready(Ok(true))
    }
}

fn no(_: String, _: String, _: String) -> Answer {
    std::future::ready(Ok(false))
}

fn never(_: String, _: String, _: String) -> Answer {
    panic!("nothing that narrows is asked about")
}

fn none() -> Option<(&'static FakeHub, &'static HubAt)> {
    None
}

async fn linked(dir: &Path, e: &Engines<FakeEngine>, hub: &FakeHub, choice: Choice) -> Done {
    let seen = Mutex::new(Vec::new());
    link(
        &dir.join(KEPT_FILE),
        e,
        hub,
        &at(),
        None,
        ACME,
        "allan",
        choice,
        yes(&seen),
    )
    .await
    .unwrap()
}

async fn kept_alive(kept: &Path, e: &Engines<FakeEngine>, hub: &FakeHub) {
    keep(kept, e, |_| Some((hub, at()))).await.unwrap();
}

impl BossHub for &FakeHub {
    fn call(
        &self,
        method: &str,
        target: &str,
        body: Option<&Zeroizing<String>>,
    ) -> impl Future<Output = Result<(u16, Zeroizing<Vec<u8>>), String>> + Send {
        (*self).call(method, target, body)
    }
}

/// The person is asked once, natively, what the boss may do first and in
/// words built from the layout; then each engine gets its link and its
/// grant, and nothing the page is told or Desk keeps holds a token.
#[tokio::test]
async fn linking_asks_once_then_links_and_grants_every_engine_and_keeps_no_token() {
    let dir = tempfile::tempdir().unwrap();
    let e = two();
    let hub = FakeHub::new(HubMode::Takes);
    let seen = Mutex::new(Vec::new());
    let done = link(
        &dir.path().join(KEPT_FILE),
        &e,
        &hub,
        &at(),
        None,
        ACME,
        "allan",
        suggest(),
        yes(&seen),
    )
    .await
    .unwrap();
    assert_eq!(done.done, vec![HERE.to_string(), "devbox".to_string()]);
    assert!(done.failed.is_empty(), "{:?}", done.failed);
    let q = seen.lock().unwrap().clone();
    assert_eq!(q.len(), 1);
    assert!(
        q[0].starts_with(&format!(
            "Suggest, seeing their status and replies.\n\nLet Allan on “Driftwerk” (driftwerk.example) boss 3 sessions in “Acme”, on “devbox” and {HERE}?"
        )),
        "{}",
        q[0]
    );
    // Each engine's own key went into its mint.
    let mints = hub.mints();
    assert_eq!(mints.len(), 2);
    assert_eq!(mints[0]["engine"]["public_key"], "ed25519:KEY-local");
    assert_eq!(mints[1]["engine"]["id"], "devbox");
    assert_eq!(mints[0]["group"], json!({"key": ACME, "name": "Acme"}));
    // The token went to the engine, with the name the hub gave itself.
    let handed = e.here.held.lock().unwrap().handed.clone();
    assert_eq!(handed[0]["token"], fake_token(1));
    assert_eq!(handed[0]["hub"], "driftwerk");
    assert_eq!(handed[0]["canonicalHub"], HUB_URL);
    assert_eq!(handed[0]["engineId"], "local");
    // Each engine's grant names only its own sessions, and goes on.
    let g = e.here.grant(ACME).unwrap();
    assert_eq!(g["boss"], "remote:driftwerk/allan");
    assert_eq!(g["level"], "suggest");
    assert_eq!(g["members"], json!([S1, S2]));
    assert_eq!(g["live"], true);
    assert_eq!(devbox(&e).grant(ACME).unwrap()["members"], json!([S3]));
    // Nothing kept here, or told the page, holds a token.
    let kept = std::fs::read_to_string(dir.path().join(KEPT_FILE)).unwrap();
    assert!(!kept.contains("SENTINEL"), "{kept}");
    assert!(!serde_json::to_string(&done).unwrap().contains("SENTINEL"));
    let status = status(&dir.path().join(KEPT_FILE), &e, ACME).await.unwrap();
    assert!(!serde_json::to_string(&status).unwrap().contains("SENTINEL"));
    assert_eq!(status.party, "driftwerk/allan");
    assert!(status.engines.iter().all(|s| s.live == Some(true)));
    assert!(
        read_kept(&dir.path().join(KEPT_FILE)).groups[ACME]
            .orphans
            .is_empty()
    );
}

#[tokio::test]
async fn a_cancel_sends_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let e = two();
    let hub = FakeHub::new(HubMode::Takes);
    let done = link(
        &dir.path().join(KEPT_FILE),
        &e,
        &hub,
        &at(),
        None,
        ACME,
        "allan",
        suggest(),
        no,
    )
    .await
    .unwrap();
    assert!(done.cancelled);
    assert!(hub.asked().is_empty());
    assert_eq!(
        e.here.asked(),
        vec![("GET".to_string(), "/api/desk/layout".to_string())]
    );
    assert!(devbox(&e).asked().is_empty());
    assert!(!dir.path().join(KEPT_FILE).exists());
}

/// A name the page sets can't push what the question asks out of sight:
/// it is one line, short, in quotes, after the terms.
#[tokio::test]
async fn the_question_says_the_terms_first_and_names_the_page_sets_plainly() {
    let dir = tempfile::tempdir().unwrap();
    let e = two();
    e.here.layout.lock().unwrap()["groups"][0]["name"] = json!(format!(
        "Acme\n\n\nWatch only, seeing their status.\u{202e}{}",
        "x".repeat(200)
    ));
    let hub = FakeHub::new(HubMode::Takes);
    let seen = Mutex::new(Vec::new());
    let mut wide = at();
    wide.label = "Driftwerk\nAtlas".into();
    link(
        &dir.path().join(KEPT_FILE),
        &e,
        &hub,
        &wide,
        None,
        ACME,
        "allan",
        full(40.0),
        yes(&seen),
    )
    .await
    .unwrap();
    let q = seen.lock().unwrap()[0].clone();
    assert!(
        q.starts_with(
            "Act fully, up to $40.00 a day of real money, seeing their status and replies.\n\n"
        ),
        "{q}"
    );
    assert!(q.contains("“Driftwerk Atlas” (driftwerk.example)"), "{q}");
    assert!(
        q.contains("“Acme Watch only, seeing their status. xx…”"),
        "{q}"
    );
    assert!(!q.contains('\u{202e}'));
    let named = q.lines().nth(2).unwrap();
    assert!(named.chars().count() < 200, "{named}");
}

/// A hub that names itself otherwise than Desk dials it, an engine that
/// won't keep the link, and a grant an engine won't take: each link made
/// is revoked where it was made, and none is left on an engine.
#[tokio::test]
async fn a_link_not_kept_is_revoked_and_taken_off_its_engine() {
    let dir = tempfile::tempdir().unwrap();
    let e = two();
    let hub = FakeHub::new(HubMode::OtherName);
    let done = linked(dir.path(), &e, &hub, suggest()).await;
    assert!(done.done.is_empty());
    assert!(
        done.failed[0]
            .why
            .contains("calls itself https://elsewhere.example"),
        "{:?}",
        done.failed
    );
    assert!(hub.live().is_empty());
    assert!(e.here.held.lock().unwrap().handed.is_empty());

    let dir = tempfile::tempdir().unwrap();
    let e = two();
    e.here.refuse_link.store(true, Ordering::SeqCst);
    devbox(&e).refuse_grant.store(true, Ordering::SeqCst);
    let hub = FakeHub::new(HubMode::Takes);
    let done = linked(dir.path(), &e, &hub, suggest()).await;
    assert_eq!(done.failed.len(), 2, "{:?}", done.failed);
    assert!(done.failed[0].why.contains("didn't keep the link"));
    assert!(done.failed[1].why.contains("didn't take the grant"));
    assert!(hub.live().is_empty(), "every token made was revoked");
    assert!(devbox(&e).held.lock().unwrap().links.is_empty());
    assert!(!serde_json::to_string(&done).unwrap().contains("SENTINEL"));
    // Nothing linked and nothing to revoke: nothing kept.
    assert!(load(&dir.path().join(KEPT_FILE)).await.groups.is_empty());
}

/// An agent that declines boss work is said so once, and no other engine
/// is minted for.
#[tokio::test]
async fn an_agent_that_declines_boss_work_says_so_and_stops_minting() {
    let dir = tempfile::tempdir().unwrap();
    let e = two();
    let hub = FakeHub::new(HubMode::Declines);
    let done = linked(dir.path(), &e, &hub, suggest()).await;
    assert_eq!(
        done.failed[0].why,
        "Allan doesn't take boss work from Desk: Driftwerk's admin turns it on in Allan's settings."
    );
    assert_eq!(done.failed.len(), 2);
    assert_eq!(hub.mints().len(), 1);
}

#[tokio::test]
async fn what_a_hub_says_of_bosses_is_said_plainly() {
    assert_eq!(
        offer(&FakeHub::new(HubMode::Takes), "Driftwerk").await,
        Offer::Takes
    );
    assert_eq!(
        offer(&FakeHub::new(HubMode::Off), "Driftwerk").await,
        Offer::Not {
            why: "Driftwerk doesn't take bosses from Desk yet: its admin turns it on.".into()
        }
    );
}

#[test]
fn act_fully_needs_a_budget_and_replies() {
    assert!(full(40.0).checked().is_ok());
    assert!(
        Choice {
            budget_usd_per_day: None,
            ..full(1.0)
        }
        .checked()
        .is_err()
    );
    assert!(full(0.0).checked().is_err());
    assert!(full(MAX_FULL_BUDGET_USD + 1.0).checked().is_err());
    assert!(full(f64::NAN).checked().is_err());
    assert!(
        Choice {
            sees: Sees::Status,
            ..full(40.0)
        }
        .checked()
        .is_err()
    );
    // A budget below Act fully is dropped.
    assert_eq!(
        Choice {
            budget_usd_per_day: Some(5.0),
            ..suggest()
        }
        .checked()
        .unwrap(),
        suggest()
    );
    assert_eq!(full(40.0).act()["budget_usd_per_day"], 40.0);
    assert_eq!(suggest().act(), json!({}));
}

#[test]
fn what_widens_is_more_level_more_seen_or_more_money() {
    let watch = Choice {
        level: Level::Watch,
        sees: Sees::Status,
        budget_usd_per_day: None,
    };
    assert!(suggest().widens(&watch));
    assert!(!watch.widens(&suggest()));
    assert!(
        Choice {
            sees: Sees::Everything,
            ..suggest()
        }
        .widens(&suggest())
    );
    assert!(full(40.0).widens(&suggest()));
    assert!(full(50.0).widens(&full(40.0)));
    assert!(!full(30.0).widens(&full(40.0)));
    assert!(!suggest().widens(&full(40.0)));
}

/// Narrowing isn't asked about; widening is, and a Cancel changes nothing.
#[tokio::test]
async fn a_change_that_gives_more_is_asked_and_one_that_gives_less_isnt() {
    let dir = tempfile::tempdir().unwrap();
    let kept = dir.path().join(KEPT_FILE);
    let e = two();
    let hub = FakeHub::new(HubMode::Takes);
    linked(dir.path(), &e, &hub, full(40.0)).await;
    let r1 = e.here.grant(ACME).unwrap()["revision"].as_i64().unwrap();
    set(&kept, &e, none(), ACME, full(30.0), never)
        .await
        .unwrap();
    let g = e.here.grant(ACME).unwrap();
    assert_eq!(g["act"]["budget_usd_per_day"], 30.0);
    assert_eq!(g["revision"].as_i64().unwrap(), r1 + 1);
    let done = set(&kept, &e, none(), ACME, full(90.0), no).await.unwrap();
    assert!(done.cancelled);
    assert_eq!(
        e.here.grant(ACME).unwrap()["act"]["budget_usd_per_day"],
        30.0
    );
    let seen = Mutex::new(Vec::new());
    set(&kept, &e, none(), ACME, full(90.0), yes(&seen))
        .await
        .unwrap();
    assert!(seen.lock().unwrap()[0].starts_with("Act fully, up to $90.00 a day"));
    assert!(seen.lock().unwrap()[0].contains(&full_line("Allan")));
    assert_eq!(
        e.here.grant(ACME).unwrap()["act"]["budget_usd_per_day"],
        90.0
    );
}

/// At Act and above, a session added to the group isn't granted until the
/// person says so; the question counts exactly what it grants.
#[tokio::test]
async fn at_act_a_session_added_to_the_group_waits_on_the_person() {
    let dir = tempfile::tempdir().unwrap();
    let kept = dir.path().join(KEPT_FILE);
    let e = two();
    let hub = FakeHub::new(HubMode::Takes);
    linked(dir.path(), &e, &hub, act()).await;
    e.here.set_items(json!([
        format!("session:{S1}"),
        format!("session:{S2}"),
        format!("session:{S4}"),
        format!("session:devbox/{S3}"),
    ]));
    kept_alive(&kept, &e, &hub).await;
    assert_eq!(e.here.grant(ACME).unwrap()["members"], json!([S1, S2]));
    assert_eq!(status(&kept, &e, ACME).await.unwrap().waiting, 1);
    // The same choice, saved: asked, with the count it will grant.
    let seen = Mutex::new(Vec::new());
    set(&kept, &e, Some((&hub, &at())), ACME, act(), yes(&seen))
        .await
        .unwrap();
    assert!(seen.lock().unwrap()[0].contains("4 sessions in “Acme”"));
    assert_eq!(e.here.grant(ACME).unwrap()["members"], json!([S1, S2, S4]));
    // Emptied, then filled again: what it fills with waits again.
    e.here.set_items(json!([]));
    kept_alive(&kept, &e, &hub).await;
    e.here
        .set_items(json!([format!("session:{S1}"), format!("session:{S4}")]));
    kept_alive(&kept, &e, &hub).await;
    assert_eq!(e.here.grant(ACME).unwrap()["members"], json!([]));
    assert_eq!(status(&kept, &e, ACME).await.unwrap().waiting, 2);
    assert!(
        set(&kept, &e, none(), ACME, act(), no)
            .await
            .unwrap()
            .cancelled
    );
    // Nothing waits: nothing is asked.
    e.here.set_items(json!([]));
    set(&kept, &e, none(), ACME, act(), never).await.unwrap();
}

/// Pause stops the group's grant on each engine (never every boss there);
/// going on is asked, and lets it go on.
#[tokio::test]
async fn pause_stops_the_group_and_going_on_is_asked() {
    let dir = tempfile::tempdir().unwrap();
    let kept = dir.path().join(KEPT_FILE);
    let e = two();
    let hub = FakeHub::new(HubMode::Takes);
    linked(dir.path(), &e, &hub, suggest()).await;
    let done = pause(&kept, &e, ACME).await.unwrap();
    assert_eq!(done.done.len(), 2);
    assert_eq!(e.here.grant(ACME).unwrap()["live"], false);
    assert!(status(&kept, &e, ACME).await.unwrap().paused);
    assert!(
        resume(&kept, &e, Some((&hub, &at())), ACME, no)
            .await
            .unwrap()
            .cancelled
    );
    assert_eq!(e.here.grant(ACME).unwrap()["live"], false);
    let seen = Mutex::new(Vec::new());
    resume(&kept, &e, Some((&hub, &at())), ACME, yes(&seen))
        .await
        .unwrap();
    assert_eq!(e.here.grant(ACME).unwrap()["live"], true);
    assert!(!status(&kept, &e, ACME).await.unwrap().paused);
}

/// A Pause an engine didn't take isn't undone by keeping alive: its stop
/// is sent again, and no grant is written or token made, near its end or
/// not.
#[tokio::test]
async fn keeping_alive_never_undoes_a_pause() {
    let dir = tempfile::tempdir().unwrap();
    let kept = dir.path().join(KEPT_FILE);
    let e = two();
    let hub = FakeHub::new(HubMode::Takes);
    *hub.expires_at.lock().unwrap() = Utc::now() + Duration::days(2);
    linked(dir.path(), &e, &hub, suggest()).await;
    devbox(&e).down.store(true, Ordering::SeqCst);
    let done = pause(&kept, &e, ACME).await.unwrap();
    assert_eq!(done.failed.len(), 1);
    let s = status(&kept, &e, ACME).await.unwrap();
    assert!(s.pausing && !s.paused, "paused only once every engine is");
    let mints = hub.mints().len();
    e.here.forget_asked();
    devbox(&e).forget_asked();
    devbox(&e).down.store(false, Ordering::SeqCst);
    kept_alive(&kept, &e, &hub).await;
    assert_eq!(devbox(&e).grant(ACME).unwrap()["live"], false);
    assert_eq!(e.here.grant(ACME).unwrap()["live"], false);
    assert_eq!(e.here.grant_puts() + devbox(&e).grant_puts(), 0);
    assert_eq!(hub.mints().len(), mints);
    assert!(status(&kept, &e, ACME).await.unwrap().paused);
}

/// Stop sends every engine its stop first, then revokes every token,
/// takes every link off its engine and deletes every grant.
#[tokio::test]
async fn stop_stops_revokes_unlinks_and_deletes_the_grants() {
    let dir = tempfile::tempdir().unwrap();
    let kept = dir.path().join(KEPT_FILE);
    let e = two();
    let hub = FakeHub::new(HubMode::Takes);
    linked(dir.path(), &e, &hub, suggest()).await;
    let done = unlink(&kept, &e, Some(&hub), ACME).await.unwrap();
    assert!(done.failed.is_empty(), "{:?}", done.failed);
    assert!(hub.live().is_empty());
    let asked = e.here.asked();
    let after: Vec<&str> = asked
        .iter()
        .skip_while(|(m, t)| !(m == "POST" && t == "/api/desk/bosses/stop"))
        .map(|(m, _)| m.as_str())
        .collect();
    assert_eq!(after, ["POST", "POST", "DELETE", "DELETE"]);
    assert!(e.here.grant(ACME).is_none());
    assert!(e.here.held.lock().unwrap().links.is_empty());
    assert!(load(&kept).await.groups.is_empty());
    // A grant written without the person's go-on stays stopped.
    let group = group_of(&layout(), ACME).unwrap();
    write_grant(
        &e.here,
        &group,
        &json!({"grantVersion": 1, "name": "Acme"}),
        None,
        false,
    )
    .await
    .unwrap();
    assert_eq!(e.here.grant(ACME).unwrap()["live"], false);
    // Linked again later: past what the deleted grant left, and resumed.
    linked(dir.path(), &e, &hub, suggest()).await;
    assert_eq!(e.here.grant(ACME).unwrap()["live"], true);
}

/// A Stop an engine missed isn't undone by keeping alive: no grant is
/// written and no token made; Stop's steps alone are tried again, until
/// they are done.
#[tokio::test]
async fn keeping_alive_finishes_a_stop_and_never_relinks() {
    let dir = tempfile::tempdir().unwrap();
    let kept = dir.path().join(KEPT_FILE);
    let e = two();
    let hub = FakeHub::new(HubMode::Takes);
    *hub.expires_at.lock().unwrap() = Utc::now() + Duration::days(2);
    linked(dir.path(), &e, &hub, suggest()).await;
    devbox(&e).down.store(true, Ordering::SeqCst);
    let done = unlink(&kept, &e, Some(&hub), ACME).await.unwrap();
    assert_eq!(done.failed.len(), 1);
    assert!(status(&kept, &e, ACME).await.unwrap().stopping);
    let mints = hub.mints().len();
    e.here.forget_asked();
    kept_alive(&kept, &e, &hub).await;
    assert_eq!(hub.mints().len(), mints);
    assert_eq!(e.here.grant_puts(), 0);
    devbox(&e).forget_asked();
    devbox(&e).down.store(false, Ordering::SeqCst);
    kept_alive(&kept, &e, &hub).await;
    assert_eq!(devbox(&e).grant_puts(), 0);
    assert!(devbox(&e).grant(ACME).is_none());
    assert!(devbox(&e).held.lock().unwrap().links.is_empty());
    assert_eq!(hub.mints().len(), mints);
    assert!(hub.live().is_empty());
    assert!(load(&kept).await.groups.is_empty());
}

/// A write another one overtook is tried again past what the engine has
/// then, never at the same revision.
#[tokio::test]
async fn a_grant_overtaken_is_written_past_what_the_engine_has() {
    let dir = tempfile::tempdir().unwrap();
    let kept = dir.path().join(KEPT_FILE);
    let e = two();
    let hub = FakeHub::new(HubMode::Takes);
    linked(dir.path(), &e, &hub, suggest()).await;
    let r1 = e.here.grant(ACME).unwrap()["revision"].as_i64().unwrap();
    e.here.race.store(true, Ordering::SeqCst);
    kept_alive(&kept, &e, &hub).await;
    let g = e.here.grant(ACME).unwrap();
    assert_eq!(g["revision"].as_i64().unwrap(), r1 + 2);
    assert_eq!(g["members"], json!([S1, S2]));
}

/// Kept alive: a grant that says nothing new is renewed at its revision,
/// one whose sessions changed is written anew, and a token near its end is
/// renewed (as a renewal of it), handed over, and the old one revoked.
#[tokio::test]
async fn keeping_alive_renews_grants_and_tokens() {
    let dir = tempfile::tempdir().unwrap();
    let kept = dir.path().join(KEPT_FILE);
    let e = two();
    let hub = FakeHub::new(HubMode::Takes);
    *hub.expires_at.lock().unwrap() = Utc::now() + Duration::days(5);
    linked(dir.path(), &e, &hub, suggest()).await;
    let r1 = e.here.grant(ACME).unwrap()["revision"].as_i64().unwrap();
    let old = read_kept(&kept).groups[ACME].engines[LOCAL_ENGINE].clone();
    *hub.expires_at.lock().unwrap() = Utc::now() + Duration::days(30);
    kept_alive(&kept, &e, &hub).await;
    assert_eq!(
        e.here.grant(ACME).unwrap()["revision"].as_i64().unwrap(),
        r1
    );
    let renewal = hub
        .mints()
        .into_iter()
        .find(|m| m["renews"] == old.token_id.as_str())
        .expect("a renewal of the old token");
    assert_eq!(renewal["engine"]["id"], "local");
    assert!(!hub.live().contains(&old.token_id), "the old one revoked");
    let handed = e.here.held.lock().unwrap().handed.clone();
    assert_eq!(handed.len(), 2, "the link was handed over again");
    let links = e.here.held.lock().unwrap().links.clone();
    assert_eq!(links.len(), 1, "the old link taken off");
    let l = read_kept(&kept).groups[ACME].engines[LOCAL_ENGINE].clone();
    assert!(l.expires_at > Utc::now() + Duration::days(20));
    assert!(read_kept(&kept).groups[ACME].orphans.is_empty());
    // A session leaves the group: the grant is written anew.
    e.here.set_items(json!([
        format!("session:{S1}"),
        format!("session:devbox/{S3}")
    ]));
    kept_alive(&kept, &e, &hub).await;
    let g = e.here.grant(ACME).unwrap();
    assert_eq!(g["revision"].as_i64().unwrap(), r1 + 1);
    assert_eq!(g["members"], json!([S1]));
}

/// A renewal the engine won't keep is revoked, and the old token stays
/// the engine's.
#[tokio::test]
async fn a_renewal_not_handed_over_is_revoked_and_the_old_one_kept() {
    let dir = tempfile::tempdir().unwrap();
    let kept = dir.path().join(KEPT_FILE);
    let e = two();
    let hub = FakeHub::new(HubMode::Takes);
    *hub.expires_at.lock().unwrap() = Utc::now() + Duration::days(5);
    linked(dir.path(), &e, &hub, suggest()).await;
    let old = read_kept(&kept).groups[ACME].engines[LOCAL_ENGINE].clone();
    e.here.refuse_link.store(true, Ordering::SeqCst);
    kept_alive(&kept, &e, &hub).await;
    let now = read_kept(&kept).groups[ACME].clone();
    assert_eq!(now.engines[LOCAL_ENGINE].token_id, old.token_id);
    assert!(now.orphans.is_empty());
    assert!(hub.live().contains(&old.token_id));
    // Only the old token, and devbox's renewal, are left on the hub.
    assert_eq!(hub.live().len(), 2);
}

/// A token that expired is made anew, the old link taken off the engine.
#[tokio::test]
async fn an_expired_token_is_made_anew() {
    let dir = tempfile::tempdir().unwrap();
    let kept = dir.path().join(KEPT_FILE);
    let e = two();
    let hub = FakeHub::new(HubMode::Takes);
    *hub.expires_at.lock().unwrap() = Utc::now() - Duration::hours(1);
    linked(dir.path(), &e, &hub, suggest()).await;
    let old = read_kept(&kept).groups[ACME].engines[LOCAL_ENGINE].clone();
    hub.live.lock().unwrap().clear();
    *hub.expires_at.lock().unwrap() = Utc::now() + Duration::days(30);
    kept_alive(&kept, &e, &hub).await;
    let l = read_kept(&kept).groups[ACME].engines[LOCAL_ENGINE].clone();
    assert_ne!(l.token_id, old.token_id);
    assert!(l.expires_at > Utc::now());
    let links = e.here.held.lock().unwrap().links.clone();
    assert_eq!(links.keys().collect::<Vec<_>>(), vec![&l.link_id]);
}

/// An engine that failed is linked by Try again, and one new to the group
/// by keeping alive; neither undoes a stop on its own.
#[tokio::test]
async fn try_again_links_an_engine_that_failed() {
    let dir = tempfile::tempdir().unwrap();
    let kept = dir.path().join(KEPT_FILE);
    let e = two();
    let hub = FakeHub::new(HubMode::Takes);
    devbox(&e).down.store(true, Ordering::SeqCst);
    let done = linked(dir.path(), &e, &hub, suggest()).await;
    assert_eq!(done.failed.len(), 1);
    let s = status(&kept, &e, ACME).await.unwrap();
    let missing = s.engines.iter().find(|x| x.engine == "devbox").unwrap();
    assert!(!missing.linked);
    assert!(
        missing
            .problem
            .as_deref()
            .unwrap()
            .contains("can't be reached")
    );
    devbox(&e).down.store(false, Ordering::SeqCst);
    let done = retry(&kept, &e, Some((&hub, &at())), ACME).await.unwrap();
    assert!(done.failed.is_empty(), "{:?}", done.failed);
    assert_eq!(devbox(&e).grant(ACME).unwrap()["members"], json!([S3]));
    assert!(read_kept(&kept).groups[ACME].unlinked.is_empty());
}

/// A boss in place of another: one question names both; the old one is
/// stopped everywhere before the new one is linked.
#[tokio::test]
async fn a_new_boss_in_place_of_another_stops_the_old_one_first() {
    let dir = tempfile::tempdir().unwrap();
    let kept = dir.path().join(KEPT_FILE);
    let e = two();
    let hub = FakeHub::new(HubMode::Takes);
    linked(dir.path(), &e, &hub, suggest()).await;
    let old: Vec<String> = hub.live().into_iter().collect();
    let seen = Mutex::new(Vec::new());
    let done = link(
        &kept,
        &e,
        &hub,
        &at(),
        Some(&hub),
        ACME,
        "bea",
        suggest(),
        yes(&seen),
    )
    .await
    .unwrap();
    assert!(done.failed.is_empty(), "{:?}", done.failed);
    assert!(seen.lock().unwrap()[0].contains("in place of Allan on “Driftwerk”"));
    assert!(old.iter().all(|t| !hub.live().contains(t)));
    assert_eq!(e.here.grant(ACME).unwrap()["boss"], "remote:driftwerk/bea");
    assert_eq!(e.here.grant(ACME).unwrap()["live"], true);
    // The same boss again is refused: it's changed in its sheet.
    assert!(
        link(&kept, &e, &hub, &at(), None, ACME, "bea", suggest(), never)
            .await
            .is_err()
    );
}

/// A hub Desk forgot: its groups are stopped on every engine, with no
/// token revoked (they went with the pairing).
#[tokio::test]
async fn a_forgotten_hub_s_groups_are_stopped() {
    let dir = tempfile::tempdir().unwrap();
    let kept = dir.path().join(KEPT_FILE);
    let e = two();
    let hub = FakeHub::new(HubMode::Takes);
    linked(dir.path(), &e, &hub, suggest()).await;
    let asked = hub.asked().len();
    hub_gone::<_, FakeHub>(&kept, &e, "driftwerk").await;
    assert_eq!(hub.asked().len(), asked);
    assert!(e.here.grant(ACME).is_none());
    assert!(devbox(&e).grant(ACME).is_none());
    assert!(load(&kept).await.groups.is_empty());
}

/// A session born in the group and listed elsewhere leaves its grant.
#[tokio::test]
async fn a_born_session_taken_out_of_the_group_leaves() {
    let dir = tempfile::tempdir().unwrap();
    let kept = dir.path().join(KEPT_FILE);
    let e = two();
    let hub = FakeHub::new(HubMode::Takes);
    linked(dir.path(), &e, &hub, suggest()).await;
    e.here.held.lock().unwrap().born = vec![S4.into()];
    e.here.layout.lock().unwrap()["ungrouped"]["items"] = json!([format!("session:{S4}")]);
    e.here
        .set_items(json!([format!("session:{S1}"), format!("session:{S2}")]));
    kept_alive(&kept, &e, &hub).await;
    assert!(e.here.held.lock().unwrap().born.is_empty());
}

/// An engine's own pause is let go only once the person says so.
#[tokio::test]
async fn an_engine_s_own_pause_is_let_go_natively() {
    let dir = tempfile::tempdir().unwrap();
    let kept = dir.path().join(KEPT_FILE);
    let e = two();
    let hub = FakeHub::new(HubMode::Takes);
    linked(dir.path(), &e, &hub, suggest()).await;
    devbox(&e).held.lock().unwrap().paused = true;
    let s = status(&kept, &e, ACME).await.unwrap();
    assert!(s.engines.iter().any(|x| x.engine_paused));
    assert!(unpause_engine(&e, "devbox", no).await.unwrap().cancelled);
    assert!(devbox(&e).held.lock().unwrap().paused);
    let seen = Mutex::new(Vec::new());
    unpause_engine(&e, "devbox", yes(&seen)).await.unwrap();
    assert!(!devbox(&e).held.lock().unwrap().paused);
}

#[test]
fn a_group_s_sessions_are_split_by_engine_and_ungrouped_has_no_remote_boss() {
    let g = group_of(&layout(), ACME).unwrap();
    assert_eq!(g.name, "Acme");
    assert_eq!(g.members[LOCAL_ENGINE], vec![S1, S2]);
    assert_eq!(g.members["devbox"], vec![S3]);
    assert_eq!(engines_of(&g), vec![LOCAL_ENGINE, "devbox"]);
    assert!(group_of(&layout(), "ungrouped").is_err());
    assert!(group_of(&layout(), "a/b").is_err());
    assert!(group_of(&layout(), "missing").is_err());
    // An engine with none of the group's sessions isn't linked, but this
    // computer's is for a group with none yet.
    let mut only_devbox = layout();
    only_devbox["groups"][0]["items"] = json!([format!("session:devbox/{S3}")]);
    assert_eq!(
        engines_of(&group_of(&only_devbox, ACME).unwrap()),
        vec!["devbox"]
    );
    assert_eq!(
        engines_of(&group_of(&layout(), "g-atlas").unwrap()),
        vec![LOCAL_ENGINE]
    );
}

#[test]
fn a_boss_hub_is_named_by_its_https_origin() {
    assert_eq!(
        canonical("https://Driftwerk.Example/").as_deref(),
        Some("https://driftwerk.example")
    );
    assert_eq!(
        canonical("https://h.example:8443").as_deref(),
        Some("https://h.example:8443")
    );
    assert_eq!(
        canonical("https://h.example:443").as_deref(),
        Some("https://h.example")
    );
    for bad in [
        "http://h.example",
        "https://u@h.example",
        "https://h.example/x",
        "https://h.example/?a=1",
    ] {
        assert!(canonical(bad).is_none(), "{bad}");
    }
}

#[test]
fn the_act_fully_line_is_the_one_agreed() {
    assert_eq!(
        full_line("Allan"),
        "Once Allan allows a request, Desk's ship and irreversible checks no longer apply; its hold, breaker and agent-settings checks still do."
    );
}

#[test]
fn a_question_at_a_time_and_quiet_after_a_cancel() {
    let gate = BossGate::with_quiet(std::time::Duration::from_secs(60));
    let asking = gate.start().unwrap();
    assert!(gate.start().is_err());
    gate.answered(false);
    drop(asking);
    assert!(gate.start().unwrap_err().contains("cancelled"));
}
