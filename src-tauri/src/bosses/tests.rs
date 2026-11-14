use std::collections::BTreeMap;
use std::sync::Mutex;

use super::*;

const ACME: &str = "g-acme";
const S1: &str = "11111111-1111-4111-8111-111111111111";
const S2: &str = "22222222-2222-4222-8222-222222222222";
const S3: &str = "33333333-3333-4333-8333-333333333333";
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

/// What an engine is asked, and what it holds, as a hub would.
#[derive(Default)]
struct Held {
    grants: BTreeMap<String, Value>,
    left: BTreeMap<String, i64>,
    links: BTreeMap<String, String>,
    /// Handed-over bodies, tokens and all: the engine's to keep.
    handed: Vec<Value>,
    asked: Vec<(String, String)>,
}

struct FakeEngine {
    id: String,
    name: String,
    layout: Value,
    held: Mutex<Held>,
    refuse_link: bool,
    refuse_grant: bool,
}

impl FakeEngine {
    fn new(id: &str, name: &str) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            layout: layout(),
            held: Mutex::default(),
            refuse_link: false,
            refuse_grant: false,
        }
    }
    fn asked(&self) -> Vec<(String, String)> {
        self.held.lock().unwrap().asked.clone()
    }
    fn grant(&self, g: &str) -> Option<Value> {
        self.held.lock().unwrap().grants.get(g).cloned()
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
        let body: Option<Value> = body.map(|b| serde_json::from_str(b).unwrap());
        let mut h = self.held.lock().unwrap();
        h.asked.push((method.into(), target.into()));
        let parts: Vec<&str> = target.trim_start_matches('/').split('/').collect();
        let out = match (method, parts.as_slice()) {
            ("GET", ["api", "desk", "layout"]) => answer(200, self.layout.clone()),
            ("GET", ["api", "desk", "engine-key"]) => answer(
                200,
                json!({"publicKey": format!("ed25519:KEY-{}", self.id)}),
            ),
            ("PUT", ["api", "desk", "boss-links", g]) => {
                if self.refuse_link {
                    answer(
                        400,
                        json!({"error": "a boss hub is linked at a public address"}),
                    )
                } else {
                    let b = body.unwrap();
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
                    .map(|(g, r)| (g.clone(), json!({"revision": r})))
                    .collect();
                answer(
                    200,
                    json!({"grants": h.grants.values().collect::<Vec<_>>(), "left": left}),
                )
            }
            ("PUT", ["api", "desk", "grants", g]) => {
                let b = body.unwrap();
                let rev = b["revision"].as_i64().unwrap();
                let old = h.grants.get(*g).cloned();
                let have = old
                    .as_ref()
                    .map(|o| o["revision"].as_i64().unwrap())
                    .or(h.left.get(*g).copied())
                    .unwrap_or(0);
                if self.refuse_grant {
                    answer(400, json!({"error": "act is an object of switches"}))
                } else if rev < have || (rev == have && old.is_none()) {
                    answer(
                        409,
                        json!({"error": format!("This engine has revision {have} of that grant: an older one is never taken.")}),
                    )
                } else {
                    let stopped =
                        old.as_ref().is_some_and(|o| o["stopped"] == true) && b["resume"] != true;
                    let mut view = b.clone();
                    view["group"] = json!(g);
                    view["stopped"] = json!(stopped);
                    view["live"] = json!(!stopped);
                    view["why"] = if stopped {
                        json!("Acme's boss was stopped in Desk.")
                    } else {
                        Value::Null
                    };
                    h.grants.insert((*g).into(), view);
                    answer(200, json!({"change": "new"}))
                }
            }
            ("DELETE", ["api", "desk", "grants", g]) => {
                if let Some(old) = h.grants.remove(*g) {
                    let r = old["revision"].as_i64().unwrap();
                    h.left.insert((*g).into(), r);
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
                }
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
    expires_at: Mutex<DateTime<Utc>>,
}

impl FakeHub {
    fn new(mode: HubMode) -> Self {
        Self {
            mode,
            asked: Mutex::default(),
            minted: Mutex::new(0),
            expires_at: Mutex::new(Utc::now() + Duration::days(30)),
        }
    }
    fn asked(&self) -> Vec<(String, String, Option<Value>)> {
        self.asked.lock().unwrap().clone()
    }
    fn revoked(&self) -> Vec<String> {
        self.asked()
            .into_iter()
            .filter(|(m, _, _)| m == "DELETE")
            .map(|(_, t, _)| t.rsplit('/').next().unwrap().to_string())
            .collect()
    }
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
            .push((method.into(), target.into(), body));
        let reply = |s: u16, v: Value| (s, Zeroizing::new(v.to_string().into_bytes()));
        let out = match (method, target) {
            ("GET", LINKS_PATH) => match self.mode {
                HubMode::Off => reply(
                    404,
                    json!({"error": "This hub's admin hasn't let Desk give its agents boss work."}),
                ),
                _ => reply(200, json!({"links": []})),
            },
            ("POST", LINKS_PATH) => match self.mode {
                HubMode::Declines => reply(
                    403,
                    json!({"error": "That agent doesn't take boss work from Desk."}),
                ),
                _ => {
                    let mut n = self.minted.lock().unwrap();
                    *n += 1;
                    reply(
                        201,
                        json!({
                            "id": format!("0000000{n}-0000-4000-8000-000000000000"),
                            "link_id": format!("1111111{n}-0000-4000-8000-000000000000"),
                            "token": fake_token(*n),
                            "expires_at": *self.expires_at.lock().unwrap(),
                            "hub": if self.mode == HubMode::OtherName { "https://elsewhere.example" } else { HUB_URL },
                        }),
                    )
                }
            },
            ("DELETE", _) => reply(204, json!(null)),
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

fn full(budget: f64) -> Choice {
    Choice {
        level: Level::Full,
        sees: Sees::Replies,
        budget_usd_per_day: Some(budget),
    }
}

fn engines(here: FakeEngine, devbox: FakeEngine) -> Engines<FakeEngine> {
    Engines {
        here,
        machines: vec![("devbox".into(), Ok(devbox))],
    }
}

fn two() -> Engines<FakeEngine> {
    engines(
        FakeEngine::new(LOCAL_ENGINE, HERE),
        FakeEngine::new("devbox", "devbox"),
    )
}

fn yes(
    seen: &Mutex<Vec<String>>,
) -> impl FnOnce(String, String, String) -> std::future::Ready<bool> + '_ {
    move |_title, question, _yes| {
        seen.lock().unwrap().push(question);
        std::future::ready(true)
    }
}

fn no(_: String, _: String, _: String) -> std::future::Ready<bool> {
    std::future::ready(false)
}

fn never(_: String, _: String, _: String) -> std::future::Ready<bool> {
    panic!("nothing that narrows is asked about")
}

async fn linked(dir: &Path, e: &Engines<FakeEngine>, hub: &FakeHub, choice: Choice) -> Done {
    let seen = Mutex::new(Vec::new());
    link(
        &dir.join(KEPT_FILE),
        e,
        hub,
        &at(),
        ACME,
        "allan",
        choice,
        yes(&seen),
    )
    .await
    .unwrap()
}

/// The person is asked once, natively, in words built from the layout;
/// then each engine gets its link and its grant, and nothing the page is
/// told or Desk keeps holds a token.
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
            "Let Allan on Driftwerk boss Acme's 3 sessions on devbox and {HERE}?"
        )),
        "{}",
        q[0]
    );
    // Each engine's own key went into its mint.
    let mints: Vec<Value> = hub
        .asked()
        .into_iter()
        .filter(|(m, _, _)| m == "POST")
        .map(|(_, _, b)| b.unwrap())
        .collect();
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
    // Each engine's grant names only its own sessions.
    let g = e.here.grant(ACME).unwrap();
    assert_eq!(g["boss"], "remote:driftwerk/allan");
    assert_eq!(g["level"], "suggest");
    assert_eq!(g["members"], json!([S1, S2]));
    assert_eq!(g["resume"], true);
    assert_eq!(
        e.machines[0].1.as_ref().unwrap().grant(ACME).unwrap()["members"],
        json!([S3])
    );
    // Nothing kept here, or told the page, holds a token.
    let kept = std::fs::read_to_string(dir.path().join(KEPT_FILE)).unwrap();
    assert!(!kept.contains("SENTINEL"), "{kept}");
    assert!(!serde_json::to_string(&done).unwrap().contains("SENTINEL"));
    let status = status(&dir.path().join(KEPT_FILE), &e, ACME).await.unwrap();
    assert!(!serde_json::to_string(&status).unwrap().contains("SENTINEL"));
    assert_eq!(status.party, "driftwerk/allan");
    assert!(status.engines.iter().all(|s| s.live == Some(true)));
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
    assert!(e.machines[0].1.as_ref().unwrap().asked().is_empty());
    assert!(!dir.path().join(KEPT_FILE).exists());
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
    assert_eq!(hub.revoked().len(), 2);
    assert!(e.here.held.lock().unwrap().handed.is_empty());

    let dir = tempfile::tempdir().unwrap();
    let mut here = FakeEngine::new(LOCAL_ENGINE, HERE);
    here.refuse_link = true;
    let mut devbox = FakeEngine::new("devbox", "devbox");
    devbox.refuse_grant = true;
    let e = engines(here, devbox);
    let hub = FakeHub::new(HubMode::Takes);
    let done = linked(dir.path(), &e, &hub, suggest()).await;
    assert_eq!(done.failed.len(), 2, "{:?}", done.failed);
    assert!(done.failed[0].why.contains("didn't keep the link"));
    assert!(done.failed[1].why.contains("didn't take the grant"));
    assert_eq!(hub.revoked().len(), 2);
    assert!(
        e.machines[0]
            .1
            .as_ref()
            .unwrap()
            .held
            .lock()
            .unwrap()
            .links
            .is_empty()
    );
    assert!(!serde_json::to_string(&done).unwrap().contains("SENTINEL"));
    // Nothing linked: nothing kept.
    assert!(bosses(&dir.path().join(KEPT_FILE)).await.is_empty());
}

#[tokio::test]
async fn an_agent_that_declines_boss_work_says_so_plainly() {
    let dir = tempfile::tempdir().unwrap();
    let e = two();
    let hub = FakeHub::new(HubMode::Declines);
    let done = linked(dir.path(), &e, &hub, suggest()).await;
    assert_eq!(
        done.failed[0].why,
        "Allan doesn't take boss work from Desk: Driftwerk's admin turns it on in Allan's settings."
    );
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
    set(&kept, &e, ACME, full(30.0), never).await.unwrap();
    let g = e.here.grant(ACME).unwrap();
    assert_eq!(g["act"]["budget_usd_per_day"], 30.0);
    assert_eq!(g["revision"].as_i64().unwrap(), r1 + 1);
    let done = set(&kept, &e, ACME, full(90.0), no).await.unwrap();
    assert!(done.cancelled);
    assert_eq!(
        e.here.grant(ACME).unwrap()["act"]["budget_usd_per_day"],
        30.0
    );
    let seen = Mutex::new(Vec::new());
    set(&kept, &e, ACME, full(90.0), yes(&seen)).await.unwrap();
    assert!(seen.lock().unwrap()[0].contains(&full_line("Allan")));
    assert_eq!(
        e.here.grant(ACME).unwrap()["act"]["budget_usd_per_day"],
        90.0
    );
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
    assert!(bosses(&kept).await[ACME].paused);
    assert!(resume(&kept, &e, ACME, no).await.unwrap().cancelled);
    assert_eq!(e.here.grant(ACME).unwrap()["live"], false);
    let seen = Mutex::new(Vec::new());
    resume(&kept, &e, ACME, yes(&seen)).await.unwrap();
    assert_eq!(e.here.grant(ACME).unwrap()["live"], true);
    assert!(!bosses(&kept).await[ACME].paused);
}

/// Stop pauses, revokes every token, takes every link off its engine and
/// deletes every grant, in that order on each engine.
#[tokio::test]
async fn stop_pauses_revokes_unlinks_and_deletes_the_grants() {
    let dir = tempfile::tempdir().unwrap();
    let kept = dir.path().join(KEPT_FILE);
    let e = two();
    let hub = FakeHub::new(HubMode::Takes);
    linked(dir.path(), &e, &hub, suggest()).await;
    let done = unlink(&kept, &e, &hub, ACME).await.unwrap();
    assert!(done.failed.is_empty(), "{:?}", done.failed);
    assert_eq!(hub.revoked().len(), 2);
    let asked = e.here.asked();
    let after: Vec<&str> = asked
        .iter()
        .skip_while(|(m, t)| !(m == "POST" && t == "/api/desk/bosses/stop"))
        .map(|(m, _)| m.as_str())
        .collect();
    assert_eq!(after, ["POST", "DELETE", "DELETE"]);
    assert!(e.here.grant(ACME).is_none());
    assert!(e.here.held.lock().unwrap().links.is_empty());
    assert!(bosses(&kept).await.is_empty());
    // Linked again later: past what the deleted grant left, and resumed.
    linked(dir.path(), &e, &hub, suggest()).await;
    assert_eq!(e.here.grant(ACME).unwrap()["live"], true);
}

/// Kept alive: a grant that says nothing new is renewed at its revision,
/// one whose sessions changed is written anew, and a token near its end is
/// renewed (mint, hand over, then the old one revoked).
#[tokio::test]
async fn keeping_alive_renews_grants_and_tokens() {
    let dir = tempfile::tempdir().unwrap();
    let kept = dir.path().join(KEPT_FILE);
    let mut e = two();
    let hub = FakeHub::new(HubMode::Takes);
    *hub.expires_at.lock().unwrap() = Utc::now() + Duration::days(5);
    linked(dir.path(), &e, &hub, suggest()).await;
    let r1 = e.here.grant(ACME).unwrap()["revision"].as_i64().unwrap();
    *hub.expires_at.lock().unwrap() = Utc::now() + Duration::days(30);
    let hub_of = |_: &str| Some((FakeHub::new(HubMode::Takes), at()));
    // The renewal's hub is another fake: the old tokens are revoked there.
    keep(&kept, &e, hub_of).await.unwrap();
    assert_eq!(
        e.here.grant(ACME).unwrap()["revision"].as_i64().unwrap(),
        r1
    );
    let handed = e.here.held.lock().unwrap().handed.clone();
    assert_eq!(handed.len(), 2, "the link was handed over again");
    let l = read_kept(&kept).groups[ACME].engines[LOCAL_ENGINE].clone();
    assert!(l.expires_at > Utc::now() + Duration::days(20));
    // A session leaves the group: the grant is written anew.
    e.here.layout["groups"][0]["items"] =
        json!([format!("session:{S1}"), format!("session:devbox/{S3}")]);
    let hub_of = |_: &str| Some((FakeHub::new(HubMode::Takes), at()));
    keep(&kept, &e, hub_of).await.unwrap();
    let g = e.here.grant(ACME).unwrap();
    assert_eq!(g["revision"].as_i64().unwrap(), r1 + 1);
    assert_eq!(g["members"], json!([S1]));
}

#[test]
fn a_group_s_sessions_are_split_by_engine_and_ungrouped_has_no_remote_boss() {
    let g = group_of(&layout(), ACME).unwrap();
    assert_eq!(g.name, "Acme");
    assert_eq!(g.members[LOCAL_ENGINE], vec![S1, S2]);
    assert_eq!(g.members["devbox"], vec![S3]);
    assert!(group_of(&layout(), "ungrouped").is_err());
    assert!(group_of(&layout(), "a/b").is_err());
    assert!(group_of(&layout(), "missing").is_err());
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
