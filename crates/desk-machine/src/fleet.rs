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

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use desk_core::backend_install::{self as install, Plan};
use desk_core::machine::{Machine, MachineId, Target};
use desk_core::machine_backend::{Arch, Backend};
use serde::{Deserialize, Serialize};

use crate::admit::{self, Confirm, Gate, Question};
use crate::hostkey::{self, Files, TrustConfirm};
use crate::link::{Link, Machines};
use crate::probe::{self, Access, Missed, Probe, System};
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
}

/// A row of `machines_list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Listed {
    pub id: String,
    pub name: String,
    pub target: String,
    pub version: Option<String>,
    pub system: Option<System>,
    pub state: State,
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
}

/// How long things take.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    /// How long Desk waits for a machine's helper to say where its hub is.
    pub ready_within: Duration,
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
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            ready_within: Duration::from_secs(180),
            poll: Duration::from_secs(1),
            check_every: Duration::from_secs(5),
            first_backoff: Duration::from_secs(5),
            max_backoff: Duration::from_secs(300),
            linger_poll: Duration::from_secs(5),
            linger_for: Duration::from_secs(30 * 60),
            admitted_for: Duration::from_secs(15 * 60),
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
    /// How long a save waits between its snapshot and its write: tests
    /// only, to hold one there.
    #[cfg(test)]
    save_pause: Mutex<Duration>,
    /// What the person's ssh settings said about the address looked at
    /// last, for the public key it would sign in with.
    files: Mutex<Option<Files>>,
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
            #[cfg(test)]
            save_pause: Mutex::default(),
            files: Mutex::default(),
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
                    Row {
                        kept: k,
                        state: State::Connecting,
                        saved: true,
                        busy: false,
                        kick: Arc::default(),
                    },
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
            })
            .collect()
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
        hostkey::trust(&self.ssh, &machine, &files, fingerprint, &confirm)
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
        let id = {
            let rows = self.rows();
            id_for(name, &|id| rows.contains_key(id))
        };
        let (machine, _) = admit::admit(&self.gate, &self.ssh, id.clone(), name, target)?;
        // The yes is used up: adding it again, or another address, asks.
        self.admitted.forget(machine.target.as_str());
        let id = id.to_string();
        {
            let mut rows = self.rows();
            if rows.contains_key(&id) {
                return Err("Another machine was added with that name meanwhile.".into());
            }
            rows.insert(
                id.clone(),
                Row {
                    kept: Kept {
                        machine: machine.clone(),
                        version: None,
                        system: None,
                    },
                    state: State::Adding,
                    saved: false,
                    busy: true,
                    kick: Arc::default(),
                },
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
        self.emit(SetupEvent {
            message: Some(message.clone()),
            ..self.say(id, step, StepState::Failed)
        });
        if let Some(r) = self.rows().get_mut(id) {
            r.busy = false;
        }
        self.set_state(id, State::Failed { message });
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
    fn set_up(self: &Arc<Self>, id: &str) {
        let Some(machine) = self.machine(id) else {
            return;
        };
        let name = machine.name.clone();
        self.emit(self.say(id, Step::Connect, StepState::Running));
        let look = match probe::look(&self.ssh, &machine) {
            Ok(l) => l,
            Err(m) => return self.step_failed(id, Step::Connect, Self::missed(&machine, m)),
        };
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
                self.emit(SetupEvent {
                    message: Some(message),
                    ..self.say(id, Step::Install, StepState::Failed)
                });
                if let Some(r) = self.rows().get_mut(id) {
                    r.kept.version = Some(from);
                    r.saved = true;
                    r.busy = false;
                }
                self.save();
                self.drop_link(id);
                self.set_state(id, State::Newer);
                self.supervise(id);
                return;
            }
            Plan::Nothing => self.keep(&machine, &look),
            Plan::Install | Plan::Upgrade { .. } => self.update(&machine, &look),
        };
        let keep = match keep {
            Ok(k) => k,
            Err(m) => return self.step_failed(id, Step::Install, m),
        };
        let link = match self.link(&machine) {
            Ok(l) => l,
            Err(m) => return self.step_failed(id, Step::Install, m),
        };
        let version = match self.wait_ready(&link, &wanted) {
            Ok(v) => v,
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
        match setup::engines(&self.ssh, &machine) {
            Ok(engines) => {
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
                    if let Err(m) =
                        restarted.and_then(|()| self.wait_ready(&link, &wanted).map(drop))
                    {
                        tracing::warn!(machine = id, problem = %m, "Desk didn't restart after its engines were installed");
                    }
                }
                self.emit(SetupEvent {
                    detail: Some(engines.detail),
                    ..self.say(id, Step::Engines, StepState::Done)
                })
            }
            Err(m) => self.emit(SetupEvent {
                message: Some(m),
                ..self.say(id, Step::Engines, StepState::Failed)
            }),
        }
        if let Some(r) = self.rows().get_mut(id) {
            r.saved = true;
            r.busy = false;
        }
        self.save();
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
        let arch = Self::fits(machine, look)?;
        let backend = self.host.backend(arch)?;
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
        setup::copy(&self.ssh, machine, &bin, &backend.version, &backend.data)?;
        setup::flip(&self.ssh, machine, &bin, &backend.version)?;
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
            r.kept.machine.clone()
        };
        let state = self.connect_now(&machine);
        if let Some(r) = self.rows().get_mut(id) {
            r.busy = false;
        }
        let ok = matches!(state, State::Ready | State::Newer);
        self.set_state(id, state);
        ok
    }

    fn connect_now(&self, machine: &Machine) -> State {
        let id = machine.id.as_str();
        if !matches!(self.state(id), Some(State::Ready)) {
            self.set_state(id, State::Connecting);
        }
        let look = match probe::look(&self.ssh, machine) {
            Ok(l) => l,
            Err(Missed::Unreachable(m)) => {
                tracing::info!(machine = id, problem = %m, "machine unreachable");
                return State::Unreachable;
            }
            Err(m) => {
                return State::Failed {
                    message: Self::missed(machine, m),
                };
            }
        };
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
                self.set_state(id, State::Updating);
                self.update(machine, &look)
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
        match self.wait_ready(&link, &wanted) {
            Ok(version) => {
                if self.rows().get(id).and_then(|r| r.kept.version.clone()) != Some(version.clone())
                {
                    self.update_kept(id, |k| k.version = Some(version));
                }
                State::Ready
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
                    let connect = match state {
                        State::Ready => {
                            if fleet.wait_kick(&id, Some(fleet.timing.check_every)) {
                                true
                            } else if fleet.machines.get(&id).is_some_and(|l| l.ready().is_none()) {
                                misses += 1;
                                if misses >= 3 {
                                    fleet.set_state(&id, State::Unreachable);
                                }
                                misses >= 3
                            } else {
                                misses = 0;
                                false
                            }
                        }
                        State::Newer => fleet.wait_kick(&id, None),
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
                        fleet.wait_kick(&id, Some(backoff));
                        backoff = (backoff * 2).min(fleet.timing.max_backoff);
                    }
                }
            });
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
        !matches!(self.state(id), Some(State::Newer))
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
        }
    }

    fn row(id: &str) -> Row {
        Row {
            kept: kept(id),
            state: State::Ready,
            saved: true,
            busy: false,
            kick: Arc::default(),
        }
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
            }),
            state: State::Ready,
        };
        assert_eq!(
            serde_json::to_value(row).unwrap(),
            serde_json::json!({"id": "devbox", "name": "devbox", "target": "dev@devbox", "version": "0.3.0", "system": {"os": "Ubuntu 24.04", "arch": "x86_64"}, "state": "ready"})
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
