//! Machines against a fake `ssh` (`src/bin/fake-ssh.rs`) that answers from
//! a scenario and really forwards a port, and a fake hub behind it: what
//! Desk refuses to run, what it asks, where the tokens go, and how it
//! follows a renewed token and a moved gateway.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
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

/// A request with `token` to `gateway_url`, as the broker sends one: the
/// status line, or none when nothing answered.
fn get(gateway_url: &str, token: &str) -> Option<String> {
    let addr = gateway_url.strip_prefix("http://").unwrap();
    let mut s = TcpStream::connect(addr).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    s.write_all(
        format!("GET /api/desk/engines HTTP/1.1\r\nhost: {addr}\r\nauthorization: Bearer {token}\r\n\r\n")
            .as_bytes(),
    )
    .ok()?;
    let mut answer = String::new();
    let _ = s.read_to_string(&mut answer);
    answer.lines().next().map(str::to_string)
}

fn link(f: &Fake, target: &str) -> Link {
    let m = machine(target);
    let tunnel = Tunnel::with_timing(
        f.ssh.clone(),
        m.clone(),
        Duration::from_secs(10),
        Duration::from_millis(50),
        Duration::from_millis(400),
    );
    Link::with_tunnel(m, f.ssh.clone(), tunnel, Duration::from_secs(10))
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
    // Only `ssh -G`, which connects nowhere.
    let calls = f.calls();
    assert_eq!(calls.len(), 1);
    assert!(calls[0].contains(&"-G".to_string()));
    let q = no.last.lock().unwrap().clone().unwrap();
    assert_eq!(q.user.as_deref(), Some("dev"));
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
    let q = yes.last.lock().unwrap().clone().unwrap();
    assert!(
        q.text().contains("through bastion.example.com"),
        "{}",
        q.text()
    );
    assert!(q.text().contains("runs as ec2-user"), "{}", q.text());
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
    assert_eq!(yes.asked.load(Ordering::SeqCst), 0);
}

/// The tokens go to the forward on this computer's loopback, and from
/// there reach the hub: never anywhere else, never in an ssh command line.
#[test]
fn the_tokens_only_go_to_the_forward_on_this_computer() {
    let (box_port, seen) = hub(ADMIN);
    let f = fake(json!([host("devbox", box_port, ADMIN, DEVICE)]));
    let link = link(&f, "devbox");
    let c = link.read().unwrap().unwrap();
    let url = desk_core::net::loopback_url(&c.gateway_url).unwrap();
    assert_eq!(url.host_str(), Some("127.0.0.1"));
    assert_ne!(
        url.port(),
        Some(box_port),
        "the forward's port, not the box's"
    );
    assert_eq!(c.device_token.as_deref(), Some(DEVICE));
    assert_eq!(
        get(&c.gateway_url, &c.admin_token).as_deref(),
        Some("HTTP/1.1 200 OK")
    );
    assert_eq!(seen.lock().unwrap().last().map(String::as_str), Some(ADMIN));
    for call in f.calls() {
        let line = call.join(" ");
        assert!(!line.contains(ADMIN) && !line.contains(DEVICE), "{line}");
    }
    assert!(!format!("{c:?}").contains(ADMIN));
    assert!(!format!("{c:?}").contains(DEVICE));
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
    let old = link.read().unwrap().unwrap();
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
        get(&kept.gateway_url, &kept.admin_token).as_deref(),
        Some("HTTP/1.1 401 Unauthorized")
    );
    link.forget();
    let new = link.connection().unwrap().unwrap();
    assert_eq!(new.admin_token, "SENTINEL-ADMIN-new");
    assert_eq!(new.device_token.as_deref(), Some("SENTINEL-DEVICE-new"));
    // The same forward: the gateway didn't move.
    assert_eq!(new.gateway_url, old.gateway_url);
    assert_eq!(
        get(&new.gateway_url, &new.admin_token).as_deref(),
        Some("HTTP/1.1 200 OK")
    );
    assert_eq!(seen.lock().unwrap().len(), 2);
}

/// Desk Helper moved the machine's gateway to another port: the old
/// forward reaches nothing (ssh closes what it can't reach), reading again
/// rebuilds it on a new port here, and requests reach the hub there.
#[test]
fn a_moved_gateway_rebuilds_the_forward_on_a_new_port() {
    let gone = {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let f = fake(json!([host("devbox", gone, ADMIN, DEVICE)]));
    let link = link(&f, "devbox");
    let before = link.read().unwrap().unwrap();
    assert_eq!(
        get(&before.gateway_url, ADMIN),
        None,
        "nothing answers there"
    );
    let (moved, seen) = hub(ADMIN);
    f.say(json!([host("devbox", moved, ADMIN, DEVICE)]));
    let after = link.read().unwrap().unwrap();
    assert_ne!(after.gateway_url, before.gateway_url, "a new address here");
    assert_eq!(
        get(&after.gateway_url, ADMIN).as_deref(),
        Some("HTTP/1.1 200 OK")
    );
    assert_eq!(seen.lock().unwrap().len(), 1);
    // The old forward is gone, not left listening.
    let old = before.gateway_url.strip_prefix("http://").unwrap();
    for _ in 0..50 {
        if TcpStream::connect(old).is_err() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(TcpStream::connect(old).is_err());
    let forwards = f
        .calls()
        .iter()
        .filter(|c| c.contains(&"-L".to_string()))
        .count();
    assert_eq!(forwards, 2);
}

/// A port here that something else took between Desk choosing it and ssh
/// binding it is never taken for the forward: ssh can't bind it and ends,
/// and the tunnel says so rather than handing out that address (whatever
/// holds it would be sent the token). The next start takes another port.
#[test]
fn a_port_another_program_holds_is_never_taken_for_the_forward() {
    let (box_port, seen) = hub(ADMIN);
    let f = fake(json!([host("devbox", box_port, ADMIN, DEVICE)]));
    let link = link(&f, "devbox");
    let squatter = TcpListener::bind("127.0.0.1:0").unwrap();
    squatter.set_nonblocking(true).unwrap();
    let taken = squatter.local_addr().unwrap().port();
    link.tunnel().start_next_on(taken);
    let e = link.read().unwrap_err();
    assert!(e.contains("Could not request local forwarding"), "{e}");
    assert!(link.tunnel().up().is_none());
    assert!(squatter.accept().is_err(), "nothing was sent to it");
    let c = link.read().unwrap().unwrap();
    assert!(!c.gateway_url.ends_with(&format!(":{taken}")));
    assert_eq!(
        get(&c.gateway_url, &c.admin_token).as_deref(),
        Some("HTTP/1.1 200 OK")
    );
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert!(squatter.accept().is_err(), "nor since");
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

/// ssh ended (the network dropped, the Mac slept): the forward is started
/// again, on a new port here, and the kept tokens go through it.
#[cfg(unix)]
#[test]
fn a_forward_that_ended_is_started_again() {
    let (box_port, seen) = hub(ADMIN);
    let f = fake(json!([host("devbox", box_port, ADMIN, DEVICE)]));
    let link = link(&f, "devbox");
    let before = link.read().unwrap().unwrap();
    let spec = format!(
        "{}:127.0.0.1:{box_port}",
        before.gateway_url.strip_prefix("http://").unwrap()
    );
    let killed = std::process::Command::new("pkill")
        .args(["-f", &spec])
        .status()
        .unwrap();
    assert!(killed.success());
    let mut after = before.clone();
    for _ in 0..100 {
        after = link.connection().unwrap().unwrap();
        if after.gateway_url != before.gateway_url {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_ne!(after.gateway_url, before.gateway_url);
    assert_eq!(
        get(&after.gateway_url, &after.admin_token).as_deref(),
        Some("HTTP/1.1 200 OK")
    );
    assert_eq!(seen.lock().unwrap().len(), 1);
    // Read over SSH once: the tokens were kept.
    let reads = f
        .calls()
        .iter()
        .filter(|c| c.join(" ").contains("connection --json"))
        .count();
    assert_eq!(reads, 1);
}
