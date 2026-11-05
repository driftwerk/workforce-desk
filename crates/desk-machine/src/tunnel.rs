//! The one forward to a machine's hub: `ssh -N -L` from a Unix socket on
//! this computer to the gateway on the machine's loopback, kept open by a
//! supervisor thread. No TCP port is opened here: the socket is in a folder
//! only the person can open (`0700`, theirs), the socket itself theirs
//! alone (`0600`), and only Desk's own native side connects to it. So the
//! hub's tokens go only into this socket, and on from there only inside
//! SSH.
//!
//! - The forward is up once the socket is there, is a socket, belongs to
//!   the person with no access for anyone else, takes a connection, and ssh
//!   is still running. Nothing ssh or the machine prints decides it.
//! - When ssh ends (the network dropped, the Mac slept), the forward is
//!   down at once (its error output closing says so), and it is started
//!   again, backing off from 1 s to 30 s.
//! - When the machine's gateway moves to another port, the forward is
//!   rebuilt at once on the same socket.
//! - ssh runs in a process group of its own, so stopping it stops a
//!   `ProxyCommand` it started too; on Linux it ends if Desk does, and a
//!   forward a Desk that ended left behind is stopped at the next start.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
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
/// How long ssh has to end after it is asked to (it ends a `ProxyCommand`
/// it started on the way out) before it is killed.
#[cfg(unix)]
const STOP_WAIT: Duration = Duration::from_secs(2);

#[derive(Default)]
struct State {
    /// The machine's gateway port the forward should reach.
    want: Option<u16>,
    /// The gateway port the forward reaches while it is up, and which start
    /// of ssh holds it.
    up: Option<(u16, u64)>,
    /// Each start of ssh, counted.
    starts: u64,
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
    /// The forward's socket here.
    socket: PathBuf,
    state: Mutex<State>,
    changed: Condvar,
    ready_within: Duration,
    backoff: (Duration, Duration),
}

impl Shared {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Where the running ssh's process id is kept, to stop one a Desk that
    /// ended left behind.
    fn pid_file(&self) -> PathBuf {
        self.socket.with_extension("pid")
    }
}

pub struct Tunnel {
    shared: Arc<Shared>,
}

impl Tunnel {
    /// The forward to `machine` at `socket`, which must be in a folder only
    /// the person can open (see `link::socket_dir`).
    pub fn new(ssh: SshExe, machine: Machine, socket: PathBuf) -> Self {
        Self::with_timing(
            ssh,
            machine,
            socket,
            READY_WITHIN,
            FIRST_BACKOFF,
            MAX_BACKOFF,
        )
    }

    pub fn with_timing(
        ssh: SshExe,
        machine: Machine,
        socket: PathBuf,
        ready_within: Duration,
        first_backoff: Duration,
        max_backoff: Duration,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                ssh,
                machine,
                socket,
                state: Mutex::default(),
                changed: Condvar::new(),
                ready_within,
                backoff: (first_backoff, max_backoff),
            }),
        }
    }

    /// The forward's socket here.
    pub fn socket(&self) -> &Path {
        &self.shared.socket
    }

    /// The machine's gateway port the forward reaches, while it is up.
    pub fn up(&self) -> Option<u16> {
        self.shared.lock().up.map(|(port, _)| port)
    }

    /// Why it last failed to start, while it isn't up.
    pub fn problem(&self) -> Option<String> {
        let state = self.shared.lock();
        state.up.is_none().then(|| state.problem.clone()).flatten()
    }

    /// Waits for the forward to the machine's gateway at `box_port` to be
    /// up (rebuilt if it reached another port); blocking, up to `wait`.
    pub fn ensure(&self, box_port: u16, wait: Duration) -> Result<(), String> {
        let shared = &self.shared;
        let mut state = shared.lock();
        state.want = Some(box_port);
        if state.up.is_none_or(|(p, _)| p != box_port) {
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
            if state.up.is_some_and(|(p, _)| p == box_port) {
                return Ok(());
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

impl Tunnel {
    /// Ends the forward now, whoever still holds the tunnel (a machine
    /// removed from Desk).
    pub fn stop(&self) {
        let mut state = self.shared.lock();
        state.stopping = true;
        self.shared.changed.notify_all();
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.stop();
    }
}

fn supervise(shared: &Arc<Shared>) {
    let (first, max) = shared.backoff;
    let mut backoff = first;
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
        let outcome = hold(shared, box_port);
        let _ = std::fs::remove_file(&shared.socket);
        let _ = std::fs::remove_file(shared.pid_file());
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

/// Starts `invocation` in a process group of its own (so stopping it stops
/// what it started), ending with Desk on Linux.
fn spawn(shared: &Shared, invocation: &desk_core::host::Invocation) -> std::io::Result<Child> {
    let mut command = shared.ssh.command(invocation);
    command.stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            command.pre_exec(|| {
                libc::setpgid(0, 0);
                #[cfg(target_os = "linux")]
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
                Ok(())
            });
        }
    }
    command.spawn()
}

/// The process group `pid` leads, if it leads one: never a pid of 1 or
/// less (which `kill` reads as every process, or the caller's own group),
/// and only a process that is its group's leader (as ssh is, from
/// [`spawn`]).
#[cfg(unix)]
fn group_of(pid: u32) -> Option<libc::pid_t> {
    let pid = libc::pid_t::try_from(pid).ok().filter(|&p| p > 1)?;
    // SAFETY: getpgid has no memory preconditions.
    (unsafe { libc::getpgid(pid) } == pid).then_some(pid)
}

/// Sends `signal` to the process group `pid` leads, if it leads one.
#[cfg(unix)]
fn signal_group(pid: u32, signal: libc::c_int) -> bool {
    match group_of(pid) {
        // SAFETY: kill has no memory preconditions.
        Some(group) => unsafe { libc::kill(-group, signal) == 0 },
        None => false,
    }
}

/// Asks `child` and its process group to end (ssh ends its `ProxyCommand`
/// on the way out), then makes sure they have. The group is signalled only
/// while `child` hasn't been reaped: once it has, its pid (and so the
/// group's id) may be another's.
fn stop(child: &mut Child) {
    if !matches!(child.try_wait(), Ok(None)) {
        return;
    }
    #[cfg(unix)]
    {
        let pid = child.id();
        if !signal_group(pid, libc::SIGTERM) {
            let _ = desk_core::process::terminate(pid);
        }
        let until = Instant::now() + STOP_WAIT;
        while Instant::now() < until {
            if !matches!(child.try_wait(), Ok(None)) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        // Still not reaped: the group is still its.
        signal_group(pid, libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Stops a forward to this socket a Desk that ended left running: only a
/// process that is still that forward (its command names this socket),
/// and its group only when it leads one.
fn stop_left_behind(shared: &Shared) {
    #[cfg(unix)]
    if let Some(pid) = std::fs::read_to_string(shared.pid_file())
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .filter(|&pid| pid > 1)
        && desk_core::process::args_of(pid)
            .is_some_and(|args| args.contains(&*shared.socket.to_string_lossy()))
    {
        tracing::info!(machine = %shared.machine.name, pid, "stopping a forward left behind");
        if !signal_group(pid, libc::SIGTERM) {
            let _ = desk_core::process::terminate(pid);
        }
    }
    let _ = std::fs::remove_file(shared.pid_file());
}

/// Whether the forward's socket is ready: a socket, the person's, open to
/// no one else, taking a connection.
#[cfg(unix)]
fn ready(socket: &Path) -> bool {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    let Ok(meta) = std::fs::symlink_metadata(socket) else {
        return false;
    };
    // SAFETY: geteuid has no preconditions.
    let me = unsafe { libc::geteuid() };
    meta.file_type().is_socket()
        && meta.uid() == me
        && meta.mode() & 0o077 == 0
        && std::os::unix::net::UnixStream::connect(socket).is_ok()
}

#[cfg(not(unix))]
fn ready(_: &Path) -> bool {
    false
}

/// Whether the supervisor should stop holding the forward to `box_port`.
fn unwanted(shared: &Shared, box_port: u16) -> bool {
    let state = shared.lock();
    state.stopping || state.want != Some(box_port)
}

/// Keeps the last of what ssh said, to say why it failed.
fn hear(said: &mut Vec<String>, line: String) {
    said.push(line);
    if said.len() > 40 {
        said.remove(0);
    }
}

/// Starts the forward to `box_port` and holds it while it runs and is
/// wanted: an error when it never came up.
fn hold(shared: &Arc<Shared>, box_port: u16) -> Result<(), String> {
    let machine = &shared.machine;
    if cfg!(not(unix)) {
        return Err("Desk reaches machines from macOS and Linux.".into());
    }
    // The person's config is read each time: a forward it sets would be
    // carried by this always-open connection too.
    let settings = ssh::settings(&shared.ssh, machine)?;
    ssh::no_forwards(machine, &settings)?;
    stop_left_behind(shared);
    let _ = std::fs::remove_file(&shared.socket);
    let mut child = spawn(shared, &machine.forward(&shared.socket, box_port))
        .map_err(|e| format!("Desk couldn't run ssh: {e}"))?;
    let _ = std::fs::write(shared.pid_file(), child.id().to_string());
    let start = {
        let mut state = shared.lock();
        state.starts += 1;
        state.starts
    };
    // What ssh says; when it stops saying anything, it has ended, and the
    // forward is down at once, not at the next look.
    let (lines_tx, lines) = mpsc::channel::<String>();
    let stderr = child.stderr.take().expect("piped");
    let ended = Arc::clone(shared);
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = lines_tx.send(line);
        }
        let mut state = ended.lock();
        if state.up.is_some_and(|(_, s)| s == start) {
            state.up = None;
            ended.changed.notify_all();
        }
    });
    let mut said: Vec<String> = Vec::new();
    let problem = |said: &[String]| ssh::problem(machine, said.join("\n").as_bytes());
    let deadline = Instant::now() + shared.ready_within;
    loop {
        while let Ok(line) = lines.try_recv() {
            hear(&mut said, line);
        }
        if let Ok(Some(_)) = child.try_wait() {
            while let Ok(line) = lines.recv_timeout(Duration::from_millis(200)) {
                hear(&mut said, line);
            }
            return Err(problem(&said));
        }
        if ready(&shared.socket) {
            break;
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
        std::thread::sleep(Duration::from_millis(50));
    }
    {
        let mut state = shared.lock();
        // Still running now: up.
        if !matches!(child.try_wait(), Ok(None)) {
            drop(state);
            return Err(problem(&said));
        }
        state.up = Some((box_port, start));
        state.problem = None;
        shared.changed.notify_all();
    }
    tracing::info!(machine = %machine.name, box_port, "the forward is up");
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
        while let Ok(line) = lines.try_recv() {
            hear(&mut said, line);
        }
        if let Ok(Some(status)) = child.try_wait() {
            // Reaped: its group is no longer Desk's to signal.
            tracing::info!(machine = %machine.name, %status, "the forward ended");
            return Ok(());
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn only_a_group_leader_above_one_is_signalled_as_a_group() {
        assert_eq!(group_of(0), None);
        assert_eq!(group_of(1), None);
        assert_eq!(group_of(u32::MAX), None);
        // The test itself isn't its group's leader under cargo.
        let me = std::process::id();
        // SAFETY: getpgid has no memory preconditions.
        let leads = unsafe { libc::getpgid(me as libc::pid_t) } == me as libc::pid_t;
        assert_eq!(group_of(me).is_some(), leads);
        let mut leader = {
            use std::os::unix::process::CommandExt;
            let mut c = std::process::Command::new("sleep");
            c.arg("30");
            // SAFETY: only async-signal-safe calls between fork and exec.
            unsafe {
                c.pre_exec(|| {
                    libc::setpgid(0, 0);
                    Ok(())
                });
            }
            c.spawn().unwrap()
        };
        assert!(group_of(leader.id()).is_some());
        let mut plain = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        assert_eq!(group_of(plain.id()), None);
        stop(&mut leader);
        assert!(matches!(leader.try_wait(), Ok(Some(_))));
        // Reaped: stopping again signals nothing.
        stop(&mut leader);
        let _ = plain.kill();
        let _ = plain.wait();
    }
}
