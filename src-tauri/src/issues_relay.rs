//! The machines' sessions' Linear and Jira, carried home: a session on one
//! of the person's machines reaches its issues through the boards linked
//! on this computer, whose hub alone holds the links' keys and tokens. A
//! machine's hub can't reach this computer's, so Desk's native side, which
//! holds each machine's forward, carries its calls.
//!
//! While Desk is open it long-polls each machine it reaches for its
//! sessions' calls (`GET /api/desk/issues/relay` there, with its admin
//! token). Each is handed to this computer's hub (`POST
//! /api/desk/issues/served`, the hub's own token), which checks it again
//! as the session asked it and runs it, and its answer is posted back for
//! that call alone (`POST /api/desk/issues/relay/{id}` on the machine).
//!
//! - **Nothing is judged here**: the call's body is built again from its
//!   own fields and the machine's id as Desk knows it, never as the
//!   machine says it, and the answer posted is `ok` or `error` alone.
//! - **Only a session Desk lists**: the session the call names must be one
//!   the machine lists in Desk now (read again when a call names one not
//!   in what was read a few seconds ago), and it is named as the sidebar
//!   names it: the name the person gave it, which a machine's hub keeps
//!   for Desk, else the machine's own. A made-up id or name never reaches
//!   this computer's hub. A machine is one OS account: the sessions on it,
//!   of whatever group, share what it can do, and this computer's hub
//!   gives them links only while they are one client's.
//! - **Sent once**: a call that may have reached this computer's hub with
//!   no answer back is never sent again; the session is told it may have
//!   gone through.
//! - **Refused when nothing was sent**: a call that can't be read, is too
//!   large, has no time left, or waits too long for its turn is answered
//!   with why, so the session isn't left waiting.
//! - **Bounded** as the crew relay is: [`crate::crew_relay::MOST_IN_FLIGHT`]
//!   at once, [`crate::crew_relay::MOST_PER_MACHINE`] from one machine.
//!
//! These routes are on none of the lists the page's requests are checked
//! against (see [`crate::broker::routes::relay_local`]).

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use desk_core::machine::MachineId;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{Semaphore, watch};
use tokio::time::Instant;

use crate::broker::{Answer, Unanswered};
use crate::crew_relay::{
    Lanes, MOST_BODY, MOST_IN_FLIGHT, MOST_SESSIONS, Timing, carry_time, error_of, post_with,
    uuid_ok,
};

/// A machine's queued calls.
pub const TAKE: &str = "/api/desk/issues/relay";
/// This computer's hub's route that runs one.
pub const SERVED: &str = "/api/desk/issues/served";
/// The largest poll read: a machine hands out at most 8 calls at a time.
const MOST_POLL: usize = 8 * MOST_BODY + 64 * 1024;
/// How often the machines Desk reaches are looked at again.
const LOOK_EVERY: Duration = Duration::from_secs(3);
/// How long a machine whose Desk doesn't carry these calls yet is left
/// before it is asked again; at once when it connects again or its hub's
/// version changes.
const OLDER_AGAIN: Duration = Duration::from_secs(60);
/// A machine's sessions in Desk.
const SESSIONS: &str = "/api/desk/sessions";
/// How long a machine's sessions as read are taken as its sessions now.
const LISTED_FOR: Duration = Duration::from_secs(5);
/// What a session hears when its answer can't be carried.
const TOO_LARGE: &str = "That answer is too large to carry; ask for fewer or one issue.";
/// What a session hears when this computer's hub doesn't run machines'
/// calls yet.
const OLDER_HOME: &str =
    "Desk on the person's Mac needs an update to give machines' sessions Linear and Jira.";

/// The hubs the courier carries between.
pub trait Ends: Send + Sync + 'static {
    /// The machines Desk reaches now, each with what changes when it
    /// connects again or its hub is updated.
    fn machines(&self) -> Vec<(MachineId, String)>;
    /// `machine`'s sessions in Desk.
    fn sessions(
        &self,
        machine: &MachineId,
    ) -> impl Future<Output = Result<Answer, Unanswered>> + Send;
    /// `machine`'s queued calls: its long poll.
    fn take(&self, machine: &MachineId) -> impl Future<Output = Result<Answer, Unanswered>> + Send;
    /// Call `body` handed to this computer's hub.
    fn serve(&self, body: Vec<u8>) -> impl Future<Output = Result<Answer, Unanswered>> + Send;
    /// Answer `body` posted to `machine` for call `id`.
    fn answer(
        &self,
        machine: &MachineId,
        id: &str,
        body: Vec<u8>,
    ) -> impl Future<Output = Result<Answer, Unanswered>> + Send;
}

/// One call as a machine queued it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Call {
    id: String,
    system: Value,
    session_id: String,
    #[serde(default)]
    input: Value,
    #[serde(default)]
    left_ms: Option<Value>,
}

impl Call {
    /// What this computer's hub takes: the call's own fields, the machine
    /// as Desk names it, and its session as Desk lists it, `named`.
    fn served(&self, machine: &MachineId, named: &str) -> Value {
        json!({
            "id": self.id,
            "machine": machine.as_str(),
            "system": self.system,
            "session": named,
            "sessionId": self.session_id,
            "input": self.input,
        })
    }
}

/// The sessions in `listed`, a machine's sessions in Desk, each one's name
/// by its id: the name the person gave it, else the machine's own.
fn names_of(listed: &Answer) -> HashMap<String, String> {
    let sessions: Vec<Value> = serde_json::from_str(&listed.body).unwrap_or_default();
    sessions
        .iter()
        .filter_map(|s| {
            let id = s.get("id").and_then(Value::as_str)?;
            let name = ["displayName", "name"]
                .iter()
                .filter_map(|k| s.get(*k).and_then(Value::as_str))
                .map(str::trim)
                .find(|n| !n.is_empty())
                .unwrap_or("a session");
            Some((id.to_string(), name.to_string()))
        })
        .collect()
}

/// A machine's sessions' names as last read, and when.
#[derive(Default)]
struct Listed(std::sync::Mutex<Option<(Instant, HashMap<String, String>)>>);

impl Listed {
    fn fresh(&self, id: &str) -> Option<String> {
        let kept = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        kept.as_ref()
            .filter(|(at, _)| at.elapsed() < LISTED_FOR)
            .and_then(|(_, names)| names.get(id).cloned())
    }

    fn keep(&self, names: HashMap<String, String>) {
        *self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some((Instant::now(), names));
    }
}

/// What Desk names session `id` on `machine`, read by `until`: from what
/// was read of its sessions in the last few seconds, else read again;
/// `Ok(None)` when Desk doesn't list it there.
async fn name_of<E: Ends>(
    ends: &E,
    machine: &MachineId,
    listed: &Listed,
    id: &str,
    until: Instant,
) -> Result<Option<String>, ()> {
    if let Some(name) = listed.fresh(id) {
        return Ok(Some(name));
    }
    let read = match tokio::time::timeout_at(until, ends.sessions(machine)).await {
        Ok(Ok(a)) if a.status == 200 => a,
        _ => return Err(()),
    };
    let names = names_of(&read);
    let name = names.get(id).cloned();
    listed.keep(names);
    Ok(name)
}

fn error(why: impl Into<String>) -> Option<Value> {
    Some(json!({ "error": why.into() }))
}

/// This computer's hub's answer, as posted back: `ok` or `error` alone;
/// `None` when it may have been done and no answer can be said.
fn reply_of(r: Result<Answer, Unanswered>) -> Option<Value> {
    match r {
        Ok(a) if a.status == 200 => {
            let v: Value = serde_json::from_str(&a.body).ok()?;
            match (v.get("ok"), v.get("error").and_then(Value::as_str)) {
                (Some(ok), _) => Some(json!({ "ok": ok })),
                (None, Some(e)) => error(e),
                _ => None,
            }
        }
        Ok(a) if matches!(a.status, 404 | 405) => error(OLDER_HOME),
        // Turned away before anything ran.
        Ok(a) if a.status == 429 => {
            error(error_of(&a).unwrap_or_else(|| {
                "Desk on the person's Mac is busy; try again in a moment.".into()
            }))
        }
        Ok(a) if (400..500).contains(&a.status) && a.status != 408 => error(
            error_of(&a)
                .unwrap_or_else(|| format!("Desk on the person's Mac refused it ({}).", a.status)),
        ),
        Ok(_) | Err(Unanswered::MaybeSent(_)) => None,
        Err(Unanswered::NotSent(why)) => {
            tracing::debug!(why = %why, "a machine's issue call reached nothing here");
            error("Desk on the person's Mac couldn't take it just now; try again.")
        }
    }
}

/// Call `call` from `machine` carried within its time, in its turn; what
/// to post back, if anything.
async fn carry<E: Ends>(
    ends: &E,
    call: &Call,
    machine: &MachineId,
    timing: Timing,
    lanes: &Lanes,
    in_flight: &Arc<Semaphore>,
    listed: &Listed,
) -> Option<Value> {
    let Some(time) = carry_time(&call.id, call.left_ms.as_ref(), timing.carry_for) else {
        return error("There was no time left to carry it; try again.");
    };
    let until = Instant::now() + time;
    if !uuid_ok(&call.session_id) {
        return error("Desk couldn't read that call.");
    }
    let name = match name_of(ends, machine, listed, &call.session_id, until).await {
        Ok(Some(name)) => name,
        Ok(None) => {
            return error(format!(
                "Desk doesn't list that session on {} now, so it isn't given Linear or Jira.",
                machine.as_str()
            ));
        }
        Err(()) => return error("Desk couldn't read this machine's sessions just now; try again."),
    };
    let Ok(body) = serde_json::to_vec(&call.served(machine, &name)) else {
        return error("Desk couldn't read that call.");
    };
    if body.len() > MOST_BODY {
        return error("That call is too large to carry; send less in it.");
    }
    let busy = || error("Desk is carrying too many calls just now; try again in a moment.");
    let Ok(Ok(_turn)) = tokio::time::timeout_at(until, lanes.of(machine).acquire_owned()).await
    else {
        return busy();
    };
    let Ok(Ok(_carrying)) =
        tokio::time::timeout_at(until, Arc::clone(in_flight).acquire_owned()).await
    else {
        return busy();
    };
    let reply = tokio::time::timeout_at(until, ends.serve(body))
        .await
        .ok()?;
    reply_of(reply).map(|a| match a.to_string().len() <= MOST_BODY {
        true => a,
        false => json!({ "error": TOO_LARGE }),
    })
}

/// The calls in a poll's answer: each readable one, and the ids of those
/// that can't be read.
fn calls(answer: &Answer) -> Result<Vec<Result<Call, String>>, u16> {
    if answer.status != 200 {
        return Err(answer.status);
    }
    let listed: Vec<Value> = serde_json::from_str(&answer.body).map_err(|_| answer.status)?;
    Ok(listed
        .into_iter()
        .filter_map(|v| {
            let id = v.get("id").and_then(Value::as_str).map(str::to_string);
            match serde_json::from_value::<Call>(v) {
                Ok(c) if uuid_ok(&c.id) => Some(Ok(c)),
                Ok(_) => None,
                Err(_) => id.filter(|i| uuid_ok(i)).map(Err),
            }
        })
        .collect())
}

/// `machine`'s calls carried until it goes or Desk quits.
async fn poll<E: Ends>(
    ends: Arc<E>,
    machine: MachineId,
    mut stop: watch::Receiver<bool>,
    timing: Timing,
    lanes: Arc<Lanes>,
    in_flight: Arc<Semaphore>,
) {
    let mut backoff = timing.backoff;
    let listed = Arc::new(Listed::default());
    loop {
        let polled = Instant::now();
        let taken = tokio::select! {
            _ = stop.changed() => return,
            t = ends.take(&machine) => t,
        };
        let pause = match taken.as_ref().map_err(|_| 0).and_then(calls) {
            Ok(listed) => {
                backoff = timing.backoff;
                for call in listed {
                    let (ends, machine) = (Arc::clone(&ends), machine.clone());
                    let (lanes, in_flight) = (Arc::clone(&lanes), Arc::clone(&in_flight));
                    let listed = Arc::clone(&listed);
                    tokio::spawn(async move {
                        let (id, answer) = match call {
                            Ok(c) => {
                                let a =
                                    carry(&*ends, &c, &machine, timing, &lanes, &in_flight, &listed)
                                        .await;
                                (c.id, a)
                            }
                            Err(id) => (id, error("Desk couldn't read that call.")),
                        };
                        match answer {
                            Some(a) => {
                                post_with(|b| ends.answer(&machine, &id, b), &id, &a, timing).await
                            }
                            None => tracing::warn!(id = %id, machine = %machine.as_str(),
                                "a machine's issue call's outcome isn't known"),
                        }
                    });
                }
                (polled.elapsed() < timing.quick_poll).then_some(timing.quick_gap)
            }
            // A machine whose Desk doesn't carry these yet.
            Err(404 | 405) => Some(OLDER_AGAIN),
            Err(_) => {
                let wait = backoff;
                backoff = (backoff * 2).min(timing.most_backoff);
                Some(wait)
            }
        };
        if let Some(pause) = pause {
            tokio::select! {
                _ = stop.changed() => return,
                () = tokio::time::sleep(pause) => {}
            }
        }
    }
}

/// Carries the machines' calls until `stop` says Desk is quitting: a poll
/// for each machine Desk reaches, ended once it doesn't.
pub async fn run<E: Ends>(ends: Arc<E>, mut stop: watch::Receiver<bool>, timing: Timing) {
    let in_flight = Arc::new(Semaphore::new(MOST_IN_FLIGHT));
    let lanes = Arc::new(Lanes::default());
    type Polling = (String, watch::Sender<bool>, tokio::task::JoinHandle<()>);
    let mut polls: HashMap<MachineId, Polling> = HashMap::new();
    loop {
        if *stop.borrow() {
            break;
        }
        let reached: HashMap<MachineId, String> = ends.machines().into_iter().collect();
        polls.retain(|m, (now, _, task)| reached.get(m) == Some(now) && !task.is_finished());
        for (machine, now) in reached {
            polls.entry(machine.clone()).or_insert_with(|| {
                let (tx, rx) = watch::channel(false);
                let task = tokio::spawn(poll(
                    Arc::clone(&ends),
                    machine,
                    rx,
                    timing,
                    Arc::clone(&lanes),
                    Arc::clone(&in_flight),
                ));
                (now, tx, task)
            });
        }
        tokio::select! {
            _ = stop.changed() => break,
            () = tokio::time::sleep(LOOK_EVERY) => {}
        }
    }
    for (_, tx, _) in polls.values() {
        let _ = tx.send(true);
    }
}

/// Ends the courier when Desk quits.
pub struct Stop(watch::Sender<bool>);

impl Stop {
    pub fn stop(&self) {
        let _ = self.0.send(true);
    }
}

/// Starts the courier for Desk's own hubs: its machines', and this
/// computer's.
pub fn start(app: tauri::AppHandle) -> Stop {
    let (tx, rx) = watch::channel(false);
    tauri::async_runtime::spawn(run(Arc::new(Desk(app)), rx, Timing::default()));
    Stop(tx)
}

struct Desk(tauri::AppHandle);

impl Desk {
    fn machine_broker(
        &self,
        machine: &MachineId,
    ) -> Result<Arc<crate::broker::Broker>, Unanswered> {
        use tauri::Manager;
        self.0
            .state::<crate::machines::MachineIo>()
            .broker(machine.as_str())
            .map_err(Unanswered::NotSent)
    }
}

impl Ends for Desk {
    fn machines(&self) -> Vec<(MachineId, String)> {
        use tauri::Manager;
        let io = self.0.state::<crate::machines::MachineIo>();
        io.ids()
            .into_iter()
            .filter_map(|id| {
                let ready = io.link(&id).ok()?.ready()?;
                let now = format!("{} {:?}", ready.gateway_url, ready.version);
                Some((MachineId::new(&id).ok()?, now))
            })
            .collect()
    }

    fn sessions(
        &self,
        machine: &MachineId,
    ) -> impl Future<Output = Result<Answer, Unanswered>> + Send {
        let broker = self.machine_broker(machine);
        async move {
            broker?
                .relay_machine("GET", SESSIONS, None, MOST_SESSIONS)
                .await
        }
    }

    fn take(&self, machine: &MachineId) -> impl Future<Output = Result<Answer, Unanswered>> + Send {
        let broker = self.machine_broker(machine);
        async move { broker?.relay_machine("GET", TAKE, None, MOST_POLL).await }
    }

    async fn serve(&self, body: Vec<u8>) -> Result<Answer, Unanswered> {
        use tauri::Manager;
        let broker = self.0.state::<crate::broker::Broker>();
        broker
            .relay_local("POST", SERVED, Some(body), MOST_BODY)
            .await
    }

    fn answer(
        &self,
        machine: &MachineId,
        id: &str,
        body: Vec<u8>,
    ) -> impl Future<Output = Result<Answer, Unanswered>> + Send {
        let broker = self.machine_broker(machine);
        let path = format!("{TAKE}/{id}");
        async move {
            broker?
                .relay_machine("POST", &path, Some(body), 64 * 1024)
                .await
        }
    }
}

#[cfg(test)]
#[path = "issues_relay_tests.rs"]
mod tests;
