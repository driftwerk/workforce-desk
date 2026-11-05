//! A machine's hub as Desk reaches it: its admin and device tokens, read
//! over SSH from `desk-helper connection --json` and held here in memory
//! only (never written on this computer, never given to the page), with
//! the forward's address on this computer's loopback in place of the
//! machine's own.
//!
//! The tokens are read again whenever the hub turns one away: Desk Helper
//! renews the device token at every start, so after the machine's helper
//! restarts (an upgrade, a crash, a reboot) the old one is dead. And again
//! when the hub can't be reached where it was: Desk Helper may have moved
//! its gateway to another port, and the forward is rebuilt to reach it.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use desk_core::backend::{Connection, connection_over};
use desk_core::host::Host;
use desk_core::machine::{MACHINE_ROOT, Machine, MachineId};

use crate::ssh::{self, SSH_FAILED, SshExe};
use crate::tunnel::{self, Tunnel};

/// What the machine said, kept. Deliberately not `Debug`.
#[derive(Clone)]
struct Kept {
    box_port: u16,
    admin_token: String,
    device_token: Option<String>,
}

pub struct Link {
    machine: Machine,
    ssh: SshExe,
    tunnel: Tunnel,
    /// How long a read waits for the forward.
    wait: Duration,
    kept: Mutex<Option<Kept>>,
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

impl Link {
    pub fn new(machine: Machine, ssh: SshExe) -> Self {
        let tunnel = Tunnel::new(ssh.clone(), machine.clone());
        Self::with_tunnel(machine, ssh, tunnel, tunnel::READY_WITHIN)
    }

    pub fn with_tunnel(machine: Machine, ssh: SshExe, tunnel: Tunnel, wait: Duration) -> Self {
        Self {
            machine,
            ssh,
            tunnel,
            wait,
            kept: Mutex::default(),
            home: Mutex::default(),
        }
    }

    pub fn machine(&self) -> &Machine {
        &self.machine
    }

    pub fn tunnel(&self) -> &Tunnel {
        &self.tunnel
    }

    fn kept(&self) -> std::sync::MutexGuard<'_, Option<Kept>> {
        self.kept.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The connection as the machine says it now, over SSH, through the
    /// forward (started, or rebuilt to where the gateway is now); none
    /// while Desk Helper there hasn't made its hub. Blocking.
    pub fn read(&self) -> Result<Option<Connection>, String> {
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
        };
        let connection = self.through(&kept)?;
        *self.kept() = Some(kept);
        Ok(Some(connection))
    }

    /// `kept` with the forward's address here: the token only ever goes to
    /// this computer's loopback.
    fn through(&self, kept: &Kept) -> Result<Connection, String> {
        let mac_port = self.tunnel.ensure(kept.box_port, self.wait)?;
        Ok(Connection {
            gateway_url: format!("http://127.0.0.1:{mac_port}"),
            admin_token: kept.admin_token.clone(),
            device_token: kept.device_token.clone(),
        })
    }

    /// The connection as last read (through the forward as it is now), or
    /// read now. Blocking.
    pub fn connection(&self) -> Result<Option<Connection>, String> {
        let kept = self.kept().clone();
        match kept {
            Some(k) => self.through(&k).map(Some),
            None => self.read(),
        }
    }

    /// The connection as last read, while the forward to it is up; none
    /// otherwise. Never runs ssh or waits.
    pub fn ready(&self) -> Option<Connection> {
        let kept = self.kept().clone()?;
        let up = self.tunnel.up().filter(|u| u.box_port == kept.box_port)?;
        Some(Connection {
            gateway_url: format!("http://127.0.0.1:{}", up.mac_port),
            admin_token: kept.admin_token,
            device_token: kept.device_token,
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
        if !home.starts_with('/') || home.lines().count() != 1 || home.chars().any(char::is_control)
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
    links: Mutex<BTreeMap<MachineId, Arc<Link>>>,
}

impl Default for Machines {
    fn default() -> Self {
        Self::new(SshExe::system())
    }
}

impl Machines {
    pub fn new(ssh: SshExe) -> Self {
        Self {
            ssh,
            links: Mutex::default(),
        }
    }

    fn links(&self) -> std::sync::MutexGuard<'_, BTreeMap<MachineId, Arc<Link>>> {
        self.links.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Reaches `machine` from now on (instead of what had its id before,
    /// whose forward ends once nothing holds it).
    pub fn insert(&self, machine: Machine) -> Arc<Link> {
        let link = Arc::new(Link::new(machine.clone(), self.ssh.clone()));
        self.links().insert(machine.id, Arc::clone(&link));
        link
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
}
