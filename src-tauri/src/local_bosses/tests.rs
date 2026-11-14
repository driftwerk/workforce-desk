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
    left: BTreeMap<String, (i64, bool)>,
    asked: Vec<(String, String, Option<Value>)>,
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
    fn hold(&self, group: &str, body: Value, stopped: bool) {
        let mut v = body;
        v["group"] = json!(group);
        v["stopped"] = json!(stopped);
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
                assert!(b.get("resume").is_none(), "never a resume: {b}");
                assert!(b.get("hours").is_none(), "{b}");
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
                if rev < have || taken || (rev == have && !same) || (old.is_none() && rev <= have) {
                    answer(409, json!({"error": "no"}))
                } else {
                    let stopped = old
                        .as_ref()
                        .map(|o| o["stopped"] == true)
                        .or(h.left.get(*g).map(|(_, s)| *s))
                        .unwrap_or(false);
                    let mut v = b.clone();
                    v.as_object_mut().unwrap().remove("leaving");
                    v["group"] = json!(g);
                    v["stopped"] = json!(stopped);
                    v["born"] = json!([]);
                    v["issuedAt"] = json!(Utc::now());
                    v["expiresAt"] = json!(Utc::now() + chrono::Duration::hours(72));
                    h.grants.insert((*g).to_string(), v.clone());
                    answer(200, json!({"grant": v}))
                }
            }
            ("DELETE", ["api", "desk", "grants", g]) => match h.grants.remove(*g) {
                Some(o) => {
                    let stopped = o["stopped"] == true;
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
        machines: machines
            .iter()
            .map(|(m, g, listed)| {
                (
                    m.to_string(),
                    MachineWanted {
                        grants: g.clone(),
                        listed: listed.iter().map(|s| s.to_string()).collect(),
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
async fn nothing_is_written_until_the_person_says_yes_and_then_exactly_what_the_hub_says() {
    let f = files();
    let devbox = Machine::new("devbox");
    let w = wanted(&[("devbox", vec![acme(&[S1, S2], "act")], &[S1, S2])]);
    sync(&f.bosses, &f.kept, &w, &on(&[&devbox])).await;
    assert!(devbox.writes().is_empty(), "not asked yet");

    let (title, body, yes) = say(&f, &w, true).await.expect("asked");
    assert!(title.contains("Sarah"), "{title}");
    assert!(
        body.contains("2 sessions") && body.contains("“devbox”") && body.contains("“Acme”"),
        "{body}"
    );
    assert!(body.contains("acting within Desk"), "{body}");
    assert!(yes.contains("Sarah"));
    // Asked once: a yes holds.
    assert!(say(&f, &w, true).await.is_none());

    let s = sync(&f.bosses, &f.kept, &w, &on(&[&devbox])).await;
    assert_eq!(s.failed, vec![]);
    let g = devbox.grant("acme").unwrap();
    assert_eq!(content(&g), content(&acme(&[S1, S2], "act").grant));
    assert_eq!(g["revision"], 1);
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
    devbox.hold("acme", allan.clone(), false);
    sync(&f.bosses, &f.kept, &w, &on(&[&devbox])).await;
    assert!(devbox.writes().is_empty(), "{:?}", devbox.writes());
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

#[tokio::test]
async fn a_boss_taken_off_has_its_grant_deleted_and_a_stop_is_never_resumed() {
    let f = files();
    let devbox = Machine::new("devbox");
    let w = wanted(&[("devbox", vec![acme(&[S1], "act")], &[S1])]);
    say(&f, &w, true).await;
    sync(&f.bosses, &f.kept, &w, &on(&[&devbox])).await;
    // The machine stopped it: it stays stopped through what is written.
    devbox.held.lock().unwrap().grants.get_mut("acme").unwrap()["stopped"] = json!(true);
    let lower = wanted(&[("devbox", vec![acme(&[S1], "watch")], &[S1])]);
    sync(&f.bosses, &f.kept, &lower, &on(&[&devbox])).await;
    let g = devbox.grant("acme").unwrap();
    assert_eq!(
        (&g["level"], &g["stopped"]),
        (&json!("watch"), &json!(true))
    );

    // The hub wants nothing for it any more (the boss taken off, the group
    // deleted, its sessions moved out): deleted.
    let none = wanted(&[("devbox", vec![], &[S1])]);
    let s = sync(&f.bosses, &f.kept, &none, &on(&[&devbox])).await;
    assert!(devbox.grant("acme").is_none());
    assert!(s.narrowed);
    // A machine the hub doesn't name at all is cleared too.
    sync(&f.bosses, &f.kept, &w, &on(&[&devbox])).await;
    assert!(devbox.grant("acme").is_some(), "written past its floor");
    assert_eq!(
        devbox.grant("acme").unwrap()["stopped"],
        true,
        "its stop kept"
    );
    sync(&f.bosses, &f.kept, &wanted(&[]), &on(&[&devbox])).await;
    assert!(devbox.grant("acme").is_none());
}

#[tokio::test]
async fn narrowing_reaches_every_machine_before_anything_widens() {
    let f = files();
    let (devbox, atlas) = (Machine::new("devbox"), Machine::new("atlas"));
    let globex = |members: &[&str]| WantedGrant {
        group: "globex".into(),
        agent: "tom".into(),
        agent_name: "Tom".into(),
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
        "act": {"nudge": true, "interrupt": false, "parallel": 6, "budget_usd_per_day": 25.0}});
    let wanted = json!({"grantVersion": 1, "name": "Acme", "boss": "local:sarah", "level": "act",
        "sees": "everything", "recall": false, "folders": [], "repos": [], "members": [S2, S3],
        "act": {"nudge": true, "interrupt": true, "parallel": 4}});
    let m = meet(&held, &wanted);
    assert_eq!(m["level"], "act");
    assert_eq!(m["sees"], "replies");
    assert_eq!(m["members"], json!([S2]));
    assert_eq!(
        m["act"],
        json!({"nudge": true, "interrupt": false, "parallel": 4})
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
    assert!(!bad(|g| g.group = "ungrouped".into()));
    assert!(!bad(|g| g.group = "a/b".into()));
}
