//! The one forward to a machine's hub: `ssh -N -L` from a free port on this
//! computer's loopback to the gateway on the machine's loopback, kept open
//! by a supervisor thread. Everything Desk sends the machine goes through
//! it, so the hub's tokens only ever go to `127.0.0.1` here, and on from
//! there only inside SSH.
//!
//! - The forward is up only once ssh has said it is listening (`-v`'s
//!   "[port listener]" line, which ssh prints only after its own bind
//!   worked) and is still running: a port another program took first makes
//!   ssh exit (`ExitOnForwardFailure`), and is never taken for the forward.
//!   An ssh that never says so is never taken as up either.
//! - When ssh ends (the network dropped, the Mac slept), it is started
//!   again, backing off from 1 s to 30 s.
//! - When the machine's gateway moves to another port, the forward is
//!   rebuilt at once, on a new port here: whatever kept the old address
//!   fails to reach it, reads again, and finds the new one.

use std::io::{BufRead, BufReader};
use std::process::{Child, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use desk_core::machine::Machine;

use crate::ssh::{self, SshExe};

/// How long ssh has to connect and listen.
pub const READY_WITHIN: Duration = Duration::from_secs(30);
const FIRST_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
#[cfg(unix)]
/// How long ssh has to end after it is asked to (it ends a `ProxyCommand`
/// it started on the way out) before it is killed.
const STOP_WAIT: Duration = Duration::from_secs(2);
/// What `ssh -v` prints once a forward's listener is bound and listening.
const LISTENING: &str = "[port listener]";

/// The forward, while it is up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Up {
    /// The machine's gateway port, on its loopback.
    pub box_port: u16,
    /// Where it is reached here, on `127.0.0.1`.
    pub mac_port: u16,
}

#[derive(Default)]
struct State {
    /// The machine's gateway port the forward should reach.
    want: Option<u16>,
    up: Option<Up>,
    /// Starts that failed, and why the last one did.
    failures: u64,
    problem: Option<String>,
    /// Someone is waiting: try again now rather than after the back-off.
    kick: bool,
    running: bool,
    stopping: bool,
}

struct Shared {
    ssh: SshExe,
    machine: Machine,
    state: Mutex<State>,
    changed: Condvar,
    ready_within: Duration,
    backoff: (Duration, Duration),
    /// The port the next start takes instead of a free one: for the tests.
    first_port: Mutex<Option<u16>>,
}

impl Shared {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub struct Tunnel {
    shared: Arc<Shared>,
}

impl Tunnel {
    pub fn new(ssh: SshExe, machine: Machine) -> Self {
        Self::with_timing(ssh, machine, READY_WITHIN, FIRST_BACKOFF, MAX_BACKOFF)
    }

    pub fn with_timing(
        ssh: SshExe,
        machine: Machine,
        ready_within: Duration,
        first_backoff: Duration,
        max_backoff: Duration,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                ssh,
                machine,
                state: Mutex::default(),
                changed: Condvar::new(),
                ready_within,
                backoff: (first_backoff, max_backoff),
                first_port: Mutex::default(),
            }),
        }
    }

    /// Has the next start take `port` here rather than a free one, as if
    /// something took it between Desk choosing it and ssh binding it.
    #[doc(hidden)]
    pub fn start_next_on(&self, port: u16) {
        *self
            .shared
            .first_port
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(port);
    }

    /// The forward, while it is up.
    pub fn up(&self) -> Option<Up> {
        self.shared.lock().up
    }

    /// Why it last failed to start, while it isn't up.
    pub fn problem(&self) -> Option<String> {
        let state = self.shared.lock();
        state.up.is_none().then(|| state.problem.clone()).flatten()
    }

    /// The port here that reaches the machine's gateway at `box_port`,
    /// once the forward is up (rebuilt if it reached another port);
    /// blocking, up to `wait`.
    pub fn ensure(&self, box_port: u16, wait: Duration) -> Result<u16, String> {
        let shared = &self.shared;
        let mut state = shared.lock();
        state.want = Some(box_port);
        if state.up.is_none_or(|u| u.box_port != box_port) {
            state.kick = true;
        }
        if !state.running {
            state.running = true;
            let s = Arc::clone(shared);
            std::thread::Builder::new()
                .name(format!("forward to {}", shared.machine.name))
                .spawn(move || supervise(&s))
                .map_err(|e| e.to_string())?;
        }
        shared.changed.notify_all();
        let failures = state.failures;
        let deadline = Instant::now() + wait;
        loop {
            if let Some(up) = state.up.filter(|u| u.box_port == box_port) {
                return Ok(up.mac_port);
            }
            if state.failures > failures {
                return Err(state.problem.clone().unwrap_or_else(|| {
                    format!("Desk couldn't connect to {}.", shared.machine.name)
                }));
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() || state.stopping {
                return Err(format!(
                    "Desk couldn't connect to {} in time.",
                    shared.machine.name
                ));
            }
            state = shared
                .changed
                .wait_timeout(state, left)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        let mut state = self.shared.lock();
        state.stopping = true;
        self.shared.changed.notify_all();
    }
}

fn supervise(shared: &Shared) {
    let (first, max) = shared.backoff;
    let mut backoff = first;
    let mut last_mac = None;
    loop {
        let box_port = {
            let mut state = shared.lock();
            while state.want.is_none() && !state.stopping {
                state = shared
                    .changed
                    .wait(state)
                    .unwrap_or_else(|e| e.into_inner());
            }
            if state.stopping {
                break;
            }
            state.kick = false;
            state.want.expect("wanted")
        };
        let started = Instant::now();
        let outcome = hold(shared, box_port, &mut last_mac);
        let mut state = shared.lock();
        state.up = None;
        if let Err(why) = outcome {
            tracing::info!(machine = %shared.machine.name, why = %why, "the forward didn't start");
            state.failures += 1;
            state.problem = Some(why);
        }
        shared.changed.notify_all();
        if state.stopping {
            break;
        }
        if state.want != Some(box_port) {
            // Moved: rebuilt at once.
            backoff = first;
            continue;
        }
        if started.elapsed() > max {
            backoff = first;
        }
        let until = Instant::now() + backoff;
        while !state.stopping && !state.kick && state.want == Some(box_port) {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            state = shared
                .changed
                .wait_timeout(state, left)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        if state.stopping {
            break;
        }
        backoff = (backoff * 2).min(max);
    }
    shared.lock().running = false;
}

/// A free port on this computer's loopback, not `avoid`: ssh binds it
/// itself, and fails (ending) if something took it meanwhile.
fn free_port(avoid: Option<u16>) -> std::io::Result<u16> {
    loop {
        let port = std::net::TcpListener::bind("127.0.0.1:0")?
            .local_addr()?
            .port();
        if Some(port) != avoid {
            return Ok(port);
        }
    }
}

/// Asks `child` to end (ssh ends its `ProxyCommand` on the way out), then
/// makes sure it has.
fn stop(child: &mut Child) {
    #[cfg(unix)]
    {
        let _ = desk_core::process::terminate(child.id());
        let until = Instant::now() + STOP_WAIT;
        while Instant::now() < until {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Keeps what ssh said that wasn't its debug chatter (the last of it, to
/// say why it failed); whether it said it is listening.
fn hear(said: &mut Vec<String>, line: String) -> bool {
    let listening = line.contains(LISTENING);
    if !line.starts_with("debug") {
        said.push(line);
        if said.len() > 40 {
            said.remove(0);
        }
    }
    listening
}

/// Whether the supervisor should stop holding the forward to `box_port`.
fn unwanted(shared: &Shared, box_port: u16) -> bool {
    let state = shared.lock();
    state.stopping || state.want != Some(box_port)
}

/// Starts the forward to `box_port` and holds it while it runs and is
/// wanted: an error when it never came up.
fn hold(shared: &Shared, box_port: u16, last_mac: &mut Option<u16>) -> Result<(), String> {
    let machine = &shared.machine;
    // The person's config is read each time: a forward it sets would be
    // carried by this always-open connection too.
    let settings = ssh::settings(&shared.ssh, machine)?;
    ssh::no_forwards(machine, &settings)?;
    let chosen = shared
        .first_port
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    let mac_port = match chosen {
        Some(port) => port,
        None => free_port(*last_mac).map_err(|e| e.to_string())?,
    };
    *last_mac = Some(mac_port);
    let mut invocation = machine.forward(mac_port, box_port);
    invocation.args.insert(0, "-v".into());
    let mut child = shared
        .ssh
        .command(&invocation)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Desk couldn't run ssh: {e}"))?;
    let (lines_tx, lines) = mpsc::channel::<String>();
    let stderr = child.stderr.take().expect("piped");
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if lines_tx.send(line).is_err() {
                break;
            }
        }
    });
    let mut said: Vec<String> = Vec::new();
    let problem = |said: &[String]| ssh::problem(machine, said.join("\n").as_bytes());
    // Up once ssh says it listens, and is still running.
    let deadline = Instant::now() + shared.ready_within;
    let mut listening = false;
    while !listening {
        match lines.recv_timeout(Duration::from_millis(100)) {
            Ok(line) => listening = hear(&mut said, line),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = child.wait();
                return Err(problem(&said));
            }
        }
        if let Ok(Some(_)) = child.try_wait() {
            // What it said last, to say why.
            while let Ok(line) = lines.recv_timeout(Duration::from_millis(200)) {
                hear(&mut said, line);
            }
            return Err(problem(&said));
        }
        if unwanted(shared, box_port) {
            stop(&mut child);
            return Ok(());
        }
        if Instant::now() > deadline {
            stop(&mut child);
            return Err(format!(
                "Desk couldn't connect to {} in time.",
                machine.name
            ));
        }
    }
    // A line just after it may still be its bind failing.
    while let Ok(line) = lines.recv_timeout(Duration::from_millis(150)) {
        hear(&mut said, line);
    }
    if let Ok(Some(_)) = child.try_wait() {
        return Err(problem(&said));
    }
    {
        let mut state = shared.lock();
        state.up = Some(Up { box_port, mac_port });
        state.problem = None;
        shared.changed.notify_all();
    }
    tracing::info!(machine = %machine.name, mac_port, box_port, "the forward is up");
    loop {
        {
            let state = shared.lock();
            let state = shared
                .changed
                .wait_timeout(state, Duration::from_millis(250))
                .unwrap_or_else(|e| e.into_inner())
                .0;
            if state.stopping || state.want != Some(box_port) {
                drop(state);
                stop(&mut child);
                return Ok(());
            }
        }
        // Drained, so ssh never blocks on a full pipe.
        while let Ok(line) = lines.try_recv() {
            hear(&mut said, line);
        }
        if let Ok(Some(status)) = child.try_wait() {
            tracing::info!(machine = %machine.name, %status, said = %said.last().map(String::as_str).unwrap_or_default(), "the forward ended");
            return Ok(());
        }
    }
}
