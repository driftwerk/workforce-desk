//! Keeping the hub running: Postgres, the memory store, the hub's config
//! and secrets, the PTY holder, restarts, and handing over to an update.

use std::collections::BTreeMap;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use desk_core::host::Host;
use desk_core::install::Install;
use desk_core::{HUB_EXECUTABLE, HubPorts, Paths, Secret, Secrets, read_ports, write_ports};
use eyre::{Context, Result};
use postgresql_embedded::{PostgreSQL, Settings};
use tokio::process::{Child, Command};
use tokio::signal::unix::{SignalKind, signal};

use crate::handover::HubSecrets;
use crate::{bootstrap, commands, config, holder, memory, model, moving};

const HEALTHY_AFTER: Duration = Duration::from_secs(300);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
const POSTGRES_TIMEOUT: Duration = Duration::from_secs(180);

fn free_port() -> Result<u16> {
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

/// Ports from the last run, or new ones on first run. A saved port that is
/// busy is an error, never replaced: something is already running on it,
/// and moving the hub to a new port would cut off everything that reaches
/// it on the old one. What an earlier helper left running is stopped
/// before this is asked ([`stop_leftovers`]).
fn ports(paths: &Paths) -> Result<HubPorts> {
    let saved = read_ports(&paths.hub_state())?;
    let keep = |what: &str, p: Option<u16>| -> Result<u16> {
        match p.filter(|&p| p != 0) {
            Some(p) if TcpListener::bind(("127.0.0.1", p)).is_ok() => Ok(p),
            Some(p) => eyre::bail!(
                "the local hub's {what} port {p} is in use: another Desk Helper or another \
                 program is running on it; stop it and start Desk Helper again"
            ),
            None => free_port(),
        }
    };
    let ports = HubPorts {
        postgres: keep("Postgres", saved.map(|s| s.postgres))?,
        admin: keep("admin", saved.map(|s| s.admin))?,
        gateway: keep("gateway", saved.map(|s| s.gateway))?,
        memory: keep("memory store", saved.map(|s| s.memory))?,
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
/// Claude Code session leaked (but the person's plugin folders). Never the
/// secrets: they go on a pipe ([`crate::handover`]), as anything in a
/// process's environment is readable by the person's other processes and
/// inherited by what the hub starts.
fn hub_env(login: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    // `~/.local/bin` too, where Claude Code's and Codex's installers put
    // them, so one installed from Desk's settings is found without a restart.
    desk_core::shell::with_local_bin(
        login
            .iter()
            .filter(|(k, _)| !k.starts_with("CLAUDE") || k.as_str() == PLUGIN_DIRS)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    )
}

/// The local Postgres's settings. `max_connections` is given on every
/// start rather than written into the data directory, so an install made
/// with the default of 100 takes it at its next start.
fn postgres_settings(paths: &Paths, port: u16, password: String) -> Settings {
    Settings {
        installation_dir: paths.postgres_install(),
        data_dir: paths.postgres_data(),
        password_file: paths.hub().join(".pgpass"),
        host: "127.0.0.1".into(),
        port,
        username: config::DATABASE_USER.into(),
        password,
        temporary: false,
        // The first start unpacks Postgres and runs initdb, which takes
        // longer than the default 5 s on a busy or older computer.
        timeout: Some(POSTGRES_TIMEOUT),
        configuration: [(
            "max_connections".to_string(),
            config::MAX_CONNECTIONS.to_string(),
        )]
        .into(),
        ..Settings::default()
    }
}

async fn start_postgres(paths: &Paths, port: u16, password: String) -> Result<PostgreSQL> {
    // Never one found running: it isn't this helper's to start over or stop.
    if let Some(pid) = postgres_running(paths) {
        eyre::bail!(
            "a Postgres (process {pid}) is already running on Desk's data; leaving it alone"
        );
    }
    let settings = postgres_settings(paths, port, password);
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
    let password_file = settings.password_file.clone();
    // One an older Desk or an unfinished start left goes first; setup writes
    // it again only when it runs initdb, and it goes again straight after,
    // whether setup worked or not.
    forget_postgres_password(&password_file);
    // Dropped, a `PostgreSQL` stops whatever server has a `postmaster.pid`
    // in the data directory, which before a start that worked may be
    // another's: so it is only let drop once this process started it. A
    // server a failed start left half up is stopped by the next helper, as
    // a leftover.
    let mut pg = std::mem::ManuallyDrop::new(PostgreSQL::new(settings));
    let setup = pg.setup().await;
    forget_postgres_password(&password_file);
    setup.context("installing Postgres")?;
    pg.start().await.context("starting Postgres")?;
    let pg = std::mem::ManuallyDrop::into_inner(pg);
    let _ = std::fs::remove_file(&first_run);
    for db in [config::DATABASE, memory::DATABASE] {
        if !pg.database_exists(db).await? {
            pg.create_database(db).await?;
        }
    }
    Ok(pg)
}

/// Removes Postgres's password file. Only initdb reads it, and setup writes
/// it again whenever initdb runs; left on disk it would give the database's
/// password to anything running as this user.
fn forget_postgres_password(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => tracing::warn!(error = %e, "could not remove Postgres's password file"),
    }
}

/// Why the hub stopped, when it is because it is too old for this Desk: it
/// refused `--secrets-fd` (clap's usage error, exit status 2), so it can't
/// take its secrets on the pipe.
fn too_old_for_this_desk(status: std::process::ExitStatus) -> Option<&'static str> {
    crate::handover::refused_the_pipe(status).then_some(
        "the hub is too old for this Desk: it doesn't take its secrets on a pipe \
         (--secrets-fd); install the hub this Desk ships with (hub.ref)",
    )
}

/// A log file to append to, moved aside to `<name>.1` first once it is
/// over `limit` bytes so logs can't fill the disk.
pub fn append_log(path: &Path, limit: u64) -> Result<std::fs::File> {
    if std::fs::metadata(path).is_ok_and(|m| m.len() > limit) {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
    Ok(std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?)
}

pub const LOG_LIMIT: u64 = 20 * 1024 * 1024;

/// `workforce serve` on the hub's config, with `env` and, on a pipe, the
/// secrets. The pipe is kept open by what this returns beside the command.
fn hub_command(
    workforce: &Path,
    paths: &Paths,
    env: &BTreeMap<String, String>,
    secrets: &HubSecrets,
) -> Result<(Command, crate::handover::Handover)> {
    let mut cmd = Command::new(workforce);
    cmd.args(["serve", "-c"])
        .arg(paths.hub_config())
        .current_dir(paths.hub())
        .env_clear()
        .envs(env);
    let handover = secrets.hand_to(&mut cmd)?;
    Ok((cmd, handover))
}

fn spawn_hub(
    workforce: &Path,
    paths: &Paths,
    env: &BTreeMap<String, String>,
    secrets: &HubSecrets,
) -> Result<Child> {
    let log = append_log(&paths.logs().join("hub.log"), LOG_LIMIT)?;
    let (mut cmd, _handover) = hub_command(workforce, paths, env, secrets)?;
    let child = cmd
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("starting {}", workforce.display()))?;
    if let Some(pid) = child.id() {
        std::fs::write(hub_pid(paths), pid.to_string())?;
    }
    Ok(child)
}

/// SIGTERM, then SIGKILL if it hasn't gone after `grace`.
pub async fn stop(child: &mut Child, grace: Duration) {
    if let Some(pid) = child.id() {
        let _ = desk_core::process::terminate(pid);
        if tokio::time::timeout(grace, child.wait()).await.is_ok() {
            return;
        }
    }
    let _ = child.kill().await;
}

/// The hub: `--workforce <path>`, else the one beside this binary — "Desk
/// Agents" in the app bundle, `desk-agents` on Linux, `workforce` in a
/// development build — else `workforce` on PATH.
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

/// What a file is on disk: an update that replaces the programs gives them
/// new inodes. Read through symlinks, so a flipped link reads as its new
/// target.
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

/// Logs to `logs/desk-hubd.log` when launchd, systemd or WSL's launcher
/// started this (no terminal to print to), to the terminal otherwise.
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

/// The Desk home, held by one helper for its life: a second one for the
/// same home is refused before it touches anything of the first's (its
/// ports, config, pid file, Postgres). The lock goes with the process,
/// however it ends; the file is left in place.
#[derive(Debug)]
struct RunLock {
    _file: std::fs::File,
}

impl RunLock {
    fn take(paths: &Paths) -> Result<Self> {
        let path = paths.hub().join("run").join("desk-hubd.lock");
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        // Opened close-on-exec (as std opens every file), so the hub and the
        // PTY holder it outlives don't keep the lock.
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .with_context(|| format!("opening {}", path.display()))?;
        match file.try_lock() {
            Ok(()) => Ok(Self { _file: file }),
            Err(std::fs::TryLockError::WouldBlock) => {
                let pid = std::fs::read_to_string(paths.helper_pid())
                    .map(|p| format!(" (process {})", p.trim()))
                    .unwrap_or_default();
                eyre::bail!(
                    "Desk Helper is already running for {}{pid}; leaving it alone. \
                     Stop it first (desk-hubd --stop) to start another.",
                    paths.root.display()
                )
            }
            Err(std::fs::TryLockError::Error(e)) => {
                Err(e).with_context(|| format!("locking {}", path.display()))
            }
        }
    }
}

/// Where the helper writes the hub's process id, so the next one can stop
/// a hub left running when this one was killed.
fn hub_pid(paths: &Paths) -> PathBuf {
    paths.hub().join("run").join("hub.pid")
}

/// The process a pid file names (on its first line, as Postgres's
/// `postmaster.pid` and Desk's own have it), while that process is the
/// program `name`: a pid left by one that crashed could name another by now.
pub(crate) fn left_running(pid_file: &Path, name: &str) -> Option<u32> {
    let pid: u32 = std::fs::read_to_string(pid_file)
        .ok()?
        .lines()
        .next()?
        .trim()
        .parse()
        .ok()?;
    desk_core::process::command_of(pid)
        .filter(|comm| desk_core::process::is_program(comm, name))
        .map(|_| pid)
}

/// Stops `pid`, a program `name` an earlier helper left running: SIGTERM,
/// then, when `kill`, SIGKILL after `grace`. Whether it has gone.
pub(crate) async fn stop_left_running(pid: u32, name: &str, grace: Duration, kill: bool) -> bool {
    let running = |pid: u32| {
        let name = name.to_owned();
        async move {
            tokio::task::spawn_blocking(move || {
                desk_core::process::command_of(pid)
                    .is_some_and(|comm| desk_core::process::is_program(&comm, &name))
            })
            .await
            .unwrap_or(false)
        }
    };
    let _ = desk_core::process::terminate(pid);
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline && running(pid).await {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if kill && running(pid).await {
        let _ = desk_core::process::kill(pid);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    !running(pid).await
}

fn program_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The Postgres running on Desk's data, if one is.
fn postgres_running(paths: &Paths) -> Option<u32> {
    left_running(&paths.postgres_data().join("postmaster.pid"), "postgres")
}

/// Stops what an earlier helper for this Desk home left running when it
/// was killed before it could stop them: the hub, the memory store, then
/// Postgres. Only called with the [`RunLock`] held, so none of them belongs
/// to a helper still running.
async fn stop_leftovers(paths: &Paths, workforce: &Path, store: Option<&Path>) -> Result<()> {
    let hub = program_name(workforce);
    if let Some(pid) = left_running(&hub_pid(paths), &hub) {
        tracing::warn!(pid, "stopping the hub an earlier Desk Helper left running");
        stop_left_running(pid, &hub, Duration::from_secs(20), true).await;
    }
    if let Some(store) = store {
        memory::stop_leftover(paths, store).await;
    }
    if let Some(pid) = postgres_running(paths) {
        tracing::warn!(
            pid,
            "stopping the Postgres an earlier Desk Helper left running"
        );
        if !stop_left_running(pid, "postgres", POSTGRES_TIMEOUT, false).await {
            eyre::bail!(
                "the Postgres an earlier Desk Helper left running (process {pid}) did not stop"
            );
        }
    }
    Ok(())
}

/// What this helper holds while it runs.
struct Claim {
    _lock: RunLock,
    _pid: PidFile,
    ports: HubPorts,
}

/// Takes the Desk home: refused at once while another helper runs for it;
/// then stops what an earlier, killed one left running, and takes the
/// saved ports, which must then be free.
async fn claim(paths: &Paths, workforce: &Path, store: Option<&Path>) -> Result<Claim> {
    let lock = RunLock::take(paths)?;
    let pid = PidFile::write(paths.helper_pid())?;
    stop_leftovers(paths, workforce, store).await?;
    Ok(Claim {
        _lock: lock,
        _pid: pid,
        ports: ports(paths)?,
    })
}

/// Writes this process's id where `--stop` finds it, and removes it when
/// dropped.
struct PidFile(PathBuf);

impl PidFile {
    fn write(path: PathBuf) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&path, std::process::id().to_string())
            .with_context(|| format!("writing {}", path.display()))?;
        Ok(Self(path))
    }
}

impl Drop for PidFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[tokio::main]
pub async fn run(paths: Paths, process_env: BTreeMap<String, String>) -> Result<()> {
    init_logging(&paths);
    if commands::root_on_windows_drive(&paths.root) {
        eyre::bail!(
            "Desk keeps its data in your Linux home, not on a Windows drive ({} is on one)",
            paths.root.display()
        );
    }
    // postgresql_embedded builds reqwest with rustls but no crypto provider;
    // every HTTP client in this process shares the one installed here.
    let _ = rustls::crypto::ring::default_provider().install_default();
    for dir in [paths.hub(), paths.hub_data(), paths.logs()] {
        std::fs::create_dir_all(&dir)?;
    }
    let workforce = workforce_binary();
    let store = memory::binary();
    let claimed = claim(&paths, &workforce, store.as_deref()).await?;
    let ports = claimed.ports;
    // The installed helper hands over to an update: it stops when what the
    // update replaces changes under it, and launchd, systemd or Desk Helper
    // on Windows starts the new one.
    let exe = std::env::current_exe()?;
    let mut programs = vec![exe.clone(), workforce.clone()];
    programs.extend(store.clone());
    let updated = replaced(
        Install::of(&exe, &process_env, &paths).watched(&programs),
        Duration::from_secs(10),
    );
    tokio::pin!(updated);
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
    let env = hub_env(&login);
    let secrets = HubSecrets::load(&Secrets::for_host(
        &paths,
        &Host::running_here(&process_env),
    )?)?;
    let pg = start_postgres(
        &paths,
        ports.postgres,
        secrets.get(Secret::PostgresPassword).to_owned(),
    )
    .await?;

    let node = match &store {
        Some(binary) => Some(memory::Node::supervise(
            binary.clone(),
            paths.clone(),
            memory::env(&paths, &ports, &login),
            memory::secrets(
                &ports,
                secrets.get(Secret::PostgresPassword),
                secrets.get(Secret::MemoryKey),
            ),
        )),
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
                if model::fetch_until_installed(&models, &state, &model::HuggingFace) {
                    let _ = model_ready.send(true);
                }
            });
        }
    }
    let mut switch_pending = node.is_some() && memories == config::Memories::Sqlite;
    if switch_pending && *model_rx.borrow() {
        switch_pending = false;
        memories = switch_to_store(&workforce, &paths, &ports, &env, &secrets).await;
    }

    tracing::info!(gateway = %ports.gateway_url(), ?memories, "local hub starting");
    {
        let paths = paths.clone();
        let gateway = ports.gateway_url();
        let admin = secrets.get(Secret::GatewayToken).to_owned();
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
    let outcome = 'run: loop {
        if let Err(e) = holder::ensure(
            &workforce,
            &paths,
            &socket,
            &env,
            secrets.get(Secret::GatewayToken),
        )
        .await
        {
            tracing::warn!(error = %e, "no PTY holder; the hub's terminals end when it restarts");
        }
        let started = Instant::now();
        let mut hub = match spawn_hub(&workforce, &paths, &env, &secrets) {
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
                        memories = switch_to_store(&workforce, &paths, &ports, &env, &secrets).await;
                        tracing::info!(?memories, "local hub starting again");
                        continue 'run;
                    }
                }
                status = hub.wait() => {
                    if let Some(why) = status.as_ref().ok().and_then(|s| too_old_for_this_desk(*s)) {
                        tracing::error!("{why}");
                    }
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
    let _ = std::fs::remove_file(hub_pid(&paths));
    // A download under way stops at its next read and keeps what it has.
    model::stop();
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
    secrets: &HubSecrets,
) -> config::Memories {
    let url = memory::url(ports);
    let key = secrets.get(Secret::MemoryKey);
    let moved = async {
        memory::ready(&url, Duration::from_secs(120)).await?;
        memory::ensure_tenant(&url, key).await?;
        write_config(paths, ports, config::Memories::Store)?;
        moving::move_sqlite(workforce, paths, env, secrets).await
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

    #[test]
    fn postgres_is_started_with_room_for_the_hubs_pools() {
        let paths = Paths::at("/Users/k/Library/Application Support/Desk");
        let settings = postgres_settings(&paths, 54001, "unused".into());
        assert_eq!(
            settings
                .configuration
                .get("max_connections")
                .map(String::as_str),
            Some("200")
        );
        assert_eq!(settings.data_dir, paths.postgres_data());
    }

    #[derive(Default)]
    struct Memory(RefCell<HashMap<Secret, String>>);

    impl desk_core::SecretStore for Memory {
        fn get(&self, s: Secret) -> Result<Option<String>> {
            Ok(self.0.borrow().get(&s).cloned())
        }
        fn set(&self, s: Secret, v: &str) -> Result<()> {
            self.0.borrow_mut().insert(s, v.into());
            Ok(())
        }
    }

    #[test]
    fn the_hub_gets_none_of_a_parent_claude_session() {
        let login = BTreeMap::from([
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("CLAUDE_CODE_CHILD_SESSION".to_string(), "1".to_string()),
            ("CLAUDECODE".to_string(), "1".to_string()),
            ("CLAUDE_CODE_PLUGIN_DIRS".to_string(), "/mine".to_string()),
        ]);
        let env = hub_env(&login);
        let claude: Vec<_> = env.keys().filter(|k| k.starts_with("CLAUDE")).collect();
        // The person's own plugin folders stay; the hub adds Desk's.
        assert_eq!(claude, ["CLAUDE_CODE_PLUGIN_DIRS"]);
        assert_eq!(env["CLAUDE_CODE_PLUGIN_DIRS"], "/mine");
    }

    /// The hub's command carries none of its secrets in its environment,
    /// only the descriptor they arrive on.
    #[test]
    fn the_hubs_secrets_are_not_in_its_environment() {
        let login = BTreeMap::from([
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("HOME".to_string(), "/Users/k".to_string()),
        ]);
        let secrets = HubSecrets::load(&Memory::default()).unwrap();
        let paths = Paths::at("/Users/k/Library/Application Support/Desk");
        let (cmd, _handover) =
            hub_command(Path::new("workforce"), &paths, &hub_env(&login), &secrets).unwrap();
        let env: BTreeMap<String, String> = cmd
            .as_std()
            .get_envs()
            .filter_map(|(k, v)| Some((k.to_str()?.to_string(), v?.to_str()?.to_string())))
            .collect();
        assert_eq!(
            env.keys().map(String::as_str).collect::<Vec<_>>(),
            ["HOME", "PATH", crate::handover::FD_ENV]
        );
        let args: Vec<&str> = cmd.as_std().get_args().filter_map(|a| a.to_str()).collect();
        assert_eq!(args[0], "serve");
        assert!(
            args.windows(2).any(|w| w == ["--secrets-fd", "3"]),
            "{args:?}"
        );
        for s in Secret::ALL {
            assert!(!env.contains_key(s.env()), "{}", s.env());
            assert!(
                !env.values().any(|v| v.contains(secrets.get(s))),
                "{}",
                s.env()
            );
        }
    }

    /// A Postgres password file an earlier start or an older Desk left is
    /// removed before Postgres is set up.
    #[test]
    fn a_left_over_postgres_password_file_is_removed() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        std::fs::create_dir_all(paths.hub()).unwrap();
        let settings = postgres_settings(&paths, 54001, "unused".into());
        std::fs::write(&settings.password_file, "pw-fixture").unwrap();
        forget_postgres_password(&settings.password_file);
        assert!(!settings.password_file.exists());
        // Nothing there is fine too.
        forget_postgres_password(&settings.password_file);
    }

    /// A hub that refuses `--secrets-fd` (clap's usage error, exit 2) is too
    /// old for this Desk, and is told apart from one that failed otherwise.
    #[tokio::test]
    async fn a_hub_too_old_for_the_pipe_is_named() {
        let exit = |code: i32| async move {
            Command::new("/bin/sh")
                .args(["-c", &format!("exit {code}")])
                .status()
                .await
                .unwrap()
        };
        assert!(too_old_for_this_desk(exit(2).await).is_some());
        assert!(too_old_for_this_desk(exit(1).await).is_none());
        assert!(too_old_for_this_desk(exit(0).await).is_none());
    }

    #[test]
    fn the_hub_finds_clis_in_local_bin() {
        let login = BTreeMap::from([
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("HOME".to_string(), "/Users/k".to_string()),
        ]);
        let env = hub_env(&login);
        assert_eq!(env["PATH"], "/usr/bin:/Users/k/.local/bin");
    }

    #[tokio::test]
    async fn flipping_the_current_version_is_noticed() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        for v in ["1", "2"] {
            std::fs::create_dir_all(bin.join(v)).unwrap();
            std::fs::write(bin.join(v).join("desk-helper"), format!("version {v}")).unwrap();
        }
        std::os::unix::fs::symlink("1", bin.join("current")).unwrap();
        let watched = Install::Wsl { bin: bin.clone() }.watched(&[bin.join("1/desk-helper")]);
        let every = Duration::from_millis(20);
        let watch = tokio::spawn(replaced(watched, every));
        tokio::time::sleep(every * 3).await;
        assert!(!watch.is_finished());
        std::os::unix::fs::symlink("2", bin.join("next")).unwrap();
        std::fs::rename(bin.join("next"), bin.join("current")).unwrap();
        tokio::time::timeout(Duration::from_secs(2), watch)
            .await
            .expect("noticed")
            .unwrap();
    }

    #[test]
    fn the_pid_file_is_there_while_it_runs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("run/desk-hubd.pid");
        let pid = PidFile::write(path.clone()).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            std::process::id().to_string()
        );
        drop(pid);
        assert!(!path.exists());
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

    /// A saved port that is busy means something is already running there:
    /// it is an error, and the saved ports are kept as they were.
    #[test]
    fn saved_ports_are_kept_and_a_taken_one_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        let first = ports(&paths).unwrap();
        assert_eq!(ports(&paths).unwrap(), first);
        let _held = TcpListener::bind(("127.0.0.1", first.gateway)).unwrap();
        let err = ports(&paths).unwrap_err().to_string();
        assert!(err.contains(&first.gateway.to_string()), "{err}");
        assert_eq!(read_ports(&paths.hub_state()).unwrap(), Some(first));
    }

    /// A saved state without a memory store port (an older Desk) gets one.
    #[test]
    fn a_missing_memory_port_is_given_one() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        let first = ports(&paths).unwrap();
        write_ports(&paths.hub_state(), &HubPorts { memory: 0, ..first }).unwrap();
        let next = ports(&paths).unwrap();
        assert_ne!(next.memory, 0);
        assert_eq!(
            HubPorts { memory: 0, ..next },
            HubPorts { memory: 0, ..first }
        );
    }

    /// A Postgres install whose `pg_ctl` only records what it is asked and
    /// fails to start, and a data directory that looks made.
    fn fake_postgres_install(paths: &Paths) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let version = Settings::default().version.to_string();
        let bin = paths
            .postgres_install()
            .join(version.trim_start_matches('='))
            .join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(paths.postgres_data()).unwrap();
        std::fs::write(paths.postgres_data().join("postgresql.conf"), "").unwrap();
        let log = paths.hub().join("pg_ctl.log");
        let script = format!(
            "#!/bin/sh\necho \"$@\" >> '{}'\ncase \"$*\" in *start*) exit 1;; esac\nexit 0\n",
            log.display()
        );
        std::fs::write(bin.join("pg_ctl"), script).unwrap();
        std::fs::set_permissions(bin.join("pg_ctl"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        log
    }

    /// A start that fails stops nothing: a `postmaster.pid` in the data
    /// directory may be another server's, and this one never started.
    #[tokio::test]
    async fn a_failed_start_stops_no_postgres() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        let log = fake_postgres_install(&paths);
        // One a crashed server left, naming a process that is gone.
        let mut gone = std::process::Command::new("true").spawn().unwrap();
        gone.wait().unwrap();
        std::fs::write(
            paths.postgres_data().join("postmaster.pid"),
            format!("{}\n", gone.id()),
        )
        .unwrap();
        assert!(
            start_postgres(&paths, 54001, "pw-fixture".into())
                .await
                .is_err()
        );
        let calls = std::fs::read_to_string(&log).unwrap();
        assert!(calls.contains("start"), "{calls}");
        assert!(!calls.contains("stop"), "{calls}");
    }

    /// A program named `name` that only sleeps (a link to `sleep`, which
    /// `ps` names by the link), started with its pid written to `pid_file`.
    fn fake_running(dir: &Path, name: &str, pid_file: &Path) -> std::process::Child {
        let bin = dir.join(name);
        std::os::unix::fs::symlink("/bin/sleep", &bin).unwrap();
        let child = std::process::Command::new(&bin).arg("600").spawn().unwrap();
        std::fs::create_dir_all(pid_file.parent().unwrap()).unwrap();
        std::fs::write(pid_file, format!("{}\n/some/data\n", child.id())).unwrap();
        child
    }

    async fn gone_soon(child: &mut std::process::Child) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if child.try_wait().unwrap().is_some() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    }

    #[test]
    fn a_second_helper_for_the_same_desk_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        let first = RunLock::take(&paths).unwrap();
        let err = RunLock::take(&paths).unwrap_err().to_string();
        assert!(err.contains("already running"), "{err}");
        // Another Desk home is its own.
        assert!(RunLock::take(&Paths::at(dir.path().join("Other"))).is_ok());
        drop(first);
        assert!(RunLock::take(&paths).is_ok());
    }

    /// Refused, a second helper leaves the running one's pid file, ports
    /// and processes as they were.
    #[tokio::test]
    async fn a_refused_helper_touches_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path().join("Desk"));
        let _running = RunLock::take(&paths).unwrap();
        let saved = ports(&paths).unwrap();
        let _held = TcpListener::bind(("127.0.0.1", saved.gateway)).unwrap();
        std::fs::write(paths.helper_pid(), "4242").unwrap();
        let mut hub = fake_running(dir.path(), "workforce", &hub_pid(&paths));
        let err = claim(&paths, &dir.path().join("workforce"), None)
            .await
            .err()
            .expect("refused")
            .to_string();
        assert!(err.contains("already running"), "{err}");
        assert_eq!(std::fs::read_to_string(paths.helper_pid()).unwrap(), "4242");
        assert_eq!(read_ports(&paths.hub_state()).unwrap(), Some(saved));
        assert!(
            hub.try_wait().unwrap().is_none(),
            "the running hub was stopped"
        );
        let _ = hub.kill();
    }

    /// With the Desk home claimed, a hub and a Postgres an earlier helper
    /// left running (it was killed) are stopped, and their ports kept.
    #[tokio::test]
    async fn what_a_killed_helper_left_running_is_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path().join("Desk"));
        let saved = ports(&paths).unwrap();
        let mut hub = fake_running(dir.path(), "workforce", &hub_pid(&paths));
        let mut pg = fake_running(
            dir.path(),
            "postgres",
            &paths.postgres_data().join("postmaster.pid"),
        );
        // A pid file naming some other program leaves it alone.
        let other_paths = Paths::at(dir.path().join("Other"));
        let mut other = fake_running(dir.path(), "sleepy", &hub_pid(&other_paths));
        let claimed = claim(&paths, &dir.path().join("workforce"), None)
            .await
            .unwrap();
        assert!(gone_soon(&mut hub).await, "the leftover hub kept running");
        assert!(
            gone_soon(&mut pg).await,
            "the leftover Postgres kept running"
        );
        assert_eq!(claimed.ports, saved);
        stop_leftovers(&other_paths, &dir.path().join("workforce"), None)
            .await
            .unwrap();
        assert!(other.try_wait().unwrap().is_none());
        let _ = other.kill();
    }

    /// A Postgres found running on Desk's data is never started over, nor
    /// stopped.
    #[tokio::test]
    async fn a_postgres_found_running_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path().join("Desk"));
        let log = fake_postgres_install(&paths);
        let mut pg = fake_running(
            dir.path(),
            "postgres",
            &paths.postgres_data().join("postmaster.pid"),
        );
        let err = start_postgres(&paths, 54001, "pw-fixture".into())
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("already running"), "{err}");
        assert!(!log.exists(), "pg_ctl was run");
        assert!(pg.try_wait().unwrap().is_none());
        let _ = pg.kill();
    }
}
