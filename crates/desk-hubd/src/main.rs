//! `desk-hubd` — "Desk Helper" in the app bundle, run by launchd at login
//! as Desk's login item. Starts the local Postgres and the memory store,
//! writes the hub's config, and keeps the hub running with the user's login
//! environment and its secrets from the keychain. Stops all three on
//! SIGTERM, and when an update replaces the app bundle under it, so launchd
//! starts the new one.

mod bootstrap;
mod config;
mod memory;
mod model;
mod moving;

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
        memory: pick(saved.map(|s| s.memory).filter(|&p| p != 0))?,
    };
    if saved != Some(ports) {
        write_ports(&paths.hub_state(), &ports)?;
    }
    Ok(ports)
}

/// Environment for `workforce serve`: login env, minus anything a parent
/// Claude Code session leaked, plus the secrets.
fn hub_env(
    login: &BTreeMap<String, String>,
    secrets: &impl SecretStore,
) -> Result<BTreeMap<String, String>> {
    // `~/.local/bin` too, where Claude Code's and Codex's installers put
    // them, so one installed from Desk's settings is found without a restart.
    let mut env = desk_core::shell::with_local_bin(
        login
            .iter()
            .filter(|(k, _)| !k.starts_with("CLAUDE"))
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
    for db in [config::DATABASE, memory::DATABASE] {
        if !pg.database_exists(db).await? {
            pg.create_database(db).await?;
        }
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
    let store = memory::binary();
    // The installed helper hands over to an updated bundle: it stops when
    // its own binary, the hub's or the memory store's is replaced, and
    // launchd starts the new ones. A development build is left running
    // whatever is rebuilt.
    let exe = std::env::current_exe()?;
    let watched = if in_bundle(&exe) {
        let mut files = vec![exe, workforce.clone()];
        files.extend(store.clone());
        files
    } else {
        Vec::new()
    };
    let updated = replaced(watched, Duration::from_secs(10));
    tokio::pin!(updated);
    let ports = ports(&paths)?;
    // Once memories have moved into the store the hub always opens them
    // there: SQLite no longer holds them.
    let mut memories = if moving::moved(&paths).is_some() {
        config::Memories::Store
    } else {
        config::Memories::Sqlite
    };
    write_config(&paths, &ports, memories)?;
    let desk_agent = paths.hub_data().join("agents").join(config::DESK_AGENT);
    config::ensure_rich(&desk_agent)?;
    config::ensure_oversight(&desk_agent)?;
    let login = desk_core::shell::login_env();
    let env = hub_env(&login, &Secrets::for_paths(&paths))?;
    let pg = start_postgres(
        &paths,
        ports.postgres,
        env[Secret::PostgresPassword.env()].clone(),
    )
    .await?;

    let node = match &store {
        Some(binary) => {
            memory::stop_leftover(&paths, binary).await;
            Some(memory::Node::supervise(
                binary.clone(),
                paths.clone(),
                memory::env(
                    &paths,
                    &ports,
                    &env[Secret::PostgresPassword.env()],
                    &env[Secret::MemoryKey.env()],
                    &login,
                ),
            ))
        }
        None => {
            tracing::warn!("no memory store beside Desk Helper; memories stay in SQLite");
            None
        }
    };
    if memories == config::Memories::Store && node.is_none() {
        tracing::error!("memories are in the memory store, which is missing from this build");
    }
    // The model is fetched in the background: the hub starts on SQLite
    // meanwhile, and moves to the store once the model is here.
    let (model_ready, mut model_rx) =
        tokio::sync::watch::channel(model::installed(&paths.memory_models()));
    if node.is_some() {
        if *model_rx.borrow() {
            let _ = model::write_state(&paths.memory_model_state(), &model::State::Ready);
        } else {
            let models = paths.memory_models();
            let state = paths.memory_model_state();
            tokio::task::spawn_blocking(move || {
                model::fetch_until_installed(&models, &state, &model::HuggingFace);
                let _ = model_ready.send(true);
            });
        }
    }
    let mut switch_pending = node.is_some() && memories == config::Memories::Sqlite;
    if switch_pending && *model_rx.borrow() {
        switch_pending = false;
        memories = switch_to_store(&workforce, &paths, &ports, &env).await;
    }

    tracing::info!(gateway = %ports.gateway_url(), ?memories, "local hub starting");
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
    let outcome = 'run: loop {
        let started = Instant::now();
        let mut hub = match spawn_hub(&workforce, &paths, &env) {
            Ok(c) => c,
            Err(e) => break Err(e),
        };
        loop {
            tokio::select! {
                _ = term.recv() => { stop(&mut hub, Duration::from_secs(20)).await; break 'run Ok(()) }
                _ = int.recv() => { stop(&mut hub, Duration::from_secs(20)).await; break 'run Ok(()) }
                _ = &mut updated => {
                    tracing::info!("Desk was updated; handing over to the new helper");
                    stop(&mut hub, Duration::from_secs(20)).await;
                    break 'run Ok(())
                }
                ready = model_rx.wait_for(|&r| r), if switch_pending => {
                    switch_pending = false;
                    if ready.is_ok() {
                        tracing::info!("the memory store's model is here; moving memories into the store");
                        stop(&mut hub, Duration::from_secs(20)).await;
                        memories = switch_to_store(&workforce, &paths, &ports, &env).await;
                        tracing::info!(?memories, "local hub starting again");
                        continue 'run;
                    }
                }
                status = hub.wait() => {
                    if started.elapsed() > HEALTHY_AFTER {
                        backoff = Duration::from_secs(1);
                    }
                    tracing::warn!(?status, retry_in = ?backoff, "hub exited; restarting");
                    tokio::select! {
                        _ = term.recv() => break 'run Ok(()),
                        _ = int.recv() => break 'run Ok(()),
                        _ = &mut updated => break 'run Ok(()),
                        _ = tokio::time::sleep(backoff) => {}
                    }
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                    continue 'run;
                }
            }
        }
    };
    // The hub first, then the store it writes to, then the database both use.
    if let Some(node) = node {
        node.stop().await;
    }
    if let Err(e) = pg.stop().await {
        tracing::warn!(error = %e, "Postgres did not stop cleanly");
    }
    outcome
}

fn write_config(paths: &Paths, ports: &HubPorts, memories: config::Memories) -> Result<()> {
    desk_core::write_private(&paths.hub_config(), &config::render(paths, ports, memories))
}

/// Puts the hub's memories in the store, with the hub stopped: waits for
/// the store, makes its tenant, writes the config that says the store, and
/// moves what SQLite holds. Anything short of a checked move leaves the hub
/// on SQLite, to be tried again on the next start.
async fn switch_to_store(
    workforce: &Path,
    paths: &Paths,
    ports: &HubPorts,
    env: &BTreeMap<String, String>,
) -> config::Memories {
    let url = memory::url(ports);
    let key = &env[Secret::MemoryKey.env()];
    let moved = async {
        memory::ready(&url, Duration::from_secs(120)).await?;
        memory::ensure_tenant(&url, key).await?;
        write_config(paths, ports, config::Memories::Store)?;
        moving::move_sqlite(workforce, paths, env).await
    }
    .await;
    match moved {
        Ok(moved) => {
            tracing::info!(counts = ?moved.counts, backup = ?moved.backup, "memories are in the memory store");
            config::Memories::Store
        }
        Err(e) => {
            tracing::error!(error = %format!("{e:#}"), "could not move memories into the memory store; staying on SQLite");
            if let Err(e) = write_config(paths, ports, config::Memories::Sqlite) {
                tracing::error!(error = %e, "could not write the hub's config");
            }
            config::Memories::Sqlite
        }
    }
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
        ]);
        let env = hub_env(&login, &Memory::default()).unwrap();
        assert!(!env.keys().any(|k| k.starts_with("CLAUDE")));
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
