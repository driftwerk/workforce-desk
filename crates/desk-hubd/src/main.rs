//! `desk-hubd` — run by launchd at login. Starts the local Postgres, writes
//! the hub's config, and keeps `workforce serve` running with the user's
//! login environment and its secrets from the keychain. Stops both on
//! SIGTERM.

mod bootstrap;
mod config;

use std::collections::BTreeMap;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use desk_core::{HubPorts, Paths, Secret, SecretStore, Secrets, read_ports, write_ports};
use eyre::{Context, Result};
use postgresql_embedded::{PostgreSQL, Settings};
use tokio::process::{Child, Command};
use tokio::signal::unix::{SignalKind, signal};

const MARKER: &str = "__DESK_ENV__";
const HEALTHY_AFTER: Duration = Duration::from_secs(300);
const MAX_BACKOFF: Duration = Duration::from_secs(60);

fn free_port() -> Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

/// Ports from the last run, or new ones on first run. A saved port that is
/// now taken by something else is replaced.
fn ports(paths: &Paths) -> Result<HubPorts> {
    let usable = |p: u16| TcpListener::bind(("127.0.0.1", p)).is_ok();
    let saved = read_ports(&paths.hub_state())?;
    let pick = |p: Option<u16>| p.filter(|&p| usable(p)).map_or_else(free_port, Ok);
    let ports = HubPorts {
        postgres: pick(saved.map(|s| s.postgres))?,
        admin: pick(saved.map(|s| s.admin))?,
        gateway: pick(saved.map(|s| s.gateway))?,
    };
    if saved != Some(ports) {
        write_ports(&paths.hub_state(), &ports)?;
    }
    Ok(ports)
}

/// The environment a terminal would have (PATH from `.zshrc`, nvm, etc.):
/// launchd starts us with almost none of it.
async fn login_env() -> BTreeMap<String, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let script = format!("printf '\\0{MARKER}\\0'; env -0");
    let out = Command::new(&shell)
        .args(["-l", "-i", "-c", &script])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    let captured = match tokio::time::timeout(Duration::from_secs(20), out).await {
        Ok(Ok(o)) => parse_env(&o.stdout),
        _ => None,
    };
    captured.unwrap_or_else(|| {
        tracing::warn!(%shell, "could not read the login environment; using launchd's");
        std::env::vars().collect()
    })
}

fn parse_env(raw: &[u8]) -> Option<BTreeMap<String, String>> {
    let text = String::from_utf8_lossy(raw);
    let (_, after) = text.split_once(&format!("\0{MARKER}\0"))?;
    Some(
        after
            .split('\0')
            .filter_map(|kv| kv.split_once('='))
            .filter(|(k, _)| !k.is_empty())
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    )
}

/// Environment for `workforce serve`: login env, minus anything a parent
/// Claude Code session leaked, plus the secrets.
fn hub_env(
    login: &BTreeMap<String, String>,
    secrets: &impl SecretStore,
) -> Result<BTreeMap<String, String>> {
    let mut env: BTreeMap<String, String> = login
        .iter()
        .filter(|(k, _)| !k.starts_with("CLAUDE"))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    for s in Secret::ALL {
        env.insert(s.env().into(), secrets.get_or_create(s)?);
    }
    Ok(env)
}

async fn start_postgres(paths: &Paths, port: u16, password: String) -> Result<PostgreSQL> {
    let settings = Settings {
        installation_dir: paths.postgres_install(),
        data_dir: paths.postgres_data(),
        password_file: paths.hub().join(".pgpass"),
        host: "127.0.0.1".into(),
        port,
        username: config::DATABASE_USER.into(),
        password,
        temporary: false,
        ..Settings::default()
    };
    let mut pg = PostgreSQL::new(settings);
    pg.setup().await.context("installing Postgres")?;
    pg.start().await.context("starting Postgres")?;
    if !pg.database_exists(config::DATABASE).await? {
        pg.create_database(config::DATABASE).await?;
    }
    Ok(pg)
}

fn spawn_hub(workforce: &Path, paths: &Paths, env: &BTreeMap<String, String>) -> Result<Child> {
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths.logs().join("hub.log"))?;
    Command::new(workforce)
        .args(["serve", "-c"])
        .arg(paths.hub_config())
        .current_dir(paths.hub())
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("starting {}", workforce.display()))
}

/// SIGTERM, then SIGKILL if it hasn't gone after `grace`.
async fn stop(child: &mut Child, grace: Duration) {
    if let Some(pid) = child.id() {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .await;
        if tokio::time::timeout(grace, child.wait()).await.is_ok() {
            return;
        }
    }
    let _ = child.kill().await;
}

fn workforce_binary() -> PathBuf {
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--workforce"
            && let Some(p) = args.next()
        {
            return p.into();
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.join("workforce")))
        .filter(|p| p.is_file())
        .unwrap_or_else(|| "workforce".into())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    // postgresql_embedded builds reqwest with rustls but no crypto provider;
    // every HTTP client in this process shares the one installed here.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let paths = Paths::new()?;
    for dir in [paths.hub(), paths.hub_data(), paths.logs()] {
        std::fs::create_dir_all(&dir)?;
    }
    let workforce = workforce_binary();
    let ports = ports(&paths)?;
    desk_core::write_private(&paths.hub_config(), &config::render(&paths, &ports))?;
    let env = hub_env(&login_env().await, &Secrets::for_paths(&paths))?;
    let pg = start_postgres(
        &paths,
        ports.postgres,
        env[Secret::PostgresPassword.env()].clone(),
    )
    .await?;
    tracing::info!(gateway = %ports.gateway_url(), "local hub starting");
    {
        let paths = paths.clone();
        let gateway = ports.gateway_url();
        let admin = env[Secret::GatewayToken.env()].clone();
        tokio::spawn(async move {
            if let Err(e) = bootstrap::run(&paths, &gateway, &admin).await {
                tracing::error!(error = %e, "could not pair Desk with its local hub");
            }
        });
    }

    let mut term = signal(SignalKind::terminate())?;
    let mut int = signal(SignalKind::interrupt())?;
    let mut backoff = Duration::from_secs(1);
    let outcome = loop {
        let started = Instant::now();
        let mut hub = match spawn_hub(&workforce, &paths, &env) {
            Ok(c) => c,
            Err(e) => break Err(e),
        };
        tokio::select! {
            _ = term.recv() => { stop(&mut hub, Duration::from_secs(20)).await; break Ok(()) }
            _ = int.recv() => { stop(&mut hub, Duration::from_secs(20)).await; break Ok(()) }
            status = hub.wait() => {
                if started.elapsed() > HEALTHY_AFTER {
                    backoff = Duration::from_secs(1);
                }
                tracing::warn!(?status, retry_in = ?backoff, "hub exited; restarting");
                tokio::select! {
                    _ = term.recv() => break Ok(()),
                    _ = int.recv() => break Ok(()),
                    _ = tokio::time::sleep(backoff) => {}
                }
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
        }
    };
    if let Err(e) = pg.stop().await {
        tracing::warn!(error = %e, "Postgres did not stop cleanly");
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[test]
    fn login_env_is_read_after_the_marker_so_shell_noise_is_ignored() {
        let raw =
            b"Welcome!\n\0__DESK_ENV__\0PATH=/opt/homebrew/bin:/usr/bin\0HOME=/Users/k\0EQ=a=b\0";
        let env = parse_env(raw).unwrap();
        assert_eq!(env["PATH"], "/opt/homebrew/bin:/usr/bin");
        assert_eq!(env["EQ"], "a=b");
        assert_eq!(env.len(), 3);
        assert!(parse_env(b"no marker").is_none());
    }

    #[derive(Default)]
    struct Memory(RefCell<HashMap<Secret, String>>);

    impl SecretStore for Memory {
        fn get(&self, s: Secret) -> Result<Option<String>> {
            Ok(self.0.borrow().get(&s).cloned())
        }
        fn set(&self, s: Secret, v: &str) -> Result<()> {
            self.0.borrow_mut().insert(s, v.into());
            Ok(())
        }
    }

    #[test]
    fn the_hub_gets_its_secrets_and_none_of_a_parent_claude_session() {
        let login = BTreeMap::from([
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("CLAUDE_CODE_CHILD_SESSION".to_string(), "1".to_string()),
            ("CLAUDECODE".to_string(), "1".to_string()),
        ]);
        let env = hub_env(&login, &Memory::default()).unwrap();
        assert!(!env.keys().any(|k| k.starts_with("CLAUDE")));
        for s in Secret::ALL {
            assert!(!env[s.env()].is_empty());
        }
    }

    #[test]
    fn saved_ports_are_kept_and_taken_ones_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        let first = ports(&paths).unwrap();
        assert_eq!(ports(&paths).unwrap(), first);
        let _held = TcpListener::bind(("127.0.0.1", first.gateway)).unwrap();
        let next = ports(&paths).unwrap();
        assert_ne!(next.gateway, first.gateway);
        assert_eq!(next.postgres, first.postgres);
    }
}
