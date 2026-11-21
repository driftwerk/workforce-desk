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
use std::time::{Duration, SystemTime};

use desk_core::machine::MachineId;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{Semaphore, watch};
use tokio::time::Instant;

use crate::broker::{Answer, Unanswered};
use crate::crew_relay::{
    Lanes, MOST_BODY, MOST_IN_FLIGHT, Timing, carry_time, error_of, post_with, uuid_ok,
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
/// before it is asked again.
const OLDER_AGAIN: Duration = Duration::from_secs(10 * 60);
/// What a session hears when this computer's hub doesn't run machines'
/// calls yet.
const OLDER_HOME: &str =
    "Desk on the person's Mac needs an update to give machines' sessions Linear and Jira.";

/// The hubs the courier carries between.
pub trait Ends: Send + Sync + 'static {
    /// The machines Desk reaches now.
    fn machines(&self) -> Vec<MachineId>;
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
    session: Value,
    #[serde(default)]
    input: Value,
    #[serde(default)]
    deadline: Option<Value>,
}

impl Call {
    /// What this computer's hub takes: the call's own fields, and the
    /// machine as Desk names it.
    fn served(&self, machine: &MachineId) -> Value {
        json!({
            "id": self.id,
            "machine": machine.as_str(),
            "system": self.system,
            "session": self.session,
            "input": self.input,
        })
    }
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
        Ok(a) if (400..500).contains(&a.status) && !matches!(a.status, 408 | 429) => error(
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
) -> Option<Value> {
    let Some(time) = carry_time(
        &call.id,
        call.deadline.as_ref(),
        timing.carry_for,
        SystemTime::now(),
    ) else {
        return error("There was no time left to carry it; try again.");
    };
    let Ok(body) = serde_json::to_vec(&call.served(machine)) else {
        return error("Desk couldn't read that call.");
    };
    if body.len() > MOST_BODY {
        return error("That call is too large to carry; send less in it.");
    }
    let until = Instant::now() + time;
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
    reply_of(reply).filter(|a| a.to_string().len() <= MOST_BODY)
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
                    tokio::spawn(async move {
                        let (id, answer) = match call {
                            Ok(c) => {
                                let a =
                                    carry(&*ends, &c, &machine, timing, &lanes, &in_flight).await;
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
    let mut polls: HashMap<MachineId, (watch::Sender<bool>, tokio::task::JoinHandle<()>)> =
        HashMap::new();
    loop {
        if *stop.borrow() {
            break;
        }
        let reached = ends.machines();
        polls.retain(|m, (_, task)| reached.contains(m) && !task.is_finished());
        for machine in reached {
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
                (tx, task)
            });
        }
        tokio::select! {
            _ = stop.changed() => break,
            () = tokio::time::sleep(LOOK_EVERY) => {}
        }
    }
    for (tx, _) in polls.values() {
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
    fn machines(&self) -> Vec<MachineId> {
        use tauri::Manager;
        let io = self.0.state::<crate::machines::MachineIo>();
        io.ids()
            .into_iter()
            .filter(|id| io.link(id).is_ok_and(|l| l.ready().is_some()))
            .filter_map(|id| MachineId::new(&id).ok())
            .collect()
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
