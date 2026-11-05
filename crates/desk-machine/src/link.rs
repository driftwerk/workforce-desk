//! A machine's hub as Desk reaches it: its admin and device tokens, read
//! over SSH from `desk-helper connection --json` and held here in memory
//! only (never written on this computer, never given to the page), reached
//! through the forward's Unix socket here.
//!
//! The tokens are read again whenever the hub turns one away: Desk Helper
//! renews the device token at every start, so after the machine's helper
//! restarts (an upgrade, a crash, a reboot) the old one is dead. And again
//! when the hub can't be reached where it was: Desk Helper may have moved
//! its gateway to another port, and the forward is rebuilt to reach it.
//!
//! Reads are one at a time: those asking while one runs take what it
//! read, and a read is at most one every [`READ_GAP`], so many requests
//! turned away at once can't become a burst of SSH logins.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use desk_core::backend::{Connection, connection_over};
use desk_core::host::Host;
use desk_core::machine::{MACHINE_ROOT, Machine, MachineId};

use crate::ssh::{self, SSH_FAILED, SshExe};
use crate::tunnel::{self, Tunnel};

/// The least time between two reads over SSH.
pub const READ_GAP: Duration = Duration::from_secs(3);

/// The longest a Unix socket's path may be: macOS keeps it in 104 bytes,
/// its NUL included.
const MAX_SOCKET: usize = 103;

/// What the machine said, kept. Deliberately not `Debug`.
#[derive(Clone)]
struct Kept {
    box_port: u16,
    admin_token: String,
    device_token: Option<String>,
    /// The backend version installed there, as it said.
    version: Option<String>,
}

/// The last read over SSH: when it ended, and what it found.
struct LastRead {
    at: Instant,
    failed: Option<String>,
}

pub struct Link {
    machine: Machine,
    ssh: SshExe,
    tunnel: Tunnel,
    /// How long a read waits for the forward.
    wait: Duration,
    gap: Duration,
    kept: Mutex<Option<Kept>>,
    /// Held while a read over SSH runs.
    reading: Mutex<Option<LastRead>>,
    home: Mutex<Option<String>>,
}

/// The machine's gateway port, from the address Desk Helper there says its
/// hub is at: `http://127.0.0.1:<port>` and nothing else, its own loopback
/// (Desk writes it so). A hub there on any other address is refused.
pub fn box_port(gateway_url: &str, machine: &Machine) -> Result<u16, String> {
    let refuse = || {
        format!(
            "Desk on {} has its hub somewhere other than that machine's own loopback, so Desk won't connect to it.",
            machine.name
        )
    };
    let url = desk_core::net::loopback_url(gateway_url).map_err(|_| refuse())?;
    match (url.host_str(), url.port()) {
        (Some("127.0.0.1"), Some(port)) if port != 0 => Ok(port),
        _ => Err(refuse()),
    }
}

/// The folder the forwards' sockets go in: `preferred`, or one in the
/// system's temporary folder when a socket's path there would be too long.
/// Made only the person's (`0700`), and refused when it is anyone else's
/// or open to anyone else.
pub fn socket_dir(preferred: &Path) -> Result<PathBuf, String> {
    let fits = |dir: &Path| dir.join("0123456789abcdef.sock").as_os_str().len() <= MAX_SOCKET;
    let dir = if fits(preferred) {
        preferred.to_path_buf()
    } else {
        #[cfg(unix)]
        // SAFETY: geteuid has no preconditions.
        let uid = unsafe { libc::geteuid() };
        #[cfg(not(unix))]
        let uid = 0;
        std::env::temp_dir().join(format!("desk-{uid}-machines"))
    };
    if !fits(&dir) || dir.to_string_lossy().contains(':') {
        return Err(format!(
            "Desk can't keep its connections to machines in {}",
            dir.display()
        ));
    }
    private_dir(&dir)?;
    Ok(dir)
}

#[cfg(unix)]
fn private_dir(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    let say = |e: std::io::Error| format!("{}: {e}", dir.display());
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(say)?;
    let meta = std::fs::symlink_metadata(dir).map_err(say)?;
    // SAFETY: geteuid has no preconditions.
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } {
        return Err(format!("{} isn't Desk's own folder", dir.display()));
    }
    if meta.mode() & 0o077 != 0 {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(say)?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn private_dir(_: &Path) -> Result<(), String> {
    Err("Desk reaches machines from macOS and Linux.".into())
}

/// Machine `id`'s socket in `dir`: named by a hash of the id, so any id
/// fits.
pub fn socket_for(dir: &Path, id: &MachineId) -> PathBuf {
    // FNV-1a: short and stable; nothing here needs it to be secret.
    let hash = id.as_str().bytes().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
    });
    dir.join(format!("{hash:016x}.sock"))
}

impl Link {
    pub fn new(machine: Machine, ssh: SshExe, socket: PathBuf) -> Self {
        let tunnel = Tunnel::new(ssh.clone(), machine.clone(), socket);
        Self::with_tunnel(machine, ssh, tunnel, tunnel::READY_WITHIN)
    }

    pub fn with_tunnel(machine: Machine, ssh: SshExe, tunnel: Tunnel, wait: Duration) -> Self {
        Self {
            machine,
            ssh,
            tunnel,
            wait,
            gap: READ_GAP,
            kept: Mutex::default(),
            reading: Mutex::default(),
            home: Mutex::default(),
        }
    }

    /// With reads at most one every `gap`.
    pub fn with_gap(mut self, gap: Duration) -> Self {
        self.gap = gap;
        self
    }

    pub fn machine(&self) -> &Machine {
        &self.machine
    }

    /// The `ssh` it reaches the machine by.
    pub fn ssh(&self) -> &SshExe {
        &self.ssh
    }

    pub fn tunnel(&self) -> &Tunnel {
        &self.tunnel
    }

    /// The forward's socket here: the only way anything reaches the
    /// machine's hub.
    pub fn socket(&self) -> &Path {
        self.tunnel.socket()
    }

    fn kept(&self) -> std::sync::MutexGuard<'_, Option<Kept>> {
        self.kept.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The connection as the machine says it now, over SSH, through the
    /// forward (started, or rebuilt to where the gateway is now); none
    /// while Desk Helper there hasn't made its hub. Blocking. One read at a
    /// time: asked while one runs, this is what that one read; asked within
    /// the gap after one, this waits out the gap first.
    pub fn read(&self) -> Result<Option<Connection>, String> {
        let asked = Instant::now();
        let mut reading = self.reading.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(last) = reading.as_ref().filter(|l| l.at >= asked) {
            return match &last.failed {
                Some(why) => Err(why.clone()),
                None => self.connection_kept(),
            };
        }
        if let Some(last) = reading.as_ref() {
            let left = self.gap.saturating_sub(last.at.elapsed());
            if !left.is_zero() {
                std::thread::sleep(left);
            }
        }
        let read = self.read_now();
        *reading = Some(LastRead {
            at: Instant::now(),
            failed: read.as_ref().err().cloned(),
        });
        read
    }

    /// The kept tokens through the forward, none when none are kept.
    fn connection_kept(&self) -> Result<Option<Connection>, String> {
        let kept = self.kept().clone();
        kept.map(|k| self.through(&k)).transpose()
    }

    fn read_now(&self) -> Result<Option<Connection>, String> {
        let host = Host::Ssh(self.machine.clone());
        let invocation = host.invocation(&self.machine.helper(), &["connection", "--json"]);
        let out = self
            .ssh
            .output(&invocation)
            .map_err(|e| format!("Desk couldn't run ssh: {e}"))?;
        match out.status.code() {
            Some(SSH_FAILED) => return Err(ssh::problem(&self.machine, &out.stderr)),
            Some(127) => return Err(format!("Desk isn't installed on {}.", self.machine.name)),
            _ => {}
        }
        // What it printed holds the tokens: parsed here, never said.
        let Some(said) = connection_over(&host, move |_| Ok(out)).map_err(|e| e.to_string())?
        else {
            *self.kept() = None;
            return Ok(None);
        };
        let kept = Kept {
            box_port: box_port(&said.gateway_url, &self.machine)?,
            admin_token: said.admin_token,
            device_token: said.device_token,
            version: said.version,
        };
        let connection = self.through(&kept)?;
        *self.kept() = Some(kept);
        Ok(Some(connection))
    }

    /// `kept`, once the forward to it is up. Its address
    /// (`http://<id>.machine.invalid:<port>`, the gateway's port on the
    /// machine) resolves nowhere: only a client bound to [`Link::socket`]
    /// reaches anything with it.
    fn through(&self, kept: &Kept) -> Result<Connection, String> {
        self.tunnel.ensure(kept.box_port, self.wait)?;
        Ok(Connection {
            gateway_url: desk_core::net::machine_base(self.machine.id.as_str(), kept.box_port),
            admin_token: kept.admin_token.clone(),
            device_token: kept.device_token.clone(),
            version: kept.version.clone(),
        })
    }

    /// The connection as last read (once the forward is up), or read now.
    /// Blocking.
    pub fn connection(&self) -> Result<Option<Connection>, String> {
        match self.connection_kept()? {
            Some(c) => Ok(Some(c)),
            None => self.read(),
        }
    }

    /// The connection as last read, while the forward to it is up; none
    /// otherwise. Never runs ssh or waits.
    pub fn ready(&self) -> Option<Connection> {
        let kept = self.kept().clone()?;
        (self.tunnel.up() == Some(kept.box_port)).then(|| Connection {
            gateway_url: desk_core::net::machine_base(self.machine.id.as_str(), kept.box_port),
            admin_token: kept.admin_token,
            device_token: kept.device_token,
            version: kept.version,
        })
    }

    /// The machine's gateway port, as last read: whether it moved since a
    /// request failed decides whether that request may be sent again.
    pub fn gateway(&self) -> Option<u16> {
        self.kept().as_ref().map(|k| k.box_port)
    }

    /// Forgets the tokens read: the next connection reads them again.
    pub fn forget(&self) {
        *self.kept() = None;
    }

    /// The account's home on the machine, read once. Blocking.
    pub fn home(&self) -> Result<String, String> {
        if let Some(home) = self.home.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            return Ok(home);
        }
        let invocation =
            self.machine
                .command(&["sh".into(), "-c".into(), r#"printf '%s\n' "$HOME""#.into()]);
        let out = self
            .ssh
            .output(&invocation)
            .map_err(|e| format!("Desk couldn't run ssh: {e}"))?;
        if !out.status.success() {
            return Err(ssh::problem(&self.machine, &out.stderr));
        }
        let home = String::from_utf8_lossy(&out.stdout).trim_end().to_string();
        if !home.starts_with('/') || home.lines().count() != 1 || !desk_core::machine::plain(&home)
        {
            return Err(format!(
                "{} didn't say where its home is.",
                self.machine.name
            ));
        }
        *self.home.lock().unwrap_or_else(|e| e.into_inner()) = Some(home.clone());
        Ok(home)
    }

    /// Desk's Claude Code plugin on the machine, as its shells name it.
    pub fn plugin_dir(&self) -> Result<String, String> {
        Ok(format!(
            "{}/{MACHINE_ROOT}/bin/current/claude-plugin",
            self.home()?
        ))
    }
}

/// Every machine Desk reaches, by id.
pub struct Machines {
    ssh: SshExe,
    /// Where the forwards' sockets go (made when a machine is first
    /// reached); none when Desk has nowhere to put them.
    sockets: Option<PathBuf>,
    links: Mutex<BTreeMap<MachineId, Arc<Link>>>,
}

impl Default for Machines {
    /// None, and nowhere to keep a forward: for what never reaches one.
    fn default() -> Self {
        Self {
            ssh: SshExe::system(),
            sockets: None,
            links: Mutex::default(),
        }
    }
}

impl Machines {
    /// The machines, their forwards' sockets in `socket_dir` (made the
    /// person's own; see [`socket_dir`]).
    pub fn new(ssh: SshExe, sockets: &Path) -> Self {
        Self {
            ssh,
            sockets: Some(sockets.to_path_buf()),
            links: Mutex::default(),
        }
    }

    fn links(&self) -> std::sync::MutexGuard<'_, BTreeMap<MachineId, Arc<Link>>> {
        self.links.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Reaches `machine` from now on (instead of what had its id before,
    /// whose forward ends once nothing holds it).
    pub fn insert(&self, machine: Machine) -> Result<Arc<Link>, String> {
        let dir = socket_dir(
            self.sockets
                .as_deref()
                .ok_or("Desk has nowhere to keep its connections to machines.")?,
        )?;
        let socket = socket_for(&dir, &machine.id);
        let link = Arc::new(Link::new(machine.clone(), self.ssh.clone(), socket));
        self.links().insert(machine.id, Arc::clone(&link));
        Ok(link)
    }

    /// Reaches `link` as its machine from now on.
    pub fn insert_link(&self, link: Link) -> Arc<Link> {
        let link = Arc::new(link);
        self.links()
            .insert(link.machine().id.clone(), Arc::clone(&link));
        link
    }

    /// Stops reaching machine `id`; whether Desk did.
    pub fn remove(&self, id: &str) -> bool {
        let mut links = self.links();
        let before = links.len();
        links.retain(|k, _| k.as_str() != id);
        links.len() != before
    }

    pub fn get(&self, id: &str) -> Option<Arc<Link>> {
        self.links()
            .iter()
            .find(|(k, _)| k.as_str() == id)
            .map(|(_, l)| Arc::clone(l))
    }

    pub fn list(&self) -> Vec<Machine> {
        self.links().values().map(|l| l.machine().clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use desk_core::machine::Target;

    #[test]
    fn the_machines_hub_must_be_on_its_own_loopback() {
        let m = Machine {
            id: MachineId::new("devbox").unwrap(),
            name: "devbox".into(),
            target: Target::new("devbox").unwrap(),
        };
        assert_eq!(box_port("http://127.0.0.1:4226", &m), Ok(4226));
        for refused in [
            "http://0.0.0.0:4226",
            "http://203.0.113.7:4226",
            "https://127.0.0.1:4226",
            "http://[::1]:4226",
            "http://localhost:4226",
            "http://127.0.0.1",
            "http://127.0.0.1:4226/x",
            "http://u:p@127.0.0.1:4226",
        ] {
            assert!(box_port(refused, &m).is_err(), "{refused}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_sockets_folder_is_the_persons_alone_and_short_enough() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let open = dir.path().join("m");
        std::fs::create_dir(&open).unwrap();
        std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o755)).unwrap();
        let made = socket_dir(&open).unwrap();
        assert_eq!(made, open);
        let mode = std::fs::metadata(&made).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        let long = dir.path().join("x".repeat(120));
        let elsewhere = socket_dir(&long).unwrap();
        assert_ne!(elsewhere, long);
        let id = MachineId::new(&"a".repeat(64)).unwrap();
        assert!(socket_for(&elsewhere, &id).as_os_str().len() <= MAX_SOCKET);
    }
}
