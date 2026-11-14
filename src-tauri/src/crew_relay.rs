//! The relay's courier (remote bosses, RBD): a local boss's calls on its
//! group's sessions on one of the person's machines, carried by Desk's
//! native side, which holds each machine's forward.
//!
//! While Desk is open it long-polls this computer's hub
//! (`GET /api/desk/crew/relay`, the hub's own token) for the calls bosses
//! made. Each names a machine by its id, as the sidebar does
//! (`session:<machine>/<id>`). Each is sent to that machine's hub
//! (`POST /api/desk/crew/served`, through its forward, with its admin
//! token), which decides it under its grant for the group, and the
//! machine's answer is posted back for that call alone
//! (`POST /api/desk/crew/relay/{id}`).
//!
//! - **Nothing is judged here.** Every call goes as the hub queued it,
//!   whatever its tool: the machine decides. Its body is built again from
//!   the call's own fields (all but `machine`), and so is the answer
//!   posted (`status` and `body` alone).
//! - **Refused only when nothing reached the machine:** it isn't one of
//!   Desk's, it can't be reached, it is busy, or the call is too large.
//!   When the machine may have had it but no answer came, nothing is
//!   posted: the hub tells the boss its outcome isn't known yet.
//! - **Sent again with the same id**, never a new one: the machine records
//!   each call by its id and never does one twice.
//! - **Bounded:** at most [`MOST_IN_FLIGHT`] calls at once, and
//!   [`MOST_PER_MACHINE`] to one machine, so a slow one never holds up the
//!   others; each is given up after [`Timing::carry_for`], within the
//!   hub's own wait.
//! - **Capped:** a call or an answer over [`MOST_BODY`] is never carried.
//!
//! These routes are on none of the lists the page's requests are checked
//! against (see [`crate::broker::routes::relay_local`]).

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use desk_core::machine::MachineId;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{Semaphore, watch};

use crate::broker::{Answer, Unanswered};

/// The most calls carried at once.
pub const MOST_IN_FLIGHT: usize = 8;
/// The most calls carried to one machine at once.
pub const MOST_PER_MACHINE: usize = 4;
/// The largest call sent to a machine, and the largest answer read from
/// one or posted back: the hub's own cap on answers.
pub const MOST_BODY: usize = 256 * 1024;
/// The largest poll read: the hub hands out at most 16 calls at a time.
const MOST_POLL: usize = 16 * MOST_BODY + 64 * 1024;

/// The statuses a machine answers with (the hub's `ServedStatus`).
const STATUSES: &[&str] = &["ok", "suggested", "refused"];

/// How long things take.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    /// How long one call is carried, sends again included: less than the
    /// hub waits for its answer (30 s).
    pub carry_for: Duration,
    /// The waits before each send again.
    pub again_after: [Duration; 2],
    /// The first wait after this computer's hub couldn't be polled, and
    /// the longest.
    pub backoff: Duration,
    pub most_backoff: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            carry_for: Duration::from_secs(25),
            again_after: [Duration::from_secs(1), Duration::from_secs(3)],
            backoff: Duration::from_secs(1),
            most_backoff: Duration::from_secs(30),
        }
    }
}

/// The hubs the courier carries between.
pub trait Ends: Send + Sync + 'static {
    /// This computer's hub's queued calls: its long poll.
    fn take(&self) -> impl Future<Output = Result<Answer, Unanswered>> + Send;
    /// Answer `body` posted to this computer's hub for call `id`.
    fn answer(
        &self,
        id: &str,
        body: Vec<u8>,
    ) -> impl Future<Output = Result<Answer, Unanswered>> + Send;
    /// Whether `machine` is one of Desk's.
    fn has(&self, machine: &MachineId) -> bool;
    /// Call `body` sent to `machine`'s hub.
    fn serve(
        &self,
        machine: &MachineId,
        body: Vec<u8>,
    ) -> impl Future<Output = Result<Answer, Unanswered>> + Send;
}

/// One call as this computer's hub queued it. All but `id` and `machine`
/// go to the machine as they came.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Call {
    id: String,
    machine: String,
    group: Value,
    tool: Value,
    #[serde(default)]
    input: Value,
    boss: Value,
    link_id: Value,
    level: Value,
    #[serde(default)]
    act: Value,
}

impl Call {
    /// What the machine's hub takes: exactly its `Relayed`.
    fn served(&self) -> Value {
        json!({
            "group": self.group,
            "tool": self.tool,
            "input": self.input,
            "boss": self.boss,
            "linkId": self.link_id,
            "id": self.id,
            "level": self.level,
            "act": self.act,
        })
    }
}

/// What became of one call.
#[derive(Debug, PartialEq)]
enum Outcome {
    /// Posted back for it: the machine's answer, or why nothing reached it.
    Answer(Value),
    /// The machine may have had it, but no answer came: nothing is posted.
    Unknown(String),
}

fn refused(why: String) -> Outcome {
    Outcome::Answer(json!({"status": "refused", "body": {"error": why}}))
}

fn unreached(machine: &str) -> Outcome {
    refused(format!("{machine} can't be reached"))
}

/// Whether `id` is a call's id as the hub gives them (a UUID).
fn uuid_ok(id: &str) -> bool {
    id.len() == 36
        && id.chars().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

/// The calls in a poll's answer, each with its id: `Err` for one that
/// can't be read (answered refused when its id can be).
fn calls(answer: Answer) -> Result<Vec<Result<Call, String>>, String> {
    if answer.status != 200 {
        return Err(format!("Desk's helper answered {}", answer.status));
    }
    let listed: Vec<Value> = serde_json::from_str(&answer.body)
        .map_err(|_| "Desk's helper's relayed calls couldn't be read".to_string())?;
    Ok(listed
        .into_iter()
        .filter_map(|v| {
            let id = v.get("id").and_then(Value::as_str).map(str::to_string);
            match serde_json::from_value::<Call>(v) {
                Ok(c) if uuid_ok(&c.id) => Some(Ok(c)),
                // No id to answer it by.
                Ok(_) => None,
                Err(_) => id.filter(|i| uuid_ok(i)).map(Err),
            }
        })
        .collect())
}

/// What the machine said, as posted back: its status and body alone; or
/// why it can't be.
fn read_reply(machine: &str, reply: &Answer) -> Result<Value, String> {
    #[derive(Deserialize)]
    struct Reply {
        status: String,
        #[serde(default)]
        body: Value,
    }
    let r: Reply = serde_json::from_str(&reply.body)
        .map_err(|_| format!("{machine}'s answer couldn't be read"))?;
    if !STATUSES.contains(&r.status.as_str()) {
        return Err(format!("{machine}'s answer couldn't be read"));
    }
    // Sent again while the first is still being done there: the machine
    // says it again with nothing of what came of it.
    if r.status == "refused"
        && r.body.get("again") == Some(&Value::Bool(true))
        && r.body.get("said").is_none_or(Value::is_null)
    {
        return Err(format!("{machine} is still doing it"));
    }
    Ok(json!({"status": r.status, "body": r.body}))
}

/// The error a hub's refusal says, briefly.
fn error_of(reply: &Answer) -> Option<String> {
    let v: Value = serde_json::from_str(&reply.body).ok()?;
    let e = v.get("error")?.as_str()?;
    Some(e.chars().take(500).collect())
}

/// Call `call` carried to its machine, sent again (with its own id) when
/// no answer came.
async fn carry<E: Ends>(ends: &E, call: &Call, timing: Timing) -> Outcome {
    let name = call.machine.as_str();
    let Some(machine) = MachineId::new(name).ok().filter(|m| ends.has(m)) else {
        return unreached(name);
    };
    let Ok(body) = serde_json::to_vec(&call.served()) else {
        return unreached(name);
    };
    if body.len() > MOST_BODY {
        return refused(format!("That call is too large to send to {name}."));
    }
    // Whether any send may have reached it: if one did, it may be done.
    let mut maybe: Option<String> = None;
    let mut last = String::new();
    for attempt in 0..=timing.again_after.len() {
        if attempt > 0 {
            tokio::time::sleep(timing.again_after[attempt - 1]).await;
        }
        match ends.serve(&machine, body.clone()).await {
            Ok(r) if r.status == 200 => {
                return match read_reply(name, &r) {
                    Ok(answer) if answer.to_string().len() <= MOST_BODY => Outcome::Answer(answer),
                    Ok(_) => Outcome::Unknown(format!("{name}'s answer is too large")),
                    Err(why) => Outcome::Unknown(why),
                };
            }
            // Refused there before anything was done.
            Ok(r) if (400..500).contains(&r.status) && !matches!(r.status, 408 | 429) => {
                return refused(
                    error_of(&r).unwrap_or_else(|| format!("{name} refused it ({})", r.status)),
                );
            }
            Ok(r) => {
                maybe = Some(format!("{name} answered {}", r.status));
            }
            Err(Unanswered::NotSent(why)) => last = why,
            Err(Unanswered::MaybeSent(why)) => maybe = Some(why),
        }
    }
    match maybe {
        Some(why) => Outcome::Unknown(why),
        None => {
            tracing::debug!(machine = %name, why = %last, "a relayed call reached nothing");
            unreached(name)
        }
    }
}

/// `answer` posted for call `id`: once it is taken, or no one waits for it.
async fn post<E: Ends>(ends: &E, id: &str, answer: &Value, timing: Timing) {
    let body = answer.to_string().into_bytes();
    if body.len() > MOST_BODY {
        tracing::warn!(id, "a relayed answer is too large to post");
        return;
    }
    for attempt in 0..=timing.again_after.len() {
        if attempt > 0 {
            tokio::time::sleep(timing.again_after[attempt - 1]).await;
        }
        match ends.answer(id, body.clone()).await {
            Ok(r) if r.status < 300 => return,
            Ok(r) if r.status == 410 => {
                tracing::info!(id, "a relayed answer came after no one waited for it");
                return;
            }
            Ok(r) if r.status < 500 && r.status != 429 => {
                tracing::warn!(id, status = r.status, "a relayed answer was refused");
                return;
            }
            // Taken once by the hub: sending it again is safe.
            Ok(_) | Err(_) => {}
        }
    }
    tracing::warn!(id, "a relayed answer couldn't be posted");
}

/// The calls being carried to each machine now.
#[derive(Default)]
struct Carrying(Mutex<HashMap<String, usize>>);

/// One of a machine's calls being carried, until dropped.
struct Slot(Arc<Carrying>, String);

impl Carrying {
    fn take(self: &Arc<Self>, machine: &str) -> Option<Slot> {
        let mut m = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let n = m.entry(machine.to_string()).or_default();
        if *n >= MOST_PER_MACHINE {
            return None;
        }
        *n += 1;
        Some(Slot(Arc::clone(self), machine.to_string()))
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut m = (self.0).0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(n) = m.get_mut(&self.1) {
            *n -= 1;
            if *n == 0 {
                m.remove(&self.1);
            }
        }
    }
}

/// Carries calls until `stop` says Desk is quitting.
pub async fn run<E: Ends>(ends: Arc<E>, mut stop: watch::Receiver<bool>, timing: Timing) {
    let in_flight = Arc::new(Semaphore::new(MOST_IN_FLIGHT));
    let carrying = Arc::new(Carrying::default());
    let mut backoff = timing.backoff;
    loop {
        if *stop.borrow() {
            return;
        }
        let taken = tokio::select! {
            _ = stop.changed() => return,
            t = ends.take() => t,
        };
        let listed = match taken.map_err(Unanswered::said).and_then(calls) {
            Ok(l) => {
                backoff = timing.backoff;
                l
            }
            Err(why) => {
                tracing::debug!(why = %why, "relayed calls couldn't be taken");
                tokio::select! {
                    _ = stop.changed() => return,
                    () = tokio::time::sleep(backoff) => {}
                }
                backoff = (backoff * 2).min(timing.most_backoff);
                continue;
            }
        };
        for call in listed {
            let ends = Arc::clone(&ends);
            let call = match call {
                Ok(c) => c,
                Err(id) => {
                    tokio::spawn(async move {
                        let why = "Desk couldn't read that call.".to_string();
                        if let Outcome::Answer(a) = refused(why) {
                            post(&*ends, &id, &a, timing).await;
                        }
                    });
                    continue;
                }
            };
            let slot = carrying.take(&call.machine);
            let permit = slot
                .as_ref()
                .and_then(|_| Arc::clone(&in_flight).try_acquire_owned().ok());
            let (Some(slot), Some(permit)) = (slot, permit) else {
                // Busy: nothing was sent, so it is refused now rather than
                // left to wait.
                tracing::info!(id = %call.id, machine = %call.machine, "a relayed call waited on a busy machine");
                tokio::spawn(async move {
                    let why = format!(
                        "Desk is already sending {} as much as it can. Try again in a moment.",
                        call.machine
                    );
                    if let Outcome::Answer(a) = refused(why) {
                        post(&*ends, &call.id, &a, timing).await;
                    }
                });
                continue;
            };
            tokio::spawn(async move {
                let _held = (slot, permit);
                let outcome = tokio::time::timeout(timing.carry_for, carry(&*ends, &call, timing))
                    .await
                    .unwrap_or_else(|_| Outcome::Unknown("no answer in time".into()));
                match outcome {
                    Outcome::Answer(a) => {
                        tracing::info!(
                            id = %call.id,
                            machine = %call.machine,
                            status = a["status"].as_str().unwrap_or(""),
                            "a relayed call answered"
                        );
                        post(&*ends, &call.id, &a, timing).await;
                    }
                    Outcome::Unknown(why) => tracing::warn!(
                        id = %call.id,
                        machine = %call.machine,
                        why = %why,
                        "a relayed call's outcome isn't known"
                    ),
                }
            });
        }
    }
}

/// Ends the courier when Desk quits.
pub struct Stop(watch::Sender<bool>);

impl Stop {
    pub fn stop(&self) {
        let _ = self.0.send(true);
    }
}

/// Starts the courier for Desk's own hubs: this computer's, and its
/// machines'.
pub fn start(app: tauri::AppHandle) -> Stop {
    let (tx, rx) = watch::channel(false);
    tauri::async_runtime::spawn(run(Arc::new(Desk(app)), rx, Timing::default()));
    Stop(tx)
}

/// This computer's hub through its broker, and each machine's through its
/// own.
struct Desk(tauri::AppHandle);

impl Ends for Desk {
    async fn take(&self) -> Result<Answer, Unanswered> {
        use tauri::Manager;
        let broker = self.0.state::<crate::broker::Broker>();
        broker
            .relay_local("GET", "/api/desk/crew/relay", None, MOST_POLL)
            .await
    }

    fn answer(
        &self,
        id: &str,
        body: Vec<u8>,
    ) -> impl Future<Output = Result<Answer, Unanswered>> + Send {
        let path = format!("/api/desk/crew/relay/{id}");
        async move {
            use tauri::Manager;
            let broker = self.0.state::<crate::broker::Broker>();
            broker
                .relay_local("POST", &path, Some(body), 64 * 1024)
                .await
        }
    }

    fn has(&self, machine: &MachineId) -> bool {
        use tauri::Manager;
        self.0
            .state::<crate::machines::MachineIo>()
            .link(machine.as_str())
            .is_ok()
    }

    fn serve(
        &self,
        machine: &MachineId,
        body: Vec<u8>,
    ) -> impl Future<Output = Result<Answer, Unanswered>> + Send {
        let machine = machine.as_str().to_string();
        async move {
            use tauri::Manager;
            let broker = self
                .0
                .state::<crate::machines::MachineIo>()
                .broker(&machine)
                .map_err(Unanswered::NotSent)?;
            broker
                .relay_machine("POST", "/api/desk/crew/served", body, MOST_BODY)
                .await
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::*;

    const A: &str = "0f0e0d0c-0b0a-4909-8807-0605040302aa";
    const B: &str = "0f0e0d0c-0b0a-4909-8807-0605040302bb";

    fn quick() -> Timing {
        Timing {
            carry_for: Duration::from_secs(5),
            again_after: [Duration::from_millis(10), Duration::from_millis(10)],
            backoff: Duration::from_millis(10),
            most_backoff: Duration::from_millis(40),
        }
    }

    fn ok(status: u16, body: Value) -> Result<Answer, Unanswered> {
        Ok(Answer {
            status,
            content_type: Some("application/json".into()),
            body: body.to_string(),
        })
    }

    /// What a machine does with each call sent to it, in turn; the last
    /// again once the rest are done.
    #[derive(Clone)]
    enum Does {
        Says(u16, Value),
        Fails(Unanswered),
        /// Never answers.
        Hangs,
    }

    #[derive(Default)]
    struct Fake {
        polls: Mutex<VecDeque<Result<Answer, Unanswered>>>,
        took: Mutex<usize>,
        machines: HashMap<String, Mutex<VecDeque<Does>>>,
        sent: Mutex<Vec<(String, Value)>>,
        answered: Mutex<Vec<(String, Value)>>,
        answers: Option<tokio::sync::mpsc::UnboundedSender<(String, Value)>>,
    }

    impl Fake {
        fn with(
            machines: &[(&str, Vec<Does>)],
        ) -> (
            Arc<Self>,
            tokio::sync::mpsc::UnboundedReceiver<(String, Value)>,
        ) {
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
            let fake = Fake {
                machines: machines
                    .iter()
                    .map(|(m, d)| (m.to_string(), Mutex::new(d.iter().cloned().collect())))
                    .collect(),
                answers: Some(tx),
                ..Fake::default()
            };
            (Arc::new(fake), rx)
        }

        fn polled(self: &Arc<Self>, calls: Vec<Value>) -> Arc<Self> {
            self.polls
                .lock()
                .unwrap()
                .push_back(ok(200, Value::Array(calls)));
            Arc::clone(self)
        }

        fn sent(&self) -> Vec<(String, Value)> {
            self.sent.lock().unwrap().clone()
        }
    }

    impl Ends for Fake {
        fn take(&self) -> impl Future<Output = Result<Answer, Unanswered>> + Send {
            *self.took.lock().unwrap() += 1;
            let next = self.polls.lock().unwrap().pop_front();
            async move {
                match next {
                    Some(n) => n,
                    None => std::future::pending().await,
                }
            }
        }

        fn answer(
            &self,
            id: &str,
            body: Vec<u8>,
        ) -> impl Future<Output = Result<Answer, Unanswered>> + Send {
            let v: Value = serde_json::from_slice(&body).unwrap();
            self.answered
                .lock()
                .unwrap()
                .push((id.to_string(), v.clone()));
            if let Some(tx) = &self.answers {
                let _ = tx.send((id.to_string(), v));
            }
            async { ok(204, Value::Null) }
        }

        fn has(&self, machine: &MachineId) -> bool {
            self.machines.contains_key(machine.as_str())
        }

        fn serve(
            &self,
            machine: &MachineId,
            body: Vec<u8>,
        ) -> impl Future<Output = Result<Answer, Unanswered>> + Send {
            let v: Value = serde_json::from_slice(&body).unwrap();
            self.sent
                .lock()
                .unwrap()
                .push((machine.as_str().to_string(), v));
            let does = self.machines.get(machine.as_str()).map(|q| {
                let mut q = q.lock().unwrap();
                if q.len() > 1 {
                    q.pop_front().unwrap()
                } else {
                    q.front().cloned().unwrap()
                }
            });
            async move {
                match does {
                    Some(Does::Says(s, b)) => ok(s, b),
                    Some(Does::Fails(u)) => Err(u),
                    Some(Does::Hangs) => std::future::pending().await,
                    None => Err(Unanswered::NotSent("no such machine".into())),
                }
            }
        }
    }

    fn call(id: &str, machine: &str) -> Value {
        json!({
            "id": id,
            "machine": machine,
            "group": "acme",
            "tool": "crew.interrupt",
            "input": {"session_id": "devbox/9f3c"},
            "boss": "local:sarah",
            "linkId": "home-relay",
            "level": "act",
            "act": {"nudge": true},
        })
    }

    fn says(body: Value) -> Does {
        Does::Says(200, json!({"status": "ok", "body": body}))
    }

    fn start(fake: &Arc<Fake>) -> watch::Sender<bool> {
        let (tx, rx) = watch::channel(false);
        tokio::spawn(run(Arc::clone(fake), rx, quick()));
        tx
    }

    async fn next(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<(String, Value)>,
    ) -> (String, Value) {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("an answer in time")
            .unwrap()
    }

    async fn none_in(rx: &mut tokio::sync::mpsc::UnboundedReceiver<(String, Value)>, ms: u64) {
        assert!(
            tokio::time::timeout(Duration::from_millis(ms), rx.recv())
                .await
                .is_err(),
            "nothing is posted"
        );
    }

    /// Each call goes to the machine it names, as the machine's hub takes
    /// it (exactly its eight fields), and each machine's answer is posted
    /// for its own call alone, built again from its status and body.
    #[tokio::test]
    async fn each_call_goes_to_its_machine_and_its_answer_to_its_call_alone() {
        let (fake, mut rx) = Fake::with(&[
            (
                "devbox",
                vec![Does::Says(
                    200,
                    json!({"status": "ok", "body": {"from": "devbox", "id": B}, "extra": 1}),
                )],
            ),
            (
                "laptop",
                vec![Does::Says(
                    200,
                    json!({"status": "suggested", "body": {"from": "laptop"}}),
                )],
            ),
        ]);
        let stop = start(&fake.polled(vec![call(A, "devbox"), call(B, "laptop")]));
        let mut got = [next(&mut rx).await, next(&mut rx).await];
        got.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            got,
            [
                (
                    A.to_string(),
                    json!({"status": "ok", "body": {"from": "devbox", "id": B}})
                ),
                (
                    B.to_string(),
                    json!({"status": "suggested", "body": {"from": "laptop"}})
                ),
            ]
        );
        let mut sent = fake.sent();
        sent.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0].0, "devbox");
        assert_eq!(
            sent[0].1,
            json!({
                "group": "acme",
                "tool": "crew.interrupt",
                "input": {"session_id": "devbox/9f3c"},
                "boss": "local:sarah",
                "linkId": "home-relay",
                "id": A,
                "level": "act",
                "act": {"nudge": true},
            })
        );
        assert_eq!(sent[1].0, "laptop");
        assert_eq!(sent[1].1["id"], B);
        stop.send(true).unwrap();
    }

    /// No tool is filtered here: one the courier has never heard of goes
    /// through as it came.
    #[tokio::test]
    async fn every_tool_goes_through_unjudged() {
        let (fake, mut rx) = Fake::with(&[("devbox", vec![says(json!({}))])]);
        let mut c = call(A, "devbox");
        c["tool"] = json!("crew.decide_something_new");
        let _stop = start(&fake.polled(vec![c]));
        assert_eq!(next(&mut rx).await.1["status"], "ok");
        assert_eq!(fake.sent()[0].1["tool"], "crew.decide_something_new");
    }

    /// A machine that isn't Desk's, or isn't a machine's id at all, is
    /// refused at once and sent nothing.
    #[tokio::test]
    async fn a_machine_that_isnt_desks_is_refused_and_sent_nothing() {
        let (fake, mut rx) = Fake::with(&[("devbox", vec![says(json!({}))])]);
        let _stop = start(&fake.polled(vec![call(A, "elsewhere"), call(B, "Dev Box")]));
        let mut got = [next(&mut rx).await, next(&mut rx).await];
        got.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            got[0].1,
            json!({"status": "refused", "body": {"error": "elsewhere can't be reached"}})
        );
        assert_eq!(
            got[1].1,
            json!({"status": "refused", "body": {"error": "Dev Box can't be reached"}})
        );
        assert!(fake.sent().is_empty());
    }

    /// A send that got no answer goes again with the same id, never a new
    /// one; the machine's answer to it is posted.
    #[tokio::test]
    async fn a_failed_send_goes_again_with_the_same_id() {
        let (fake, mut rx) = Fake::with(&[(
            "devbox",
            vec![
                Does::Fails(Unanswered::MaybeSent("dropped".into())),
                Does::Fails(Unanswered::NotSent("forward down".into())),
                says(json!({"done": true})),
            ],
        )]);
        let _stop = start(&fake.polled(vec![call(A, "devbox")]));
        assert_eq!(
            next(&mut rx).await,
            (A.into(), json!({"status": "ok", "body": {"done": true}}))
        );
        let sent = fake.sent();
        assert_eq!(sent.len(), 3);
        assert!(
            sent.iter()
                .all(|(m, b)| m == "devbox" && b == &sent[0].1 && b["id"] == A)
        );
    }

    /// Nothing reached the machine however often it was sent: refused, as
    /// it can't be reached.
    #[tokio::test]
    async fn a_machine_never_reached_is_said_so() {
        let (fake, mut rx) = Fake::with(&[(
            "devbox",
            vec![Does::Fails(Unanswered::NotSent("no forward".into()))],
        )]);
        let _stop = start(&fake.polled(vec![call(A, "devbox")]));
        assert_eq!(
            next(&mut rx).await.1,
            json!({"status": "refused", "body": {"error": "devbox can't be reached"}})
        );
        assert_eq!(fake.sent().len(), 3);
    }

    /// The machine may have had it, but no answer came: nothing is posted,
    /// so the hub tells the boss its outcome isn't known yet (never that
    /// it wasn't done).
    #[tokio::test]
    async fn a_call_the_machine_may_have_done_is_never_said_refused() {
        let (fake, mut rx) = Fake::with(&[
            (
                "devbox",
                vec![Does::Fails(Unanswered::MaybeSent("dropped".into()))],
            ),
            ("laptop", vec![Does::Says(502, json!({}))]),
            // Sent again while the first is still being done there.
            (
                "server",
                vec![
                    Does::Fails(Unanswered::MaybeSent("dropped".into())),
                    Does::Says(
                        200,
                        json!({"status": "refused", "body": {"again": true, "said": null}}),
                    ),
                ],
            ),
            (
                "pi",
                vec![Does::Says(200, json!({"status": "maybe", "body": {}}))],
            ),
        ]);
        let _stop = start(&fake.polled(vec![
            call(A, "devbox"),
            call(B, "laptop"),
            call("0f0e0d0c-0b0a-4909-8807-0605040302cc", "server"),
            call("0f0e0d0c-0b0a-4909-8807-0605040302dd", "pi"),
        ]));
        none_in(&mut rx, 300).await;
        assert_eq!(fake.sent().iter().filter(|(m, _)| m == "devbox").count(), 3);
    }

    /// The machine refused it before doing anything (its route's 400 or
    /// 403): refused, in its words.
    #[tokio::test]
    async fn a_machines_refusal_is_said_in_its_words() {
        let (fake, mut rx) = Fake::with(&[(
            "devbox",
            vec![Does::Says(
                400,
                json!({"error": "a relayed call says its boss's level"}),
            )],
        )]);
        let _stop = start(&fake.polled(vec![call(A, "devbox")]));
        assert_eq!(
            next(&mut rx).await.1,
            json!({"status": "refused", "body": {"error": "a relayed call says its boss's level"}})
        );
        assert_eq!(fake.sent().len(), 1);
    }

    /// A call over the cap is never sent; an answer over it is never
    /// posted.
    #[tokio::test]
    async fn nothing_over_the_cap_is_carried_either_way() {
        let big = "x".repeat(MOST_BODY);
        let (fake, mut rx) = Fake::with(&[
            ("devbox", vec![says(json!({}))]),
            ("laptop", vec![says(json!({"text": big}))]),
        ]);
        let mut c = call(A, "devbox");
        c["input"] = json!({"text": big});
        let _stop = start(&fake.polled(vec![c, call(B, "laptop")]));
        let (id, said) = next(&mut rx).await;
        assert_eq!(id, A);
        assert_eq!(said["status"], "refused");
        assert!(
            said["body"]["error"]
                .as_str()
                .unwrap()
                .contains("too large")
        );
        none_in(&mut rx, 200).await;
        assert_eq!(fake.sent().len(), 1, "only laptop's was sent");
        assert_eq!(fake.sent()[0].0, "laptop");
    }

    /// A machine that never answers holds up no other: its calls past its
    /// share are refused as busy, and another machine's are carried.
    #[tokio::test]
    async fn a_slow_machine_never_holds_up_the_others() {
        let (fake, mut rx) =
            Fake::with(&[("slow", vec![Does::Hangs]), ("fast", vec![says(json!({}))])]);
        let ids: Vec<String> = (0..6)
            .map(|i| format!("0f0e0d0c-0b0a-4909-8807-06050403020{i}"))
            .collect();
        let mut calls: Vec<Value> = ids.iter().map(|id| call(id, "slow")).collect();
        calls.push(call(A, "fast"));
        let _stop = start(&fake.polled(calls).polled(vec![call(B, "fast")]));
        let mut got = Vec::new();
        for _ in 0..4 {
            got.push(next(&mut rx).await);
        }
        let busy: Vec<_> = got
            .iter()
            .filter(|(_, a)| a["status"] == "refused")
            .collect();
        assert_eq!(busy.len(), 6 - MOST_PER_MACHINE);
        assert!(busy.iter().all(|(id, a)| {
            ids.contains(id)
                && a["body"]["error"]
                    .as_str()
                    .unwrap()
                    .contains("already sending slow")
        }));
        let fast: Vec<_> = got
            .iter()
            .filter(|(_, a)| a["status"] == "ok")
            .map(|(id, _)| id.as_str())
            .collect();
        assert_eq!(fast.len(), 2);
        assert!(fast.contains(&A) && fast.contains(&B));
        assert_eq!(
            fake.sent().iter().filter(|(m, _)| m == "slow").count(),
            MOST_PER_MACHINE
        );
    }

    /// A call whose fields can't be read is refused by its id; one with no
    /// id it can be answered by is dropped.
    #[tokio::test]
    async fn a_call_that_cant_be_read_is_refused_by_its_id() {
        let (fake, mut rx) = Fake::with(&[("devbox", vec![says(json!({}))])]);
        let _stop = start(&fake.polled(vec![
            json!({"id": A, "machine": "devbox"}),
            json!({"id": "../x", "machine": "devbox"}),
            call("not-a-uuid", "devbox"),
        ]));
        let (id, said) = next(&mut rx).await;
        assert_eq!(id, A);
        assert_eq!(said["status"], "refused");
        none_in(&mut rx, 200).await;
        assert!(fake.sent().is_empty());
    }

    /// While this computer's hub can't be polled the courier waits longer
    /// each time, and it stops when Desk quits.
    #[tokio::test]
    async fn it_backs_off_while_the_hub_is_down_and_stops_with_desk() {
        let (fake, _rx) = Fake::with(&[]);
        for _ in 0..50 {
            fake.polls
                .lock()
                .unwrap()
                .push_back(Err(Unanswered::NotSent("down".into())));
        }
        let (tx, rx) = watch::channel(false);
        let task = tokio::spawn(run(Arc::clone(&fake), rx, quick()));
        tokio::time::sleep(Duration::from_millis(300)).await;
        let took = *fake.took.lock().unwrap();
        // 10, 20, 40, 40, ... ms apart: far fewer than without waiting.
        assert!((3..=15).contains(&took), "{took} polls");
        tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("stops")
            .unwrap();
    }

    /// A poll that hangs (the hub's long poll) still ends when Desk quits.
    #[tokio::test]
    async fn a_waiting_poll_ends_when_desk_quits() {
        let (fake, _rx) = Fake::with(&[]);
        let (tx, rx) = watch::channel(false);
        let task = tokio::spawn(run(Arc::clone(&fake), rx, quick()));
        tokio::time::sleep(Duration::from_millis(20)).await;
        tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("stops")
            .unwrap();
    }
}
