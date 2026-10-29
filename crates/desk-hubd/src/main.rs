//! `desk-hubd` — "Desk Helper" in the app bundle, run by launchd at login
//! as Desk's login item. Starts the local Postgres, writes the hub's config,
//! and keeps the hub running with the user's login environment and its
//! secrets from the keychain. Starts the PTY holder before the hub, which
//! keeps the hub's terminals through its restarts. Stops the hub and
//! Postgres (never the holder) on SIGTERM, and when an update replaces the
//! app bundle under it, so launchd starts the new one.

mod bootstrap;
mod config;
mod holder;

use std::collections::BTreeMap;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use desk_core::{
    HUB_EXECUTABLE, HubPorts, Paths, Secret, SecretStore, Secrets, read_ports, write_ports,
};
use eyre::{Context, Result};
use postgresql_embedded::{PostgreSQL, Settings};
use tokio::process::{Child, Command};
use tokio::signal::unix::{SignalKind, signal};

const HEALTHY_AFTER: Duration = Duration::from_secs(300);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
const POSTGRES_TIMEOUT: Duration = Duration::from_secs(180);

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

/// Claude Code's own plugin folders, which the hub keeps for the shells it
/// opens (adding Desk's), unlike the rest of `CLAUDE*`.
const PLUGIN_DIRS: &str = "CLAUDE_CODE_PLUGIN_DIRS";

/// Environment for `workforce serve`: login env, minus anything a parent
/// Claude Code session leaked (but the person's plugin folders), plus the
/// secrets.
fn hub_env(
    login: &BTreeMap<String, String>,
    secrets: &impl SecretStore,
) -> Result<BTreeMap<String, String>> {
    // `~/.local/bin` too, where Claude Code's and Codex's installers put
    // them, so one installed from Desk's settings is found without a restart.
    let mut env = desk_core::shell::with_local_bin(
        login
            .iter()
            .filter(|(k, _)| !k.starts_with("CLAUDE") || k.as_str() == PLUGIN_DIRS)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    );
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
        // The first start unpacks Postgres and runs initdb, which takes
        // longer than the default 5 s on a busy or older Mac.
        timeout: Some(POSTGRES_TIMEOUT),
        ..Settings::default()
    };
    // A first initdb that didn't finish leaves a data directory that looks
    // made but isn't; the marker says to start it over.
    let first_run = paths.hub().join("postgres.initializing");
    if first_run.exists() {
        tracing::warn!("the last first start of Postgres didn't finish; starting it over");
        match std::fs::remove_dir_all(paths.postgres_data()) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e).context("clearing an unfinished Postgres"),
        }
    }
    if !paths.postgres_data().join("postgresql.conf").exists() {
        std::fs::write(&first_run, "")?;
    }
    let mut pg = PostgreSQL::new(settings);
    pg.setup().await.context("installing Postgres")?;
    pg.start().await.context("starting Postgres")?;
    let _ = std::fs::remove_file(&first_run);
    if !pg.database_exists(config::DATABASE).await? {
        pg.create_database(config::DATABASE).await?;
    }
    Ok(pg)
}

/// A log file to append to, moved aside to `<name>.1` first once it is
/// over `limit` bytes so logs can't fill the disk.
fn append_log(path: &Path, limit: u64) -> Result<std::fs::File> {
    if std::fs::metadata(path).is_ok_and(|m| m.len() > limit) {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
    Ok(std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?)
}

const LOG_LIMIT: u64 = 20 * 1024 * 1024;

fn spawn_hub(workforce: &Path, paths: &Paths, env: &BTreeMap<String, String>) -> Result<Child> {
    let log = append_log(&paths.logs().join("hub.log"), LOG_LIMIT)?;
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

/// The hub: `--workforce <path>`, else the one beside this binary — "Desk
/// Agents" in the app bundle, `workforce` in a development build — else
/// `workforce` on PATH.
fn workforce_binary() -> PathBuf {
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--workforce"
            && let Some(p) = args.next()
        {
            return p.into();
        }
    }
    let dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    dir.and_then(|d| {
        [HUB_EXECUTABLE, "workforce"]
            .into_iter()
            .map(|n| d.join(n))
            .find(|p| p.is_file())
    })
    .unwrap_or_else(|| "workforce".into())
}

/// Whether this binary runs from inside an app bundle — the installed
/// helper, as opposed to a development build.
fn in_bundle(exe: &Path) -> bool {
    exe.to_string_lossy().contains(".app/Contents/MacOS/")
}

/// What a file is on disk: an update that replaces the app bundle gives
/// both binaries new inodes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileId {
    dev: u64,
    ino: u64,
    len: u64,
    mtime: i64,
}

fn file_id(path: &Path) -> Option<FileId> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::metadata(path).ok()?;
    Some(FileId {
        dev: m.dev(),
        ino: m.ino(),
        len: m.len(),
        mtime: m.mtime(),
    })
}

/// Resolves once any of `files` is no longer the file it was when this
/// started and its replacement has stopped changing — the app was updated
/// in place. Never resolves when `files` is empty.
async fn replaced(files: Vec<PathBuf>, every: Duration) {
    if files.is_empty() {
        return std::future::pending().await;
    }
    let start: Vec<_> = files.iter().map(|f| file_id(f)).collect();
    loop {
        tokio::time::sleep(every).await;
        let now: Vec<_> = files.iter().map(|f| file_id(f)).collect();
        if now == start {
            continue;
        }
        // Wait out the copy: the new files must exist and hold still.
        tokio::time::sleep(every).await;
        let settled: Vec<_> = files.iter().map(|f| file_id(f)).collect();
        if settled == now && settled.iter().all(Option::is_some) {
            return;
        }
    }
}

/// Logs to `logs/desk-hubd.log` when launchd started this (no terminal to
/// print to), to the terminal otherwise.
fn init_logging(paths: &Paths) {
    use std::io::IsTerminal;
    let filter =
        tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into());
    let file = (!std::io::stderr().is_terminal())
        .then(|| {
            std::fs::create_dir_all(paths.logs()).ok()?;
            append_log(&paths.logs().join("desk-hubd.log"), LOG_LIMIT).ok()
        })
        .flatten();
    match file {
        Some(f) => tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_ansi(false)
            .with_writer(std::sync::Mutex::new(f))
            .init(),
        None => tracing_subscriber::fmt().with_env_filter(filter).init(),
    }
}

/// `--forget-secrets`: deletes the keychain items this binary made — the
/// local hub's secrets and Desk's token for it — for "Remove Desk's data".
/// The keychain lets the binary that made an item delete it without asking,
/// so the app runs this rather than deleting them itself.
fn forget_secrets(paths: &Paths) -> Result<()> {
    let secrets = Secrets::for_paths(paths);
    for s in Secret::ALL {
        secrets.delete_account(s.account())?;
    }
    secrets.delete_account(&desk_core::device_token_account(desk_core::LOCAL_HUB_ID))
}

#[tokio::main]
async fn main() -> Result<()> {
    let paths = Paths::new()?;
    if std::env::args().any(|a| a == "--forget-secrets") {
        return forget_secrets(&paths);
    }
    init_logging(&paths);
    // postgresql_embedded builds reqwest with rustls but no crypto provider;
    // every HTTP client in this process shares the one installed here.
    let _ = rustls::crypto::ring::default_provider().install_default();
    for dir in [paths.hub(), paths.hub_data(), paths.logs()] {
        std::fs::create_dir_all(&dir)?;
    }
    let workforce = workforce_binary();
    // The installed helper hands over to an updated bundle: it stops when
    // its own binary or the hub's is replaced, and launchd starts the new
    // ones. A development build is left running whatever is rebuilt.
    let exe = std::env::current_exe()?;
    let watched = if in_bundle(&exe) {
        vec![exe, workforce.clone()]
    } else {
        Vec::new()
    };
    let updated = replaced(watched, Duration::from_secs(10));
    tokio::pin!(updated);
    let ports = ports(&paths)?;
    desk_core::write_private(&paths.hub_config(), &config::render(&paths, &ports))?;
    let desk_agent = paths.hub_data().join("agents").join(config::DESK_AGENT);
    config::ensure_rich(&desk_agent)?;
    config::ensure_oversight(&desk_agent)?;
    let env = hub_env(&desk_core::shell::login_env(), &Secrets::for_paths(&paths))?;
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
    let socket = paths.pty_socket();
    let outcome = loop {
        if let Err(e) = holder::ensure(
            &workforce,
            &paths,
            &socket,
            &env,
            &env[Secret::GatewayToken.env()],
        )
        .await
        {
            tracing::warn!(error = %e, "no PTY holder; the hub's terminals end when it restarts");
        }
        let started = Instant::now();
        let mut hub = match spawn_hub(&workforce, &paths, &env) {
            Ok(c) => c,
            Err(e) => break Err(e),
        };
        tokio::select! {
            _ = term.recv() => { stop(&mut hub, Duration::from_secs(20)).await; break Ok(()) }
            _ = int.recv() => { stop(&mut hub, Duration::from_secs(20)).await; break Ok(()) }
            _ = &mut updated => {
                tracing::info!("Desk was updated; handing over to the new helper");
                stop(&mut hub, Duration::from_secs(20)).await;
                break Ok(())
            }
            status = hub.wait() => {
                if started.elapsed() > HEALTHY_AFTER {
                    backoff = Duration::from_secs(1);
                }
                tracing::warn!(?status, retry_in = ?backoff, "hub exited; restarting");
                tokio::select! {
                    _ = term.recv() => break Ok(()),
                    _ = int.recv() => break Ok(()),
                    _ = &mut updated => break Ok(()),
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
            ("CLAUDE_CODE_PLUGIN_DIRS".to_string(), "/mine".to_string()),
        ]);
        let env = hub_env(&login, &Memory::default()).unwrap();
        let claude: Vec<_> = env.keys().filter(|k| k.starts_with("CLAUDE")).collect();
        // The person's own plugin folders stay; the hub adds Desk's.
        assert_eq!(claude, ["CLAUDE_CODE_PLUGIN_DIRS"]);
        assert_eq!(env["CLAUDE_CODE_PLUGIN_DIRS"], "/mine");
        for s in Secret::ALL {
            assert!(!env[s.env()].is_empty());
        }
    }

    #[test]
    fn the_hub_finds_clis_in_local_bin() {
        let login = BTreeMap::from([
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("HOME".to_string(), "/Users/k".to_string()),
        ]);
        let env = hub_env(&login, &Memory::default()).unwrap();
        assert_eq!(env["PATH"], "/usr/bin:/Users/k/.local/bin");
    }

    #[test]
    fn only_the_bundled_helper_hands_over_on_update() {
        assert!(in_bundle(Path::new(
            "/Applications/Desk.app/Contents/MacOS/Desk Helper"
        )));
        assert!(!in_bundle(Path::new("/src/desk/target/debug/desk-hubd")));
    }

    #[tokio::test]
    async fn a_replaced_binary_is_noticed_once_it_settles() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("Desk Agents");
        std::fs::write(&bin, "old").unwrap();
        let every = Duration::from_millis(20);
        let watch = tokio::spawn(replaced(vec![bin.clone()], every));
        tokio::time::sleep(every * 3).await;
        assert!(!watch.is_finished());
        let new = dir.path().join("new");
        std::fs::write(&new, "new build").unwrap();
        std::fs::rename(&new, &bin).unwrap();
        tokio::time::timeout(Duration::from_secs(2), watch)
            .await
            .expect("noticed")
            .unwrap();
    }

    #[test]
    fn logs_over_their_limit_are_moved_aside() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("hub.log");
        std::fs::write(&log, "x".repeat(100)).unwrap();
        append_log(&log, 10).unwrap();
        assert_eq!(std::fs::metadata(&log).unwrap().len(), 0);
        assert!(dir.path().join("hub.log.1").is_file());
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
