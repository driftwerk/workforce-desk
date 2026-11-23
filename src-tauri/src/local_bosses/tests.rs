use std::future::Future;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use super::*;
use crate::broker::NativeAnswer;

const S1: &str = "11111111-1111-4111-8111-111111111111";
const S2: &str = "22222222-2222-4222-8222-222222222222";
const S3: &str = "33333333-3333-4333-8333-333333333333";

/// What a machine's hub does with grants, as far as these steps need: a
/// revision only goes up and the same one again only renews; a session is
/// in one grant at most; a deleted grant leaves its revision and its stop.
#[derive(Default)]
struct Held {
    grants: BTreeMap<String, Value>,
    left: BTreeMap<String, (i64, Value)>,
    asked: Vec<(String, String, Option<Value>)>,
    /// The most hours this machine gives a grant.
    most_hours: Option<u64>,
}

struct Machine {
    id: String,
    held: StdMutex<Held>,
}

impl Machine {
    fn new(id: &str) -> Self {
        Self {
            id: id.into(),
            held: StdMutex::default(),
        }
    }
    fn grant(&self, g: &str) -> Option<Value> {
        self.held.lock().unwrap().grants.get(g).cloned()
    }
    fn hold(&self, group: &str, body: Value, stopped: Value) {
        let mut v = body;
        v["group"] = json!(group);
        v["stopped"] = stopped;
        v["born"] = json!([]);
        v["issuedAt"] = json!(Utc::now());
        v["expiresAt"] = json!(Utc::now() + chrono::Duration::hours(72));
        self.held.lock().unwrap().grants.insert(group.into(), v);
    }
    fn writes(&self) -> Vec<(String, String, Option<Value>)> {
        self.held
            .lock()
            .unwrap()
            .asked
            .iter()
            .filter(|(m, _, _)| m != "GET")
            .cloned()
            .collect()
    }
    fn forget_asked(&self) {
        self.held.lock().unwrap().asked.clear();
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

impl Engine for Machine {
    fn id(&self) -> &str {
        &self.id
    }
    fn name(&self) -> &str {
        &self.id
    }
    fn call(
        &self,
        method: &str,
        target: &str,
        body: Option<&Zeroizing<String>>,
    ) -> impl Future<Output = Result<NativeAnswer, String>> + Send {
        // Only what the native side may ask a machine ever reaches it.
        assert!(
            crate::broker::routes::native_boss(method, target).is_ok(),
            "{method} {target}"
        );
        let body: Option<Value> = body.map(|b| serde_json::from_str(b).unwrap());
        let mut h = self.held.lock().unwrap();
        h.asked.push((method.into(), target.into(), body.clone()));
        let parts: Vec<&str> = target.trim_start_matches('/').split('/').collect();
        let out = match (method, parts.as_slice()) {
            ("GET", ["api", "desk", "grants"]) => {
                let left: serde_json::Map<String, Value> = h
                    .left
                    .iter()
                    .map(|(g, (r, s))| (g.clone(), json!({"revision": r, "stopped": s})))
                    .collect();
                answer(
                    200,
                    json!({"grants": h.grants.values().cloned().collect::<Vec<_>>(), "left": left}),
                )
            }
            ("PUT", ["api", "desk", "grants", g]) => {
                let b = body.unwrap();
                let resume = b["resume"] == true;
                let rev = b["revision"].as_i64().unwrap();
                let old = h.grants.get(*g).cloned();
                let have = old
                    .as_ref()
                    .map(|o| o["revision"].as_i64().unwrap())
                    .or(h.left.get(*g).map(|(r, _)| *r))
                    .unwrap_or(0);
                let members = members_of(&b);
                let taken = h.grants.iter().any(|(other, o)| {
                    other != g && members_of(o).intersection(&members).next().is_some()
                });
                let same = old.as_ref().is_some_and(|o| says_same(o, &b));
                let too_long =
                    matches!((b["hours"].as_u64(), h.most_hours), (Some(a), Some(m)) if a > m);
                if too_long {
                    answer(
                        400,
                        json!({
                            "error": "this engine lets a grant last 1 to 12 hours, not 24",
                            "code": "grant_too_long",
                            "mostHours": h.most_hours,
                        }),
                    )
                } else if rev < have
                    || taken
                    || (rev == have && (!same || resume))
                    || (old.is_none() && rev <= have)
                {
                    answer(409, json!({"error": "no"}))
                } else {
                    let stopped = match resume {
                        true => Value::Null,
                        false => old
                            .as_ref()
                            .map(|o| o["stopped"].clone())
                            .or(h.left.get(*g).map(|(_, s)| s.clone()))
                            .unwrap_or(Value::Null),
                    };
                    let mut v = b.clone();
                    for k in ["leaving", "hours", "resume"] {
                        v.as_object_mut().unwrap().remove(k);
                    }
                    v["group"] = json!(g);
                    v["stopped"] = stopped;
                    v["born"] = json!([]);
                    v["issuedAt"] = json!(Utc::now());
                    v["expiresAt"] = json!(Utc::now() + chrono::Duration::hours(72));
                    h.grants.insert((*g).to_string(), v.clone());
                    answer(200, json!({"grant": v}))
                }
            }
            ("DELETE", ["api", "desk", "grants", g]) => match h.grants.remove(*g) {
                Some(o) => {
                    let stopped = o["stopped"].clone();
                    h.left
                        .insert((*g).to_string(), (o["revision"].as_i64().unwrap(), stopped));
                    answer(204, Value::Null)
                }
                None => answer(404, Value::Null),
            },
            other => panic!("not a grant's route: {other:?}"),
        };
        std::future::ready(Ok(out))
    }
}

/// What the hub says Acme's boss on this computer should have on a machine.
fn acme(members: &[&str], level: &str) -> WantedGrant {
    WantedGrant {
        group: "acme".into(),
        agent: "sarah".into(),
        agent_name: "Sarah".into(),
        agent_since: Some("born-1".into()),
        plan: None,
        grant: json!({
            "grantVersion": 1, "name": "Acme", "boss": "local:sarah",
            "level": level, "sees": "everything", "recall": false,
            "folders": [], "repos": [], "members": members,
            "act": {"nudge": true, "interrupt": true, "parallel": 4},
        }),
    }
}

fn wanted(machines: &[(&str, Vec<WantedGrant>, &[&str])]) -> Wanted {
    Wanted {
        grant_version: 1,
        plans_known: true,
        ungrouped_known: false,
        machines: machines
            .iter()
            .map(|(m, g, listed)| {
                (
                    m.to_string(),
                    MachineWanted {
                        grants: g.clone(),
                        listed: listed.iter().map(|s| s.to_string()).collect(),
                        ungrouped_known: true,
                    },
                )
            })
            .collect(),
    }
}

struct Files {
    _dir: tempfile::TempDir,
    bosses: std::path::PathBuf,
    kept: std::path::PathBuf,
}

fn files() -> Files {
    let dir = tempfile::tempdir().unwrap();
    Files {
        bosses: dir.path().join(bosses::KEPT_FILE),
        kept: dir.path().join(KEPT_FILE),
        _dir: dir,
    }
}

async fn say(f: &Files, w: &Wanted, yes: bool) -> Option<(String, String, String)> {
    let asked: Arc<StdMutex<Option<(String, String, String)>>> = Arc::default();
    let got = Arc::clone(&asked);
    let names = BTreeMap::from([("devbox".to_string(), "devbox".to_string())]);
    ask_one(&f.kept, w, &names, &BTreeSet::new(), move |t, b, y| {
        *got.lock().unwrap() = Some((t, b, y));
        async move { Ok(yes) }
    })
    .await
    .unwrap();
    asked.lock().unwrap().clone()
}

fn on<'a>(m: &'a [&'a Machine]) -> Vec<(String, Result<&'a Machine, String>)> {
    m.iter().map(|m| (m.id.clone(), Ok(*m))).collect()
}

impl Engine for &Machine {
    fn id(&self) -> &str {
        (*self).id()
    }
    fn name(&self) -> &str {
        (*self).name()
    }
    fn call(
        &self,
        method: &str,
        target: &str,
        body: Option<&Zeroizing<String>>,
    ) -> impl Future<Output = Result<NativeAnswer, String>> + Send {
        (*self).call(method, target, body)
    }
}

#[tokio::test]
async fn the_main_overseer_is_asked_once_for_a_machine_s_ungrouped_sessions() {
    let f = files();
    let devbox = Machine::new("devbox");
    let mut g = acme(&[S1], "act");
    g.group = "ungrouped".into();
    g.agent = "desk".into();
    g.agent_name = "Desk".into();
    g.grant["boss"] = json!("local:desk");
    g.grant["name"] = json!("Ungrouped");
    let w = wanted(&[("devbox", vec![g.clone()], &[S1])]);
    let (title, body, _) = say(&f, &w, true).await.expect("asked");
    assert!(title.contains("“Desk”"), "{title}");
    assert!(
        body.starts_with("“Desk” oversees your ungrouped sessions on this computer"),
        "{body}"
    );
    assert!(body.contains("1 session on “devbox”"), "{body}");
    let s = sync(&f.bosses, &f.kept, &w, &on(&[&devbox])).await;
    assert_eq!(s.failed, vec![]);
    assert_eq!(
        content(&devbox.grant("ungrouped").unwrap()),
        content(&g.grant)
    );
    // What the page hands devbox's ungrouped sessions to.
    let desk = BTreeMap::from([("ungrouped".to_string(), "desk".to_string())]);
    assert_eq!(s.carried["devbox"], desk);

    // The hub restarted, or Desk asks again after a while: devbox's
    // sessions aren't read yet, so its grant is left as it is, still handed
    // to its boss.
    let unread = |known: bool| {
        let mut w = wanted(&[("devbox", vec![], &[S1])]);
        w.machines.get_mut("devbox").unwrap().ungrouped_known = known;
        w
    };
    let before = devbox.writes().len();
    let s = sync(&f.bosses, &f.kept, &unread(false), &on(&[&devbox])).await;
    assert_eq!(devbox.writes().len(), before, "{:?}", devbox.writes());
    assert!(devbox.grant("ungrouped").is_some());
    assert_eq!(s.carried["devbox"], desk);
    // A machine the hub doesn't say at all is left as it is too.
    let s = sync(&f.bosses, &f.kept, &wanted(&[]), &on(&[&devbox])).await;
    assert!(devbox.grant("ungrouped").is_some());
    assert_eq!(s.carried.get("devbox"), Some(&desk));
    // Read, with nothing in Ungrouped there: it goes.
    sync(&f.bosses, &f.kept, &unread(true), &on(&[&devbox])).await;
    assert!(devbox.grant("ungrouped").is_none());
}

#[tokio::test]
async fn a_machine_s_ungrouped_grant_goes_once_there_is_no_main_overseer() {
    let f = files();
    let devbox = Machine::new("devbox");
    let mut g = acme(&[S1], "act");
    g.group = "ungrouped".into();
    g.agent = "desk".into();
    g.grant["boss"] = json!("local:desk");
    let w = wanted(&[("devbox", vec![g], &[S1])]);
    say(&f, &w, true).await.expect("asked");
    sync(&f.bosses, &f.kept, &w, &on(&[&devbox])).await;
    assert!(devbox.grant("ungrouped").is_some());

    // The main overseer is gone: devbox, with no other grant, isn't listed
    // at all, and every machine's Ungrouped grant is said to be none.
    let gone = Wanted {
        ungrouped_known: true,
        ..wanted(&[])
    };
    let s = sync(&f.bosses, &f.kept, &gone, &on(&[&devbox])).await;
    assert_eq!(s.failed, vec![]);
    assert!(devbox.grant("ungrouped").is_none(), "{:?}", devbox.writes());
    assert!(
        s.carried.get("devbox").is_none_or(BTreeMap::is_empty),
        "{:?}",
        s.carried
    );
}

#[tokio::test]
async fn nothing_is_written_until_the_person_says_yes_and_then_exactly_what_the_hub_says() {
    let f = files();
    let devbox = Machine::new("devbox");
    let w = wanted(&[("devbox", vec![acme(&[S1, S2], "act")], &[S1, S2])]);
    sync(&f.bosses, &f.kept, &w, &on(&[&devbox])).await;
    assert!(devbox.writes().is_empty(), "not asked yet");

    let (title, body, yes) = say(&f, &w, true).await.expect("asked");
    assert!(title.contains("“Sarah”"), "the boss's name quoted: {title}");
    assert!(body.starts_with("“Sarah” oversees"), "{body}");
    assert!(
        body.contains("2 sessions") && body.contains("“devbox”") && body.contains("“Acme”"),
        "{body}"
    );
    assert!(body.contains("acting within Desk"), "{body}");
    assert!(yes.contains("“Sarah”"), "{yes}");
    // Asked once: a yes holds.
    assert!(say(&f, &w, true).await.is_none());

    let s = sync(&f.bosses, &f.kept, &w, &on(&[&devbox])).await;
    assert_eq!(s.failed, vec![]);
    let g = devbox.grant("acme").unwrap();
    assert_eq!(content(&g), content(&acme(&[S1, S2], "act").grant));
    assert_eq!(g["revision"], 1);
    let put = devbox.writes().last().unwrap().2.clone().unwrap();
    assert_eq!(put["hours"], 24, "a day at a time");
    assert!(put.get("resume").is_none(), "nothing to lift: {put}");
    // Nothing new: nothing written, until it is past half its life.
    devbox.forget_asked();
    sync(&f.bosses, &f.kept, &w, &on(&[&devbox])).await;
    assert!(devbox.writes().is_empty());
    {
        let mut h = devbox.held.lock().unwrap();
        let g = h.grants.get_mut("acme").unwrap();
        g["issuedAt"] = json!(Utc::now() - chrono::Duration::hours(42));
        g["expiresAt"] = json!(Utc::now() + chrono::Duration::hours(30));
    }
    sync(&f.bosses, &f.kept, &w, &on(&[&devbox])).await;
    assert_eq!(devbox.writes().len(), 1);
    assert_eq!(devbox.grant("acme").unwrap()["revision"], 1, "renewed");
    // A session the person puts in the group later is the boss's, as at
    // home: not asked again.
    let more = wanted(&[("devbox", vec![acme(&[S1, S2, S3], "act")], &[S1, S2, S3])]);
    assert!(say(&f, &more, true).await.is_none());
    sync(&f.bosses, &f.kept, &more, &on(&[&devbox])).await;
    assert_eq!(members_of(&devbox.grant("acme").unwrap()).len(), 3);
}

/// What a write says, apart from when and how often it was written.
fn content(v: &Value) -> Value {
    let mut v = v.clone();
    for k in [
        "revision",
        "group",
        "stopped",
        "born",
        "issuedAt",
        "expiresAt",
        "leaving",
    ] {
        v.as_object_mut().unwrap().remove(k);
    }
    v
}

#[tokio::test]
async fn a_no_holds_until_a_machine_session_the_person_wasnt_asked_about_joins() {
    let f = files();
    let devbox = Machine::new("devbox");
    let w = wanted(&[("devbox", vec![acme(&[S1], "act")], &[S1])]);
    assert!(say(&f, &w, false).await.is_some());
    assert!(say(&f, &w, false).await.is_none(), "not asked again");
    sync(&f.bosses, &f.kept, &w, &on(&[&devbox])).await;
    assert!(devbox.writes().is_empty());
    let more = wanted(&[("devbox", vec![acme(&[S1, S2], "act")], &[S1, S2])]);
    assert!(
        say(&f, &more, true).await.is_some(),
        "asked about the new one"
    );
    sync(&f.bosses, &f.kept, &more, &on(&[&devbox])).await;
    assert!(devbox.grant("acme").is_some());
}

#[tokio::test]
async fn a_group_bossed_from_another_hub_is_never_written() {
    let f = files();
    let devbox = Machine::new("devbox");
    let w = wanted(&[("devbox", vec![acme(&[S1], "act")], &[S1])]);
    say(&f, &w, true).await;
    // Its grant on the machine names a boss on another hub.
    let allan = json!({"grantVersion": 1, "revision": 3, "name": "Acme", "boss": "remote:driftwerk/allan",
                       "level": "suggest", "sees": "replies", "recall": false, "folders": [], "repos": [],
                       "members": [S1], "act": {}});
    devbox.hold("acme", allan.clone(), Value::Null);
    let s = sync(&f.bosses, &f.kept, &w, &on(&[&devbox])).await;
    assert!(devbox.writes().is_empty(), "{:?}", devbox.writes());
    assert!(
        s.carried["devbox"].is_empty(),
        "not this computer's to hand to"
    );
    assert_eq!(
        devbox.grant("acme").unwrap()["boss"],
        "remote:driftwerk/allan"
    );

    // Desk linked a boss on another hub for it: a grant of ours there goes,
    // and none is written.
    let f2 = files();
    say(&f2, &w, true).await;
    let other = Machine::new("devbox");
    sync(&f2.bosses, &f2.kept, &w, &on(&[&other])).await;
    assert!(other.grant("acme").is_some());
    let kept = json!({"groups": {"acme": {
        "hub": "driftwerk", "hubLabel": "Driftwerk", "agent": "allan",
        "choice": {"level": "suggest", "sees": "replies"}, "engines": {}
    }}});
    std::fs::write(&f2.bosses, kept.to_string()).unwrap();
    other.forget_asked();
    let s = sync(&f2.bosses, &f2.kept, &w, &on(&[&other])).await;
    assert!(other.grant("acme").is_none());
    assert!(s.narrowed);
    assert!(
        other.writes().iter().all(|(m, _, _)| m == "DELETE"),
        "{:?}",
        other.writes()
    );
    // Nor is one asked about.
    let f3 = files();
    std::fs::write(&f3.bosses, kept.to_string()).unwrap();
    let names = BTreeMap::new();
    let remote = BTreeSet::from(["acme".to_string()]);
    let asked = ask_one(&f3.kept, &w, &names, &remote, |_, _, _| async {
        Err::<bool, String>("asked".into())
    })
    .await;
    assert_eq!(asked, Ok(false));
}

/// A grant the machine wouldn't take is never one the page hands its
/// sessions to.
#[tokio::test]
async fn a_grant_the_machine_refused_hands_it_nothing() {
    let f = files();
    let devbox = Machine::new("devbox");
    let w = wanted(&[("devbox", vec![acme(&[S1], "act")], &[S1])]);
    say(&f, &w, true).await;
    // Another home's grant there holds S1: Acme's is refused whole.
    let globex = json!({"grantVersion": 1, "revision": 1, "name": "Globex", "boss": "remote:driftwerk/allan",
                        "level": "suggest", "sees": "replies", "recall": false, "folders": [], "repos": [],
                        "members": [S1], "act": {}});
    devbox.hold("globex", globex, Value::Null);
    let s = sync(&f.bosses, &f.kept, &w, &on(&[&devbox])).await;
    assert_eq!(s.failed.len(), 1, "{:?}", s.failed);
    assert!(devbox.grant("acme").is_none());
    assert!(s.carried["devbox"].is_empty(), "{:?}", s.carried);
}

fn stop(from: &str, at: DateTime<Utc>) -> Value {
    json!({"at": at, "from": from})
}

#[tokio::test]
async fn a_boss_taken_off_has_its_grant_deleted_and_a_machine_s_stop_is_never_lifted() {
    let f = files();
    let devbox = Machine::new("devbox");
    let w = wanted(&[("devbox", vec![acme(&[S1], "act")], &[S1])]);
    say(&f, &w, true).await;
    sync(&f.bosses, &f.kept, &w, &on(&[&devbox])).await;
    // The machine stopped it: it stays stopped through what is written,
    // and is said.
    let there = stop("machine", Utc::now());
    devbox.held.lock().unwrap().grants.get_mut("acme").unwrap()["stopped"] = there.clone();
    let lower = wanted(&[("devbox", vec![acme(&[S1], "watch")], &[S1])]);
    let s = sync(&f.bosses, &f.kept, &lower, &on(&[&devbox])).await;
    let g = devbox.grant("acme").unwrap();
    assert_eq!((&g["level"], &g["stopped"]), (&json!("watch"), &there));
    assert!(
        s.stopped_there
            .contains(&("devbox".to_string(), "acme".to_string()))
    );
    assert!(
        s.carried["devbox"].is_empty(),
        "stopped there: no one's to hand to"
    );
    assert!(
        devbox
            .writes()
            .iter()
            .all(|(_, _, b)| b.as_ref().is_none_or(|b| b.get("resume").is_none()))
    );

    // The hub wants nothing for it any more (the boss taken off, the group
    // deleted, its sessions moved out): deleted.
    let none = wanted(&[("devbox", vec![], &[S1])]);
    let s = sync(&f.bosses, &f.kept, &none, &on(&[&devbox])).await;
    assert!(devbox.grant("acme").is_none());
    assert!(s.narrowed);
    // Written again past its floor, the machine's stop is kept, even after
    // a fresh yes.
    say_fresh(&f, &w).await;
    sync(&f.bosses, &f.kept, &w, &on(&[&devbox])).await;
    assert_eq!(
        devbox.grant("acme").unwrap()["stopped"],
        there,
        "its stop kept"
    );
    // A machine the hub doesn't name at all is cleared too.
    sync(&f.bosses, &f.kept, &wanted(&[]), &on(&[&devbox])).await;
    assert!(devbox.grant("acme").is_none());
}

/// Says yes afresh, as if the person had been asked again.
async fn say_fresh(f: &Files, w: &Wanted) {
    let mut kept = read_kept(&f.kept);
    kept.groups.remove("acme");
    std::fs::write(&f.kept, serde_json::to_string(&kept).unwrap()).unwrap();
    say(f, w, true).await.expect("asked again");
}

#[tokio::test]
async fn a_stop_desk_made_before_the_persons_yes_is_lifted_with_it_and_one_after_isnt() {
    let f = files();
    let devbox = Machine::new("devbox");
    let w = wanted(&[("devbox", vec![acme(&[S1], "act")], &[S1])]);
    // A remote boss of Acme was stopped in Desk, and its grant deleted.
    let before = Utc::now() - chrono::Duration::minutes(5);
    devbox
        .held
        .lock()
        .unwrap()
        .left
        .insert("acme".into(), (4, stop("desk", before)));
    say(&f, &w, true).await;
    let s = sync(&f.bosses, &f.kept, &w, &on(&[&devbox])).await;
    assert!(
        s.carried["devbox"].contains_key("acme"),
        "held for its boss"
    );
    let g = devbox.grant("acme").unwrap();
    assert_eq!(g["stopped"], Value::Null, "lifted by the yes");
    assert_eq!(g["revision"], 5);
    let put = devbox.writes().last().unwrap().2.clone().unwrap();
    assert_eq!(put["resume"], true);

    // Stopped in Desk after the yes: it stays stopped, and the person is
    // asked again.
    let after = stop("desk", Utc::now());
    devbox.held.lock().unwrap().grants.get_mut("acme").unwrap()["stopped"] = after.clone();
    let lower = wanted(&[("devbox", vec![acme(&[S1], "watch")], &[S1])]);
    let s = sync(&f.bosses, &f.kept, &lower, &on(&[&devbox])).await;
    assert!(s.stopped_since_yes.contains_key("acme"));
    assert!(
        s.carried["devbox"].is_empty(),
        "stopped: its boss runs nothing"
    );
    let g = devbox.grant("acme").unwrap();
    assert_eq!((&g["level"], &g["stopped"]), (&json!("watch"), &after));
    // A Cancel leaves it stopped and isn't asked again; written as it was,
    // it is still not carried.
    say(&f, &lower, false).await.expect("asked again");
    let s = sync(&f.bosses, &f.kept, &lower, &on(&[&devbox])).await;
    assert!(s.carried["devbox"].is_empty(), "{:?}", s.carried);
    assert_eq!(devbox.grant("acme").unwrap()["stopped"], after);
    assert!(say(&f, &lower, true).await.is_none());

    // Stopped again; this time the fresh yes lifts it.
    let again = stop("desk", Utc::now());
    devbox.held.lock().unwrap().grants.get_mut("acme").unwrap()["stopped"] = again;
    sync(&f.bosses, &f.kept, &lower, &on(&[&devbox])).await;
    say(&f, &lower, true).await.expect("asked again");
    sync(&f.bosses, &f.kept, &lower, &on(&[&devbox])).await;
    assert_eq!(devbox.grant("acme").unwrap()["stopped"], Value::Null);
}

#[tokio::test]
async fn a_higher_level_than_the_one_said_yes_to_asks_again() {
    let f = files();
    let devbox = Machine::new("devbox");
    let watching = wanted(&[("devbox", vec![acme(&[S1], "watch")], &[S1])]);
    say(&f, &watching, true).await.expect("asked");
    sync(&f.bosses, &f.kept, &watching, &on(&[&devbox])).await;
    assert_eq!(devbox.grant("acme").unwrap()["level"], "watch");
    // Raised to Suggest at home and Cancelled: kept at Watch, as said yes
    // to, and not asked again.
    let suggesting = wanted(&[("devbox", vec![acme(&[S1], "suggest")], &[S1])]);
    say(&f, &suggesting, false).await.expect("asked again");
    sync(&f.bosses, &f.kept, &suggesting, &on(&[&devbox])).await;
    assert_eq!(devbox.grant("acme").unwrap()["level"], "watch");
    assert!(say(&f, &suggesting, true).await.is_none());
    // Raised to Act: kept at Watch until the person says more.
    let acting = wanted(&[("devbox", vec![acme(&[S1], "act")], &[S1])]);
    sync(&f.bosses, &f.kept, &acting, &on(&[&devbox])).await;
    assert_eq!(devbox.grant("acme").unwrap()["level"], "watch");
    let (_, body, _) = say(&f, &acting, true).await.expect("asked again");
    assert!(body.contains("acting within Desk"), "{body}");
    sync(&f.bosses, &f.kept, &acting, &on(&[&devbox])).await;
    assert_eq!(devbox.grant("acme").unwrap()["level"], "act");
    // Lowered, nothing is asked.
    assert!(say(&f, &watching, true).await.is_none());
}

#[tokio::test]
async fn act_fully_with_no_budget_from_the_hub_is_carried_as_act_with_no_budget() {
    let f = files();
    let devbox = Machine::new("devbox");
    let w = wanted(&[("devbox", vec![acme(&[S1], "full")], &[S1])]);
    let (_, body, _) = say(&f, &w, true).await.expect("asked");
    assert!(body.contains("acting within Desk"), "{body}");
    sync(&f.bosses, &f.kept, &w, &on(&[&devbox])).await;
    let g = devbox.grant("acme").unwrap();
    assert_eq!(g["level"], "act");
    assert!(g["act"].get("budget_usd_per_day").is_none(), "{g}");
    assert_eq!(g["act"]["parallel"], 4);
    // A budget that can't be one is no budget.
    for bad in [json!(0), json!(-5), json!(20_000), json!("20")] {
        let mut full = acme(&[S1], "full");
        full.grant["act"]["budget_usd_per_day"] = bad;
        let g = capped(full.grant);
        assert_eq!(g["level"], "act", "{g}");
        assert!(g["act"].get("budget_usd_per_day").is_none(), "{g}");
    }
}

#[tokio::test]
async fn act_fully_with_its_one_budget_is_carried_once_the_person_says_yes_to_it() {
    let f = files();
    let devbox = Machine::new("devbox");
    // Said yes at Act first.
    let acting = wanted(&[("devbox", vec![acme(&[S1], "act")], &[S1])]);
    say(&f, &acting, true).await.expect("asked");
    sync(&f.bosses, &f.kept, &acting, &on(&[&devbox])).await;
    assert_eq!(devbox.grant("acme").unwrap()["level"], "act");
    // Act fully at home, with its budget: no higher until asked again.
    let mut full = acme(&[S1], "full");
    full.grant["act"]["budget_usd_per_day"] = json!(20);
    let w = wanted(&[("devbox", vec![full], &[S1])]);
    sync(&f.bosses, &f.kept, &w, &on(&[&devbox])).await;
    let g = devbox.grant("acme").unwrap();
    assert_eq!(g["level"], "act");
    let (_, body, _) = say(&f, &w, true).await.expect("asked again");
    assert!(
        body.contains("at Act fully, within one daily budget of $20.00 counted across this computer and every machine"),
        "{body}"
    );
    sync(&f.bosses, &f.kept, &w, &on(&[&devbox])).await;
    let g = devbox.grant("acme").unwrap();
    assert_eq!(g["level"], "full");
    assert_eq!(g["act"]["budget_usd_per_day"], 20);
    assert_eq!(g["act"]["parallel"], 4);
}

#[tokio::test]
async fn act_fully_with_no_budget_set_at_home_says_so_and_a_lower_yes_carries_no_budget() {
    let f = files();
    let devbox = Machine::new("devbox");
    let mut full = acme(&[S1], "full");
    full.grant["act"]["budget_usd_per_day"] = json!(10_000.0);
    let w = wanted(&[("devbox", vec![full], &[S1])]);
    let (_, body, _) = say(&f, &w, false).await.expect("asked");
    assert!(
        body.contains("at Act fully, with no daily budget set (at most $10000.00 a day"),
        "{body}"
    );
    // Said yes at Act, then raised: written at Act, with no budget.
    let f = files();
    let acting = wanted(&[("devbox", vec![acme(&[S1], "act")], &[S1])]);
    say(&f, &acting, true).await.expect("asked");
    sync(&f.bosses, &f.kept, &w, &on(&[&devbox])).await;
    let g = devbox.grant("acme").unwrap();
    assert_eq!(g["level"], "act");
    assert!(g["act"].get("budget_usd_per_day").is_none(), "{g}");
}

#[tokio::test]
async fn an_agent_made_again_with_the_same_id_is_asked_about_again() {
    let f = files();
    let devbox = Machine::new("devbox");
    let w = wanted(&[("devbox", vec![acme(&[S1], "act")], &[S1])]);
    say(&f, &w, true).await.expect("asked");
    sync(&f.bosses, &f.kept, &w, &on(&[&devbox])).await;
    assert_eq!(devbox.grant("acme").unwrap()["level"], "act");
    // Sarah deleted and made again: the old yes isn't hers.
    let mut again = acme(&[S1], "act");
    again.agent_since = Some("born-2".into());
    let again = wanted(&[("devbox", vec![again], &[S1])]);
    sync(&f.bosses, &f.kept, &again, &on(&[&devbox])).await;
    assert!(
        devbox.grant("acme").is_none(),
        "nothing is held for her until asked"
    );
    assert!(say(&f, &again, false).await.is_some(), "asked again");
    sync(&f.bosses, &f.kept, &again, &on(&[&devbox])).await;
    assert!(devbox.grant("acme").is_none(), "a Cancel gives her nothing");
}

#[tokio::test]
async fn a_no_is_asked_again_once_the_bosss_level_or_switches_change_at_home() {
    let f = files();
    let w = wanted(&[("devbox", vec![acme(&[S1], "act")], &[S1])]);
    say(&f, &w, false).await.expect("asked");
    assert!(say(&f, &w, false).await.is_none());
    let lower = wanted(&[("devbox", vec![acme(&[S1], "suggest")], &[S1])]);
    assert!(say(&f, &lower, false).await.is_some(), "its level changed");
    let mut switched = acme(&[S1], "suggest");
    switched.grant["act"]["interrupt"] = json!(false);
    let switched = wanted(&[("devbox", vec![switched], &[S1])]);
    assert!(
        say(&f, &switched, false).await.is_some(),
        "its switches changed"
    );
    assert!(say(&f, &switched, false).await.is_none());
}

#[tokio::test]
async fn a_machine_that_gives_less_than_a_day_is_written_its_own_length() {
    let f = files();
    let devbox = Machine::new("devbox");
    devbox.held.lock().unwrap().most_hours = Some(12);
    let w = wanted(&[("devbox", vec![acme(&[S1], "act")], &[S1])]);
    say(&f, &w, true).await;
    let s = sync(&f.bosses, &f.kept, &w, &on(&[&devbox])).await;
    assert_eq!(s.failed, vec![]);
    assert!(devbox.grant("acme").is_some());
    let put = devbox.writes().last().unwrap().2.clone().unwrap();
    assert_eq!(put["hours"], 12, "{put}");
}

#[tokio::test]
async fn narrowing_reaches_every_machine_before_anything_widens() {
    let f = files();
    let (devbox, atlas) = (Machine::new("devbox"), Machine::new("atlas"));
    let globex = |members: &[&str]| WantedGrant {
        group: "globex".into(),
        agent: "tom".into(),
        agent_name: "Tom".into(),
        agent_since: None,
        plan: None,
        grant: json!({
            "grantVersion": 1, "name": "Globex", "boss": "local:tom",
            "level": "act", "sees": "everything", "recall": false,
            "folders": [], "repos": [], "members": members, "act": {"nudge": true},
        }),
    };
    let w = wanted(&[
        (
            "devbox",
            vec![acme(&[S1, S2], "act"), globex(&[])],
            &[S1, S2],
        ),
        ("atlas", vec![acme(&[S3], "act")], &[S3]),
    ]);
    say(&f, &w, true).await;
    say(&f, &w, true).await;
    sync(&f.bosses, &f.kept, &w, &on(&[&devbox, &atlas])).await;
    assert!(devbox.grant("acme").is_some() && atlas.grant("acme").is_some());

    // S2 moves from Acme to Globex on devbox, and Acme's boss is lowered
    // to Watch while atlas gets nothing new.
    let w2 = wanted(&[
        (
            "devbox",
            vec![acme(&[S1], "watch"), globex(&[S2])],
            &[S1, S2],
        ),
        ("atlas", vec![acme(&[S3], "watch")], &[S3]),
    ]);
    devbox.forget_asked();
    atlas.forget_asked();
    let s = sync(&f.bosses, &f.kept, &w2, &on(&[&devbox, &atlas])).await;
    assert_eq!(s.failed, vec![], "the move went through in one run");
    assert_eq!(
        members_of(&devbox.grant("acme").unwrap()),
        BTreeSet::from([S1.to_string()])
    );
    assert_eq!(
        members_of(&devbox.grant("globex").unwrap()),
        BTreeSet::from([S2.to_string()])
    );
    assert_eq!(devbox.grant("acme").unwrap()["level"], "watch");
    assert_eq!(atlas.grant("acme").unwrap()["level"], "watch");
    // Acme narrowed on devbox before Globex gained S2 there.
    let writes = devbox.writes();
    let at = |g: &str| writes.iter().position(|(_, t, _)| t.ends_with(g)).unwrap();
    assert!(at("acme") < at("globex"), "{writes:?}");

    // A new boss of a group is never written over the old one's: no boss
    // first.
    let mut tom = acme(&[S1], "act");
    tom.agent = "tom".into();
    tom.grant["boss"] = json!("local:tom");
    let w3 = wanted(&[("devbox", vec![tom, globex(&[S2])], &[S1, S2])]);
    say(&f, &w3, true).await;
    devbox.forget_asked();
    sync(&f.bosses, &f.kept, &w3, &on(&[&devbox])).await;
    let bosses: Vec<Value> = devbox
        .writes()
        .iter()
        .filter(|(_, t, _)| t.ends_with("/acme"))
        .map(|(_, _, b)| b.as_ref().unwrap()["boss"].clone())
        .collect();
    assert_eq!(bosses, vec![Value::Null, json!("local:tom")]);
}

#[test]
fn a_meet_is_no_more_than_either_side() {
    let held = json!({"grantVersion": 1, "name": "Acme", "boss": "local:sarah", "level": "full",
        "sees": "replies", "recall": false, "folders": [], "repos": [], "members": [S1, S2],
        "act": {"nudge": true, "interrupt": false, "parallel": 6, "budget_usd_per_day": 25.0,
                "hold_minutes": 2, "answer_after_minutes": 30}});
    let wanted = json!({"grantVersion": 1, "name": "Acme", "boss": "local:sarah", "level": "act",
        "sees": "everything", "recall": false, "folders": [], "repos": [], "members": [S2, S3],
        "act": {"nudge": true, "interrupt": true, "parallel": 4,
                "hold_minutes": 5, "answer_after_minutes": 10}});
    let m = meet(&held, &wanted);
    assert_eq!(m["level"], "act");
    assert_eq!(m["sees"], "replies");
    assert_eq!(m["members"], json!([S2]));
    // The person's input holds a session the longer of the two.
    assert_eq!(
        m["act"],
        json!({"nudge": true, "interrupt": false, "parallel": 4,
               "hold_minutes": 5, "answer_after_minutes": 30})
    );
    assert_eq!(m["boss"], "local:sarah");
    let mut other = wanted.clone();
    other["boss"] = json!("local:tom");
    assert_eq!(meet(&held, &other)["boss"], Value::Null);
    // Nothing it can't read is taken for more.
    let mut odd = held.clone();
    odd["level"] = json!("everything");
    assert_eq!(meet(&odd, &wanted)["level"], "watch");
}

#[test]
fn only_a_grant_for_a_boss_here_with_nothing_wider_is_carried() {
    assert!(carried(&acme(&[S1], "act")));
    let bad = |f: fn(&mut WantedGrant)| {
        let mut g = acme(&[S1], "act");
        f(&mut g);
        carried(&g)
    };
    assert!(!bad(|g| g.grant["boss"] = json!("remote:driftwerk/allan")));
    assert!(!bad(|g| g.grant["boss"] = json!("local:tom")));
    assert!(!bad(|g| g.grant["folders"] = json!(["/home/dev"])));
    assert!(!bad(|g| g.grant["repos"] = json!(["acme/web"])));
    assert!(!bad(|g| g.grant["recall"] = json!(true)));
    assert!(!bad(|g| g.grant["resume"] = json!(true)));
    assert!(!bad(|g| g.grant["hours"] = json!(336)));
    assert!(!bad(|g| g.grant["grantVersion"] = json!(2)));
    assert!(!bad(|g| g.grant["level"] = json!("root")));
    assert!(!bad(|g| g.grant["members"] = json!(["../x"])));
    assert!(!bad(|g| g.group = "a/b".into()));
    let mut ungrouped = acme(&[S1], "act");
    ungrouped.group = "ungrouped".into();
    assert!(carried(&ungrouped), "Ungrouped's, the main overseer's");
    ungrouped.plan = Some(PLAN.into());
    assert!(!carried(&ungrouped), "never marked as a plan's");
}

const PLAN: &str = "44444444-4444-4444-8444-444444444444";

/// What the hub says the main overseer's plan should have on a machine.
fn planned(members: &[&str], level: &str) -> WantedGrant {
    WantedGrant {
        group: format!("plan-{PLAN}"),
        agent: "desk".into(),
        agent_name: "Desk".into(),
        agent_since: None,
        plan: Some(PLAN.into()),
        grant: json!({
            "grantVersion": 1, "name": "Speed up recall", "boss": "local:desk",
            "level": level, "sees": "everything", "recall": false,
            "folders": [], "repos": [], "members": members,
            "act": {"nudge": true, "parallel": 4},
        }),
    }
}

#[test]
fn a_plans_grant_is_carried_only_marked_as_that_plan_s() {
    assert!(carried(&planned(&[S1], "act")));
    let bad = |f: fn(&mut WantedGrant)| {
        let mut g = planned(&[S1], "act");
        f(&mut g);
        carried(&g)
    };
    assert!(!bad(|g| g.plan = None), "a plan's id unmarked");
    assert!(!bad(|g| g.plan = Some(S1.into())), "another plan's mark");
    assert!(
        !bad(|g| g.group = "acme".into()),
        "a group marked as a plan"
    );
    assert!(!bad(|g| g.grant["folders"] = json!(["/home/dev"])));
    assert!(!bad(|g| g.grant["boss"] = json!("remote:driftwerk/allan")));
    // A group's own grant is carried as before, whatever its id says.
    let mut g = acme(&[S1], "act");
    g.group = "plan-q3".into();
    assert!(carried(&g));
}

/// A plan's grant id is its plan's in the hub's own spelling alone.
#[test]
fn a_plans_grant_id_is_its_plan_s_in_lowercase_alone() {
    let plan = "aaaaaaaa-4444-4444-8444-44444444444b";
    assert_eq!(plan_of(&format!("plan-{plan}")), Some(plan));
    let upper = plan.to_ascii_uppercase();
    assert_eq!(plan_of(&format!("plan-{upper}")), None);
    let mut g = planned(&[S1], "act");
    (g.group, g.plan) = (format!("plan-{upper}"), Some(upper));
    assert!(
        !carried(&g),
        "an upper-case plan id is never a plan's grant"
    );
}

#[tokio::test]
async fn a_plans_grant_is_written_as_the_hub_says_without_asking_and_goes_with_its_sessions() {
    let f = files();
    let devbox = Machine::new("devbox");
    let key = format!("plan-{PLAN}");
    let w = wanted(&[(
        "devbox",
        vec![acme(&[S1], "act"), planned(&[S2], "act")],
        &[S1, S2],
    )]);
    // Before its first ticket starts there: written with no sessions, so
    // that ticket starts in it.
    let ahead = wanted(&[("devbox", vec![planned(&[], "act")], &[])]);
    let s = sync(&f.bosses, &f.kept, &ahead, &on(&[&devbox])).await;
    assert_eq!(s.failed, vec![]);
    assert!(members_of(&devbox.grant(&key).expect("written ahead")).is_empty());
    let s = sync(&f.bosses, &f.kept, &w, &on(&[&devbox])).await;
    assert_eq!(s.failed, vec![]);
    let g = devbox.grant(&key).expect("written with no question");
    assert_eq!(content(&g), content(&planned(&[S2], "act").grant));
    assert!(devbox.grant("acme").is_none(), "Acme's waits for its yes");
    // Only the group's boss is asked about; nothing of the plan is kept.
    let (_, body, _) = say(&f, &w, true).await.expect("asked about Acme");
    assert!(
        body.contains("“Acme”") && !body.contains("recall"),
        "{body}"
    );
    assert!(say(&f, &w, true).await.is_none());
    assert!(!read_kept(&f.kept).groups.contains_key(&key));
    // Capped as any grant: Act fully only with its budget, which the hub
    // counts once across every grant of its boss.
    let full = wanted(&[("devbox", vec![planned(&[S2], "full")], &[S2])]);
    sync(&f.bosses, &f.kept, &full, &on(&[&devbox])).await;
    assert_eq!(devbox.grant(&key).unwrap()["level"], "act");
    let mut budgeted = planned(&[S2], "full");
    budgeted.grant["act"]["budget_usd_per_day"] = json!(40);
    sync(
        &f.bosses,
        &f.kept,
        &wanted(&[("devbox", vec![budgeted], &[S2])]),
        &on(&[&devbox]),
    )
    .await;
    let g = devbox.grant(&key).unwrap();
    assert_eq!(
        (&g["level"], &g["act"]["budget_usd_per_day"]),
        (&json!("full"), &json!(40))
    );
    // A stop Desk made of it is never lifted from here.
    let made = stop("desk", Utc::now());
    devbox.held.lock().unwrap().grants.get_mut(&key).unwrap()["stopped"] = made.clone();
    let more = wanted(&[("devbox", vec![planned(&[S2, S3], "act")], &[S2, S3])]);
    sync(&f.bosses, &f.kept, &more, &on(&[&devbox])).await;
    let g = devbox.grant(&key).unwrap();
    assert_eq!((members_of(&g).len(), &g["stopped"]), (2, &made));
    // A hub that doesn't say its plans' grants yet leaves it as it is,
    // until it is past its time.
    let unknown = Wanted {
        plans_known: false,
        ..wanted(&[("devbox", vec![], &[S2])])
    };
    let s = sync(&f.bosses, &f.kept, &unknown, &on(&[&devbox])).await;
    assert_eq!(s.failed, vec![]);
    assert_eq!(members_of(&devbox.grant(&key).unwrap()).len(), 2);
    let ended = json!(Utc::now() - chrono::Duration::minutes(1));
    devbox.held.lock().unwrap().grants.get_mut(&key).unwrap()["expiresAt"] = ended;
    sync(&f.bosses, &f.kept, &unknown, &on(&[&devbox])).await;
    assert!(devbox.grant(&key).is_none(), "past its time: deleted");
    sync(&f.bosses, &f.kept, &more, &on(&[&devbox])).await;
    assert!(devbox.grant(&key).is_some());
    // The plan has no sessions there any more, or ended: deleted.
    sync(
        &f.bosses,
        &f.kept,
        &wanted(&[("devbox", vec![], &[S2])]),
        &on(&[&devbox]),
    )
    .await;
    assert!(devbox.grant(&key).is_none());
}

#[tokio::test]
async fn a_step_passed_over_while_its_group_is_changed_is_said_to_wait() {
    let f = files();
    let devbox = Machine::new("devbox");
    let w = wanted(&[("devbox", vec![acme(&[S1], "act")], &[S1])]);
    say(&f, &w, true).await;
    sync(&f.bosses, &f.kept, &w, &on(&[&devbox])).await;
    let none = wanted(&[("devbox", vec![], &[S1])]);
    let ops = bosses::ops_of(&f.bosses, "acme");
    let held = ops.lock().await;
    let s = sync(&f.bosses, &f.kept, &none, &on(&[&devbox])).await;
    assert_eq!(s.waiting, BTreeSet::from(["devbox".to_string()]));
    assert!(
        devbox.grant("acme").is_some(),
        "not while the group is changed"
    );
    drop(held);
    let s = sync(&f.bosses, &f.kept, &none, &on(&[&devbox])).await;
    assert!(s.waiting.is_empty());
    assert!(devbox.grant("acme").is_none());
}
