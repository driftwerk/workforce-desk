//! The add flow's native steps as a command, for the live check against a
//! real machine (designs/desk-remote-machines-design.md §12): with the
//! system's own `ssh`, it looks at the machine, adds it with a development
//! backend folder (a CI `backend-linux-<arch>` artifact), waits until it is
//! ready, then asks its hub for its engines through the forward. Every
//! event and state is printed; a token never is.
//!
//! ```text
//! machine-live <target> --root <folder> --backend <folder> [--yes] [--trust]
//!     [--cancel] [--log] [--remote-log] [--edit <target>] [--uninstall] [--remove]
//! ```
//!
//! `--root` holds this run's `machines.json`, backend cache and forward
//! socket: a folder of the run's own, never Desk's. `--yes` answers the
//! question before Desk runs anything there; without it, nothing runs.
//! `--remove` forgets the machine on this computer at the end (Desk stays
//! installed there, as Remove from Desk leaves it).
//!
//! The machines redesign's flows, each printed as it goes:
//! - `--trust` says yes to trusting a new host key and to reaching the
//!   machine at another address, as the person would in the native dialog;
//! - `--cancel` cancels adding once the install step runs, and stops there;
//! - `--log` prints this computer's log of it, `--remote-log` Desk's own log
//!   there (its service's, over SSH);
//! - `--edit <target>` reaches it at another address (the same host key
//!   only);
//! - `--uninstall` removes it with Desk uninstalled there, step by step.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use desk_core::machine_backend::{self, Arch, Backend};
use desk_machine::admit::{Confirm, Question};
use desk_machine::fleet::{Fleet, Host, RemoveEvent, SetupEvent, State, Timing};
use desk_machine::hostkey::{SwitchQuestion, TrustConfirm, TrustQuestion};
use desk_machine::setup::Person;
use desk_machine::{Machines, SshExe};

struct Live {
    root: PathBuf,
    folder: PathBuf,
    version: String,
}

impl Host for Live {
    fn changed(&self) {}
    fn setup(&self, event: &SetupEvent) {
        println!("setup {}", serde_json::to_string(event).expect("an event"));
    }
    fn dropped(&self, id: &str) {
        println!("dropped {id}");
    }
    fn wanted(&self) -> Result<String, String> {
        machine_backend::dev_version(&self.version, &self.folder).map_err(|e| e.to_string())
    }
    fn backend(&self, arch: Arch) -> Result<Backend, String> {
        machine_backend::development(
            &self.root.join("backend"),
            &self.folder,
            &self.version,
            arch,
        )
        .map_err(|e| e.to_string())
    }
    fn person(&self) -> Person {
        Person::default()
    }
    fn removing(&self, event: &RemoveEvent) {
        println!("remove {}", serde_json::to_string(event).expect("an event"));
    }
}

struct Answer(bool, bool);

impl Confirm for Answer {
    fn run_on(&self, q: &Question) -> bool {
        println!("asked: {}", q.text().replace('\n', " / "));
        self.0
    }
}

impl TrustConfirm for Answer {
    fn trust_key(&self, q: &TrustQuestion) -> bool {
        println!("asked: {}", q.text().replace('\n', " / "));
        self.1
    }
    fn switch_to(&self, q: &SwitchQuestion) -> bool {
        println!("asked: {}", q.text().replace('\n', " / "));
        self.1
    }
    fn uninstall(&self, q: &desk_machine::hostkey::UninstallQuestion) -> bool {
        println!("asked: {}", q.text().replace('\n', " / "));
        self.1
    }
}

/// `GET path` with `token` through the forward's socket: what came back.
#[cfg(unix)]
fn get(socket: &std::path::Path, path: &str, token: &str) -> String {
    use std::io::{Read as _, Write as _};
    let mut s =
        std::os::unix::net::UnixStream::connect(socket).unwrap_or_else(|e| fail(&e.to_string()));
    write!(
        s,
        "GET {path} HTTP/1.1\r\nhost: 127.0.0.1\r\nauthorization: Bearer {token}\r\nconnection: close\r\n\r\n"
    )
    .unwrap_or_else(|e| fail(&e.to_string()));
    let mut said = String::new();
    let _ = s.read_to_string(&mut said);
    said
}

#[cfg(not(unix))]
fn get(_: &std::path::Path, _: &str, _: &str) -> String {
    fail("machines are reached from macOS and Linux")
}

fn fail(said: &str) -> ! {
    eprintln!("machine-live: {said}");
    std::process::exit(1);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let value = |flag: &str| {
        args.windows(2)
            .find(|w| w[0] == flag)
            .map(|w| PathBuf::from(&w[1]))
    };
    let target = args
        .first()
        .filter(|t| !t.starts_with('-'))
        .unwrap_or_else(|| {
            fail("machine-live <target> --root <folder> --backend <folder> [--yes] [--remove]")
        });
    let root = value("--root").unwrap_or_else(|| fail("--root is needed"));
    let folder = value("--backend").unwrap_or_else(|| fail("--backend is needed"));
    let root_text = root.to_string_lossy();
    if root_text.contains("Application Support/Desk") || root_text.contains("/Desk-dev") {
        fail("--root must be a folder of this run's own, never Desk's");
    }
    std::fs::create_dir_all(&root).unwrap_or_else(|e| fail(&e.to_string()));
    let yes = args.iter().any(|a| a == "--yes");
    let has = |flag: &str| args.iter().any(|a| a == flag);
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let ssh = SshExe::system();
    let machines = Arc::new(Machines::new(ssh.clone(), &root.join("sockets")));
    let answer = Arc::new(Answer(yes, has("--trust")));
    let fleet = Fleet::new(
        ssh,
        Arc::clone(&machines),
        root.join("machines.json"),
        home,
        Arc::new(Live {
            root: root.clone(),
            folder,
            version: std::env::var("DESK_VERSION").unwrap_or_else(|_| "0.1.0".into()),
        }),
        answer.clone(),
        answer,
        Timing::default(),
    );

    let started = Instant::now();
    println!(
        "hosts {}",
        serde_json::to_string(&fleet.ssh_hosts()).expect("hosts")
    );
    let mut probe = fleet.probe(target).unwrap_or_else(|e| fail(&e));
    println!("probe {}", serde_json::to_string(&probe).expect("a probe"));
    if let desk_machine::probe::ProbeKey::New { fingerprint, .. } = &probe.host_key
        && has("--trust")
    {
        fleet
            .trust(target, fingerprint)
            .unwrap_or_else(|e| fail(&e));
        probe = fleet.probe(target).unwrap_or_else(|e| fail(&e));
        println!(
            "probe after trust {}",
            serde_json::to_string(&probe).expect("a probe")
        );
    }
    println!("public key found: {}", fleet.public_key().is_some());
    let id = fleet.add(target, &probe.name).unwrap_or_else(|e| fail(&e));
    println!("added {id}");
    if has("--cancel") {
        let until = Instant::now() + Duration::from_secs(10 * 60);
        while !fleet.list().iter().any(|m| m.progress.is_some()) {
            if let Some(State::Failed { message }) = fleet.state(&id) {
                fail(&format!("failed before the copy: {message}"));
            }
            if Instant::now() > until {
                fail("never reached the copy");
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let at = Instant::now();
        fleet.cancel_add(&id).unwrap_or_else(|e| fail(&e));
        while !fleet.list().is_empty() {
            std::thread::sleep(Duration::from_millis(50));
        }
        println!(
            "cancelled in {} ms; machines left: {}",
            at.elapsed().as_millis(),
            fleet.list().len()
        );
        for line in std::fs::read_to_string(root.join("machines.json"))
            .unwrap_or_default()
            .lines()
        {
            println!("machines.json {line}");
        }
        fleet.shutdown();
        return;
    }
    let until = Instant::now() + Duration::from_secs(20 * 60);
    loop {
        match fleet.state(&id) {
            Some(State::Ready) => break,
            Some(State::Failed { message }) => fail(&format!("failed: {message}")),
            Some(State::Newer) => fail("the machine is on a newer Desk"),
            _ if Instant::now() > until => fail("not ready in 20 minutes"),
            _ => std::thread::sleep(Duration::from_millis(500)),
        }
    }
    println!("ready after {:.1}s", started.elapsed().as_secs_f64());
    println!(
        "list {}",
        serde_json::to_string(&fleet.list()).expect("a list")
    );

    // The hub, through the forward's socket, with the admin token: only the
    // status line is printed.
    let link = machines.get(&id).unwrap_or_else(|| fail("no link"));
    let c = link
        .connection()
        .unwrap_or_else(|e| fail(&e))
        .unwrap_or_else(|| fail("no connection"));
    for (path, token) in [
        ("/api/desk/engines", c.admin_token.as_str()),
        ("/api/desk/folders?path=", c.admin_token.as_str()),
    ] {
        let at = Instant::now();
        let said = get(link.socket(), path, token);
        let body = said.split("\r\n\r\n").nth(1).unwrap_or_default();
        println!(
            "GET {path}: {} in {} ms, {} bytes",
            said.lines().next().unwrap_or("nothing"),
            at.elapsed().as_millis(),
            body.len()
        );
        if path == "/api/desk/engines" {
            println!("engines: {}", body.chars().take(400).collect::<String>());
        }
    }
    if has("--log") {
        for l in fleet.log(&id).unwrap_or_default() {
            println!("log {:?} {}", l.kind, l.text);
        }
    }
    if has("--remote-log") {
        match fleet.remote_log(&id, Duration::from_secs(10)) {
            Ok(said) => println!(
                "remote log: {} lines; last: {}",
                said.lines().count(),
                said.lines().last().unwrap_or("")
            ),
            Err(e) => println!("remote log refused: {e}"),
        }
    }
    if let Some(to) = value("--edit") {
        let to = to.to_string_lossy().into_owned();
        match fleet.edit(&id, Some(&to), None) {
            Ok(done) => println!(
                "edit to {to}: {}",
                serde_json::to_string(&done).expect("an edit")
            ),
            Err(e) => println!("edit to {to} refused: {e}"),
        }
        let until = Instant::now() + Duration::from_secs(120);
        while fleet.state(&id) != Some(State::Ready) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(200));
        }
        println!(
            "after edit: {}",
            serde_json::to_string(&fleet.list()).expect("a list")
        );
    }
    if has("--uninstall") {
        match fleet.uninstall(&id) {
            Ok(true) => println!("uninstalled; machines left: {}", fleet.list().len()),
            Ok(false) => println!("uninstall cancelled; nothing removed"),
            Err(e) => println!("uninstall refused: {e}"),
        }
        fleet.shutdown();
        return;
    }
    let remove = args.iter().any(|a| a == "--remove");
    if remove {
        fleet.remove(&id).unwrap_or_else(|e| fail(&e));
        println!("removed {id}; forward up: {}", link.tunnel().up().is_some());
    }
    // The forward ends with this run.
    fleet.shutdown();
    println!("forward up after: {}", link.tunnel().up().is_some());
}
