//! The person's machines as Desk keeps them: the registry
//! (`machines.json` in Desk's folder: id, name, target, the version
//! installed and the system; never a secret), where each stands, adding one
//! (§4 of the remote machines design), and connecting to each, which
//! upgrades a machine on an older Desk and drives one on a newer Desk no
//! further.
//!
//! The page names a machine only by id, or while adding one by the address
//! the person typed, which is checked here. Nothing runs on an address
//! before the person said yes to it natively (`admit::Gate`); that yes
//! stands for a while for that exact address, so looking at it again,
//! trusting its key and adding it ask once.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use desk_core::backend_install::{self as install, Plan};
use desk_core::machine::{Machine, MachineId, Target};
use desk_core::machine_backend::{Arch, Backend};
use serde::{Deserialize, Serialize};

use crate::admit::{self, Confirm, Gate, Question};
use crate::hostkey::{self, Files, SwitchQuestion, TrustConfirm, UninstallQuestion};
use crate::link::{Link, Machines};
use crate::probe::{self, Access, Missed, Probe, ProbeKey, System};
use crate::setup::{self, Person};
use crate::ssh::{self, SshExe};
use crate::suggest;

/// Where a machine stands, as the page reads it (`readState`): a word, or
/// `{"failed": {"message": …}}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Adding,
    Connecting,
    Ready,
    Unreachable,
    Updating,
    /// On a newer Desk than this one: driven no further.
    Newer,
    Failed {
        message: String,
    },
    /// Updating it to this Desk's version stopped (or was cancelled): it
    /// runs `from` still, and is driven no further until it matches.
    UpdateFailed {
        message: String,
        from: Option<String>,
    },
}

/// An update under way there, step by step, as its row shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRun {
    pub to: String,
    pub from: Option<String>,
    pub steps: Vec<UpdateStep>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UpdateStep {
    pub key: UpdateKey,
    pub state: StepState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateKey {
    /// This Desk's backend for its system, signature checked.
    Download,
    /// Copied there.
    Copy,
    /// `current` flipped to it: Desk restarts there; sessions stay.
    Switch,
    /// Connected again, on the new version.
    Reconnect,
}

impl UpdateRun {
    fn new(to: &str, from: Option<String>) -> UpdateRun {
        UpdateRun {
            to: to.to_string(),
            from,
            steps: [
                UpdateKey::Download,
                UpdateKey::Copy,
                UpdateKey::Switch,
                UpdateKey::Reconnect,
            ]
            .into_iter()
            .map(|key| UpdateStep {
                key,
                state: StepState::Waiting,
                detail: None,
            })
            .collect(),
        }
    }
}

/// A machine as `machines.json` keeps it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Kept {
    #[serde(flatten)]
    pub machine: Machine,
    /// The Desk version installed there, once known.
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub system: Option<System>,
    /// The host key Desk knows it by: what makes another address the same
    /// machine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_key: Option<KeptKey>,
    /// When Desk last reached it (Unix ms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_connected: Option<i64>,
}

/// A machine's host key, as Desk keeps and shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeptKey {
    /// `ED25519`.
    pub kind: String,
    /// `SHA256:…`.
    pub fingerprint: String,
    /// When the person trusted it from Desk (Unix ms); none when it was in
    /// their known_hosts already.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trusted_at: Option<i64>,
}

/// One line of this computer's log of a machine: what Desk did to reach
/// it, and what ssh said.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    /// Unix ms.
    pub at: i64,
    pub kind: LogKind,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LogKind {
    Info,
    Ok,
    Warn,
    Error,
}

/// What an update cancelled before its switch-over says.
const UPDATE_CANCELLED: &str = "The update was cancelled.";

/// The most lines kept of a machine's log.
const LOG_LINES: usize = 200;

/// How Desk reaches a machine, as the person's ssh config makes it
/// (`ssh -G`, read at each connect).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reach {
    pub user: Option<String>,
    pub hostname: Option<String>,
    pub port: Option<String>,
    /// `ProxyJump`'s hosts, or that a `ProxyCommand` runs.
    pub via: Option<String>,
    /// The `Host` entry its address is, and the file it is in.
    pub entry: Option<String>,
    pub file: Option<String>,
    /// The line that removes its old key from the person's known_hosts
    /// (`ssh-keygen -R`, by the name and port ssh looks it up by).
    pub forget_key: Option<String>,
}

/// What the last look there found, besides its system.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    pub free_kb: Option<u64>,
    pub linger: Option<bool>,
    /// Desk's user service there is enabled.
    pub service: bool,
    pub systemd: bool,
    pub user: Option<String>,
    /// The line that turns linger on there, made here with the account's
    /// name checked and quoted.
    pub linger_line: Option<String>,
}

/// What checking another address for a machine found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Checked {
    /// It shows the machine's own key: switching to it is a click.
    #[serde(rename_all = "camelCase")]
    Same { key: KeptKey, took_ms: u64 },
    /// The person said no: nothing ran there.
    Cancelled,
    /// It shows another key: never switched to.
    DifferentKey { shown: KeptKey, known: KeptKey },
}

/// An address checked for a machine, and what its switch needs.
struct CheckedAt {
    target: Target,
    line: String,
    files: Files,
    at: Instant,
}

/// How long a check stands for the switch that follows it.
const CHECK_STANDS: Duration = Duration::from_secs(5 * 60);

/// What changing how a machine is reached did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Edited {
    /// The name, the address or both are changed.
    Done,
    /// The person said no: nothing changed.
    Cancelled,
    /// The new address shows another key than the machine's: refused.
    DifferentKey { shown: KeptKey, known: KeptKey },
}

/// An ssh that couldn't run, or ran out of time, in plain words.
fn ssh_ran_out(machine: &Machine, e: &std::io::Error, within: Duration) -> String {
    if e.kind() == std::io::ErrorKind::TimedOut {
        format!(
            "{} didn't answer within {} s. Nothing changed.",
            machine.target,
            within.as_secs()
        )
    } else {
        format!("Desk couldn't run ssh: {e}")
    }
}

/// Now, in Unix ms.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// A row of `machines_list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    pub id: String,
    pub name: String,
    pub target: String,
    pub version: Option<String>,
    pub system: Option<System>,
    pub state: State,
    /// Why it is offline or failed, in the person's words.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// ssh's own last line about it, as ssh said it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub said: Option<String>,
    /// Unix ms: when it was last reached, when Desk last tried, when it
    /// tries next, and since when it has been connected.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_connected: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_try: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_try: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connected_since: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reach: Option<Reach>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Details>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_key: Option<KeptKey>,
    /// The key it shows now, when its host key changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shown_key: Option<KeptKey>,
    /// What an install or update there is doing now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update: Option<UpdateRun>,
}

/// A step of adding a machine, as the page's checklist shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Step {
    Connect,
    Install,
    Engines,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StepState {
    /// Not begun (an update's later steps).
    Waiting,
    Running,
    Done,
    Failed,
    Blocked,
}

/// The `machine-setup` event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SetupEvent {
    pub machine: String,
    pub step: Step,
    pub state: StepState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<String>,
}

/// What the app gives the fleet: where to say things, and the backend.
pub trait Host: Send + Sync + 'static {
    /// Any machine's state, name or version changed.
    fn changed(&self);
    fn setup(&self, event: &SetupEvent);
    /// Machine `id` is reached no more (removed, or on a newer Desk): the
    /// app drops its broker and sockets.
    fn dropped(&self, id: &str);
    /// The backend version machines run: this Desk's.
    fn wanted(&self) -> Result<String, String>;
    /// That backend for `arch`, checked, ready to copy.
    fn backend(&self, arch: Arch) -> Result<Backend, String>;
    /// Who owns the machines, for their services.
    fn person(&self) -> Person;
    /// A step of uninstalling Desk from a machine moved.
    fn removing(&self, event: &RemoveEvent) {
        let _ = event;
    }
}

/// A step of removing a machine with Desk uninstalled from it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoveStep {
    /// Desk's service stopped there, and its unit taken away.
    Stop,
    /// Everything Desk keeps there removed.
    Remove,
    /// Linger turned off for the account.
    Linger,
    /// Forgotten on this computer.
    Forget,
}

/// The `machine-remove` event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemoveEvent {
    pub machine: String,
    pub step: RemoveStep,
    pub state: StepState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// What to run there by hand, when Desk couldn't do it itself.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<String>,
}

/// How long things take.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    /// How long Desk waits for a machine's helper to say where its hub is.
    pub ready_within: Duration,
    /// The longest one step of setting a machine up may take.
    pub step_within: Duration,
    pub poll: Duration,
    /// How often a ready machine's forward is looked at.
    pub check_every: Duration,
    pub first_backoff: Duration,
    pub max_backoff: Duration,
    /// How often, and how long, Desk looks for linger after asking for it.
    pub linger_poll: Duration,
    pub linger_for: Duration,
    /// How long a yes to an address stands.
    pub admitted_for: Duration,
    /// How long changing how a machine is reached may wait on ssh, after
    /// the person's yes: reading its settings, its key, and checking it.
    pub edit_within: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            ready_within: Duration::from_secs(180),
            step_within: ssh::Step::LIMIT,
            poll: Duration::from_secs(1),
            check_every: Duration::from_secs(5),
            first_backoff: Duration::from_secs(5),
            max_backoff: Duration::from_secs(300),
            linger_poll: Duration::from_secs(5),
            linger_for: Duration::from_secs(30 * 60),
            admitted_for: Duration::from_secs(15 * 60),
            edit_within: Duration::from_secs(45),
        }
    }
}

/// The addresses the person said yes to, and when.
struct Admitted {
    within: Duration,
    at: Mutex<HashMap<String, Instant>>,
}

impl Admitted {
    fn has(&self, target: &str) -> bool {
        let mut at = self.at.lock().unwrap_or_else(|e| e.into_inner());
        at.retain(|_, when| when.elapsed() < self.within);
        at.contains_key(target)
    }

    fn add(&self, target: &str) {
        self.at
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(target.to_string(), Instant::now());
    }

    /// The yes to `target` is used up, or no longer stands.
    fn forget(&self, target: &str) {
        self.at
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(target);
    }
}

/// The question, asked once for an address while the yes stands.
struct Remembering {
    inner: Arc<dyn Confirm>,
    admitted: Arc<Admitted>,
}

impl Confirm for Remembering {
    fn run_on(&self, question: &Question) -> bool {
        if self.admitted.has(&question.target) {
            return true;
        }
        let yes = self.inner.run_on(question);
        if yes {
            self.admitted.add(&question.target);
        }
        yes
    }
}

/// How Desk Helper is kept running there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Keep {
    /// The systemd user service, with linger.
    Service,
    /// Started by Desk at each connect: no systemd for users there.
    OnConnect,
    /// Started by Desk at each connect until linger is on, which needs
    /// someone who may turn it on.
    Blocked,
}

struct Row {
    kept: Kept,
    state: State,
    /// In `machines.json`.
    saved: bool,
    /// A connect is running.
    busy: bool,
    kick: Arc<(Mutex<bool>, Condvar)>,
    /// What the page shows of where it stands, besides its state.
    now: Now,
    /// Set when the person cancels adding it (or its update, or its
    /// uninstall between steps).
    cancel: Arc<std::sync::atomic::AtomicBool>,
    /// Driven no further until the person asks (Reconnect): an uninstall
    /// that stopped partway, which a connect would install again.
    hold: bool,
    /// Desk is being uninstalled from it now.
    removing: bool,
}

/// Where a machine stands, besides its state: why, when, how it is reached,
/// and this computer's log of it. Held in memory.
#[derive(Default)]
struct Now {
    reason: Option<String>,
    said: Option<String>,
    last_try: Option<i64>,
    next_try: Option<i64>,
    connected_since: Option<i64>,
    reach: Option<Reach>,
    details: Option<Details>,
    /// The key it shows now, when that isn't the one this computer knows.
    shown_key: Option<KeptKey>,
    log: VecDeque<LogLine>,
    /// What a copy there has done so far ("Copying Desk 0.2.1… 22 of 61 MB").
    progress: Option<String>,
    /// An update to this Desk's version under way, or the one that stopped.
    update: Option<UpdateRun>,
}

impl Row {
    fn new(kept: Kept, state: State, saved: bool, busy: bool) -> Row {
        Row {
            kept,
            state,
            saved,
            busy,
            kick: Arc::default(),
            now: Now::default(),
            cancel: Arc::default(),
            hold: false,
            removing: false,
        }
    }
}

pub struct Fleet {
    ssh: SshExe,
    machines: Arc<Machines>,
    file: PathBuf,
    /// This computer's home, where the person's `~/.ssh` is.
    home: PathBuf,
    host: Arc<dyn Host>,
    gate: Gate,
    admitted: Arc<Admitted>,
    trust: Arc<dyn TrustConfirm>,
    /// One trust question at a time, none for a while after a Cancel.
    trust_gate: hostkey::TrustGate,
    timing: Timing,
    rows: Mutex<BTreeMap<String, Row>>,
    /// Held from a save's snapshot of the rows through its rename, so an
    /// older snapshot can't land after a newer one (a removed machine
    /// back).
    saving: Mutex<()>,
    /// Set when `machines.json` was there but didn't read: it is never
    /// written over, and nothing is added until it is fixed or moved.
    unreadable: std::sync::atomic::AtomicBool,
    /// Addresses being added whose id isn't known yet (the person's yes is
    /// awaited), and whether the person cancelled adding them meanwhile.
    pending: Mutex<HashMap<String, bool>>,
    /// How long a save waits between its snapshot and its write: tests
    /// only, to hold one there.
    #[cfg(test)]
    save_pause: Mutex<Duration>,
    /// What the person's ssh settings said about the address looked at
    /// last, for the public key it would sign in with.
    files: Mutex<Option<Files>>,
    /// Keys the person trusted from Desk, by address, until the machine at
    /// that address is added.
    trusted: Mutex<HashMap<String, KeptKey>>,
    /// Addresses checked to show a machine's own key, by machine: what a
    /// switch to them needs, for [`CHECK_STANDS`].
    checked: Mutex<HashMap<String, CheckedAt>>,
}

/// Whether the machine's hub answers through the forward: its engines, as
/// the page first asks for them, with `token` (only ever into the forward's
/// socket). Blocking, a few seconds at most.
#[cfg(unix)]
fn answers(link: &Link, token: &str) -> bool {
    use std::io::{Read as _, Write as _};
    let Ok(mut s) = std::os::unix::net::UnixStream::connect(link.socket()) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(5)));
    if write!(
        s,
        "GET /api/desk/engines HTTP/1.1\r\nhost: 127.0.0.1\r\nauthorization: Bearer {token}\r\nconnection: close\r\n\r\n"
    )
    .is_err()
    {
        return false;
    }
    let mut head = [0u8; 12];
    s.read_exact(&mut head).is_ok() && head.starts_with(b"HTTP/1.1 200")
}

#[cfg(not(unix))]
fn answers(_: &Link, _: &str) -> bool {
    true
}

/// Writes `bytes` to `file` through a partial file of this write's own
/// (0600), synced, then renamed into place and the folder synced.
fn write_private(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = file.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let partial = dir.join(format!(
        ".{name}.{}.{}.partial",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    let written = (|| {
        let mut f = o.open(&partial)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&partial, file)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    written?;
    #[cfg(unix)]
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

/// Where a development backend comes from.
fn machine_backend_env() -> &'static str {
    desk_core::machine_backend::DEV_OVERRIDE_ENV
}

/// Waits a little for the forwards of `links`, stopped, to end: each one's
/// ssh is ended on a thread of its own, and none should outlive the app.
fn ended(links: &[Arc<Link>]) {
    let until = Instant::now() + Duration::from_secs(3);
    while links.iter().any(|l| l.tunnel().up().is_some()) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// An id for `name`: lowercase letters, digits and `-`, never `local`, and
/// none of `taken`.
pub fn id_for(name: &str, taken: &dyn Fn(&str) -> bool) -> MachineId {
    let mut slug = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    let mut base: String = slug.trim_matches('-').chars().take(40).collect();
    base = base.trim_end_matches('-').to_string();
    if base.is_empty() || base == desk_core::LOCAL_HUB_ID {
        base = format!("machine{}", if base.is_empty() { "" } else { "-local" });
    }
    let mut id = base.clone();
    let mut n = 2;
    while taken(&id) {
        id = format!("{base}-{n}");
        n += 1;
    }
    MachineId::new(&id).expect("an id made of letters, digits and -")
}

impl Fleet {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        ssh: SshExe,
        machines: Arc<Machines>,
        file: PathBuf,
        home: PathBuf,
        host: Arc<dyn Host>,
        confirm: Arc<dyn Confirm>,
        trust: Arc<dyn TrustConfirm>,
        timing: Timing,
    ) -> Arc<Fleet> {
        let admitted = Arc::new(Admitted {
            within: timing.admitted_for,
            at: Mutex::default(),
        });
        let gate = Gate::new(Arc::new(Remembering {
            inner: confirm,
            admitted: Arc::clone(&admitted),
        }));
        Arc::new(Fleet {
            ssh,
            machines,
            file,
            home,
            host,
            gate,
            admitted,
            trust,
            trust_gate: hostkey::TrustGate::default(),
            timing,
            rows: Mutex::default(),
            saving: Mutex::default(),
            unreadable: Default::default(),
            pending: Mutex::default(),
            #[cfg(test)]
            save_pause: Mutex::default(),
            files: Mutex::default(),
            trusted: Mutex::default(),
            checked: Mutex::default(),
        })
    }

    fn rows(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Row>> {
        self.rows.lock().unwrap_or_else(|e| e.into_inner())
    }

    // ── The registry ────────────────────────────────────────────────────

    /// The machines `machines.json` keeps, read once at start, each then
    /// connected to (and upgraded when it is on an older Desk).
    pub fn load(self: &Arc<Self>) {
        let kept: Vec<Kept> = match std::fs::read_to_string(&self.file) {
            Ok(s) => match serde_json::from_str::<Vec<Kept>>(&s) {
                Ok(k) => k,
                Err(e) => {
                    tracing::warn!(file = %self.file.display(), error = %e, "the machines file doesn't read; it is kept as it is, and not written over");
                    self.unreadable
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    return;
                }
            },
            Err(_) => Vec::new(),
        };
        let ids: Vec<String> = {
            let mut rows = self.rows();
            for k in kept {
                rows.insert(
                    k.machine.id.to_string(),
                    Row::new(k, State::Connecting, true, false),
                );
            }
            rows.keys().cloned().collect()
        };
        self.host.changed();
        for id in ids {
            self.supervise(&id);
        }
    }

    /// Writes the machines added: whole or not at all, private to the
    /// person (0600), synced before it takes the file's place; one save at
    /// a time, each with the rows as they are when it starts. Never over a
    /// file that didn't read.
    fn save(&self) {
        if self.unreadable.load(std::sync::atomic::Ordering::SeqCst) {
            tracing::warn!(file = %self.file.display(), "not writing over the machines file that didn't read");
            return;
        }
        let _saving = self.saving.lock().unwrap_or_else(|e| e.into_inner());
        let kept: Vec<Kept> = self
            .rows()
            .values()
            .filter(|r| r.saved)
            .map(|r| r.kept.clone())
            .collect();
        #[cfg(test)]
        std::thread::sleep(*self.save_pause.lock().unwrap());
        if let Err(e) = write_private(
            &self.file,
            &serde_json::to_vec_pretty(&kept).unwrap_or_default(),
        ) {
            tracing::warn!(file = %self.file.display(), error = %e, "couldn't write the machines file");
        }
    }

    pub fn list(&self) -> Vec<Listed> {
        self.rows()
            .values()
            .map(|r| Listed {
                id: r.kept.machine.id.to_string(),
                name: r.kept.machine.name.clone(),
                target: r.kept.machine.target.to_string(),
                version: r.kept.version.clone(),
                system: r.kept.system.clone(),
                state: r.state.clone(),
                reason: r.now.reason.clone(),
                said: r.now.said.clone(),
                last_connected: r.kept.last_connected,
                last_try: r.now.last_try,
                next_try: r.now.next_try,
                connected_since: r.now.connected_since,
                reach: r.now.reach.clone(),
                details: r.now.details.clone(),
                host_key: r.kept.host_key.clone(),
                shown_key: r.now.shown_key.clone(),
                progress: r.now.progress.clone(),
                update: r.now.update.clone(),
            })
            .collect()
    }

    /// Says where step `key` of machine `id`'s update is, when one runs.
    fn update_step(&self, id: &str, key: UpdateKey, state: StepState, detail: Option<String>) {
        self.set_now(id, |n| {
            if let Some(run) = n.update.as_mut()
                && let Some(step) = run.steps.iter_mut().find(|s| s.key == key)
            {
                step.state = state;
                if detail.is_some() {
                    step.detail = detail;
                }
            }
        });
    }

    /// The step of machine `id`'s update that runs now, if any.
    fn update_running(&self, id: &str) -> Option<UpdateKey> {
        self.rows().get(id).and_then(|r| {
            r.now.update.as_ref().and_then(|u| {
                u.steps
                    .iter()
                    .find(|s| s.state == StepState::Running)
                    .map(|s| s.key)
            })
        })
    }

    /// "Cancel update" (`machine_cancel_update`): stops machine `id`'s update
    /// before it switches over (whatever runs there is ended); it stays on
    /// the version it had, driven no further until it matches.
    pub fn cancel_update(&self, id: &str) -> Result<(), String> {
        // Looked at and set under the one lock the switch-over is begun
        // under (`begin_switch`): a Cancel either lands before it, or is
        // refused.
        let rows = self.rows();
        let r = rows.get(id).ok_or("That machine isn't in Desk any more.")?;
        let name = &r.kept.machine.name;
        let running = r.now.update.as_ref().and_then(|u| {
            u.steps
                .iter()
                .find(|s| s.state == StepState::Running)
                .map(|s| s.key)
        });
        match running {
            Some(UpdateKey::Download | UpdateKey::Copy) => {}
            Some(_) => {
                return Err(format!(
                    "{name} is switching over now: it's done in a few seconds."
                ));
            }
            None => return Err(format!("{name} isn't updating now.")),
        }
        r.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }

    /// Begins machine `id`'s switch-over, unless its update was cancelled:
    /// both under one lock with Cancel update, so a Cancel never lands
    /// after the switch-over has begun. True when it begins.
    fn begin_switch(&self, id: &str) -> bool {
        let mut rows = self.rows();
        let Some(r) = rows.get_mut(id) else {
            return false;
        };
        if r.cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return false;
        }
        if let Some(run) = r.now.update.as_mut()
            && let Some(step) = run.steps.iter_mut().find(|s| s.key == UpdateKey::Switch)
        {
            step.state = StepState::Running;
        }
        true
    }

    /// A step that can't be cancelled (the switch-over, reconnecting after
    /// it): its own cancel flag, which nothing sets, and the step's limit.
    fn step_uncancellable(&self) -> ssh::Step {
        ssh::Step::new(Arc::default(), self.timing.step_within)
    }

    /// This computer's log of machine `id`, oldest first.
    pub fn log(&self, id: &str) -> Result<Vec<LogLine>, String> {
        self.rows()
            .get(id)
            .map(|r| r.now.log.iter().cloned().collect())
            .ok_or_else(|| "That machine isn't in Desk any more.".to_string())
    }

    /// Adds a line to machine `id`'s log, and to Desk's own.
    fn note(&self, id: &str, kind: LogKind, text: impl Into<String>) {
        let text = text.into();
        match kind {
            LogKind::Error | LogKind::Warn => {
                tracing::info!(machine = id, problem = %text, "machine log")
            }
            _ => tracing::info!(machine = id, said = %text, "machine log"),
        }
        if let Some(r) = self.rows().get_mut(id) {
            if r.now.log.len() >= LOG_LINES {
                r.now.log.pop_front();
            }
            r.now.log.push_back(LogLine {
                at: now_ms(),
                kind,
                text,
            });
        }
    }

    /// Changes what the page shows of where machine `id` stands, and says
    /// so.
    fn set_now(&self, id: &str, f: impl FnOnce(&mut Now)) {
        let found = match self.rows().get_mut(id) {
            Some(r) => {
                f(&mut r.now);
                true
            }
            None => false,
        };
        if found {
            self.host.changed();
        }
    }

    pub fn state(&self, id: &str) -> Option<State> {
        self.rows().get(id).map(|r| r.state.clone())
    }

    fn set_state(&self, id: &str, state: State) {
        let changed = match self.rows().get_mut(id) {
            Some(r) if r.state != state => {
                tracing::info!(machine = id, ?state, "machine");
                r.state = state;
                true
            }
            _ => false,
        };
        if changed {
            self.host.changed();
        }
    }

    fn update_kept(&self, id: &str, f: impl FnOnce(&mut Kept)) {
        let saved = match self.rows().get_mut(id) {
            Some(r) => {
                f(&mut r.kept);
                r.saved
            }
            None => return,
        };
        if saved {
            self.save();
        }
        self.host.changed();
    }

    fn machine(&self, id: &str) -> Option<Machine> {
        self.rows().get(id).map(|r| r.kept.machine.clone())
    }

    /// The machine's link, made again if it was dropped.
    fn link(&self, machine: &Machine) -> Result<Arc<Link>, String> {
        // One removed meanwhile (while it was being set up) stays removed.
        if self.machine(machine.id.as_str()).is_none() {
            return Err("That machine isn't in Desk any more.".into());
        }
        match self.machines.get(machine.id.as_str()) {
            Some(l) => Ok(l),
            None => self.machines.insert(machine.clone()),
        }
    }

    fn drop_link(&self, id: &str) {
        let link = self.machines.get(id);
        if let Some(link) = &link {
            link.tunnel().stop();
        }
        self.machines.remove(id);
        self.host.dropped(id);
        ended(link.as_slice());
    }

    // ── Before adding ───────────────────────────────────────────────────

    /// The person's yes to `target`, asked natively unless it stands.
    fn ask(&self, machine: &Machine) -> Result<(), String> {
        self.gate.ask(&Question {
            name: machine.name.clone(),
            target: machine.target.to_string(),
        })
    }

    fn settings_said(&self, machine: &Machine) -> Result<String, String> {
        let out = self
            .ssh
            .output(&machine.settings())
            .map_err(|e| format!("Desk couldn't run ssh: {e}"))?;
        if !out.status.success() {
            return Err(ssh::problem(machine, &out.stderr));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    fn looked_at(target: &str) -> Result<Machine, String> {
        let target = Target::new(target.trim()).map_err(|e| e.to_string())?;
        Ok(Machine {
            id: MachineId::new("probe").expect("an id"),
            name: probe::name_of(target.as_str()),
            target,
        })
    }

    /// A first look at `target` (`machine_probe`): its host key, then
    /// whether this computer's key gets in. Asks the person first; nothing
    /// runs before their yes, not even `ssh -G`. Blocking.
    pub fn probe(&self, target: &str) -> Result<Probe, String> {
        let machine = Self::looked_at(target)?;
        self.ask(&machine)?;
        let said = self.settings_said(&machine)?;
        let settings = ssh::Settings::parse(&said);
        ssh::no_forwards(&machine, &settings)?;
        let files = Files::parse(&said, &self.home);
        *self.files.lock().unwrap_or_else(|e| e.into_inner()) = Some(files.clone());
        let mut probe = probe::probe(&self.ssh, &machine, settings.user, &files);
        if matches!(probe.host_key, ProbeKey::Changed { .. }) {
            probe.forget_key = hostkey::forget_line(&files, &self.home);
        }
        // A name that didn't resolve may be spelled differently in the
        // person's SSH config; the config's text is read, nothing is run.
        if let Some(Access::Unreachable { message, suggest }) = &mut probe.access
            && message.contains("Could not resolve hostname")
        {
            *suggest = suggest::did_you_mean(&self.home, machine.target.as_str());
        }
        Ok(probe)
    }

    /// Trusts `target`'s host key (`machine_trust`), when it is the one with
    /// `fingerprint` and the person says yes to it natively. Only for an
    /// address the person said yes to looking at. Blocking.
    pub fn trust(&self, target: &str, fingerprint: &str) -> Result<(), String> {
        let machine = Self::looked_at(target)?;
        if !self.admitted.has(machine.target.as_str()) {
            return Err("Look at the machine in Settings → Machines first.".into());
        }
        let said = self.settings_said(&machine)?;
        // Nothing connects to a machine whose config would carry forwards.
        ssh::no_forwards(&machine, &ssh::Settings::parse(&said))?;
        let files = Files::parse(&said, &self.home);
        let confirm = hostkey::Gated {
            gate: &self.trust_gate,
            confirm: self.trust.as_ref(),
        };
        if let Some(key) = hostkey::trust(&self.ssh, &machine, &files, fingerprint, &confirm)? {
            let kept = KeptKey {
                kind: key.kind(),
                fingerprint: key.fingerprint,
                trusted_at: Some(now_ms()),
            };
            self.trusted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(machine.target.to_string(), kept.clone());
            // A machine of Desk's at that address now has this key: the
            // one another address must show to be the same machine.
            let same: Vec<String> = self
                .rows()
                .iter()
                .filter(|(_, r)| r.kept.machine.target == machine.target)
                .map(|(id, _)| id.clone())
                .collect();
            for id in same {
                self.update_kept(&id, |k| k.host_key = Some(kept.clone()));
                self.set_now(&id, |n| n.shown_key = None);
            }
        }
        Ok(())
    }

    /// This computer's public SSH key (`machine_public_key`): for the
    /// address last looked at, the key its settings name; else ssh's own
    /// defaults. Only ever a `.pub` file or the agent's public keys.
    pub fn public_key(&self) -> Option<String> {
        let files = self.files.lock().unwrap_or_else(|e| e.into_inner()).clone();
        probe::public_key(files.as_ref(), &self.home)
    }

    // ── Adding ──────────────────────────────────────────────────────────

    /// Adds `target` as `name` (`machine_add`) and sets it up there on its
    /// own thread, saying each step on `machine-setup`; its id, once the
    /// person said yes (natively, unless their yes to looking at it
    /// stands), and ssh reaches it with its key known.
    pub fn add(self: &Arc<Self>, target: &str, name: &str) -> Result<String, String> {
        let target = target.trim();
        if self.unreadable.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(format!(
                "Desk couldn't read its list of machines ({}), so it won't add one until that file is fixed or moved away. Then quit and open Desk again.",
                self.file.display()
            ));
        }
        if self
            .rows()
            .values()
            .any(|r| r.kept.machine.target.as_str() == target)
        {
            return Err(format!("{target} is in Desk already."));
        }
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 60 || name.chars().any(char::is_control) {
            return Err("Give it a name of up to 60 letters.".into());
        }
        if self
            .rows()
            .values()
            .any(|r| r.kept.machine.name.eq_ignore_ascii_case(name))
        {
            return Err(format!(
                "Another machine is called {name} already. Two machines can't share a name."
            ));
        }
        let id = {
            let rows = self.rows();
            id_for(name, &|id| rows.contains_key(id))
        };
        // Cancellable by its address until it has an id: while the
        // person's yes is awaited, a Cancel stops it once they answer.
        self.pending_adds().insert(target.to_string(), false);
        let admitted = admit::admit(&self.gate, &self.ssh, id.clone(), name, target);
        let cancelled = self.pending_adds().remove(target).unwrap_or(false);
        if cancelled {
            if let Ok((machine, _)) = &admitted {
                self.admitted.forget(machine.target.as_str());
            }
            tracing::info!(target, "adding a machine was cancelled before it began");
            return Err(ssh::CANCELLED.into());
        }
        let (machine, _) = admitted?;
        // The yes is used up: adding it again, or another address, asks.
        self.admitted.forget(machine.target.as_str());
        let id = id.to_string();
        {
            let mut rows = self.rows();
            if rows.contains_key(&id) {
                return Err("Another machine was added with that name meanwhile.".into());
            }
            let trusted = self
                .trusted
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(machine.target.as_str());
            rows.insert(
                id.clone(),
                Row::new(
                    Kept {
                        machine: machine.clone(),
                        version: None,
                        system: None,
                        host_key: trusted,
                        last_connected: None,
                    },
                    State::Adding,
                    false,
                    true,
                ),
            );
        }
        self.host.changed();
        let fleet = Arc::clone(self);
        let thread_id = id.clone();
        std::thread::Builder::new()
            .name(format!("adding {}", machine.name))
            .spawn(move || fleet.set_up(&thread_id))
            .map_err(|e| e.to_string())?;
        Ok(id)
    }

    fn say(&self, id: &str, step: Step, state: StepState) -> SetupEvent {
        SetupEvent {
            machine: id.to_string(),
            step,
            state,
            detail: None,
            message: None,
            line: None,
        }
    }

    fn emit(&self, event: SetupEvent) {
        self.host.setup(&event);
    }

    /// A step failed: said, and the machine stands failed.
    fn step_failed(&self, id: &str, step: Step, message: String) {
        if self.cancelled(id) {
            return self.forget_cancelled(id, step);
        }
        self.note(id, LogKind::Error, message.clone());
        self.emit(SetupEvent {
            message: Some(message.clone()),
            ..self.say(id, step, StepState::Failed)
        });
        if let Some(r) = self.rows().get_mut(id) {
            r.busy = false;
        }
        self.set_state(id, State::Failed { message });
    }

    /// One step of setting machine `id` up: ended when the person cancels
    /// adding it, or when it has run [`Timing::step_within`].
    fn step(&self, id: &str) -> ssh::Step {
        let cancel = self
            .rows()
            .get(id)
            .map(|r| Arc::clone(&r.cancel))
            .unwrap_or_default();
        ssh::Step::new(cancel, self.timing.step_within)
    }

    fn pending_adds(&self) -> std::sync::MutexGuard<'_, HashMap<String, bool>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Saves machine `id` as added, unless the person cancelled adding it:
    /// both under one lock with Cancel adding (which refuses one saved), so
    /// neither can slip between the other's look and change. True when
    /// saved; a cancelled one is forgotten.
    fn save_added(&self, id: &str, step: Step, change: impl FnOnce(&mut Row)) -> bool {
        let cancelled = {
            let mut rows = self.rows();
            match rows.get_mut(id) {
                None => return false,
                Some(r) if r.cancel.load(std::sync::atomic::Ordering::SeqCst) => true,
                Some(r) => {
                    change(r);
                    r.saved = true;
                    r.busy = false;
                    false
                }
            }
        };
        if cancelled {
            self.forget_cancelled(id, step);
            return false;
        }
        self.save();
        true
    }

    /// Whether the person cancelled adding machine `id`.
    fn cancelled(&self, id: &str) -> bool {
        self.rows()
            .get(id)
            .is_some_and(|r| r.cancel.load(std::sync::atomic::Ordering::SeqCst))
    }

    /// Adding machine `id` was cancelled at `step`: it goes, as if it had
    /// never been added (what was copied there stays, and adding it again
    /// picks it up).
    fn forget_cancelled(&self, id: &str, step: Step) {
        // Said first, so the card hears why before the machine is gone.
        self.emit(SetupEvent {
            message: Some(ssh::CANCELLED.into()),
            ..self.say(id, step, StepState::Failed)
        });
        let row = self.rows().remove(id);
        if let Some(row) = &row {
            self.admitted.forget(row.kept.machine.target.as_str());
            row.kick.1.notify_all();
        }
        self.drop_link(id);
        tracing::info!(machine = id, "adding a machine was cancelled");
        self.host.changed();
    }

    /// "Cancel adding" (`machine_cancel_add`): stops setting machine `id` up
    /// at once (whatever runs there is ended) and forgets it. Only for one
    /// being added: one added is removed instead.
    pub fn cancel_add(&self, id: &str) -> Result<(), String> {
        let running = {
            let rows = self.rows();
            let Some(r) = rows.get(id) else {
                drop(rows);
                // Not a machine's id: an address being added whose id isn't
                // known yet (the person's yes awaited); adding it stops once
                // they answer.
                if let Some(cancelled) = self.pending_adds().get_mut(id) {
                    *cancelled = true;
                    return Ok(());
                }
                return Err("That machine isn't in Desk any more.".into());
            };
            if r.saved {
                return Err(format!(
                    "{} is added already: remove it instead.",
                    r.kept.machine.name
                ));
            }
            r.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
            r.busy
        };
        if !running {
            // Its setup had stopped already (a step failed): gone now.
            self.forget_cancelled(id, Step::Connect);
        }
        Ok(())
    }

    /// "Retry" on a machine whose engines couldn't be installed while it was
    /// added (`machine_retry_engines`): it is added already, so this installs
    /// Claude Code and Codex there again, saying the step on `machine-setup`
    /// as adding did, within the step's limit, and restarts Desk there once
    /// they are, so its hub finds them.
    pub fn retry_engines(self: &Arc<Self>, id: &str) -> Result<(), String> {
        let machine = {
            let mut rows = self.rows();
            let r = rows
                .get_mut(id)
                .ok_or("That machine isn't in Desk any more.")?;
            if !r.saved {
                return Err(format!("{} isn't added yet.", r.kept.machine.name));
            }
            if r.busy {
                return Err(format!(
                    "{} is busy connecting: try again in a moment.",
                    r.kept.machine.name
                ));
            }
            r.busy = true;
            r.kept.machine.clone()
        };
        let fleet = Arc::clone(self);
        let id = id.to_string();
        let spawn_id = id.clone();
        std::thread::Builder::new()
            .name(format!("engines for {}", machine.name))
            .spawn(move || {
                fleet.emit(fleet.say(&id, Step::Engines, StepState::Running));
                let engines = fleet.step(&id).run(|| {
                    let look = probe::look(&fleet.ssh, &machine)
                        .map_err(|m| Self::missed(&machine, m))?;
                    let engines = setup::engines(&fleet.ssh, &machine)?;
                    if engines.installed {
                        if let Err(m) = setup::restart(
                            &fleet.ssh,
                            &machine,
                            &look.bin(),
                            &fleet.host.person(),
                            look.service,
                        ) {
                            tracing::warn!(machine = %machine.id, problem = %m, "Desk didn't restart after its engines were installed");
                        }
                        if let Some(l) = fleet.machines.get(machine.id.as_str()) {
                            l.forget();
                        }
                    }
                    Ok::<_, String>(engines)
                });
                if let Some(r) = fleet.rows().get_mut(&id) {
                    r.busy = false;
                }
                match engines {
                    Ok(engines) => {
                        fleet.note(&id, LogKind::Ok, engines.detail.clone());
                        fleet.emit(SetupEvent {
                            detail: Some(engines.detail),
                            ..fleet.say(&id, Step::Engines, StepState::Done)
                        });
                    }
                    Err(m) => {
                        fleet.note(&id, LogKind::Error, m.clone());
                        fleet.emit(SetupEvent {
                            message: Some(m),
                            ..fleet.say(&id, Step::Engines, StepState::Failed)
                        });
                    }
                }
                fleet.kick(&id);
            })
            .map_err(|e| {
                // No thread to clear it: cleared here, or the machine would
                // stay busy for good.
                if let Some(r) = self.rows().get_mut(&spawn_id) {
                    r.busy = false;
                }
                e.to_string()
            })?;
        Ok(())
    }

    /// Why a look found nothing, in the person's words.
    fn missed(machine: &Machine, missed: Missed) -> String {
        match missed {
            Missed::Key(hostkey::KeyTrouble::Changed) => format!(
                "{}'s host key isn't the one your Mac knows. Desk won't connect until you've checked why and fixed known_hosts.",
                machine.name
            ),
            Missed::Key(hostkey::KeyTrouble::Unknown) => {
                format!("Your Mac doesn't know {}'s host key yet.", machine.name)
            }
            Missed::Refused => format!(
                "{} turned your SSH key away, or it needs unlocking first (ssh-add).",
                machine.name
            ),
            Missed::Unreachable(m) => m,
        }
    }

    /// Whether Desk's backend can run there; why not.
    fn fits(machine: &Machine, look: &probe::Look) -> Result<Arch, String> {
        let name = &machine.name;
        if look.kernel != "Linux" {
            return Err(format!(
                "Desk runs on Linux machines, and {name} runs {}.",
                look.kernel
            ));
        }
        let arch = Arch::of_uname(&look.arch)
            .ok_or_else(|| format!("Desk has no engine for {} machines yet.", look.arch))?;
        match &look.glibc {
            Some(g) if desk_core::backend::glibc_supported(g) => Ok(arch),
            Some(g) => Err(format!(
                "Desk needs glibc {}.{} or newer, and {name} has {g}.",
                desk_core::backend::MIN_GLIBC.0,
                desk_core::backend::MIN_GLIBC.1
            )),
            None => Err(format!(
                "Desk needs a Linux with glibc, and {name} doesn't say it has one."
            )),
        }
    }

    /// The §4 flow, after the person's yes: look, install, start, connect,
    /// then the engines. Blocking; its own thread.
    /// What the machine's page says about it (free space, linger, its
    /// service, systemd, the account), from a look there.
    fn know_details(&self, id: &str, look: &probe::Look) {
        self.set_now(id, |n| {
            n.details = Some(Details {
                free_kb: look.free_kb,
                linger: look.linger,
                service: look.service,
                systemd: look.systemd,
                user: Some(look.user.clone()),
                linger_line: Some(install::linger_by_hand(&look.user)),
            })
        });
    }

    fn set_up(self: &Arc<Self>, id: &str) {
        let Some(machine) = self.machine(id) else {
            return;
        };
        let name = machine.name.clone();
        self.emit(self.say(id, Step::Connect, StepState::Running));
        self.note(id, LogKind::Info, format!("connecting to {name}"));
        let look = match self.step(id).run(|| probe::look(&self.ssh, &machine)) {
            Ok(l) => l,
            Err(m) => return self.step_failed(id, Step::Connect, Self::missed(&machine, m)),
        };
        self.know_details(id, &look);
        if let Err(m) = Self::fits(&machine, &look) {
            return self.step_failed(id, Step::Connect, m);
        }
        if look.desktop {
            return self.step_failed(id, Step::Connect, probe::DESKTOP.into());
        }
        let system = look.system();
        self.emit(SetupEvent {
            detail: Some(format!(
                "Connected as {} · {} · {}",
                look.user, system.os, system.arch
            )),
            message: look
                .root
                .then(|| "Sessions would run as root there. A user of its own is safer.".into()),
            ..self.say(id, Step::Connect, StepState::Done)
        });
        self.update_kept(id, |k| k.system = Some(system));

        let wanted = match self.host.wanted() {
            Ok(w) => w,
            Err(m) => return self.step_failed(id, Step::Install, m),
        };
        self.emit(SetupEvent {
            detail: Some(format!("Installing Desk {wanted}…")),
            ..self.say(id, Step::Install, StepState::Running)
        });
        let keep = match install::plan(look.installed.as_deref(), &wanted) {
            Plan::Downgrade { from } => {
                let message = format!(
                    "{name} has a newer Desk ({from}) than this one ({wanted}). Update Desk on this Mac, then try again."
                );
                if !self.save_added(id, Step::Install, |r| r.kept.version = Some(from)) {
                    return;
                }
                self.emit(SetupEvent {
                    message: Some(message),
                    ..self.say(id, Step::Install, StepState::Failed)
                });
                self.drop_link(id);
                self.set_state(id, State::Newer);
                self.supervise(id);
                return;
            }
            plan => plan,
        };
        let installed = self.step(id).run(|| {
            let keep = match keep {
                Plan::Nothing => self.keep(&machine, &look),
                _ => self.update(&machine, &look),
            }?;
            let link = self.link(&machine)?;
            let version = self.wait_ready(&link, &wanted)?;
            Ok::<_, String>((keep, link, version))
        });
        let (keep, link, version) = match installed {
            Ok(i) => i,
            Err(m) => return self.step_failed(id, Step::Install, m),
        };
        let line = install::linger_by_hand(&look.user);
        self.emit(match keep {
            Keep::Service => SetupEvent {
                detail: Some(format!(
                    "Desk {version} installed, and set to start when it boots"
                )),
                ..self.say(id, Step::Install, StepState::Done)
            },
            Keep::OnConnect => SetupEvent {
                detail: Some(format!("Desk {version} installed")),
                message: Some(format!(
                    "{name} has no systemd for its users, so Desk starts itself there each time it connects."
                )),
                ..self.say(id, Step::Install, StepState::Done)
            },
            Keep::Blocked => SetupEvent {
                detail: Some(format!(
                    "Desk {version} is installed. To start it when {name} boots, run this there:"
                )),
                message: Some(format!(
                    "Until then Desk starts itself there each time it connects. Turning on linger for {} needs an administrator.",
                    look.user
                )),
                line: Some(line),
                ..self.say(id, Step::Install, StepState::Blocked)
            },
        });
        self.update_kept(id, |k| k.version = Some(version.clone()));

        self.emit(self.say(id, Step::Engines, StepState::Running));
        let engines = self.step(id).run(|| {
            let engines = setup::engines(&self.ssh, &machine)?;
            // The hub finds its engines' programs as it starts: one
            // installed after it started needs it started again.
            if engines.installed {
                let restarted = setup::restart(
                    &self.ssh,
                    &machine,
                    &look.bin(),
                    &self.host.person(),
                    keep == Keep::Service,
                );
                link.forget();
                if let Err(m) = restarted.and_then(|()| self.wait_ready(&link, &wanted).map(drop)) {
                    tracing::warn!(machine = id, problem = %m, "Desk didn't restart after its engines were installed");
                }
            }
            Ok::<_, String>(engines)
        });
        if !self.save_added(id, Step::Engines, |_| {}) {
            return;
        }
        match engines {
            Ok(engines) => self.emit(SetupEvent {
                detail: Some(engines.detail),
                ..self.say(id, Step::Engines, StepState::Done)
            }),
            Err(m) => {
                self.note(id, LogKind::Error, m.clone());
                self.emit(SetupEvent {
                    message: Some(m),
                    ..self.say(id, Step::Engines, StepState::Failed)
                })
            }
        }
        let at = now_ms();
        let reach = self.reach_of(&machine);
        self.set_now(id, |n| {
            n.reason = None;
            n.said = None;
            n.connected_since = Some(at);
            n.reach = reach;
        });
        self.update_kept(id, |k| k.last_connected = Some(at));
        self.note(id, LogKind::Ok, format!("connected · Desk {version}"));
        self.know_key(id, &machine);
        self.set_state(id, State::Ready);
        self.host.changed();
        self.supervise(id);
        if keep == Keep::Blocked {
            self.await_linger(id, &machine, &look, &version);
        }
    }

    /// Waits for linger on a machine that started without it, then moves
    /// Desk there to its service.
    fn await_linger(&self, id: &str, machine: &Machine, look: &probe::Look, version: &str) {
        let until = Instant::now() + self.timing.linger_for;
        while Instant::now() < until {
            std::thread::sleep(self.timing.linger_poll);
            if self.machine(id).is_none() {
                return;
            }
            let Ok(now) = probe::look(&self.ssh, machine) else {
                continue;
            };
            if now.linger != Some(true) {
                continue;
            }
            let bin = look.bin();
            let _ = setup::stop(&self.ssh, machine, &bin);
            if setup::service(&self.ssh, machine, &bin, &self.host.person()).is_ok() {
                self.machines.get(id).inspect(|l| l.forget());
                self.emit(SetupEvent {
                    detail: Some(format!(
                        "Desk {version} installed, and set to start when it boots"
                    )),
                    ..self.say(id, Step::Install, StepState::Done)
                });
                self.kick(id);
            }
            return;
        }
    }

    /// Copies this Desk's backend there and flips to it, then keeps it
    /// running. Blocking.
    fn update(&self, machine: &Machine, look: &probe::Look) -> Result<Keep, String> {
        let id = machine.id.as_str();
        let arch = Self::fits(machine, look)?;
        self.update_step(id, UpdateKey::Download, StepState::Running, None);
        let backend = match self.host.backend(arch) {
            Ok(b) => b,
            Err(m) => {
                self.update_step(id, UpdateKey::Download, StepState::Failed, Some(m.clone()));
                return Err(m);
            }
        };
        self.update_step(
            id,
            UpdateKey::Download,
            StepState::Done,
            Some(format!(
                "Desk {} for Linux {}, {}",
                backend.version,
                look.arch,
                if backend.signed {
                    "signature checked"
                } else {
                    "a development build, its signature not checked"
                }
            )),
        );
        if self.cancelled(id) {
            return Err(UPDATE_CANCELLED.into());
        }
        if !backend.signed {
            tracing::warn!(machine = %machine.id, version = %backend.version, "installing a development backend; its signature isn't checked");
            // Said where the machine is added too, not only in the log.
            self.emit(SetupEvent {
                detail: Some(format!("Installing Desk {}…", backend.version)),
                message: Some(format!(
                    "This is a development build of Desk's engine ({}), whose signature isn't checked.",
                    machine_backend_env()
                )),
                ..self.say(machine.id.as_str(), Step::Install, StepState::Running)
            });
        }
        let bin = look.bin();
        // A helper Desk started itself goes before the flip, so the one
        // started after it is the new version's (a service's restarts by
        // itself).
        if look.installed.is_some() && !look.service {
            let _ = setup::stop(&self.ssh, machine, &bin);
        }
        let mb = |b: u64| ((b as f64) / 1_000_000.0).round() as u64;
        self.update_step(
            id,
            UpdateKey::Copy,
            StepState::Running,
            Some(format!("Copying it to {}…", machine.name)),
        );
        let progress = |sent: u64, total: u64| {
            let said = format!(
                "Copying Desk {} to {}… {} of {} MB",
                backend.version,
                machine.name,
                mb(sent),
                mb(total).max(1)
            );
            let short = format!(
                "Copying it to {}… {} of {} MB",
                machine.name,
                mb(sent),
                mb(total).max(1)
            );
            self.update_step(id, UpdateKey::Copy, StepState::Running, Some(short));
            self.set_now(id, |n| n.progress = Some(said.clone()));
            self.emit(SetupEvent {
                detail: Some(said),
                ..self.say(id, Step::Install, StepState::Running)
            });
        };
        let copied = self.step(id).run(|| {
            setup::copy(
                &self.ssh,
                machine,
                &bin,
                &backend.version,
                &backend.data,
                &progress,
            )
        });
        self.set_now(id, |n| n.progress = None);
        if let Err(m) = copied {
            let m = if self.cancelled(id) {
                UPDATE_CANCELLED.to_string()
            } else {
                m
            };
            self.update_step(id, UpdateKey::Copy, StepState::Failed, Some(m.clone()));
            return Err(m);
        }
        self.update_step(
            id,
            UpdateKey::Copy,
            StepState::Done,
            Some(format!("Copied to {}", machine.name)),
        );
        // From here it can't be cancelled: Desk there restarts in seconds.
        if !self.begin_switch(id) {
            return Err(UPDATE_CANCELLED.into());
        }
        self.host.changed();
        if let Err(m) = self
            .step_uncancellable()
            .run(|| setup::flip(&self.ssh, machine, &bin, &backend.version))
        {
            self.update_step(id, UpdateKey::Switch, StepState::Failed, Some(m.clone()));
            return Err(m);
        }
        self.update_step(id, UpdateKey::Switch, StepState::Done, None);
        if let Some(l) = self.machines.get(machine.id.as_str()) {
            l.forget();
        }
        tracing::info!(machine = %machine.id, version = %backend.version, "installed Desk on a machine");
        self.keep(machine, look)
    }

    /// Keeps Desk Helper running there: its service where linger is on (or
    /// the account may turn it on), else started by Desk. Blocking.
    fn keep(&self, machine: &Machine, look: &probe::Look) -> Result<Keep, String> {
        let bin = look.bin();
        let person = self.host.person();
        if !look.systemd {
            setup::start(&self.ssh, machine, &bin, &person)?;
            return Ok(Keep::OnConnect);
        }
        if look.service || look.linger == Some(true) || setup::linger(&self.ssh, machine)? {
            if !look.service {
                let _ = setup::stop(&self.ssh, machine, &bin);
            }
            setup::service(&self.ssh, machine, &bin, &person)?;
            return Ok(Keep::Service);
        }
        setup::start(&self.ssh, machine, &bin, &person)?;
        Ok(Keep::Blocked)
    }

    /// Waits until the machine's helper says where its hub is, with a
    /// device token, the helper running there is `wanted`'s, and its hub
    /// answers through the forward (a helper that handed over has its
    /// token already, and its hub a moment later):
    /// `connection --json` says the version installed, while for a few
    /// seconds after a flip the helper it names is still the one before,
    /// handing over. The version it runs. Blocking.
    fn wait_ready(&self, link: &Link, wanted: &str) -> Result<String, String> {
        let until = Instant::now() + self.timing.ready_within;
        let mut last = None;
        loop {
            if let Some(why) = ssh::Step::current().and_then(|s| s.ended()) {
                return Err(why.to_string());
            }
            match link.read() {
                Ok(Some(c)) if c.device_token.is_some() => {
                    match setup::running(&self.ssh, link.machine()) {
                        Ok(Some(v)) if v == wanted && answers(link, &c.admin_token) => {
                            return Ok(v);
                        }
                        Ok(_) => {}
                        Err(e) => last = Some(e),
                    }
                }
                Ok(_) => {}
                Err(e) => last = Some(e),
            }
            if Instant::now() >= until {
                return Err(last.unwrap_or_else(|| {
                    format!("Desk didn't start on {} in time.", link.machine().name)
                }));
            }
            std::thread::sleep(self.timing.poll);
        }
    }

    // ── Connecting ──────────────────────────────────────────────────────

    /// Connects to machine `id` as it is now: upgrades it when it is on an
    /// older Desk, refuses to drive it when it is on a newer one, starts
    /// Desk there when it isn't running. Whether it went as far as it
    /// should (ready, or newer). Blocking.
    pub fn connect(&self, id: &str) -> bool {
        let machine = {
            let mut rows = self.rows();
            let Some(r) = rows.get_mut(id) else {
                return true;
            };
            if r.busy {
                return true;
            }
            r.busy = true;
            // A cancel was for the update it stopped, not this connect.
            r.cancel.store(false, std::sync::atomic::Ordering::SeqCst);
            r.kept.machine.clone()
        };
        let was_ready = matches!(self.state(id), Some(State::Ready));
        let state = self.connect_now(&machine);
        if let Some(r) = self.rows().get_mut(id) {
            r.busy = false;
        }
        let ok = matches!(
            state,
            State::Ready | State::Newer | State::UpdateFailed { .. }
        );
        match &state {
            State::Ready => {
                let at = now_ms();
                self.set_now(id, |n| {
                    n.reason = None;
                    n.said = None;
                    n.next_try = None;
                    if !was_ready || n.connected_since.is_none() {
                        n.connected_since = Some(at);
                    }
                });
                self.update_kept(id, |k| k.last_connected = Some(at));
                let version = self
                    .rows()
                    .get(id)
                    .and_then(|r| r.kept.version.clone())
                    .unwrap_or_default();
                self.note(id, LogKind::Ok, format!("connected · Desk {version}"));
                self.know_key(id, &machine);
            }
            State::Newer => self.note(id, LogKind::Warn, "it runs a newer Desk: driven no further"),
            State::Failed { message } => {
                let message = message.clone();
                self.set_now(id, |n| {
                    n.reason = Some(message);
                    n.connected_since = None;
                });
            }
            State::Unreachable => self.set_now(id, |n| n.connected_since = None),
            _ => {}
        }
        self.set_state(id, state);
        ok
    }

    /// Keeps the host key machine `id` shows, when Desk doesn't know it
    /// yet: what makes another address the same machine.
    fn know_key(&self, id: &str, machine: &Machine) {
        if self
            .rows()
            .get(id)
            .is_some_and(|r| r.kept.host_key.is_some())
        {
            return;
        }
        // All of it within one limit: it can run before the person is asked
        // anything (checking another address), and never waits for good.
        let ssh = self.ssh.until(Instant::now() + self.timing.edit_within);
        let Ok((key, _)) = hostkey::capture(&ssh, machine) else {
            return;
        };
        // Kept only once it is one the person's known_hosts already has for
        // it: what answered a capture (which trusts nothing) isn't proof
        // of anything by itself.
        let files = match ssh.output(&machine.settings()) {
            Ok(out) if out.status.success() => {
                Files::parse(&String::from_utf8_lossy(&out.stdout), &self.home)
            }
            _ => return,
        };
        if !hostkey::known_fingerprints(&files).contains(&key.fingerprint) {
            self.note(
                id,
                LogKind::Warn,
                format!(
                    "the host key it showed ({}) isn't in your known_hosts for it: not kept",
                    key.fingerprint
                ),
            );
            return;
        }
        self.update_kept(id, |k| {
            k.host_key.get_or_insert(KeptKey {
                kind: key.kind(),
                fingerprint: key.fingerprint,
                trusted_at: None,
            });
        });
    }

    /// How Desk reaches `machine` now, as the person's ssh config says.
    fn reach_of(&self, machine: &Machine) -> Option<Reach> {
        let said = self.settings_said(machine).ok()?;
        let settings = ssh::Settings::parse(&said);
        let files = Files::parse(&said, &self.home);
        let entry = suggest::hosts(&self.home)
            .into_iter()
            .find(|e| e.host == machine.target.as_str());
        Some(Reach {
            user: settings.user,
            hostname: settings.hostname,
            port: settings.port,
            via: settings.via.map(|v| {
                if v.contains(' ') {
                    "a ProxyCommand".to_string()
                } else {
                    v
                }
            }),
            file: entry.as_ref().map(|e| e.file.clone()),
            entry: entry.map(|e| e.host),
            forget_key: hostkey::forget_line(&files, &self.home),
        })
    }

    fn connect_now(&self, machine: &Machine) -> State {
        let id = machine.id.as_str();
        if !matches!(self.state(id), Some(State::Ready)) {
            self.set_state(id, State::Connecting);
        }
        let reach = self.reach_of(machine);
        let through = reach
            .as_ref()
            .and_then(|r| r.via.clone())
            .map(|v| format!(" through {v}"))
            .unwrap_or_default();
        self.note(
            id,
            LogKind::Info,
            format!("connecting to {}{through}", machine.name),
        );
        self.set_now(id, |n| {
            n.last_try = Some(now_ms());
            n.next_try = None;
            if reach.is_some() {
                n.reach = reach;
            }
        });
        let (look, said) = probe::look_said(&self.ssh, machine);
        let look = match look {
            Ok(l) => l,
            Err(Missed::Unreachable(m)) => {
                tracing::info!(machine = id, problem = %m, "machine unreachable");
                self.note(
                    id,
                    LogKind::Error,
                    said.clone().unwrap_or_else(|| m.clone()),
                );
                self.set_now(id, |n| {
                    n.reason = Some(m);
                    n.said = said;
                });
                return State::Unreachable;
            }
            Err(m) => {
                // Its key changed: the key it shows now, beside the one kept.
                let shown = matches!(m, Missed::Key(hostkey::KeyTrouble::Changed))
                    .then(|| hostkey::capture(&self.ssh, machine).ok())
                    .flatten()
                    .map(|(k, _)| KeptKey {
                        kind: k.kind(),
                        fingerprint: k.fingerprint,
                        trusted_at: None,
                    });
                let message = Self::missed(machine, m);
                self.note(
                    id,
                    LogKind::Error,
                    said.clone().unwrap_or_else(|| message.clone()),
                );
                self.set_now(id, |n| {
                    n.said = said;
                    n.shown_key = shown;
                });
                return State::Failed { message };
            }
        };
        self.set_now(id, |n| n.shown_key = None);
        self.know_details(id, &look);
        // Never over desktop Desk, installed there since.
        if look.desktop {
            return State::Failed {
                message: probe::DESKTOP.into(),
            };
        }
        let system = look.system();
        if self.rows().get(id).and_then(|r| r.kept.system.clone()) != Some(system.clone()) {
            self.update_kept(id, |k| k.system = Some(system));
        }
        let wanted = match self.host.wanted() {
            Ok(w) => w,
            Err(message) => return State::Failed { message },
        };
        let link = match self.link(machine) {
            Ok(l) => l,
            Err(message) => return State::Failed { message },
        };
        let kept = match install::plan(look.installed.as_deref(), &wanted) {
            Plan::Downgrade { from } => {
                tracing::info!(machine = id, %from, %wanted, "machine on a newer Desk");
                self.update_kept(id, |k| k.version = Some(from));
                self.drop_link(id);
                return State::Newer;
            }
            Plan::Install | Plan::Upgrade { .. } => {
                let from = look.installed.clone();
                self.set_now(id, |n| n.update = Some(UpdateRun::new(&wanted, from)));
                self.note(
                    id,
                    LogKind::Info,
                    format!("updating Desk there to {wanted}"),
                );
                self.set_state(id, State::Updating);
                match self.update(machine, &look) {
                    Ok(k) => {
                        self.update_step(id, UpdateKey::Reconnect, StepState::Running, None);
                        Ok(k)
                    }
                    Err(message) => {
                        self.note(id, LogKind::Error, message.clone());
                        let from = look.installed.clone();
                        let message = if message == UPDATE_CANCELLED {
                            format!(
                                "You cancelled the update: it stays on {} until it matches.",
                                from.as_deref().unwrap_or("its version")
                            )
                        } else {
                            message
                        };
                        return State::UpdateFailed { message, from };
                    }
                }
            }
            Plan::Nothing => {
                let running = matches!(link.read(), Ok(Some(_)));
                let move_to_service = !look.service && look.systemd && look.linger == Some(true);
                if running && !move_to_service {
                    Ok(Keep::Service)
                } else if look.service {
                    setup::start_service(&self.ssh, machine).map(|()| Keep::Service)
                } else {
                    self.keep(machine, &look)
                }
            }
        };
        if let Err(message) = kept {
            return State::Failed { message };
        }
        let updating = self.update_running(id) == Some(UpdateKey::Reconnect);
        let step = if updating {
            self.step_uncancellable()
        } else {
            self.step(id)
        };
        match step.run(|| self.wait_ready(&link, &wanted)) {
            Ok(version) => {
                if updating {
                    self.note(id, LogKind::Ok, format!("updated to Desk {version}"));
                    self.set_now(id, |n| n.update = None);
                }
                if self.rows().get(id).and_then(|r| r.kept.version.clone()) != Some(version.clone())
                {
                    self.update_kept(id, |k| k.version = Some(version));
                }
                State::Ready
            }
            Err(message) if updating => {
                self.update_step(
                    id,
                    UpdateKey::Reconnect,
                    StepState::Failed,
                    Some(message.clone()),
                );
                State::UpdateFailed {
                    message,
                    from: self.rows().get(id).and_then(|r| r.kept.version.clone()),
                }
            }
            Err(message) => State::Failed { message },
        }
    }

    /// "Try again": connects to machine `id` now, rather than at the next
    /// back-off; one whose adding failed is set up again from the start.
    pub fn reconnect(self: &Arc<Self>, id: &str) -> Result<(), String> {
        let again = {
            let mut rows = self.rows();
            let Some(r) = rows.get_mut(id) else {
                return Err("That machine isn't in Desk any more.".into());
            };
            let again = !r.saved && !r.busy && matches!(r.state, State::Failed { .. });
            if again {
                r.busy = true;
                r.state = State::Adding;
                r.cancel.store(false, std::sync::atomic::Ordering::SeqCst);
            }
            again
        };
        if !again {
            self.kick(id);
            return Ok(());
        }
        self.host.changed();
        let fleet = Arc::clone(self);
        let id = id.to_string();
        std::thread::Builder::new()
            .name(format!("adding {id} again"))
            .spawn(move || fleet.set_up(&id))
            .map(drop)
            .map_err(|e| e.to_string())
    }

    fn kick(&self, id: &str) {
        let kick = match self.rows().get(id) {
            Some(r) => Arc::clone(&r.kick),
            None => return,
        };
        *kick.0.lock().unwrap_or_else(|e| e.into_inner()) = true;
        kick.1.notify_all();
    }

    /// Waits for a kick, or `wait`; whether it was kicked.
    fn wait_kick(&self, id: &str, wait: Option<Duration>) -> bool {
        let kick = match self.rows().get(id) {
            Some(r) => Arc::clone(&r.kick),
            None => return false,
        };
        let mut kicked = kick.0.lock().unwrap_or_else(|e| e.into_inner());
        let until = wait.map(|w| Instant::now() + w);
        while !*kicked {
            match until {
                Some(u) => {
                    let left = u.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        break;
                    }
                    kicked = kick
                        .1
                        .wait_timeout(kicked, left)
                        .unwrap_or_else(|e| e.into_inner())
                        .0;
                }
                None => {
                    kicked = kick.1.wait(kicked).unwrap_or_else(|e| e.into_inner());
                }
            }
            if self.machine(id).is_none() {
                return false;
            }
        }
        std::mem::replace(&mut *kicked, false)
    }

    /// Keeps machine `id` connected on a thread of its own, until it is
    /// removed: connects (with back-off while it can't), watches the
    /// forward of a ready one, and waits for "Try again" on one on a newer
    /// Desk.
    fn supervise(self: &Arc<Self>, id: &str) {
        let fleet = Arc::clone(self);
        let id = id.to_string();
        let _ = std::thread::Builder::new()
            .name(format!("machine {id}"))
            .spawn(move || {
                let mut backoff = fleet.timing.first_backoff;
                let mut misses = 0;
                loop {
                    let Some(state) = fleet.state(&id) else {
                        return;
                    };
                    // Held (an uninstall stopped partway): only Reconnect
                    // drives it again.
                    if fleet.rows().get(&id).is_some_and(|r| r.hold) {
                        let asked = fleet.wait_kick(&id, None);
                        if let Some(r) = fleet.rows().get_mut(&id) {
                            r.hold = !asked;
                        }
                        if !asked {
                            continue;
                        }
                    }
                    let connect = match state {
                        State::Ready => {
                            if fleet.wait_kick(&id, Some(fleet.timing.check_every)) {
                                true
                            } else if !fleet.rows().get(&id).is_some_and(|r| r.busy)
                                && fleet.machines.get(&id).is_some_and(|l| l.ready().is_none())
                            {
                                misses += 1;
                                if misses >= 3 {
                                    let name =
                                        fleet.machine(&id).map(|m| m.name).unwrap_or_default();
                                    let secs = (fleet.timing.check_every * 3).as_secs().max(1);
                                    fleet.note(
                                        &id,
                                        LogKind::Warn,
                                        format!("link dropped: no answer for {secs} s"),
                                    );
                                    fleet.set_now(&id, |n| {
                                        n.reason = Some(format!(
                                            "Desk lost its link to {name}: no answer for {secs} s."
                                        ));
                                        n.said = None;
                                        n.connected_since = None;
                                    });
                                    fleet.set_state(&id, State::Unreachable);
                                }
                                misses >= 3
                            } else {
                                misses = 0;
                                false
                            }
                        }
                        // Driven no further until asked: Update to match.
                        State::Newer | State::UpdateFailed { .. } => fleet.wait_kick(&id, None),
                        State::Adding => {
                            fleet.wait_kick(&id, Some(fleet.timing.poll));
                            false
                        }
                        _ => true,
                    };
                    if fleet.state(&id).is_none() {
                        return;
                    }
                    if !connect {
                        continue;
                    }
                    misses = 0;
                    if fleet.connect(&id) {
                        backoff = fleet.timing.first_backoff;
                    } else {
                        let next = now_ms() + backoff.as_millis() as i64;
                        fleet.note(
                            &id,
                            LogKind::Info,
                            format!("next try in {} s", backoff.as_secs().max(1)),
                        );
                        fleet.set_now(&id, |n| n.next_try = Some(next));
                        if fleet.wait_kick(&id, Some(backoff)) {
                            fleet.note(&id, LogKind::Info, "reconnecting now, as asked");
                        }
                        backoff = (backoff * 2).min(fleet.timing.max_backoff);
                    }
                }
            });
    }

    // ── Reading and changing it ─────────────────────────────────────────

    /// The `Host` entries in the person's SSH config, read as text.
    pub fn ssh_hosts(&self) -> Vec<suggest::HostEntry> {
        suggest::hosts(&self.home)
    }

    /// The last `lines` of Desk's own log on machine `id` (its service's,
    /// from `journalctl --user`), read over SSH with Desk's fixed options;
    /// each line cleaned to plain text. Gives up after `within`. Blocking.
    pub fn remote_log(&self, id: &str, within: Duration) -> Result<String, String> {
        let machine = self
            .machine(id)
            .ok_or("That machine isn't in Desk any more.")?;
        let words: Vec<String> = [
            "journalctl",
            "--user",
            "-u",
            desk_core::systemd::UNIT,
            "-n",
            "200",
            "--no-pager",
            "-o",
            "short-iso",
        ]
        .iter()
        .map(|w| w.to_string())
        .collect();
        let out = self
            .ssh
            .output_within(&machine.command(&words), within)
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::TimedOut {
                    format!(
                        "{} didn't answer within {} s.",
                        machine.name,
                        within.as_secs()
                    )
                } else {
                    format!("Desk couldn't run ssh: {e}")
                }
            })?;
        if out.status.code() == Some(ssh::SSH_FAILED) {
            return Err(ssh::problem(&machine, &out.stderr));
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let lines: Vec<String> = text
            .lines()
            .map(|l| {
                l.chars()
                    .map(|c| if c == '\t' { ' ' } else { c })
                    .filter(|c| !c.is_control() && !desk_core::machine::is_format(*c))
                    .take(400)
                    .collect::<String>()
            })
            .collect();
        if lines.iter().all(|l| l.trim().is_empty()) {
            return Ok(format!(
                "{} has no log from Desk's service yet{}.",
                machine.name,
                if out.status.success() {
                    ""
                } else {
                    " (journalctl couldn't read it)"
                }
            ));
        }
        Ok(lines.join("\n"))
    }

    /// Checks that `target` reaches machine `id` (`machine_check_reach`):
    /// the person is asked natively first (nothing runs for the address
    /// before), then the key it shows is read, within one limit, and
    /// compared with the machine's own, checked against the person's
    /// known_hosts. The same key stands for a switch for a few minutes.
    /// Blocking.
    pub fn check_reach(self: &Arc<Self>, id: &str, target: &str) -> Result<Checked, String> {
        let machine = self
            .machine(id)
            .ok_or("That machine isn't in Desk any more.")?;
        let t = Target::new(target.trim()).map_err(|e| e.to_string())?;
        if t == machine.target {
            return Err(format!("{t} is how Desk reaches {} now.", machine.name));
        }
        if let Some((_, other)) = self
            .rows()
            .iter()
            .find(|(other, r)| *other != id && r.kept.machine.target == t)
        {
            return Err(format!(
                "{t} is how Desk reaches {} already.",
                other.kept.machine.name
            ));
        }
        // Only a key checked against the person's known_hosts says what
        // the machine is: none on record, nothing moves.
        if self
            .rows()
            .get(id)
            .is_some_and(|r| r.kept.host_key.is_none())
        {
            self.know_key(id, &machine);
        }
        let known = self
            .rows()
            .get(id)
            .and_then(|r| r.kept.host_key.clone())
            .ok_or_else(|| {
                format!(
                    "Desk has no host key for {name} checked against your known_hosts yet, so it can't tell another address is the same machine. Reconnect {name}, then try again.",
                    name = machine.name
                )
            })?;
        let question = SwitchQuestion {
            name: machine.name.clone(),
            from: machine.target.to_string(),
            to: t.to_string(),
            kind: known.kind.clone(),
            fingerprint: known.fingerprint.clone(),
        };
        let confirm = &self.trust;
        if !self.trust_gate.ask(|| confirm.switch_to(&question))? {
            return Ok(Checked::Cancelled);
        }
        let moved = Machine {
            target: t.clone(),
            ..machine.clone()
        };
        // Only now does anything run for the new address, all of it within
        // one limit.
        let started = Instant::now();
        let within = self.timing.edit_within;
        let ssh = self.ssh.until(started + within);
        let out = ssh
            .output(&moved.settings())
            .map_err(|e| ssh_ran_out(&moved, &e, within))?;
        if !out.status.success() {
            return Err(ssh::problem(&moved, &out.stderr));
        }
        let said = String::from_utf8_lossy(&out.stdout).into_owned();
        ssh::no_forwards(&moved, &ssh::Settings::parse(&said))?;
        let files = Files::parse(&said, &self.home);
        let (shown, line) = hostkey::capture(&ssh, &moved)?;
        let shown = KeptKey {
            kind: shown.kind(),
            fingerprint: shown.fingerprint,
            trusted_at: None,
        };
        if shown.fingerprint != known.fingerprint {
            self.note(
                id,
                LogKind::Warn,
                format!(
                    "{t} shows another host key ({}): not moved there",
                    shown.fingerprint
                ),
            );
            return Ok(Checked::DifferentKey { shown, known });
        }
        self.checked
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                id.to_string(),
                CheckedAt {
                    target: t,
                    line,
                    files,
                    at: Instant::now(),
                },
            );
        Ok(Checked::Same {
            key: known,
            took_ms: started.elapsed().as_millis() as u64,
        })
    }

    /// Changes machine `id`'s name, how it is reached (`target`), or both
    /// (`machine_edit`). A new address must show the machine's own host
    /// key: the person is asked natively first (nothing runs there before),
    /// then the key it shows is read and compared; another key is refused
    /// and nothing changes. Blocking.
    pub fn edit(
        self: &Arc<Self>,
        id: &str,
        target: Option<&str>,
        name: Option<&str>,
    ) -> Result<Edited, String> {
        let machine = self
            .machine(id)
            .ok_or("That machine isn't in Desk any more.")?;
        let name = name.map(str::trim).filter(|n| *n != machine.name);
        if let Some(n) = name {
            if n.is_empty() || n.chars().count() > 60 {
                return Err("Give it a name of up to 60 letters.".into());
            }
            // Shown as it says, as adding's names are: nothing that could
            // make it read as something else (no zero-width or bidi marks).
            if !desk_core::machine::plain(n) {
                return Err(
                    "A machine's name can only have letters, numbers, spaces and punctuation."
                        .into(),
                );
            }
            if self
                .rows()
                .iter()
                .any(|(other, r)| other != id && r.kept.machine.name.eq_ignore_ascii_case(n))
            {
                return Err(format!(
                    "Another machine is called {n} already. Two machines can't share a name."
                ));
            }
        }
        let target = match target
            .map(str::trim)
            .filter(|t| *t != machine.target.as_str())
        {
            Some(t) => Some(Target::new(t).map_err(|e| e.to_string())?),
            None => None,
        };
        if let Some(t) = &target
            && let Some((_, other)) = self
                .rows()
                .iter()
                .find(|(other, r)| *other != id && r.kept.machine.target == *t)
        {
            return Err(format!(
                "{t} is how Desk reaches {} already.",
                other.kept.machine.name
            ));
        }
        if let Some(t) = target {
            let moved = Machine {
                target: t.clone(),
                ..machine.clone()
            };
            // Checked a moment ago (`check_reach`), or checked now.
            let fresh = {
                let mut checked = self.checked.lock().unwrap_or_else(|e| e.into_inner());
                match checked.remove(id) {
                    Some(c) if c.target == t && c.at.elapsed() < CHECK_STANDS => Some(c),
                    _ => None,
                }
            };
            let at = match fresh {
                Some(c) => c,
                None => match self.check_reach(id, t.as_str())? {
                    Checked::Same { .. } => self
                        .checked
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(id)
                        .ok_or("Desk lost track of that check. Try again.")?,
                    Checked::Cancelled => return Ok(Edited::Cancelled),
                    Checked::DifferentKey { shown, known } => {
                        return Ok(Edited::DifferentKey { shown, known });
                    }
                },
            };
            let within = self.timing.edit_within;
            let ssh = self.ssh.until(Instant::now() + within);
            match hostkey::trouble(&ssh, &moved)? {
                None => {}
                Some(hostkey::KeyTrouble::Unknown) => hostkey::learn(&at.files, &at.line)?,
                Some(hostkey::KeyTrouble::Changed) => {
                    return Err(format!(
                        "Your known_hosts has another key for {t}. Desk won't change it: remove that line (ssh-keygen -R), then try again."
                    ));
                }
            }
            self.update_kept(id, |k| k.machine.target = t.clone());
            self.note(
                id,
                LogKind::Info,
                format!("now reached at {t}, the same host key"),
            );
            tracing::info!(machine = id, target = %t, "machine reached at another address");
            // Its link and forward are made again, to the new address.
            self.drop_link(id);
            self.set_now(id, |n| n.reach = None);
            self.set_state(id, State::Connecting);
            self.kick(id);
        }
        if let Some(n) = name {
            let n = n.to_string();
            self.update_kept(id, |k| k.machine.name = n.clone());
            self.note(id, LogKind::Info, format!("named {n}"));
        }
        Ok(Edited::Done)
    }

    // ── Removing ────────────────────────────────────────────────────────

    /// Forgets machine `id` on this computer (`machine_remove`): its link,
    /// forward and broker end now. Desk stays installed and running there.
    pub fn remove(&self, id: &str) -> Result<(), String> {
        let row = self.rows().remove(id);
        let Some(row) = row else {
            return Err("That machine isn't in Desk any more.".into());
        };
        row.kick.1.notify_all();
        // Adding it back asks again.
        self.admitted.forget(row.kept.machine.target.as_str());
        if row.saved {
            self.save();
        }
        self.drop_link(id);
        self.host.changed();
        Ok(())
    }

    /// Removes machine `id` and uninstalls Desk from it first
    /// (`machine_uninstall`), saying each step on `machine-remove`: its
    /// service stopped and its unit gone, everything Desk keeps there
    /// removed (`--remove-everything`), linger off, then forgotten here.
    /// Each step stops after [`Timing::step_within`]. A step that fails
    /// says why and nothing is forgotten: Try again, or remove it without
    /// uninstalling. Only a machine's own install is ever touched. Blocking.
    pub fn uninstall(&self, id: &str) -> Result<bool, String> {
        let machine = self
            .machine(id)
            .ok_or("That machine isn't in Desk any more.")?;
        let name = machine.name.clone();
        if !matches!(
            self.state(id),
            Some(State::Ready | State::UpdateFailed { .. } | State::Newer | State::Failed { .. })
        ) {
            return Err(format!(
                "Desk can't reach {name} right now, so it can only forget it here."
            ));
        }
        // Asked natively first, naming the machine and its address, Cancel
        // the default: nothing runs there before a yes.
        let question = UninstallQuestion {
            name: name.clone(),
            target: machine.target.to_string(),
        };
        let confirm = &self.trust;
        if !self.trust_gate.ask(|| confirm.uninstall(&question))? {
            return Ok(false);
        }
        let say =
            |step: RemoveStep, state: StepState, message: Option<String>, line: Option<String>| {
                self.host.removing(&RemoveEvent {
                    machine: id.to_string(),
                    step,
                    state,
                    message,
                    line,
                });
            };
        // Each step whole, within its limit: Cancel takes effect between
        // steps, never halfway through one.
        let run = |step: RemoveStep, script: &str, what: &str| -> Result<(), String> {
            say(step, StepState::Running, None, None);
            let done = self
                .step_uncancellable()
                .run(|| setup::run(&self.ssh, &machine, script, what));
            match done {
                Ok(_) => {
                    say(step, StepState::Done, None, None);
                    Ok(())
                }
                Err(m) => {
                    say(step, StepState::Failed, Some(m.clone()), None);
                    self.note(id, LogKind::Error, m.clone());
                    Err(m)
                }
            }
        };
        // Nothing connects to it (and so starts Desk there again) while it
        // goes: its supervisor waits on `busy` until this is done.
        // A connect under way finishes first (it can take a step's length).
        let until = Instant::now() + self.timing.step_within;
        loop {
            {
                let mut rows = self.rows();
                let Some(r) = rows.get_mut(id) else {
                    return Err("That machine isn't in Desk any more.".into());
                };
                if !r.busy {
                    r.busy = true;
                    r.removing = true;
                    r.cancel.store(false, std::sync::atomic::Ordering::SeqCst);
                    break;
                }
            }
            if Instant::now() >= until {
                return Err(format!("{name} is busy connecting: try again in a moment."));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        struct Held<'a>(&'a Fleet, &'a str);
        impl Drop for Held<'_> {
            fn drop(&mut self) {
                if let Some(r) = self.0.rows().get_mut(self.1) {
                    r.busy = false;
                    r.removing = false;
                    r.cancel.store(false, std::sync::atomic::Ordering::SeqCst);
                }
            }
        }
        let held = Held(self, id);
        self.note(id, LogKind::Info, format!("uninstalling Desk from {name}"));
        // The link goes first: nothing of Desk's talks to it while it goes.
        self.drop_link(id);
        let stopped = run(
            RemoveStep::Stop,
            &setup::uninstall_stop_script(),
            &format!("Couldn't stop Desk's service on {name}"),
        );
        if let Err(m) = stopped {
            // Nothing was removed: connecting again starts Desk there again.
            drop(held);
            self.kick(id);
            return Err(m);
        }
        if self.cancelled(id) {
            // Cancelled before anything was removed: Desk there starts again.
            self.note(
                id,
                LogKind::Info,
                "uninstalling was cancelled; nothing was removed",
            );
            drop(held);
            self.kick(id);
            return Ok(false);
        }
        let removed = run(
            RemoveStep::Remove,
            &setup::uninstall_remove_script(),
            "Couldn't remove ~/.local/share/Desk",
        )
        .and_then(|()| {
            // Checked, not assumed: the folder (and the sign-ins in it) is gone.
            setup::run(
                &self.ssh,
                &machine,
                &setup::uninstall_gone_script(),
                "Desk couldn't check ~/.local/share/Desk is gone",
            )
            .map(drop)
            .inspect_err(|m| {
                say(RemoveStep::Remove, StepState::Failed, Some(m.clone()), None);
            })
        });
        if let Err(m) = removed {
            // Partway: Desk there is stopped and perhaps half gone. A connect
            // would install it again, so it is held until the person says.
            let message = format!(
                "Uninstalling stopped partway: Desk on {name} is stopped, and ~/.local/share/Desk may be partly gone. Try again, or remove it without uninstalling."
            );
            if let Some(r) = self.rows().get_mut(id) {
                r.hold = true;
            }
            drop(held);
            self.set_state(id, State::Failed { message });
            return Err(m);
        }
        // Linger turned off where the account may; else the line to run.
        say(RemoveStep::Linger, StepState::Running, None, None);
        match self.step_uncancellable().run(|| {
            setup::run(
                &self.ssh,
                &machine,
                setup::UNINSTALL_LINGER_SCRIPT,
                "linger",
            )
        }) {
            Ok(_) => say(RemoveStep::Linger, StepState::Done, None, None),
            Err(_) => {
                // The account's name as checked when it was read (a POSIX
                // name), and quoted all the same.
                let user = self
                    .rows()
                    .get(id)
                    .and_then(|r| r.now.details.as_ref().and_then(|d| d.user.clone()))
                    .filter(|u| probe::valid_user(u));
                say(
                    RemoveStep::Linger,
                    StepState::Blocked,
                    Some(format!(
                        "Linger stays on for {}: turning it off needs an administrator there.",
                        user.as_deref().unwrap_or("that account")
                    )),
                    Some(format!(
                        "sudo loginctl disable-linger {}",
                        user.as_deref()
                            .map(desk_core::machine::quote)
                            .unwrap_or_else(|| "\"$USER\"".into())
                    )),
                );
            }
        }
        say(RemoveStep::Forget, StepState::Running, None, None);
        drop(held);
        self.remove(id)?;
        say(RemoveStep::Forget, StepState::Done, None, None);
        tracing::info!(
            machine = id,
            "uninstalled Desk from a machine and forgot it"
        );
        Ok(true)
    }

    /// "Cancel" while Desk is being uninstalled from machine `id`
    /// (`machine_cancel_uninstall`): it stops before removing anything, when
    /// the step running now is stopping Desk's service; once it removes,
    /// it goes on to the end.
    pub fn cancel_uninstall(&self, id: &str) -> Result<(), String> {
        let rows = self.rows();
        let r = rows.get(id).ok_or("That machine isn't in Desk any more.")?;
        if !r.removing {
            return Err(format!(
                "{} isn't being uninstalled now.",
                r.kept.machine.name
            ));
        }
        r.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }

    /// Stops connecting to every machine (the app is quitting), keeping
    /// `machines.json` as it is.
    pub fn shutdown(&self) {
        let rows = std::mem::take(&mut *self.rows());
        let mut links = Vec::new();
        for (id, row) in rows {
            row.kick.1.notify_all();
            if let Some(link) = self.machines.get(&id) {
                link.tunnel().stop();
                links.push(link);
            }
            self.machines.remove(&id);
        }
        ended(&links);
    }

    /// Whether the page may drive machine `id` now: not one on a newer Desk.
    pub fn drivable(&self, id: &str) -> bool {
        !matches!(
            self.state(id),
            Some(State::Newer | State::UpdateFailed { .. })
        )
    }

    pub fn home(&self) -> &Path {
        &self.home
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Quiet;

    impl Host for Quiet {
        fn changed(&self) {}
        fn setup(&self, _: &SetupEvent) {}
        fn dropped(&self, _: &str) {}
        fn wanted(&self) -> Result<String, String> {
            Ok("0.2.0".into())
        }
        fn backend(&self, _: Arch) -> Result<Backend, String> {
            Err("none".into())
        }
        fn person(&self) -> Person {
            Person::default()
        }
    }

    struct No;

    impl Confirm for No {
        fn run_on(&self, _: &Question) -> bool {
            false
        }
    }

    impl TrustConfirm for No {
        fn trust_key(&self, _: &hostkey::TrustQuestion) -> bool {
            false
        }
    }

    /// A fleet that reaches nothing, keeping `machines.json` in `dir`.
    fn quiet(dir: &Path) -> Arc<Fleet> {
        let ssh = SshExe::at(dir.join("no-ssh"));
        Fleet::new(
            ssh.clone(),
            Arc::new(Machines::new(ssh, &dir.join("s"))),
            dir.join("machines.json"),
            dir.to_path_buf(),
            Arc::new(Quiet),
            Arc::new(No),
            Arc::new(No),
            Timing::default(),
        )
    }

    fn kept(id: &str) -> Kept {
        Kept {
            machine: Machine {
                id: MachineId::new(id).unwrap(),
                name: id.into(),
                target: Target::new(id).unwrap(),
            },
            version: Some("0.2.0".into()),
            system: None,
            host_key: None,
            last_connected: None,
        }
    }

    fn row(id: &str) -> Row {
        Row::new(kept(id), State::Ready, true, false)
    }

    #[test]
    fn a_removed_machine_is_never_written_back_by_an_older_save() {
        let dir = tempfile::tempdir().unwrap();
        let fleet = quiet(dir.path());
        {
            let mut rows = fleet.rows();
            rows.insert("a".into(), row("a"));
            rows.insert("gone".into(), row("gone"));
        }
        std::thread::scope(|s| {
            // A save (a supervise thread's) takes its snapshot, with "gone"
            // in it, and is held before it writes.
            *fleet.save_pause.lock().unwrap() = Duration::from_millis(300);
            s.spawn(|| fleet.save());
            std::thread::sleep(Duration::from_millis(100));
            *fleet.save_pause.lock().unwrap() = Duration::ZERO;
            // Meanwhile the person removes it.
            fleet.remove("gone").unwrap();
        });
        let said = std::fs::read_to_string(dir.path().join("machines.json")).unwrap();
        let ids: Vec<String> = serde_json::from_str::<Vec<Kept>>(&said)
            .unwrap()
            .into_iter()
            .map(|k| k.machine.id.to_string())
            .collect();
        assert_eq!(ids, ["a"]);
        // No partial file is left behind, and the file is the person's own.
        let left: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("partial"))
            .collect();
        assert!(left.is_empty(), "{left:?}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("machines.json"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn a_machines_file_that_doesnt_read_is_never_written_over() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("machines.json");
        std::fs::write(&file, "[{\"id\": \"devbox\", \"name\": ").unwrap();
        let fleet = quiet(dir.path());
        fleet.load();
        assert!(fleet.list().is_empty());
        fleet.rows().insert("a".into(), row("a"));
        fleet.save();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "[{\"id\": \"devbox\", \"name\": "
        );
        // Nothing is added while it stands, and the person is told why.
        let refused = fleet.add("devbox", "devbox").unwrap_err();
        assert!(refused.contains("machines.json"), "{refused}");
    }

    #[test]
    fn removing_a_machine_takes_back_the_yes_to_it() {
        let dir = tempfile::tempdir().unwrap();
        let fleet = quiet(dir.path());
        fleet.admitted.add("devbox");
        fleet.rows().insert("devbox".into(), row("devbox"));
        fleet.remove("devbox").unwrap();
        assert!(!fleet.admitted.has("devbox"));
    }

    #[test]
    fn a_state_reads_as_the_page_reads_it() {
        let as_json = |s: State| serde_json::to_value(s).unwrap();
        for (s, word) in [
            (State::Adding, "adding"),
            (State::Connecting, "connecting"),
            (State::Ready, "ready"),
            (State::Unreachable, "unreachable"),
            (State::Updating, "updating"),
            (State::Newer, "newer"),
        ] {
            assert_eq!(as_json(s), serde_json::json!(word));
        }
        assert_eq!(
            as_json(State::Failed {
                message: "no".into()
            }),
            serde_json::json!({"failed": {"message": "no"}})
        );
        assert_eq!(
            as_json(State::UpdateFailed {
                message: "no room".into(),
                from: Some("0.2.0".into())
            }),
            serde_json::json!({"update_failed": {"message": "no room", "from": "0.2.0"}})
        );
    }

    #[test]
    fn a_row_has_what_the_page_reads() {
        let row = Listed {
            id: "devbox".into(),
            name: "devbox".into(),
            target: "dev@devbox".into(),
            version: Some("0.3.0".into()),
            system: Some(System {
                os: "Ubuntu 24.04".into(),
                arch: "x86_64".into(),
                glibc: Some("2.39".into()),
            }),
            state: State::Unreachable,
            reason: Some("SSH couldn't reach devbox.".into()),
            said: Some("ssh: connect to host 10.0.3.14 port 22: Connection timed out".into()),
            last_connected: Some(1),
            last_try: Some(2),
            next_try: Some(3),
            connected_since: None,
            reach: Some(Reach {
                user: Some("dev".into()),
                hostname: Some("10.0.3.14".into()),
                port: Some("22".into()),
                via: Some("bastion".into()),
                entry: Some("devbox".into()),
                file: Some("~/.ssh/config".into()),
                forget_key: Some("ssh-keygen -R 10.0.3.14".into()),
            }),
            details: None,
            host_key: Some(KeptKey {
                kind: "ED25519".into(),
                fingerprint: "SHA256:k3Vq".into(),
                trusted_at: Some(4),
            }),
            shown_key: Some(KeptKey {
                kind: "ED25519".into(),
                fingerprint: "SHA256:x9Zp".into(),
                trusted_at: None,
            }),
            progress: None,
            update: None,
        };
        assert_eq!(
            serde_json::to_value(row).unwrap(),
            serde_json::json!({
                "id": "devbox", "name": "devbox", "target": "dev@devbox", "version": "0.3.0",
                "system": {"os": "Ubuntu 24.04", "arch": "x86_64", "glibc": "2.39"}, "state": "unreachable",
                "reason": "SSH couldn't reach devbox.", "said": "ssh: connect to host 10.0.3.14 port 22: Connection timed out",
                "lastConnected": 1, "lastTry": 2, "nextTry": 3,
                "reach": {"user": "dev", "hostname": "10.0.3.14", "port": "22", "via": "bastion", "entry": "devbox", "file": "~/.ssh/config", "forgetKey": "ssh-keygen -R 10.0.3.14"},
                "hostKey": {"kind": "ED25519", "fingerprint": "SHA256:k3Vq", "trustedAt": 4},
                "shownKey": {"kind": "ED25519", "fingerprint": "SHA256:x9Zp"}
            })
        );
        let event = SetupEvent {
            machine: "devbox".into(),
            step: Step::Install,
            state: StepState::Blocked,
            detail: None,
            message: None,
            line: Some("sudo loginctl enable-linger 'dev'".into()),
        };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({"machine": "devbox", "step": "install", "state": "blocked", "line": "sudo loginctl enable-linger 'dev'"})
        );
    }

    #[test]
    fn the_kept_machine_is_checked_as_it_is_read() {
        let k: Vec<Kept> = serde_json::from_str(
            r#"[{"id": "devbox", "name": "devbox", "target": "dev@devbox", "version": "0.3.0", "system": {"os": "Ubuntu 24.04", "arch": "x86_64"}}, {"id": "b", "name": "b", "target": "b"}]"#,
        )
        .unwrap();
        assert_eq!(k[0].version.as_deref(), Some("0.3.0"));
        assert_eq!(k[1].system, None);
        assert!(
            serde_json::from_str::<Vec<Kept>>(
                r#"[{"id": "x", "name": "x", "target": "-oProxyCommand=y"}]"#
            )
            .is_err()
        );
    }

    #[test]
    fn an_id_is_made_from_the_name() {
        let none = |_: &str| false;
        assert_eq!(id_for("devbox", &none).as_str(), "devbox");
        assert_eq!(id_for("Build Server #2", &none).as_str(), "build-server-2");
        assert_eq!(id_for("local", &none).as_str(), "machine-local");
        assert_eq!(id_for("€€", &none).as_str(), "machine");
        assert_eq!(id_for("devbox", &|id| id == "devbox").as_str(), "devbox-2");
    }
}
