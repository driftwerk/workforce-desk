//! The backend — Desk Helper, the local hub, its memory store and Postgres —
//! as the app reaches it: in the app's own folder on macOS and Linux, inside
//! a WSL distro on Windows, where only Desk Helper reads its secrets and
//! hands them over its output.

use eyre::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::host::{Host, Invocation, Wsl};
use crate::{LOCAL_HUB_ID, Paths, Secret, SecretStore, Secrets, device_token_account, read_ports};

/// How to talk to the local hub.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Connection {
    pub gateway_url: String,
    pub admin_token: String,
    /// Desk's own device token, once Desk Helper has paired Desk with the
    /// hub.
    pub device_token: Option<String>,
}

/// The connection as the backend's own files hold it; none until Desk
/// Helper has chosen the ports and made the gateway token.
pub fn read_connection(paths: &Paths, secrets: &Secrets) -> Result<Option<Connection>> {
    let Some(ports) = read_ports(&paths.hub_state())? else {
        return Ok(None);
    };
    let Some(admin_token) = secrets.get(Secret::GatewayToken)? else {
        return Ok(None);
    };
    Ok(Some(Connection {
        gateway_url: ports.gateway_url(),
        admin_token,
        device_token: secrets.get_account(&device_token_account(LOCAL_HUB_ID))?,
    }))
}

/// What `desk-helper connection --json` printed.
pub fn parse_connection(stdout: &[u8]) -> Result<Option<Connection>> {
    serde_json::from_slice(stdout).context("reading what Desk Helper said about the local hub")
}

/// Ends the PTY holder (and with it the hub's terminals), forgets the
/// backend's secrets and deletes its folder: everything the backend keeps.
#[cfg(unix)]
pub fn remove_everything(paths: &Paths, secrets: &Secrets) -> Result<()> {
    crate::holder::stop(&paths.pty_socket(), std::time::Duration::from_secs(10))?;
    secrets.forget_backend()?;
    match std::fs::remove_dir_all(&paths.root) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).with_context(|| format!("deleting {}", paths.root.display())),
    }
}

/// The oldest glibc the Linux backend runs on: Ubuntu 22.04's, which it is
/// built on.
pub const MIN_GLIBC: (u32, u32) = (2, 35);

/// Whether a glibc version (`2.39`, `2.35.1`) is [`MIN_GLIBC`] or newer.
pub fn glibc_supported(version: &str) -> bool {
    let mut parts = version.trim().split('.').map(|p| p.parse::<u32>().ok());
    match (parts.next().flatten(), parts.next().flatten()) {
        (Some(major), Some(minor)) => (major, minor) >= MIN_GLIBC,
        _ => false,
    }
}

/// `desk-helper --check`: whether the backend can run where it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Check {
    pub ok: bool,
    /// The C library's version on Linux with glibc.
    pub glibc: Option<String>,
    pub arch: String,
    /// Whether a port can be opened on 127.0.0.1.
    pub loopback: bool,
    /// Whether Desk's folder is on a Linux filesystem, not a Windows drive
    /// WSL mounts (where Postgres and the PTY holder can't work).
    pub root_on_ext4: bool,
}

impl Check {
    pub fn of(glibc: Option<String>, arch: &str, loopback: bool, root_on_ext4: bool) -> Check {
        let ok = glibc.as_deref().is_none_or(glibc_supported)
            && matches!(arch, "x86_64" | "aarch64")
            && loopback
            && root_on_ext4;
        Check {
            ok,
            glibc,
            arch: arch.into(),
            loopback,
            root_on_ext4,
        }
    }

    /// What failed, in the person's words; none when nothing did.
    pub fn problem(&self) -> Option<String> {
        if self.ok {
            None
        } else if !self.root_on_ext4 {
            Some("Desk's folder is on a Windows drive; it needs to be in your Linux home".into())
        } else if !self.loopback {
            Some("Desk can't open a port on 127.0.0.1 there".into())
        } else if !matches!(self.arch.as_str(), "x86_64" | "aarch64") {
            Some(format!("Desk doesn't run on {}", self.arch))
        } else {
            Some(format!(
                "Desk needs Ubuntu 22.04 or newer, or Debian 12 (this Linux has glibc {})",
                self.glibc.as_deref().unwrap_or("of unknown version")
            ))
        }
    }
}

/// Which backend the app uses, where it isn't this computer itself (on
/// Windows, a WSL distro): kept in the app's folder once setup chose it.
pub fn read_host(paths: &Paths) -> Result<Option<Host>> {
    match std::fs::read_to_string(paths.backend_host()) {
        Ok(s) => Ok(Some(serde_json::from_str(&s).with_context(|| {
            format!("reading {}", paths.backend_host().display())
        })?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("reading {}", paths.backend_host().display())),
    }
}

pub fn write_host(paths: &Paths, host: &Host) -> Result<()> {
    crate::write_private(&paths.backend_host(), &serde_json::to_string_pretty(host)?)
}

/// Where the backend is, and its folder as the app opens it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backend {
    pub host: Host,
    pub paths: Paths,
}

impl Backend {
    /// The backend on this computer, sharing the app's folder.
    pub fn native(paths: Paths) -> Self {
        Self {
            host: Host::Native,
            paths,
        }
    }

    /// The backend inside a WSL distro; its folder through Windows'
    /// `\\wsl.localhost` share.
    pub fn wsl(wsl: Wsl) -> Self {
        let root = wsl.root();
        let host = Host::Wsl(wsl);
        Self {
            paths: Paths::at(host.host_path(&root)),
            host,
        }
    }

    pub fn connection(&self) -> Result<Option<Connection>> {
        self.connection_with(|i| i.command().output())
    }

    /// The connection, with `run` running what a WSL backend is asked
    /// (`wsl.exe`, or a stand-in).
    pub fn connection_with(
        &self,
        run: impl FnOnce(&Invocation) -> std::io::Result<std::process::Output>,
    ) -> Result<Option<Connection>> {
        match &self.host {
            Host::Native => {
                read_connection(&self.paths, &Secrets::for_host(&self.paths, &self.host)?)
            }
            Host::Wsl(w) => {
                let out = run(&self.host.invocation(&w.helper(), &["connection", "--json"]))
                    .context("asking Desk Helper in WSL for the local hub")?;
                if !out.status.success() {
                    eyre::bail!(
                        "Desk Helper in {} couldn't say: {}",
                        w.distro,
                        String::from_utf8_lossy(&out.stderr).trim()
                    );
                }
                parse_connection(&out.stdout)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{HubPorts, KeyStore, write_ports};

    #[test]
    fn the_connection_waits_for_the_ports_and_the_token() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        let secrets = Secrets::of(&paths, KeyStore::File);
        assert_eq!(read_connection(&paths, &secrets).unwrap(), None);
        let ports = HubPorts {
            postgres: 1,
            admin: 2,
            gateway: 3,
            memory: 4,
        };
        write_ports(&paths.hub_state(), &ports).unwrap();
        assert_eq!(read_connection(&paths, &secrets).unwrap(), None);
        secrets.set(Secret::GatewayToken, "admin").unwrap();
        let unpaired = read_connection(&paths, &secrets).unwrap().unwrap();
        assert_eq!(unpaired.gateway_url, "http://127.0.0.1:3");
        assert_eq!(unpaired.device_token, None);
        secrets
            .set_account(&device_token_account(LOCAL_HUB_ID), "device")
            .unwrap();
        let paired = read_connection(&paths, &secrets).unwrap().unwrap();
        assert_eq!(paired.device_token.as_deref(), Some("device"));
        let said = serde_json::to_vec(&Some(paired.clone())).unwrap();
        assert_eq!(parse_connection(&said).unwrap(), Some(paired));
        assert_eq!(parse_connection(b"null").unwrap(), None);
        assert!(parse_connection(b"Welcome to Ubuntu").is_err());
    }

    #[test]
    fn a_check_says_what_failed() {
        assert_eq!(
            Check::of(Some("2.39".into()), "x86_64", true, true).problem(),
            None
        );
        let old = Check::of(Some("2.31".into()), "x86_64", true, true);
        assert!(!old.ok);
        assert!(old.problem().unwrap().contains("glibc 2.31"));
        assert!(
            Check::of(None, "x86_64", true, false)
                .problem()
                .unwrap()
                .contains("Windows drive")
        );
        assert!(
            Check::of(None, "riscv64", true, true)
                .problem()
                .unwrap()
                .contains("riscv64")
        );
        let said = serde_json::to_string(&old).unwrap();
        assert_eq!(serde_json::from_str::<Check>(&said).unwrap(), old);
    }

    #[test]
    fn the_chosen_backend_is_kept_in_the_apps_folder() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        assert_eq!(read_host(&paths).unwrap(), None);
        let host = Host::Wsl(Wsl {
            distro: "Ubuntu".into(),
            user: "sarah".into(),
            home: "/home/sarah".into(),
            automount: "/mnt/".into(),
        });
        write_host(&paths, &host).unwrap();
        assert_eq!(read_host(&paths).unwrap(), Some(host));
    }

    #[test]
    fn glibc_must_be_ubuntu_22_04s_or_newer() {
        for (v, ok) in [
            ("2.35", true),
            ("2.39", true),
            ("3.0", true),
            ("2.35.1", true),
            ("2.31", false),
            ("1.99", false),
            ("", false),
            ("musl", false),
        ] {
            assert_eq!(glibc_supported(v), ok, "{v}");
        }
    }

    #[test]
    fn a_wsl_backend_is_opened_through_the_distros_share() {
        let backend = Backend::wsl(Wsl {
            distro: "Ubuntu".into(),
            user: "sarah".into(),
            home: "/home/sarah".into(),
            automount: "/mnt/".into(),
        });
        assert_eq!(
            backend.paths.root,
            std::path::PathBuf::from(r"\\wsl.localhost\Ubuntu\home\sarah\.local\share\Desk")
        );
        assert_eq!(Backend::native(Paths::at("/x")).paths, Paths::at("/x"));
    }
}
