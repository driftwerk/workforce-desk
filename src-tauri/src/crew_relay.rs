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
//!   the call's own fields (all but `machine` and `deadline`), and so is
//!   the answer posted (`status` and `body` alone).
//! - **Refused only when nothing reached the machine:** it isn't one of
//!   Desk's, it can't be reached, Desk was too busy to send it in time, it
//!   is too late to, or the call is too large. When the machine may have
//!   had it but no answer came, nothing is posted: the hub tells the boss
//!   its outcome isn't known yet.
//! - **Sent again with the same id**, never a new one: the machine records
//!   each call by its id and never does one twice.
//! - **Bounded:** at most [`MOST_IN_FLIGHT`] calls at once, and
//!   [`MOST_PER_MACHINE`] to one machine, so a slow one never holds up the
//!   others. A call waits for its turn within its time: until the hub's
//!   `deadline` for it, less a margin, or [`Timing::carry_for`].
//! - **Capped:** a call or an answer over [`MOST_BODY`] is never carried.
//!
//! - **A plan's sessions on a machine** (`desk.sessions`,
//!   `desk.session_start`, queued by the hub's own plan runner for a plan
//!   the person approved, never by a boss's tool) go as New session's own
//!   requests: `GET` and `POST /api/desk/sessions` on that machine, with
//!   Desk's plugin folder there in the start's environment. A start is sent
//!   once: when it may have reached the machine but no answer came, its
//!   outcome isn't known, and the hub finds the session there by its name.
//!
//! These routes are on none of the lists the page's requests are checked
//! against (see [`crate::broker::routes::relay_local`]).

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use desk_core::machine::MachineId;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{Semaphore, watch};
use tokio::time::Instant;

use crate::broker::{Answer, Unanswered};

/// The most calls carried at once.
pub const MOST_IN_FLIGHT: usize = 8;
/// The most calls carried to one machine at once.
pub const MOST_PER_MACHINE: usize = 3;
/// The largest call sent to a machine, and the largest answer read from
/// one or posted back: the hub's own cap on answers.
pub const MOST_BODY: usize = 256 * 1024;
/// The largest poll read: the hub hands out at most 16 calls at a time.
const MOST_POLL: usize = 16 * MOST_BODY + 64 * 1024;
/// With less than this left before the hub's deadline, a call isn't sent.
const LEAST_LEFT: Duration = Duration::from_secs(3);
/// What is kept back of the time left, to post the answer in.
const MARGIN: Duration = Duration::from_secs(2);

/// The statuses a machine answers with (the hub's `ServedStatus`).
const STATUSES: &[&str] = &["ok", "suggested", "refused"];

/// A plan's sessions on a machine, as the hub's plan runner asks for them.
const SESSIONS: &str = "desk.sessions";
/// A plan's ticket's session started on a machine.
const SESSION_START: &str = "desk.session_start";
/// What a plan's start may say, as New session says it: nothing else goes.
const START_FIELDS: &[&str] = &[
    "engine", "name", "cwd", "goal", "prompt", "view", "worktree", "model",
];
/// The most of a session's last reply read back.
const MOST_REPLY: usize = 2000;
/// The largest list of a machine's sessions read.
const MOST_SESSIONS: usize = 8 * 1024 * 1024;

/// How long things take.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    /// How long one call is carried, its wait for its turn and sends again
    /// included, when the hub gives no deadline: less than the hub waits
    /// for its answer (30 s).
    pub carry_for: Duration,
    /// The waits before each send again.
    pub again_after: [Duration; 2],
    /// The first wait after this computer's hub couldn't be polled, and
    /// the longest.
    pub backoff: Duration,
    pub most_backoff: Duration,
    /// How long each post of an answer waits, and all of them together.
    pub post_try: Duration,
    pub post_for: Duration,
    /// An empty poll back sooner than `quick_poll` is followed by a pause
    /// of `quick_gap`.
    pub quick_poll: Duration,
    pub quick_gap: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            carry_for: Duration::from_secs(25),
            again_after: [Duration::from_secs(1), Duration::from_secs(3)],
            backoff: Duration::from_secs(1),
            most_backoff: Duration::from_secs(30),
            post_try: Duration::from_secs(10),
            post_for: Duration::from_secs(20),
            quick_poll: Duration::from_secs(1),
            quick_gap: Duration::from_millis(200),
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
    /// `machine`'s sessions in Desk (`GET /api/desk/sessions` there), or
    /// with `start`, that session started (`POST`), as New session does.
    fn sessions(
        &self,
        machine: &MachineId,
        start: Option<Vec<u8>>,
    ) -> impl Future<Output = Result<Answer, Unanswered>> + Send;
    /// Desk's Claude Code plugin folder on `machine`, when it can say.
    fn plugin_dir(&self, machine: &MachineId) -> impl Future<Output = Option<String>> + Send;
}

/// One call as this computer's hub queued it. All but `id`, `machine` and
/// `deadline` go to the machine as they came.
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
    /// When the hub stops waiting for its answer (RFC 3339), when it says;
    /// kept as it came, so one that isn't a time is said, not a call that
    /// can't be read.
    #[serde(default)]
    deadline: Option<Value>,
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

    /// How long it may be carried from `now`: until the hub's deadline less
    /// [`MARGIN`], at most `carry_for`; `None` when too little is left to
    /// send it at all.
    fn time(&self, carry_for: Duration, now: SystemTime) -> Option<Duration> {
        let deadline = match &self.deadline {
            None | Some(Value::Null) => return Some(carry_for),
            Some(d) => d.as_str(),
        };
        let Some(at) = deadline.and_then(|d| chrono::DateTime::parse_from_rfc3339(d).ok()) else {
            tracing::warn!(id = %self.id, "a relayed call's deadline couldn't be read");
            return Some(carry_for);
        };
        // In chrono's own terms, which hold any date (`SystemTime` may not
        // on every platform).
        let left = at
            .with_timezone(&chrono::Utc)
            .signed_duration_since(chrono::DateTime::<chrono::Utc>::from(now))
            .to_std()
            .unwrap_or_default();
        // Never past `carry_for`, whatever this computer's clock does.
        (left >= LEAST_LEFT).then(|| (left - MARGIN).min(carry_for))
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

/// Call `call` carried to `machine`, sent again (with its own id) when no
/// answer came.
async fn carry<E: Ends>(ends: &E, call: &Call, machine: &MachineId, timing: Timing) -> Outcome {
    let name = call.machine.as_str();
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
        match ends.serve(machine, body.clone()).await {
            Ok(r) if r.status == 200 => {
                return match read_reply(name, &r) {
                    Ok(answer) if answer.to_string().len() <= MOST_BODY => Outcome::Answer(answer),
                    Ok(_) => Outcome::Unknown(format!("{name}'s answer is too large")),
                    Err(why) => Outcome::Unknown(why),
                };
            }
            // Refused there before anything was done: unless an earlier
            // send may have done it.
            Ok(r) if (400..500).contains(&r.status) && !matches!(r.status, 408 | 429) => {
                if let Some(why) = maybe {
                    return Outcome::Unknown(format!("{why}; then {name} answered {}", r.status));
                }
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

/// A session as a machine lists it, as much as a plan reads: its id,
/// names, folder, state and last reply (capped); none without an id.
fn session_of(v: &Value) -> Option<Value> {
    let id = v.get("id")?.as_str()?;
    let text = |k: &str| {
        v.get(k)
            .filter(|x| x.is_string())
            .cloned()
            .unwrap_or(Value::Null)
    };
    let reply = v
        .get("lastReply")
        .and_then(Value::as_str)
        .map(|r| r.chars().take(MOST_REPLY).collect::<String>());
    Some(json!({
        "id": id,
        "name": text("name"),
        "displayName": text("displayName"),
        "cwd": text("cwd"),
        "state": text("state"),
        "lastReply": reply,
    }))
}

/// Why a machine refused one of Desk's own requests, briefly.
fn refusal(name: &str, r: &Answer) -> Outcome {
    refused(error_of(r).unwrap_or_else(|| format!("{name} refused it ({})", r.status)))
}

/// A plan's call on `machine`'s sessions (`tool`, one of [`SESSIONS`] and
/// [`SESSION_START`]) made there as New session makes it. A start is sent
/// once.
async fn carry_desk<E: Ends>(ends: &E, call: &Call, machine: &MachineId, tool: &str) -> Outcome {
    let name = call.machine.as_str();
    if tool == SESSIONS {
        let r = match ends.sessions(machine, None).await {
            Ok(r) => r,
            Err(_) => return unreached(name),
        };
        if r.status != 200 {
            return refusal(name, &r);
        }
        let Some(listed) = serde_json::from_str::<Value>(&r.body).ok().and_then(|v| {
            v.as_array()
                .map(|l| l.iter().filter_map(session_of).collect::<Vec<_>>())
        }) else {
            return refused(format!("{name}'s sessions couldn't be read"));
        };
        let answer = json!({"status": "ok", "body": listed});
        if answer.to_string().len() > MOST_BODY {
            return refused(format!("{name} has too many sessions to read at once"));
        }
        return Outcome::Answer(answer);
    }
    let Some(given) = call.input.as_object() else {
        return refused("That start couldn't be read.".to_string());
    };
    let mut start: serde_json::Map<String, Value> = START_FIELDS
        .iter()
        .filter_map(|k| given.get(*k).map(|v| ((*k).to_string(), v.clone())))
        .collect();
    if let Some(dir) = ends.plugin_dir(machine).await {
        start.insert("env".into(), json!({"CLAUDE_CODE_PLUGIN_DIRS": dir}));
    }
    let Ok(body) = serde_json::to_vec(&start) else {
        return unreached(name);
    };
    if body.len() > MOST_BODY {
        return refused(format!("That start is too large to send to {name}."));
    }
    match ends.sessions(machine, Some(body)).await {
        Ok(r) if (200..300).contains(&r.status) => {
            match serde_json::from_str::<Value>(&r.body)
                .ok()
                .as_ref()
                .and_then(session_of)
            {
                Some(s) => Outcome::Answer(json!({"status": "ok", "body": s})),
                None => Outcome::Unknown(format!("{name}'s answer to a start couldn't be read")),
            }
        }
        // Refused there: nothing was started.
        Ok(r) if (400..500).contains(&r.status) && r.status != 408 => refusal(name, &r),
        Ok(r) => Outcome::Unknown(format!("{name} answered {}", r.status)),
        Err(Unanswered::NotSent(_)) => unreached(name),
        Err(Unanswered::MaybeSent(why)) => Outcome::Unknown(why),
    }
}

/// `answer` posted for call `id`: until it is taken, or no one waits for
/// it, each post within `post_try` and all within `post_for`.
async fn post<E: Ends>(ends: &E, id: &str, answer: &Value, timing: Timing) {
    let body = answer.to_string().into_bytes();
    if body.len() > MOST_BODY {
        tracing::warn!(id, "a relayed answer is too large to post");
        return;
    }
    let posting = async {
        for attempt in 0..=timing.again_after.len() {
            if attempt > 0 {
                tokio::time::sleep(timing.again_after[attempt - 1]).await;
            }
            match tokio::time::timeout(timing.post_try, ends.answer(id, body.clone())).await {
                Ok(Ok(r)) if r.status < 300 => return true,
                Ok(Ok(r)) if r.status == 410 => {
                    tracing::info!(id, "a relayed answer came after no one waited for it");
                    return true;
                }
                Ok(Ok(r)) if r.status < 500 && !matches!(r.status, 408 | 429) => {
                    tracing::warn!(id, status = r.status, "a relayed answer was refused");
                    return true;
                }
                // Taken once by the hub: sending it again is safe.
                _ => {}
            }
        }
        false
    };
    if !tokio::time::timeout(timing.post_for, posting)
        .await
        .unwrap_or(false)
    {
        tracing::warn!(id, "a relayed answer couldn't be posted");
    }
}

/// Each of Desk's machines' turns: [`MOST_PER_MACHINE`] calls at once.
#[derive(Default)]
struct Lanes(Mutex<HashMap<MachineId, Arc<Semaphore>>>);

impl Lanes {
    fn of(&self, machine: &MachineId) -> Arc<Semaphore> {
        let mut m = self.0.lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(
            m.entry(machine.clone())
                .or_insert_with(|| Arc::new(Semaphore::new(MOST_PER_MACHINE))),
        )
    }
}

/// Call `call` carried within `time`: its turn on its machine and among
/// all calls waited for, then sent. Its turns are given back as it ends,
/// before its answer is posted.
async fn carry_in_turn<E: Ends>(
    ends: &E,
    call: &Call,
    time: Duration,
    lanes: &Lanes,
    in_flight: &Arc<Semaphore>,
    timing: Timing,
) -> Outcome {
    let until = Instant::now() + time;
    let name = call.machine.as_str();
    // Only Desk's own machines have a lane.
    let Some(machine) = MachineId::new(name).ok().filter(|m| ends.has(m)) else {
        return unreached(name);
    };
    let lane = lanes.of(&machine);
    let Ok(Ok(_turn)) = tokio::time::timeout_at(until, lane.acquire_owned()).await else {
        return refused(format!(
            "Desk is already sending {name} as much as it can. Try again in a moment."
        ));
    };
    let Ok(Ok(_carrying)) =
        tokio::time::timeout_at(until, Arc::clone(in_flight).acquire_owned()).await
    else {
        return refused(
            "Desk is carrying too many calls just now. Try again in a moment.".to_string(),
        );
    };
    let carried = async {
        match call.tool.as_str() {
            Some(t @ (SESSIONS | SESSION_START)) => carry_desk(ends, call, &machine, t).await,
            _ => carry(ends, call, &machine, timing).await,
        }
    };
    tokio::time::timeout_at(until, carried)
        .await
        .unwrap_or_else(|_| Outcome::Unknown("no answer in time".into()))
}

/// Carries calls until `stop` says Desk is quitting.
pub async fn run<E: Ends>(ends: Arc<E>, mut stop: watch::Receiver<bool>, timing: Timing) {
    let in_flight = Arc::new(Semaphore::new(MOST_IN_FLIGHT));
    let lanes = Arc::new(Lanes::default());
    let mut backoff = timing.backoff;
    loop {
        if *stop.borrow() {
            return;
        }
        let polled = Instant::now();
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
        // Back at once with nothing: not asked again at once.
        if listed.is_empty() && polled.elapsed() < timing.quick_poll {
            tokio::select! {
                _ = stop.changed() => return,
                () = tokio::time::sleep(timing.quick_gap) => {}
            }
            continue;
        }
        for call in listed {
            let ends = Arc::clone(&ends);
            let (lanes, in_flight) = (Arc::clone(&lanes), Arc::clone(&in_flight));
            tokio::spawn(async move {
                let call = match call {
                    Ok(c) => c,
                    Err(id) => {
                        let why = "Desk couldn't read that call.".to_string();
                        if let Outcome::Answer(a) = refused(why) {
                            post(&*ends, &id, &a, timing).await;
                        }
                        return;
                    }
                };
                let outcome = match call.time(timing.carry_for, SystemTime::now()) {
                    None => refused(format!(
                        "There's no time left to send it to {}.",
                        call.machine
                    )),
                    Some(time) => {
                        carry_in_turn(&*ends, &call, time, &lanes, &in_flight, timing).await
                    }
                };
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
                .relay_machine("POST", "/api/desk/crew/served", Some(body), MOST_BODY)
                .await
        }
    }

    fn sessions(
        &self,
        machine: &MachineId,
        start: Option<Vec<u8>>,
    ) -> impl Future<Output = Result<Answer, Unanswered>> + Send {
        let machine = machine.as_str().to_string();
        async move {
            use tauri::Manager;
            let broker = self
                .0
                .state::<crate::machines::MachineIo>()
                .broker(&machine)
                .map_err(Unanswered::NotSent)?;
            let method = if start.is_some() { "POST" } else { "GET" };
            broker
                .relay_machine(method, "/api/desk/sessions", start, MOST_SESSIONS)
                .await
        }
    }

    fn plugin_dir(&self, machine: &MachineId) -> impl Future<Output = Option<String>> + Send {
        use tauri::Manager;
        let link = self
            .0
            .state::<crate::machines::MachineIo>()
            .link(machine.as_str())
            .ok();
        async move {
            let link = link?;
            tauri::async_runtime::spawn_blocking(move || link.plugin_dir().ok())
                .await
                .ok()
                .flatten()
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
            carry_for: Duration::from_secs(1),
            again_after: [Duration::from_millis(10), Duration::from_millis(10)],
            backoff: Duration::from_millis(10),
            most_backoff: Duration::from_millis(40),
            post_try: Duration::from_millis(100),
            post_for: Duration::from_millis(300),
            quick_poll: Duration::from_secs(1),
            quick_gap: Duration::from_millis(50),
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
        /// What this computer's hub answers each post, in turn; 204 after.
        posts: Mutex<VecDeque<Does>>,
        answers: Option<tokio::sync::mpsc::UnboundedSender<(String, Value)>>,
        /// What each machine's sessions route does, in turn, and what it
        /// was sent (`None` for a listing).
        desk: Mutex<VecDeque<Does>>,
        desk_sent: Mutex<Vec<(String, Option<Value>)>>,
        plugin: Option<String>,
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
            let does = self.posts.lock().unwrap().pop_front();
            async move {
                match does {
                    Some(Does::Says(s, b)) => ok(s, b),
                    Some(Does::Fails(u)) => Err(u),
                    Some(Does::Hangs) => std::future::pending().await,
                    None => ok(204, Value::Null),
                }
            }
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

        fn sessions(
            &self,
            machine: &MachineId,
            start: Option<Vec<u8>>,
        ) -> impl Future<Output = Result<Answer, Unanswered>> + Send {
            let start = start.map(|b| serde_json::from_slice::<Value>(&b).unwrap());
            self.desk_sent
                .lock()
                .unwrap()
                .push((machine.as_str().to_string(), start));
            let does = self.desk.lock().unwrap().pop_front();
            async move {
                match does {
                    Some(Does::Says(s, b)) => ok(s, b),
                    Some(Does::Fails(u)) => Err(u),
                    Some(Does::Hangs) => std::future::pending().await,
                    None => Err(Unanswered::NotSent("nothing there".into())),
                }
            }
        }

        fn plugin_dir(&self, _: &MachineId) -> impl Future<Output = Option<String>> + Send {
            std::future::ready(self.plugin.clone())
        }
    }

    fn desk_call(id: &str, tool: &str, input: Value) -> Value {
        json!({
            "id": id,
            "machine": "devbox",
            "group": "acme",
            "tool": tool,
            "input": input,
            "boss": "local:sarah",
            "linkId": Value::Null,
            "level": "act",
        })
    }

    fn with_desk(
        does: Vec<Does>,
        plugin: Option<&str>,
    ) -> (
        Arc<Fake>,
        tokio::sync::mpsc::UnboundedReceiver<(String, Value)>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let fake = Fake {
            machines: [("devbox".to_string(), Mutex::new(VecDeque::new()))].into(),
            answers: Some(tx),
            desk: Mutex::new(does.into()),
            plugin: plugin.map(str::to_string),
            ..Fake::default()
        };
        (Arc::new(fake), rx)
    }

    const SESSION: &str = "1a2b3c4d-0b0a-4909-8807-0605040302cc";

    /// A plan's start goes to the machine's own sessions route, as New
    /// session sends it: its own fields alone, with Desk's plugin folder
    /// there; the session it made is posted back, as much as a plan reads.
    #[tokio::test]
    async fn a_plans_start_goes_to_the_machines_sessions_with_its_plugin_folder() {
        let made = json!({
            "id": SESSION, "name": "VEL-3", "displayName": null, "cwd": "/home/dev/vellev",
            "state": "starting", "lastReply": null, "engine": "claude", "pending": {"x": 1},
        });
        let (fake, mut rx) = with_desk(
            vec![Does::Says(200, made)],
            Some("/home/dev/.local/share/Desk/bin/current/claude-plugin"),
        );
        let input = json!({
            "engine": "claude", "name": "VEL-3", "cwd": "/home/dev/vellev", "goal": "g",
            "prompt": "p", "model": "opus", "worktree": "vel-3",
            "env": {"EVIL": "1"}, "account": null, "group": "g1",
        });
        let stop = start(&fake.polled(vec![desk_call(A, "desk.session_start", input)]));
        let (id, answer) = next(&mut rx).await;
        assert_eq!(id, A);
        assert_eq!(
            answer,
            json!({"status": "ok", "body": {
                "id": SESSION, "name": "VEL-3", "displayName": null,
                "cwd": "/home/dev/vellev", "state": "starting", "lastReply": null,
            }})
        );
        let sent = fake.desk_sent.lock().unwrap().clone();
        assert_eq!(
            sent,
            vec![(
                "devbox".to_string(),
                Some(json!({
                    "engine": "claude", "name": "VEL-3", "cwd": "/home/dev/vellev", "goal": "g",
                    "prompt": "p", "model": "opus", "worktree": "vel-3",
                    "env": {"CLAUDE_CODE_PLUGIN_DIRS": "/home/dev/.local/share/Desk/bin/current/claude-plugin"},
                }))
            )]
        );
        // Never through the crew's own route.
        assert!(fake.sent().is_empty());
        let _ = stop.send(true);
    }

    /// A start is sent once: refused there, it is said; maybe there but
    /// unanswered, nothing is posted and it isn't sent again.
    #[tokio::test]
    async fn a_plans_start_is_sent_once() {
        let (fake, mut rx) = with_desk(
            vec![
                Does::Says(400, json!({"error": "There's no folder /home/dev/nope."})),
                Does::Fails(Unanswered::MaybeSent("cut off".into())),
                Does::Says(502, json!({})),
            ],
            None,
        );
        let input = json!({"engine": "codex", "name": "VEL-1", "cwd": "/home/dev/nope"});
        let stop = start(&fake.polled(vec![desk_call(A, "desk.session_start", input.clone())]));
        assert_eq!(
            next(&mut rx).await,
            (
                A.to_string(),
                json!({"status": "refused", "body": {"error": "There's no folder /home/dev/nope."}})
            )
        );
        let _ = stop.send(true);
        // Cut off, or a gateway's error: maybe started, so not sent again.
        for _ in 0..2 {
            let stop = start(&fake.polled(vec![desk_call(B, "desk.session_start", input.clone())]));
            none_in(&mut rx, 300).await;
            let _ = stop.send(true);
        }
        // Each start went once, with no plugin folder to give.
        let sent = fake.desk_sent.lock().unwrap().clone();
        assert_eq!(sent.len(), 3);
        assert!(
            sent.iter()
                .all(|(_, b)| b.as_ref().is_some_and(|b| b.get("env").is_none()))
        );
    }

    /// A plan's listing reads the machine's sessions, each as much as a
    /// plan reads, its last reply capped; a machine that can't be reached
    /// is said.
    #[tokio::test]
    async fn a_plans_listing_reads_the_machines_sessions_briefly() {
        let long = "x".repeat(MOST_REPLY + 50);
        let (fake, mut rx) = with_desk(
            vec![
                Does::Says(
                    200,
                    json!([
                        {"id": SESSION, "name": "VEL-3", "cwd": "/home/dev/vellev", "state": "idle",
                         "lastReply": long, "goal": "secret-ish", "pending": null},
                        {"name": "no id"},
                    ]),
                ),
                Does::Fails(Unanswered::NotSent("down".into())),
            ],
            None,
        );
        let stop = start(&fake.polled(vec![desk_call(A, "desk.sessions", json!({}))]));
        let (id, answer) = next(&mut rx).await;
        assert_eq!(id, A);
        assert_eq!(answer["status"], "ok");
        let listed = answer["body"].as_array().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["state"], "idle");
        assert_eq!(listed[0]["lastReply"].as_str().unwrap().len(), MOST_REPLY);
        assert!(listed[0].get("goal").is_none());
        assert_eq!(
            fake.desk_sent.lock().unwrap()[0],
            ("devbox".to_string(), None)
        );
        let _ = stop.send(true);
        let stop = start(&fake.polled(vec![desk_call(B, "desk.sessions", json!({}))]));
        assert_eq!(
            next(&mut rx).await,
            (
                B.to_string(),
                json!({"status": "refused", "body": {"error": "devbox can't be reached"}})
            )
        );
        let _ = stop.send(true);
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

    /// RFC 3339, `secs` from now.
    fn in_secs(secs: u64) -> String {
        chrono::DateTime::<chrono::Utc>::from(SystemTime::now() + Duration::from_secs(secs))
            .to_rfc3339()
    }

    fn says(body: Value) -> Does {
        Does::Says(200, json!({"status": "ok", "body": body}))
    }

    fn start(fake: &Arc<Fake>) -> watch::Sender<bool> {
        start_with(fake, quick())
    }

    fn start_with(fake: &Arc<Fake>, timing: Timing) -> watch::Sender<bool> {
        let (tx, rx) = watch::channel(false);
        tokio::spawn(run(Arc::clone(fake), rx, timing));
        tx
    }

    /// Calls carried for 4 s, and the time of one with [`waits`]' deadline
    /// (2.2 s): one waiting runs out well before those it waits on.
    fn longer() -> Timing {
        Timing {
            carry_for: Duration::from_secs(4),
            ..quick()
        }
    }

    fn waits() -> String {
        chrono::DateTime::<chrono::Utc>::from(SystemTime::now() + Duration::from_millis(4200))
            .to_rfc3339()
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
        let mut a = call(A, "devbox");
        a["deadline"] = json!(in_secs(20));
        let stop = start(&fake.polled(vec![a, call(B, "laptop")]));
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
        // Those after the first it takes run out of time first.
        let mut calls: Vec<Value> = ids
            .iter()
            .enumerate()
            .map(|(i, id)| {
                let mut c = call(id, "slow");
                if i >= MOST_PER_MACHINE {
                    c["deadline"] = json!(waits());
                }
                c
            })
            .collect();
        calls.push(call(A, "fast"));
        let _stop = start_with(&fake.polled(calls).polled(vec![call(B, "fast")]), longer());
        // The fast machine's come first, while the slow one's wait.
        let mut fast = [next(&mut rx).await, next(&mut rx).await];
        fast.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(fast[0].0, A);
        assert_eq!(fast[1].0, B);
        assert!(fast.iter().all(|(_, a)| a["status"] == "ok"));
        // Past its share, the slow one's waited their turn, and when their
        // time ran out were refused as never sent; those it took post
        // nothing.
        let mut busy = Vec::new();
        for _ in 0..(6 - MOST_PER_MACHINE) {
            busy.push(next(&mut rx).await);
        }
        assert!(busy.iter().all(|(id, a)| {
            ids.contains(id)
                && a["status"] == "refused"
                && a["body"]["error"]
                    .as_str()
                    .unwrap()
                    .contains("already sending slow")
        }));
        none_in(&mut rx, 300).await;
        assert_eq!(
            fake.sent().iter().filter(|(m, _)| m == "slow").count(),
            MOST_PER_MACHINE
        );
    }

    /// Past all the calls Desk carries at once, one waits its turn and,
    /// when its time runs out, is refused as Desk being busy (not its
    /// machine).
    #[tokio::test]
    async fn past_the_most_in_flight_a_call_waits_then_is_refused_as_desk_busy() {
        let (fake, mut rx) = Fake::with(&[
            ("m1", vec![Does::Hangs]),
            ("m2", vec![Does::Hangs]),
            ("m3", vec![Does::Hangs]),
        ]);
        let calls: Vec<Value> = (0..9)
            .map(|i| {
                let id = format!("0f0e0d0c-0b0a-4909-8807-06050403020{i}");
                let mut c = call(&id, &format!("m{}", i % 3 + 1));
                // The last runs out of time before those it waits on.
                if i >= MOST_IN_FLIGHT {
                    c["deadline"] = json!(waits());
                }
                c
            })
            .collect();
        let _stop = start_with(&fake.polled(calls), longer());
        let (_, a) = next(&mut rx).await;
        assert_eq!(a["status"], "refused");
        assert!(
            a["body"]["error"]
                .as_str()
                .unwrap()
                .contains("carrying too many calls"),
            "{a}"
        );
        none_in(&mut rx, 300).await;
        assert_eq!(fake.sent().len(), MOST_IN_FLIGHT);
    }

    /// A call's turns are given back when it ends: many more calls than
    /// fit at once to one machine are each carried in turn.
    #[tokio::test]
    async fn turns_are_given_back_as_calls_end() {
        let (fake, mut rx) = Fake::with(&[("devbox", vec![says(json!({}))])]);
        let mut polls = Arc::clone(&fake);
        for p in 0..4 {
            let calls = (0..5)
                .map(|i| {
                    call(
                        &format!("0f0e0d0c-0b0a-4909-8807-0605040302{p}{i}"),
                        "devbox",
                    )
                })
                .collect();
            polls = polls.polled(calls);
        }
        let _stop = start(&polls);
        for _ in 0..20 {
            assert_eq!(next(&mut rx).await.1["status"], "ok");
        }
        assert_eq!(fake.sent().len(), 20);
    }

    /// A call's turns are given back before its answer is posted: while
    /// posts hang, more calls than its machine's share are all sent at
    /// once.
    #[tokio::test]
    async fn turns_are_given_back_before_the_answer_is_posted() {
        let (fake, _rx) = Fake::with(&[("devbox", vec![says(json!({}))])]);
        *fake.posts.lock().unwrap() = vec![Does::Hangs; 64].into();
        let calls = (0..7)
            .map(|i| call(&format!("0f0e0d0c-0b0a-4909-8807-06050403020{i}"), "devbox"))
            .collect();
        let slow_posts = Timing {
            post_try: Duration::from_secs(5),
            post_for: Duration::from_secs(5),
            ..quick()
        };
        let _stop = start_with(&fake.polled(calls), slow_posts);
        tokio::time::sleep(Duration::from_millis(1000)).await;
        assert_eq!(fake.sent().len(), 7);
    }

    /// A machine that never answers is given up on when the call's time
    /// runs out, and nothing is posted (it may have done it).
    #[tokio::test]
    async fn a_call_out_of_time_posts_nothing() {
        let (fake, mut rx) = Fake::with(&[("devbox", vec![Does::Hangs])]);
        let _stop = start(&fake.polled(vec![call(A, "devbox")]));
        none_in(&mut rx, 1500).await;
        assert_eq!(fake.sent().len(), 1);
    }

    /// `deadline`, when the hub gives one, bounds a call: too little left
    /// and it isn't sent; else it is given up on before the hub stops
    /// waiting, posting nothing.
    #[tokio::test]
    async fn the_hubs_deadline_bounds_a_call() {
        let (fake, mut rx) = Fake::with(&[("devbox", vec![Does::Hangs])]);
        let mut late = call(A, "devbox");
        late["deadline"] = json!(in_secs(1));
        let mut soon = call(B, "devbox");
        soon["deadline"] = json!(in_secs(6));
        let _stop = start(&fake.polled(vec![late, soon]));
        let (id, a) = next(&mut rx).await;
        assert_eq!(id, A);
        assert_eq!(a["status"], "refused");
        assert!(
            a["body"]["error"]
                .as_str()
                .unwrap()
                .contains("no time left")
        );
        // B's time is its deadline less the margin (about 4 s), held to
        // `carry_for` (1 s).
        tokio::time::sleep(Duration::from_millis(1300)).await;
        assert_eq!(fake.sent().len(), 1, "only B was sent");
        assert_eq!(fake.sent()[0].1["id"], B);
        assert!(fake.sent()[0].1.get("deadline").is_none());
        none_in(&mut rx, 1500).await;
    }

    #[test]
    fn a_calls_time_is_the_hubs_deadline_less_the_margin_or_carry_for() {
        let now = SystemTime::now();
        let with = |d: Option<&str>| Call {
            deadline: d.map(|d| json!(d)),
            ..serde_json::from_value::<Call>(call(A, "devbox")).unwrap()
        };
        let carry_for = Duration::from_secs(25);
        assert_eq!(with(None).time(carry_for, now), Some(carry_for));
        assert_eq!(
            with(Some("not a time")).time(carry_for, now),
            Some(carry_for)
        );
        let in10 =
            chrono::DateTime::<chrono::Utc>::from(now + Duration::from_secs(10)).to_rfc3339();
        assert_eq!(
            with(Some(&in10)).time(carry_for, now),
            Some(Duration::from_secs(8))
        );
        // Far off, or this computer's clock stepped back: held to
        // `carry_for`.
        let far =
            chrono::DateTime::<chrono::Utc>::from(now + Duration::from_secs(3600)).to_rfc3339();
        assert_eq!(with(Some(&far)).time(carry_for, now), Some(carry_for));
        let in2 = chrono::DateTime::<chrono::Utc>::from(now + Duration::from_secs(2)).to_rfc3339();
        assert_eq!(with(Some(&in2)).time(carry_for, now), None);
        let past = chrono::DateTime::<chrono::Utc>::from(now - Duration::from_secs(5)).to_rfc3339();
        assert_eq!(with(Some(&past)).time(carry_for, now), None);
        // Any date at all, however far back.
        assert_eq!(
            with(Some("0001-01-01T00:00:00Z")).time(carry_for, now),
            None
        );
        assert_eq!(
            with(Some("9999-12-31T23:59:59Z")).time(carry_for, now),
            Some(carry_for)
        );
        // A deadline that isn't a time, or isn't a string, is said and
        // `carry_for` used; the call is still read.
        let mut odd = call(A, "devbox");
        odd["deadline"] = json!(5);
        let odd: Call = serde_json::from_value(odd).unwrap();
        assert_eq!(odd.time(carry_for, now), Some(carry_for));
        let mut null = call(A, "devbox");
        null["deadline"] = Value::Null;
        let null: Call = serde_json::from_value(null).unwrap();
        assert_eq!(null.time(carry_for, now), Some(carry_for));
    }

    /// A refusal after a send that may have reached the machine isn't
    /// said as refused: the first may have been done.
    #[tokio::test]
    async fn a_refusal_after_a_maybe_posts_nothing() {
        let (fake, mut rx) = Fake::with(&[(
            "devbox",
            vec![
                Does::Fails(Unanswered::MaybeSent("dropped".into())),
                Does::Says(403, json!({"error": "not yours"})),
            ],
        )]);
        let _stop = start(&fake.polled(vec![call(A, "devbox")]));
        none_in(&mut rx, 300).await;
        assert_eq!(fake.sent().len(), 2);
    }

    /// A machine's 408 or 429 may have come after it had the call: sent
    /// again, and nothing posted if that's all it says.
    #[tokio::test]
    async fn a_machines_408_or_429_is_maybe_sent() {
        let (fake, mut rx) = Fake::with(&[
            ("devbox", vec![Does::Says(408, json!({}))]),
            (
                "laptop",
                vec![Does::Says(429, json!({})), says(json!({"done": true}))],
            ),
        ]);
        let _stop = start(&fake.polled(vec![call(A, "devbox"), call(B, "laptop")]));
        assert_eq!(
            next(&mut rx).await,
            (B.into(), json!({"status": "ok", "body": {"done": true}}))
        );
        none_in(&mut rx, 300).await;
        assert_eq!(fake.sent().iter().filter(|(m, _)| m == "devbox").count(), 3);
    }

    /// A machine's replay of a call it already did is posted as it says,
    /// with what it said; suggested goes through.
    #[test]
    fn replays_and_suggestions_are_posted_as_said() {
        let reply = |v: Value| Answer {
            status: 200,
            content_type: None,
            body: v.to_string(),
        };
        for (status, body) in [
            ("ok", json!({"again": true, "said": "Interrupted."})),
            ("refused", json!({"again": true, "said": "Not yours."})),
            ("suggested", json!({"suggestion": "s1"})),
        ] {
            assert_eq!(
                read_reply("devbox", &reply(json!({"status": status, "body": body}))),
                Ok(json!({"status": status, "body": body}))
            );
        }
        assert!(
            read_reply(
                "devbox",
                &reply(json!({"status": "refused", "body": {"again": true, "said": null}}))
            )
            .is_err()
        );
    }

    /// Posting an answer: sent again after a 5xx or no answer; done at a
    /// 2xx, a 410 (no one waits) or another 4xx (dropped).
    #[tokio::test]
    async fn an_answer_is_posted_until_taken_or_turned_away() {
        let answer = json!({"status": "ok", "body": {}});
        for (posts, tries) in [
            (
                vec![Does::Says(503, json!({})), Does::Says(204, json!({}))],
                2,
            ),
            (
                vec![
                    Does::Fails(Unanswered::MaybeSent("dropped".into())),
                    Does::Says(204, json!({})),
                ],
                2,
            ),
            (vec![Does::Says(410, json!({}))], 1),
            (vec![Does::Says(400, json!({}))], 1),
            (vec![Does::Hangs, Does::Says(204, json!({}))], 2),
            (vec![Does::Says(502, json!({})); 3], 3),
        ] {
            let (fake, _rx) = Fake::with(&[]);
            *fake.posts.lock().unwrap() = posts.into();
            post(&*fake, A, &answer, quick()).await;
            assert_eq!(fake.answered.lock().unwrap().len(), tries);
        }
        // All posts together are bounded too.
        let (fake, _rx) = Fake::with(&[]);
        *fake.posts.lock().unwrap() = vec![Does::Hangs; 3].into();
        let t = Instant::now();
        post(&*fake, A, &answer, quick()).await;
        assert!(t.elapsed() < Duration::from_millis(600));
    }

    /// An empty poll back at once isn't followed by another at once.
    #[tokio::test]
    async fn an_empty_poll_back_at_once_waits_a_moment() {
        let (fake, _rx) = Fake::with(&[]);
        for _ in 0..50 {
            fake.polls.lock().unwrap().push_back(ok(200, json!([])));
        }
        let _stop = start(&fake);
        tokio::time::sleep(Duration::from_millis(300)).await;
        let took = *fake.took.lock().unwrap();
        assert!((2..=8).contains(&took), "{took} polls");
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
