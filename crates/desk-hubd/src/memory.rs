//! The local hub's memory store: a vellev node ("Desk Memory" in the app
//! bundle, `desk-memory` on Linux) kept running beside the hub as Postgres
//! is. Loopback only, on a port Desk chose, with a key Desk keeps with its
//! other secrets; its data in Desk's folder on this computer, its commit pointer in Desk's own Postgres (a
//! database of its own), and the embedding model Desk Helper fetched for it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use desk_core::{HubPorts, MEMORY_EXECUTABLE, Paths, process};
use eyre::{Context, Result, bail};
use tokio::process::{Child, Command};
use tokio::sync::watch;

use crate::config::MEMORY_TENANT;

/// The store's own database in Desk's Postgres.
pub const DATABASE: &str = "memory";

/// How long the store is given to let go of its tenant and stop: its drain
/// and the uploads it aborts.
const STOP_GRACE: Duration = Duration::from_secs(45);

const HEALTHY_AFTER: Duration = Duration::from_secs(300);
const MAX_BACKOFF: Duration = Duration::from_secs(60);

/// The store: `--memory <path>`, else the one beside this binary ("Desk
/// Memory" in the app bundle, `desk-memory` on Linux, `vellev` in a
/// development build), else
/// `vellev` on PATH. `None` when there is none: memories then stay in the
/// hub's SQLite.
pub fn binary() -> Option<PathBuf> {
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--memory"
            && let Some(p) = args.next()
        {
            return Some(p.into());
        }
    }
    let beside = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .and_then(|d| {
            [MEMORY_EXECUTABLE, "vellev"]
                .into_iter()
                .map(|n| d.join(n))
                .find(|p| p.is_file())
        });
    beside.or_else(|| {
        std::env::var_os("PATH").and_then(|path| {
            std::env::split_paths(&path)
                .map(|d| d.join("vellev"))
                .find(|p| p.is_file())
        })
    })
}

pub fn url(ports: &HubPorts) -> String {
    format!("http://127.0.0.1:{}", ports.memory)
}

/// A `file://` URL of `path`, spaces and all ("Application Support").
fn file_url(path: &Path) -> String {
    let mut out = String::from("file://");
    for b in path.to_string_lossy().bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// The store's environment, and nothing else: its settings, its secrets
/// (never on the command line, where `ps` shows them), and a Hugging Face
/// address that leads nowhere, so that it only ever reads the model Desk
/// Helper fetched and never downloads one of its own.
pub fn env(
    paths: &Paths,
    ports: &HubPorts,
    postgres_password: &str,
    key: &str,
    login: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    for k in ["HOME", "TMPDIR", "USER", "PATH"] {
        if let Some(v) = login.get(k) {
            env.insert(k.to_string(), v.clone());
        }
    }
    let listen = format!("127.0.0.1:{}", ports.memory);
    let set = |env: &mut BTreeMap<String, String>, k: &str, v: String| {
        env.insert(k.to_string(), v);
    };
    set(&mut env, "VELLEV_LISTEN", listen.clone());
    set(&mut env, "VELLEV_ADVERTISE_URL", format!("http://{listen}"));
    set(
        &mut env,
        "VELLEV_DATABASE_URL",
        format!(
            "postgres://{}:{postgres_password}@127.0.0.1:{}/{DATABASE}",
            crate::config::DATABASE_USER,
            ports.postgres
        ),
    );
    set(&mut env, "VELLEV_DATABASE_CONNECTIONS", "4".into());
    set(&mut env, "VELLEV_STORE", file_url(&paths.memory_store()));
    set(
        &mut env,
        "VELLEV_CACHE_DIR",
        paths.memory_cache().to_string_lossy().into_owned(),
    );
    set(
        &mut env,
        "VELLEV_MODEL_DIR",
        paths.memory_models().to_string_lossy().into_owned(),
    );
    set(&mut env, "VELLEV_LOCAL_MODEL", crate::model::MODEL.into());
    set(&mut env, "VELLEV_API_KEYS", key.into());
    set(&mut env, "VELLEV_TENANTS", MEMORY_TENANT.into());
    // A day to restore to is plenty on one computer, and keeps what a restore
    // needs from piling up on its disk.
    set(&mut env, "VELLEV_RESTORE_WINDOW_SECS", "86400".into());
    set(&mut env, "HF_ENDPOINT", "http://127.0.0.1:9".into());
    set(&mut env, "RUST_LOG", "info".into());
    env
}

fn pidfile(paths: &Paths) -> PathBuf {
    paths.memory().join("store.pid")
}

fn spawn(binary: &Path, paths: &Paths, env: &BTreeMap<String, String>) -> Result<Child> {
    for dir in [
        paths.memory_store(),
        paths.memory_cache(),
        paths.memory_models(),
    ] {
        std::fs::create_dir_all(&dir)?;
    }
    let log = crate::supervise::append_log(
        &paths.logs().join("memory.log"),
        crate::supervise::LOG_LIMIT,
    )?;
    let child = Command::new(binary)
        .arg("serve")
        .current_dir(paths.memory())
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("starting {}", binary.display()))?;
    if let Some(pid) = child.id() {
        std::fs::write(pidfile(paths), pid.to_string())?;
    }
    Ok(child)
}

/// Stops a store an earlier Desk Helper left running (it was killed before
/// it could stop it), which would otherwise hold the tenant and its port.
/// Only a process that is the store's binary is stopped.
pub async fn stop_leftover(paths: &Paths, binary: &Path) {
    let Some(pid) = std::fs::read_to_string(pidfile(paths))
        .ok()
        .and_then(|p| p.trim().parse::<u32>().ok())
    else {
        return;
    };
    let name = binary
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let running = |pid: u32| async move {
        tokio::task::spawn_blocking(move || process::command_of(pid))
            .await
            .ok()
            .flatten()
    };
    if !running(pid)
        .await
        .is_some_and(|comm| process::is_program(&comm, &name))
    {
        return;
    }
    tracing::warn!(
        pid,
        "stopping the memory store an earlier Desk Helper left running"
    );
    let _ = process::terminate(pid);
    let deadline = Instant::now() + STOP_GRACE;
    while Instant::now() < deadline && running(pid).await.is_some() {
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    if running(pid).await.is_some() {
        let _ = process::kill(pid);
    }
}

/// The store, kept running: started again after it exits, sooner the
/// longer it had run, until told to stop.
pub struct Node {
    stop: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl Node {
    pub fn supervise(binary: PathBuf, paths: Paths, env: BTreeMap<String, String>) -> Self {
        let (stop, mut stopping) = watch::channel(false);
        let task = tokio::spawn(async move {
            let mut backoff = Duration::from_secs(1);
            loop {
                let started = Instant::now();
                let mut child = match spawn(&binary, &paths, &env) {
                    Ok(c) => c,
                    Err(e) => {
                        tracing::error!(error = %format!("{e:#}"), "could not start the memory store");
                        tokio::select! {
                            _ = stopping.changed() => return,
                            _ = tokio::time::sleep(backoff) => {}
                        }
                        backoff = (backoff * 2).min(MAX_BACKOFF);
                        continue;
                    }
                };
                tokio::select! {
                    _ = stopping.changed() => {
                        crate::supervise::stop(&mut child, STOP_GRACE).await;
                        let _ = std::fs::remove_file(pidfile(&paths));
                        return;
                    }
                    status = child.wait() => {
                        if started.elapsed() > HEALTHY_AFTER {
                            backoff = Duration::from_secs(1);
                        }
                        tracing::warn!(?status, retry_in = ?backoff, "memory store exited; restarting");
                        tokio::select! {
                            _ = stopping.changed() => return,
                            _ = tokio::time::sleep(backoff) => {}
                        }
                        backoff = (backoff * 2).min(MAX_BACKOFF);
                    }
                }
            }
        });
        Self { stop, task }
    }

    /// Stops the store, waiting for it to let go of its tenant.
    pub async fn stop(self) {
        let _ = self.stop.send(true);
        let _ = self.task.await;
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_default()
}

/// Waits for the store to say it is ready, for at most `within`.
pub async fn ready(url: &str, within: Duration) -> Result<()> {
    let http = client();
    let deadline = Instant::now() + within;
    loop {
        match http.get(format!("{url}/health/ready")).send().await {
            Ok(r) if r.status().is_success() => return Ok(()),
            _ if Instant::now() > deadline => {
                bail!(
                    "the memory store was not ready within {}s",
                    within.as_secs()
                )
            }
            _ => tokio::time::sleep(Duration::from_millis(500)).await,
        }
    }
}

/// Makes the tenant everything is kept in, if it isn't there (the hub
/// never makes one, so that a mistyped name can't start an empty store).
pub async fn ensure_tenant(url: &str, key: &str) -> Result<()> {
    let r = client()
        .put(format!("{url}/v1/tenants/{MEMORY_TENANT}"))
        .bearer_auth(key)
        .send()
        .await
        .context("asking the memory store for its tenant")?;
    if !r.status().is_success() {
        bail!(
            "the memory store refused its tenant: {} {}",
            r.status(),
            r.text().await.unwrap_or_default()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ports() -> HubPorts {
        HubPorts {
            postgres: 54001,
            admin: 54002,
            gateway: 54003,
            memory: 54004,
        }
    }

    #[test]
    fn the_store_listens_on_loopback_and_keeps_its_data_in_desks_folder() {
        let paths = Paths::at("/Users/k/Library/Application Support/Desk");
        let login = BTreeMap::from([
            ("HOME".to_string(), "/Users/k".to_string()),
            ("HF_HOME".to_string(), "/elsewhere".to_string()),
            ("AWS_SECRET_ACCESS_KEY".to_string(), "nope".to_string()),
        ]);
        let env = env(&paths, &ports(), "pw", "key", &login);
        assert_eq!(env["VELLEV_LISTEN"], "127.0.0.1:54004");
        assert_eq!(env["VELLEV_ADVERTISE_URL"], "http://127.0.0.1:54004");
        assert_eq!(
            env["VELLEV_STORE"],
            "file:///Users/k/Library/Application%20Support/Desk/hub/memory/store"
        );
        assert!(env["VELLEV_DATABASE_URL"].ends_with("@127.0.0.1:54001/memory"));
        assert_eq!(env["VELLEV_LOCAL_MODEL"], "BAAI/bge-base-en-v1.5");
        assert_eq!(env["VELLEV_TENANTS"], "desk");
        assert_eq!(env["HOME"], "/Users/k");
        // It reads only the model Desk fetched, where Desk put it.
        assert!(!env.contains_key("HF_HOME"));
        assert!(env["HF_ENDPOINT"].starts_with("http://127.0.0.1:"));
        assert!(!env.contains_key("AWS_SECRET_ACCESS_KEY"));
    }

    /// A stand-in for the store: a script that runs until killed, and
    /// exits at once the first time if asked to.
    fn fake_store(dir: &Path, crash_first: bool) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join("vellev");
        let marker = dir.join("ran-once");
        let script = if crash_first {
            format!(
                "#!/bin/sh\nif [ ! -f '{m}' ]; then touch '{m}'; exit 3; fi\necho started >> '{log}'\nexec sleep 600\n",
                m = marker.display(),
                log = dir.join("starts").display()
            )
        } else {
            format!(
                "#!/bin/sh\necho started >> '{}'\nexec sleep 600\n",
                dir.join("starts").display()
            )
        };
        std::fs::write(&bin, script).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }

    async fn wait_for(cond: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !cond() {
            assert!(Instant::now() < deadline, "timed out");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn pid_running(pid: u32) -> bool {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .is_ok_and(|s| s.success())
    }

    #[tokio::test]
    async fn the_store_is_started_restarted_after_a_crash_and_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path().join("Desk"));
        std::fs::create_dir_all(paths.logs()).unwrap();
        let bin = fake_store(dir.path(), true);
        let node = Node::supervise(bin, paths.clone(), BTreeMap::new());
        // The first run exits at once; the second is started a second later.
        let starts = dir.path().join("starts");
        wait_for(|| std::fs::read_to_string(&starts).is_ok_and(|s| s.lines().count() == 1)).await;
        let pid: u32 = {
            let pidfile = pidfile(&paths);
            wait_for(|| pidfile.is_file()).await;
            std::fs::read_to_string(&pidfile)
                .unwrap()
                .trim()
                .parse()
                .unwrap()
        };
        assert!(pid_running(pid));
        // Killed outright, it is started again.
        std::process::Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .status()
            .unwrap();
        wait_for(|| std::fs::read_to_string(&starts).is_ok_and(|s| s.lines().count() == 2)).await;
        let second: u32 = std::fs::read_to_string(pidfile(&paths))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert_ne!(second, pid);
        node.stop().await;
        assert!(!pid_running(second));
        assert!(!pidfile(&paths).exists());
    }

    #[tokio::test]
    async fn a_store_left_running_is_stopped_and_nothing_else_is() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path().join("Desk"));
        std::fs::create_dir_all(paths.memory()).unwrap();
        let bin = fake_store(dir.path(), false);
        let mut orphan = std::process::Command::new(&bin).spawn().unwrap();
        std::fs::write(pidfile(&paths), orphan.id().to_string()).unwrap();
        let starts = dir.path().join("starts");
        wait_for(|| starts.is_file()).await;
        // Some other process under that pid is left alone.
        let mut other = std::process::Command::new("sleep")
            .arg("600")
            .spawn()
            .unwrap();
        let other_paths = Paths::at(dir.path().join("Other"));
        std::fs::create_dir_all(other_paths.memory()).unwrap();
        std::fs::write(pidfile(&other_paths), other.id().to_string()).unwrap();
        stop_leftover(&other_paths, &bin).await;
        assert!(other.try_wait().unwrap().is_none());
        // `sh` runs the script, so `ps` names the interpreter: name the
        // script's own process by what it execs.
        stop_leftover(&paths, Path::new("/bin/sleep")).await;
        let deadline = Instant::now() + Duration::from_secs(5);
        while orphan.try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline, "the leftover store kept running");
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = other.kill();
    }
}
