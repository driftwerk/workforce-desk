use std::collections::VecDeque;
use std::sync::Mutex;

use super::*;

const A: &str = "0f0e0d0c-0b0a-4909-8807-0605040302aa";
const B: &str = "0f0e0d0c-0b0a-4909-8807-0605040302bb";

fn quick() -> Timing {
    Timing {
        carry_for: Duration::from_secs(1),
        again_after: [Duration::from_millis(10), Duration::from_millis(10)],
        backoff: Duration::from_millis(10),
        most_backoff: Duration::from_millis(40),
        post_try: Duration::from_millis(100),
        post_for: Duration::from_millis(300),
        quick_poll: Duration::from_millis(1),
        quick_gap: Duration::from_millis(10),
    }
}

fn says(status: u16, body: Value) -> Result<Answer, Unanswered> {
    Ok(Answer {
        status,
        content_type: Some("application/json".into()),
        body: body.to_string(),
    })
}

const SESSION: &str = "5b0c4c8e-0000-4000-8000-000000000015";

fn devbox() -> MachineId {
    MachineId::new("devbox").unwrap()
}

/// A call as a machine queues it, with `secs` left for it.
fn queued(id: &str, secs: u64) -> Value {
    json!({
        "id": id, "system": "linear", "session": "a name it chose", "sessionId": SESSION,
        "input": { "action": "get", "key": "VEL-15" },
        "machine": "somewhere-else",
        "leftMs": secs * 1000,
    })
}

/// The machine's sessions as Desk lists them.
fn listed() -> Value {
    json!([
        { "id": "5b0c4c8e-0000-4000-8000-000000000001", "name": "other" },
        { "id": SESSION, "name": "vel-15", "displayName": "VEL-15 fix" },
    ])
}

/// Desk's ends: machines that answer their polls in turn (then nothing for
/// a long while), and a home that answers its calls in turn (then `ok`).
#[derive(Default)]
struct Fake {
    reached: Mutex<Vec<(MachineId, String)>>,
    sessions: Mutex<Value>,
    polls: Mutex<VecDeque<Result<Answer, Unanswered>>>,
    takes: Mutex<usize>,
    home: Mutex<VecDeque<Result<Answer, Unanswered>>>,
    served: Mutex<Vec<Value>>,
    answered: Option<tokio::sync::mpsc::UnboundedSender<(String, String, Value)>>,
}

impl Fake {
    fn with(
        polls: Vec<Result<Answer, Unanswered>>,
        home: Vec<Result<Answer, Unanswered>>,
    ) -> (
        Arc<Self>,
        tokio::sync::mpsc::UnboundedReceiver<(String, String, Value)>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = Fake {
            reached: Mutex::new(vec![(devbox(), "1.0".into())]),
            sessions: Mutex::new(listed()),
            polls: Mutex::new(polls.into()),
            home: Mutex::new(home.into()),
            answered: Some(tx),
            ..Fake::default()
        };
        (Arc::new(fake), rx)
    }

    fn served(&self) -> Vec<Value> {
        self.served.lock().unwrap().clone()
    }
}

impl Ends for Fake {
    fn machines(&self) -> Vec<(MachineId, String)> {
        self.reached.lock().unwrap().clone()
    }

    async fn sessions(&self, _: &MachineId) -> Result<Answer, Unanswered> {
        let listed = self.sessions.lock().unwrap().clone();
        says(200, listed)
    }

    async fn take(&self, _: &MachineId) -> Result<Answer, Unanswered> {
        *self.takes.lock().unwrap() += 1;
        let next = self.polls.lock().unwrap().pop_front();
        match next {
            Some(r) => r,
            None => {
                tokio::time::sleep(Duration::from_secs(30)).await;
                says(200, json!([]))
            }
        }
    }

    async fn serve(&self, body: Vec<u8>) -> Result<Answer, Unanswered> {
        self.served
            .lock()
            .unwrap()
            .push(serde_json::from_slice(&body).unwrap());
        let next = self.home.lock().unwrap().pop_front();
        next.unwrap_or_else(|| says(200, json!({ "ok": { "issue": "VEL-15" }, "extra": 1 })))
    }

    async fn answer(
        &self,
        machine: &MachineId,
        id: &str,
        body: Vec<u8>,
    ) -> Result<Answer, Unanswered> {
        if let Some(tx) = &self.answered {
            let _ = tx.send((
                machine.as_str().to_string(),
                id.to_string(),
                serde_json::from_slice(&body).unwrap(),
            ));
        }
        says(204, Value::Null)
    }
}

fn running(fake: &Arc<Fake>) -> watch::Sender<bool> {
    let (tx, rx) = watch::channel(false);
    tokio::spawn(run(Arc::clone(fake), rx, quick()));
    tx
}

async fn next(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<(String, String, Value)>,
) -> (String, String, Value) {
    tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("an answer in time")
        .expect("an answer")
}

/// A machine's call goes home as that machine's and its session's, as Desk
/// names them, with its own fields alone; home's answer goes back to it,
/// `ok` alone, once.
#[tokio::test]
async fn a_call_is_carried_home_as_its_machines_and_answered_once() {
    let (fake, mut rx) = Fake::with(vec![says(200, json!([queued(A, 30)]))], vec![]);
    let stop = running(&fake);
    let (machine, id, body) = next(&mut rx).await;
    assert_eq!((machine.as_str(), id.as_str()), ("devbox", A));
    assert_eq!(body, json!({ "ok": { "issue": "VEL-15" } }));
    assert_eq!(
        fake.served(),
        vec![json!({
            "id": A, "machine": "devbox", "system": "linear", "session": "VEL-15 fix",
            "sessionId": SESSION, "input": { "action": "get", "key": "VEL-15" },
        })]
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(rx.try_recv().is_err());
    assert_eq!(fake.served().len(), 1);
    stop.send(true).unwrap();
}

/// What can't be carried is answered with why, and nothing goes home: an
/// unreadable call, one with no time left, and one from a session Desk
/// doesn't list there.
#[tokio::test]
async fn what_cant_be_carried_is_answered_and_never_sent() {
    const C: &str = "0f0e0d0c-0b0a-4909-8807-0605040302cc";
    let unreadable = json!({ "id": B, "session": "vel-15" });
    let mut made_up = queued(C, 30);
    made_up["sessionId"] = json!("5b0c4c8e-0000-4000-8000-0000000000ff");
    let (fake, mut rx) = Fake::with(
        vec![says(200, json!([unreadable, queued(A, 1), made_up]))],
        vec![],
    );
    let stop = running(&fake);
    let mut said = [
        next(&mut rx).await,
        next(&mut rx).await,
        next(&mut rx).await,
    ];
    said.sort_by(|a, b| a.1.cmp(&b.1));
    assert_eq!(said[0].1, A);
    assert!(
        said[0].2["error"]
            .as_str()
            .unwrap()
            .contains("no time left")
    );
    assert_eq!(said[1].1, B);
    assert!(
        said[1].2["error"]
            .as_str()
            .unwrap()
            .contains("couldn't read")
    );
    assert_eq!(said[2].1, C);
    assert!(
        said[2].2["error"]
            .as_str()
            .unwrap()
            .contains("Desk doesn't list that session on devbox")
    );
    assert!(fake.served().is_empty());
    stop.send(true).unwrap();
}

/// Home's refusals are said; an older home says it needs an update; home
/// that may have had the call and said nothing is never asked again, and
/// nothing is posted for it.
#[tokio::test]
async fn home_s_refusals_are_said_and_an_unknown_outcome_isnt() {
    let calls = json!([queued(A, 30)]);
    for (home, said) in [
        (says(404, json!({})), Some(OLDER_HOME.to_string())),
        (
            says(409, json!({ "error": "that call was served already" })),
            Some("that call was served already".to_string()),
        ),
        (
            says(200, json!({ "ok": "x".repeat(MOST_BODY) })),
            Some(TOO_LARGE.to_string()),
        ),
        (Err(Unanswered::MaybeSent("cut off".into())), None),
        (says(200, json!({ "neither": true })), None),
    ] {
        let (fake, mut rx) = Fake::with(vec![says(200, calls.clone())], vec![home]);
        let stop = running(&fake);
        match said {
            Some(words) => assert_eq!(next(&mut rx).await.2, json!({ "error": words })),
            None => {
                tokio::time::sleep(Duration::from_millis(300)).await;
                assert!(rx.try_recv().is_err());
            }
        }
        assert_eq!(fake.served().len(), 1);
        stop.send(true).unwrap();
    }
}

/// A machine whose Desk doesn't carry these calls yet is left alone for a
/// while, and asked again at once when its hub is updated; one that fails
/// is asked again, backing off.
#[tokio::test]
async fn an_older_machine_is_left_alone_until_updated_and_a_failing_one_asked_again() {
    let (older, _rx) = Fake::with(vec![says(404, json!({})), says(404, json!({}))], vec![]);
    let stop = running(&older);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(*older.takes.lock().unwrap(), 1);
    older.reached.lock().unwrap()[0].1 = "1.1".into();
    tokio::time::sleep(LOOK_EVERY + Duration::from_millis(500)).await;
    assert_eq!(*older.takes.lock().unwrap(), 2);
    stop.send(true).unwrap();

    let failing = vec![
        Err(Unanswered::NotSent("down".into())),
        says(500, json!({})),
        says(200, json!([queued(A, 30)])),
    ];
    let (fake, mut rx) = Fake::with(failing, vec![]);
    let stop = running(&fake);
    assert_eq!(next(&mut rx).await.1, A);
    assert!(*fake.takes.lock().unwrap() >= 3);
    stop.send(true).unwrap();
}

/// A machine Desk no longer reaches is polled no more.
#[tokio::test]
async fn a_machine_desk_no_longer_reaches_isnt_polled() {
    let (fake, _rx) = Fake::with(vec![], vec![]);
    fake.reached.lock().unwrap().clear();
    let stop = running(&fake);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(*fake.takes.lock().unwrap(), 0);
    stop.send(true).unwrap();
}
