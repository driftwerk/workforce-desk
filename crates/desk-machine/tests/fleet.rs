//! Adding, upgrading and connecting to machines end to end, against a fake
//! `ssh` (`src/bin/fake-ssh.rs`) that runs Desk's scripts for real in a home
//! of the test's own, with stand-ins for `systemctl`, `loginctl`, Claude
//! Code and Codex there, and a backend whose Desk Helper is a script that
//! answers `--check`, `--machine`, `--stop` and `connection --json` as the
//! real one does. Its hub is a fake on this computer's loopback, reached
//! through the fake's real forward. The scripts are a Linux machine's
//! (`uname`, glibc, GNU `mv -T`, `sha256sum`), so these run on Linux.
#![cfg(target_os = "linux")]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use desk_core::machine_backend::{Arch, Backend};
use desk_machine::admit::{Confirm, Question};
use desk_machine::fleet::{Fleet, Host, SetupEvent, State, StepState, Timing};
use desk_machine::hostkey::{TrustConfirm, TrustQuestion};
use desk_machine::probe::{Access, ProbeKey};
use desk_machine::setup::Person;
use desk_machine::{Machines, SshExe};
use serde_json::{Value, json};

const ADMIN: &str = "SENTINEL-ADMIN-0d1e";

/// devbox's own host key, whose fingerprint is known.
const KEY: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINVryCC2LMDehVH2s0X1phBfYDkIBfEp4uRw/+7lxe8F";
const FINGERPRINT: &str = "SHA256:cMQjkpgAup3Z2qvE9D0nGAgCQu0F+mxQUK9Jc7YPO6s";

/// The machine's home, with stand-ins for what Desk runs there.
const SYSTEMCTL: &str = r#"#!/bin/sh
# systemctl --user, as far as Desk uses it.
f="$HOME/.fake"; mkdir -p "$f"
[ "$1" = --user ] && shift
# As systemd: starting one that runs does nothing; restarting starts it again.
run() { "$HOME/.local/share/Desk/bin/current/desk-helper" --machine; }
start() { [ -e "$f/running" ] || run; }
case "$1" in
  show-environment) [ -e "$f/no-systemd" ] && exit 1; exit 0 ;;
  is-enabled) [ -e "$f/enabled" ] && { echo enabled; exit 0; }; echo disabled; exit 1 ;;
  is-active) [ -e "$f/running" ] && { echo active; exit 0; }; echo inactive; exit 3 ;;
  daemon-reload) echo reload >> "$f/systemctl.log"; exit 0 ;;
  enable) touch "$f/enabled"; [ "$2" = --now ] && start; exit 0 ;;
  start) start; exit 0 ;;
  restart) run; exit 0 ;;
esac
exit 0
"#;

const LOGINCTL: &str = r#"#!/bin/sh
f="$HOME/.fake"; mkdir -p "$f"
case "$1" in
  show-user)
    v=$(cat "$f/linger" 2>/dev/null || echo no)
    case "$*" in *--value*) echo "$v" ;; *) echo "Linger=$v" ;; esac ;;
  enable-linger) [ -e "$f/linger-allowed" ] || exit 1; echo yes > "$f/linger" ;;
esac
"#;

const ENGINE: &str = "#!/bin/sh\necho \"9.9.9 (fake)\"\n";

/// `curl -fsSL <installer> -o <file>`: an installer that puts its engine
/// in `~/.local/bin`, as Claude Code's and Codex's do.
const CURL: &str = r#"#!/bin/sh
out=
while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done
case "$out" in *claude.sh) n=claude ;; *) n=codex ;; esac
cat > "$out" <<EOF
mkdir -p "\$HOME/.local/bin"
printf '#!/bin/sh\necho "1.0.0 (fake)"\n' > "\$HOME/.local/bin/$n"
chmod +x "\$HOME/.local/bin/$n"
EOF
"#;

/// Desk Helper, at version `VERSION`: running is a file saying its version
/// and the number of its start (its device token). `connection --json`
/// says the version it is itself (the one installed) and the running one's
/// token, as the real one does. A flip ends one Desk started itself; the
/// service's hands over a few reads later, as the real one notices the flip
/// after a few seconds, and starts again at the new version.
const HELPER: &str = r#"#!/bin/sh
f="$HOME/.fake"; mkdir -p "$f"
bin="$HOME/.local/share/Desk/bin"
pidfile="$HOME/.local/share/Desk/hub/run/desk-hubd.pid"
here=$(cd "$(dirname "$0")" && pwd -P)
stop() { [ -e "$pidfile" ] && kill "$(cat "$pidfile")" 2>/dev/null; rm -f "$pidfile" "$f/running"; }
case "$1" in
  --check) [ -e "$f/check-fails" ] && { echo "this machine can't run Desk" >&2; exit 1; }; exit 0 ;;
  --machine)
    stop
    n=$(( $(cat "$f/starts" 2>/dev/null || echo 0) + 1 )); echo $n > "$f/starts"
    # A process of this version's own, as the real helper is, named by
    # its pid file.
    [ -x "$here/fake-runner" ] || cp /bin/sleep "$here/fake-runner"
    mkdir -p "$(dirname "$pidfile")"
    "$here/fake-runner" 3600 </dev/null >/dev/null 2>&1 &
    echo $! > "$pidfile"
    echo "VERSION $n" > "$f/running"; exit 0 ;;
  --stop) stop; exit 0 ;;
  connection)
    [ -e "$f/running" ] || { echo null; exit 0; }
    read v n < "$f/running"
    current=$(readlink "$bin/current")
    if [ "$v" != "$current" ]; then
      if [ -e "$f/enabled" ]; then
        h=$(( $(cat "$f/handover" 2>/dev/null || echo 0) + 1 )); echo $h > "$f/handover"
        if [ $h -ge 3 ]; then rm -f "$f/handover"; "$bin/current/desk-helper" --machine; read v n < "$f/running"; fi
      else stop; echo null; exit 0; fi
    fi
    printf '{"gateway_url":"http://127.0.0.1:%s","admin_token":"ADMIN","device_token":"DEVICE-%s","version":"%s"}\n' "$(cat "$f/port")" "$n" "VERSION" ;;
esac
"#;

struct Box_ {
    dir: tempfile::TempDir,
    ssh: SshExe,
}

fn place(fake: &Path, exe: &Path) {
    if cfg!(target_os = "linux") && std::fs::hard_link(fake, exe).is_ok() {
        return;
    }
    std::fs::copy(fake, exe).unwrap();
}

fn script(path: &Path, text: &str) {
    std::fs::write(path, text).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

impl Drop for Box_ {
    /// Ends the stand-ins for the machine's helper this test started.
    fn drop(&mut self) {
        let _ = std::process::Command::new("pkill")
            .arg("-f")
            .arg(format!(
                "{}/home/.local/share/Desk/bin/",
                self.dir.path().display()
            ))
            .status();
    }
}

impl Box_ {
    fn new() -> Box_ {
        let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
        let exe = dir.path().join("ssh");
        place(Path::new(env!("CARGO_BIN_EXE_fake-ssh")), &exe);
        let b = Box_ {
            ssh: SshExe::at(exe),
            dir,
        };
        for d in ["home/.fake", "fakebin", "mac/.ssh", "backends"] {
            std::fs::create_dir_all(b.dir.path().join(d)).unwrap();
        }
        script(&b.dir.path().join("fakebin/systemctl"), SYSTEMCTL);
        script(&b.dir.path().join("fakebin/loginctl"), LOGINCTL);
        script(&b.dir.path().join("fakebin/claude"), ENGINE);
        script(&b.dir.path().join("fakebin/codex"), ENGINE);
        b.say(None);
        b
    }

    fn home(&self) -> PathBuf {
        self.dir.path().join("home")
    }

    fn fake(&self, name: &str) -> PathBuf {
        self.home().join(".fake").join(name)
    }

    fn known_hosts(&self) -> PathBuf {
        self.dir.path().join("mac/.ssh/known_hosts")
    }

    /// What devbox says from now on; with `key`, the host key it shows.
    fn say(&self, key: Option<&str>) {
        self.say_with(key, "");
    }

    /// As [`Box_::say`], with `more` in its SSH settings.
    fn say_with(&self, key: Option<&str>, more: &str) {
        let host = json!({
            "target": "devbox",
            "settings": format!(
                "user dev\nhostname 203.0.113.7\nport 22\nidentityfile {}\nuserknownhostsfile {} {}\n{more}",
                self.dir.path().join("mac/.ssh/id_ed25519").display(),
                self.known_hosts().display(),
                self.dir.path().join("mac/.ssh/known_hosts2").display(),
            ),
            "exec": {"home": self.home(), "path": self.dir.path().join("fakebin")},
            "host_key": key,
        });
        std::fs::write(
            self.dir.path().join("scenario.json"),
            json!({"log": self.dir.path().join("calls.jsonl"), "hosts": [host]}).to_string(),
        )
        .unwrap();
    }

    /// Several addresses at once: each `(target, key)`, all the one home
    /// (the same machine, or the same account on it, whatever its key).
    fn say_hosts(&self, hosts: &[(&str, Option<&str>)]) {
        let hosts: Vec<Value> = hosts
            .iter()
            .map(|(target, key)| {
                json!({
                    "target": target,
                    "settings": format!(
                        "user dev\nhostname 203.0.113.7\nport 22\nidentityfile {}\nuserknownhostsfile {}\n",
                        self.dir.path().join("mac/.ssh/id_ed25519").display(),
                        self.known_hosts().display(),
                    ),
                    "exec": {"home": self.home(), "path": self.dir.path().join("fakebin")},
                    "host_key": key,
                })
            })
            .collect();
        std::fs::write(
            self.dir.path().join("scenario.json"),
            json!({"log": self.dir.path().join("calls.jsonl"), "hosts": hosts}).to_string(),
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

    /// A backend at `version`, packed as the release packs one.
    fn backend(&self, version: &str) -> PathBuf {
        let src = self.dir.path().join("backends").join(version);
        std::fs::create_dir_all(src.join("claude-plugin")).unwrap();
        script(
            &src.join("desk-helper"),
            &HELPER.replace("VERSION", version),
        );
        script(&src.join("desk-agents"), "#!/bin/sh\n");
        script(&src.join("desk-memory"), "#!/bin/sh\n");
        std::fs::write(src.join("claude-plugin/plugin.json"), "{}").unwrap();
        let tarball = self
            .dir
            .path()
            .join("backends")
            .join(format!("{version}.tar.gz"));
        let ok = std::process::Command::new("tar")
            .arg("-czf")
            .arg(&tarball)
            .arg("-C")
            .arg(&src)
            .args(["desk-helper", "desk-agents", "desk-memory", "claude-plugin"])
            .status()
            .unwrap()
            .success();
        assert!(ok);
        tarball
    }

    fn installed(&self) -> Option<String> {
        std::fs::read_link(self.home().join(".local/share/Desk/bin/current"))
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    }
}

/// A hub on this computer's loopback that answers 200 to the admin token
/// and `good`'s device token, and 401 to any other.
fn hub(good: Arc<Mutex<String>>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
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
            let status = if auth == *good.lock().unwrap() || auth == "ADMIN" {
                "200 OK"
            } else {
                "401 Unauthorized"
            };
            let _ = s.write_all(
                format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                    .as_bytes(),
            );
        }
    });
    port
}

/// A request with `token` through the forward's socket, as the broker
/// sends one: the status line, or none when nothing answered.
fn status(socket: &Path, token: &str) -> Option<String> {
    let addr = "127.0.0.1";
    let mut s = UnixStream::connect(socket).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    write!(
        s,
        "GET /api/desk/engines HTTP/1.1\r\nhost: {addr}\r\nauthorization: Bearer {token}\r\nconnection: close\r\n\r\n"
    )
    .ok()?;
    let mut said = String::new();
    let _ = s.read_to_string(&mut said);
    said.lines().next().map(str::to_string)
}

#[derive(Default)]
struct Said {
    changes: AtomicUsize,
    events: Mutex<Vec<SetupEvent>>,
    dropped: Mutex<Vec<String>>,
}

struct TestHost {
    said: Arc<Said>,
    wanted: String,
    tarball: PathBuf,
}

impl Host for TestHost {
    fn changed(&self) {
        self.said.changes.fetch_add(1, Ordering::SeqCst);
    }
    fn setup(&self, event: &SetupEvent) {
        self.said.events.lock().unwrap().push(event.clone());
    }
    fn dropped(&self, id: &str) {
        self.said.dropped.lock().unwrap().push(id.to_string());
    }
    fn wanted(&self) -> Result<String, String> {
        Ok(self.wanted.clone())
    }
    fn backend(&self, arch: Arch) -> Result<Backend, String> {
        Ok(Backend {
            version: self.wanted.clone(),
            arch,
            tarball: self.tarball.clone(),
            data: std::fs::read(&self.tarball).map_err(|e| e.to_string())?,
            signed: false,
        })
    }
    fn person(&self) -> Person {
        Person {
            name: Some("Ada Lovelace".into()),
            email: Some("ada@example.com".into()),
        }
    }
}

struct Yes(AtomicUsize, bool);

impl Confirm for Yes {
    fn run_on(&self, _: &Question) -> bool {
        self.0.fetch_add(1, Ordering::SeqCst);
        self.1
    }
}

impl TrustConfirm for Yes {
    fn trust_key(&self, _: &TrustQuestion) -> bool {
        self.0.fetch_add(1, Ordering::SeqCst);
        self.1
    }
    fn switch_to(&self, _: &desk_machine::hostkey::SwitchQuestion) -> bool {
        self.0.fetch_add(1, Ordering::SeqCst);
        self.1
    }
}

fn timing() -> Timing {
    Timing {
        ready_within: Duration::from_secs(20),
        step_within: Duration::from_secs(20),
        poll: Duration::from_millis(100),
        check_every: Duration::from_millis(200),
        first_backoff: Duration::from_millis(200),
        max_backoff: Duration::from_secs(1),
        linger_poll: Duration::from_millis(200),
        linger_for: Duration::from_secs(20),
        admitted_for: Duration::from_secs(60),
        edit_within: Duration::from_secs(2),
    }
}

struct Run {
    fleet: Arc<Fleet>,
    machines: Arc<Machines>,
    said: Arc<Said>,
    asked: Arc<Yes>,
}

impl Run {
    fn list_target(&self) -> String {
        self.fleet.list()[0].target.clone()
    }
}

fn fleet(b: &Box_, wanted: &str, answer: bool) -> Run {
    let said = Arc::new(Said::default());
    let asked = Arc::new(Yes(AtomicUsize::new(0), answer));
    let machines = Arc::new(Machines::new(b.ssh.clone(), &b.dir.path().join("socks")));
    let tarball = b.backend(wanted);
    let fleet = Fleet::new(
        b.ssh.clone(),
        Arc::clone(&machines),
        b.dir.path().join("mac/machines.json"),
        b.dir.path().join("mac"),
        Arc::new(TestHost {
            said: Arc::clone(&said),
            wanted: wanted.into(),
            tarball,
        }),
        asked.clone(),
        asked.clone(),
        timing(),
    );
    Run {
        fleet,
        machines,
        said,
        asked,
    }
}

fn until(what: &str, f: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !f() {
        assert!(Instant::now() < deadline, "waited for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn step(r: &Run, step: &str, state: StepState) -> Option<SetupEvent> {
    r.said
        .events
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|e| serde_json::to_value(e.step).unwrap() == json!(step) && e.state == state)
        .cloned()
}

/// The fake hub's port, and the device token it takes.
fn serve(b: &Box_) -> Arc<Mutex<String>> {
    let good = Arc::new(Mutex::new("DEVICE-1".to_string()));
    let port = hub(Arc::clone(&good));
    std::fs::write(b.fake("port"), port.to_string()).unwrap();
    good
}

#[test]
fn adding_a_machine_installs_starts_and_connects_it() {
    let b = Box_::new();
    let _hub = serve(&b);
    std::fs::write(b.fake("linger-allowed"), "").unwrap();
    let r = fleet(&b, "0.2.0", true);
    let id = r.fleet.add("devbox", "devbox").unwrap();
    assert_eq!(id, "devbox");
    until("ready", || r.fleet.state(&id) == Some(State::Ready));
    assert_eq!(r.asked.0.load(Ordering::SeqCst), 1, "asked once");
    // The yes was used up by the add: looking again asks again.
    r.fleet.probe("devbox").unwrap();
    assert_eq!(r.asked.0.load(Ordering::SeqCst), 2, "asked again");

    let connect = step(&r, "connect", StepState::Done).unwrap();
    assert!(connect.detail.unwrap().starts_with("Connected as "));
    let install = step(&r, "install", StepState::Done).unwrap();
    assert_eq!(
        install.detail.as_deref(),
        Some("Desk 0.2.0 installed, and set to start when it boots")
    );
    let engines = step(&r, "engines", StepState::Done).unwrap();
    assert_eq!(
        engines.detail.as_deref(),
        Some("Claude Code 9.9.9 and Codex 9.9.9 installed")
    );

    // Installed as the install scripts lay it out, and its service has an
    // absolute ExecStart in machine mode, told who its owner is.
    assert_eq!(b.installed().as_deref(), Some("0.2.0"));
    // Desk's folder there is marked a machine's (its secrets in a file).
    assert!(b.home().join(".local/share/Desk/machine").is_file());
    let unit =
        std::fs::read_to_string(b.home().join(".config/systemd/user/desk-helper.service")).unwrap();
    let exec = unit.lines().find(|l| l.starts_with("ExecStart=")).unwrap();
    assert!(
        exec.contains(&format!(
            "{}/.local/share/Desk/bin/current/desk-helper",
            b.home().display()
        )) && exec.contains("--machine"),
        "{unit}"
    );
    assert!(unit.contains("Ada Lovelace"), "{unit}");
    assert_eq!(
        std::fs::read_to_string(b.fake("linger")).unwrap().trim(),
        "yes"
    );
    // Nothing of a partial copy is left.
    let bin: Vec<String> = std::fs::read_dir(b.home().join(".local/share/Desk/bin"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(!bin.iter().any(|n| n.contains("partial")), "{bin:?}");

    // Kept, without a secret, and listed as the page reads it.
    let kept = std::fs::read_to_string(b.dir.path().join("mac/machines.json")).unwrap();
    assert!(!kept.contains(ADMIN) && !kept.contains("DEVICE"), "{kept}");
    let kept: Value = serde_json::from_str(&kept).unwrap();
    assert_eq!(kept[0]["id"], "devbox");
    assert_eq!(kept[0]["version"], "0.2.0");
    let row = serde_json::to_value(&r.fleet.list()[0]).unwrap();
    assert_eq!(row["state"], "ready");
    assert_eq!(row["version"], "0.2.0");
    assert!(row["system"]["arch"].is_string());

    // The machine's hub is reached through the forward, with its token.
    let link = r.machines.get(&id).unwrap();
    let c = link.connection().unwrap().unwrap();
    assert_eq!(
        status(link.socket(), c.device_token.as_deref().unwrap()).as_deref(),
        Some("HTTP/1.1 200 OK")
    );
    // No token ever went into an ssh command line.
    assert!(
        b.calls()
            .iter()
            .flatten()
            .all(|a| !a.contains("ADMIN") && !a.contains("DEVICE-"))
    );
}

#[test]
fn without_linger_desk_starts_itself_and_says_the_line_to_run() {
    let b = Box_::new();
    let _hub = serve(&b);
    let r = fleet(&b, "0.2.0", true);
    let id = r.fleet.add("devbox", "devbox").unwrap();
    until("blocked", || {
        step(&r, "install", StepState::Blocked).is_some()
    });
    let blocked = step(&r, "install", StepState::Blocked).unwrap();
    let line = blocked.line.unwrap();
    assert!(line.starts_with("sudo loginctl enable-linger "), "{line}");
    // Nothing asked sudo for it.
    assert!(
        b.calls()
            .iter()
            .flatten()
            .all(|a| !a.contains("sudo -n") && !a.contains("sudo loginctl"))
    );
    until("ready", || r.fleet.state(&id) == Some(State::Ready));
    assert!(!b.fake("enabled").exists(), "no service without linger");
    assert!(b.fake("running").exists(), "started by Desk");

    // Once someone turns linger on, Desk moves itself to its service.
    std::fs::write(b.fake("linger"), "yes").unwrap();
    until("the service", || {
        step(&r, "install", StepState::Done).is_some()
    });
    assert!(b.fake("enabled").exists());
}

#[test]
fn an_older_machine_is_upgraded_when_desk_connects() {
    let b = Box_::new();
    let _hub = serve(&b);
    std::fs::write(b.fake("linger-allowed"), "").unwrap();
    let first = fleet(&b, "0.1.0", true);
    let id = first.fleet.add("devbox", "devbox").unwrap();
    until("ready at 0.1.0", || {
        first.fleet.state(&id) == Some(State::Ready)
    });
    first.fleet.shutdown();

    // This Desk is newer: the machine is upgraded as it connects.
    let r = fleet(&b, "0.2.0", true);
    r.fleet.load();
    until("ready at 0.2.0", || {
        r.fleet.state(&id) == Some(State::Ready)
            && r.fleet.list()[0].version.as_deref() == Some("0.2.0")
    });
    assert_eq!(b.installed().as_deref(), Some("0.2.0"));
    // Ready once the new version's helper runs, not while the one before
    // was still handing over.
    assert!(
        std::fs::read_to_string(b.fake("running"))
            .unwrap()
            .starts_with("0.2.0 "),
        "the helper running is the new one"
    );
    // The version before is kept beside it.
    assert!(b.home().join(".local/share/Desk/bin/0.1.0").is_dir());
    let kept: Value = serde_json::from_str(
        &std::fs::read_to_string(b.dir.path().join("mac/machines.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(kept[0]["version"], "0.2.0");
    // Nobody is asked to connect to a machine already added.
    assert_eq!(r.asked.0.load(Ordering::SeqCst), 0);
    let c = r.machines.get(&id).unwrap().connection().unwrap().unwrap();
    assert_eq!(c.version.as_deref(), Some("0.2.0"));
}

#[test]
fn a_machine_on_a_newer_desk_is_driven_no_further() {
    let b = Box_::new();
    let _hub = serve(&b);
    std::fs::write(b.fake("linger-allowed"), "").unwrap();
    let first = fleet(&b, "0.3.0", true);
    let id = first.fleet.add("devbox", "devbox").unwrap();
    until("ready at 0.3.0", || {
        first.fleet.state(&id) == Some(State::Ready)
    });
    first.fleet.shutdown();

    let r = fleet(&b, "0.2.0", true);
    r.fleet.load();
    until("newer", || r.fleet.state(&id) == Some(State::Newer));
    // Not downgraded, not reached.
    assert_eq!(b.installed().as_deref(), Some("0.3.0"));
    assert!(!b.home().join(".local/share/Desk/bin/0.2.0").exists());
    assert!(r.machines.get(&id).is_none());
    assert!(!r.fleet.drivable(&id));
    assert_eq!(*r.said.dropped.lock().unwrap(), vec![id.clone()]);
    let row = serde_json::to_value(&r.fleet.list()[0]).unwrap();
    assert_eq!(row["state"], "newer");
    assert_eq!(row["version"], "0.3.0");
}

#[test]
fn a_restarted_helper_is_followed_to_its_new_token() {
    let b = Box_::new();
    let good = serve(&b);
    std::fs::write(b.fake("linger-allowed"), "").unwrap();
    let r = fleet(&b, "0.2.0", true);
    let id = r.fleet.add("devbox", "devbox").unwrap();
    until("ready", || r.fleet.state(&id) == Some(State::Ready));
    let link = r.machines.get(&id).unwrap();
    let before = link.connection().unwrap().unwrap();
    let old = before.device_token.clone().unwrap();
    *good.lock().unwrap() = old.clone();

    // The machine's helper restarts (a crash, a reboot): a new device token,
    // and the old one is refused.
    std::process::Command::new(b.home().join(".local/share/Desk/bin/current/desk-helper"))
        .arg("--machine")
        .env("HOME", b.home())
        .status()
        .unwrap();
    let now = std::fs::read_to_string(b.fake("starts")).unwrap();
    *good.lock().unwrap() = format!("DEVICE-{}", now.trim());
    assert_eq!(
        status(link.socket(), &old).as_deref(),
        Some("HTTP/1.1 401 Unauthorized")
    );
    // Read again over ssh, as chat and the Floor do on a 401: the new one.
    let after = link.read().unwrap().unwrap();
    assert_ne!(after.device_token.as_deref(), Some(old.as_str()));
    assert_eq!(
        status(link.socket(), after.device_token.as_deref().unwrap()).as_deref(),
        Some("HTTP/1.1 200 OK")
    );

    // A helper that stopped is started again at the next connect.
    std::process::Command::new(b.home().join(".local/share/Desk/bin/current/desk-helper"))
        .arg("--stop")
        .env("HOME", b.home())
        .status()
        .unwrap();
    r.fleet.reconnect(&id).unwrap();
    until("running again", || b.fake("running").exists());
    until("ready again", || r.fleet.state(&id) == Some(State::Ready));
}

#[test]
fn a_removed_machine_is_reached_no_more() {
    let b = Box_::new();
    let _hub = serve(&b);
    std::fs::write(b.fake("linger-allowed"), "").unwrap();
    let r = fleet(&b, "0.2.0", true);
    let id = r.fleet.add("devbox", "devbox").unwrap();
    until("ready", || r.fleet.state(&id) == Some(State::Ready));
    let link = r.machines.get(&id).unwrap();
    assert!(link.tunnel().up().is_some());

    r.fleet.probe("devbox").unwrap();
    let asked = r.asked.0.load(Ordering::SeqCst);
    r.fleet.remove(&id).unwrap();
    // Removing it takes back the yes to it.
    r.fleet.probe("devbox").unwrap();
    assert_eq!(r.asked.0.load(Ordering::SeqCst), asked + 1, "asked again");
    assert!(r.fleet.list().is_empty());
    assert!(r.machines.get(&id).is_none());
    assert_eq!(*r.said.dropped.lock().unwrap(), vec![id.clone()]);
    // Its forward ends though something still holds the link.
    until("the forward gone", || link.tunnel().up().is_none());
    let kept: Value = serde_json::from_str(
        &std::fs::read_to_string(b.dir.path().join("mac/machines.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(kept, json!([]));
    // Desk stays installed there.
    assert_eq!(b.installed().as_deref(), Some("0.2.0"));
    assert!(r.fleet.reconnect(&id).is_err());
}

#[test]
fn a_new_host_key_is_shown_then_trusted_only_as_it_was_shown() {
    let b = Box_::new();
    b.say(Some(KEY));
    let r = fleet(&b, "0.2.0", true);

    // Trusting needs a look first, which the person said yes to.
    assert!(r.fleet.trust("devbox", FINGERPRINT).is_err());
    assert!(b.calls().is_empty(), "nothing ran");

    let p = r.fleet.probe("devbox").unwrap();
    assert_eq!(
        p.host_key,
        ProbeKey::New {
            fingerprint: FINGERPRINT.into(),
            key_type: "ED25519".into()
        }
    );
    assert_eq!(p.access, None);
    assert_eq!(r.asked.0.load(Ordering::SeqCst), 1);

    // Another fingerprint than the one the machine shows: refused, unasked.
    let other = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    assert!(
        r.fleet
            .trust("devbox", other)
            .unwrap_err()
            .contains("another key")
    );
    assert!(!b.known_hosts().exists());
    assert_eq!(r.asked.0.load(Ordering::SeqCst), 1);

    r.fleet.trust("devbox", FINGERPRINT).unwrap();
    assert_eq!(r.asked.0.load(Ordering::SeqCst), 2, "the trust question");
    assert_eq!(
        std::fs::read_to_string(b.known_hosts()).unwrap(),
        format!("devbox {KEY}\n")
    );
    let p = r.fleet.probe("devbox").unwrap();
    assert_eq!(p.host_key, ProbeKey::Known);
    assert!(matches!(p.access, Some(Access::Ok { .. })), "{p:?}");
    assert_eq!(
        r.asked.0.load(Ordering::SeqCst),
        2,
        "the yes to look stands"
    );
}

#[test]
fn a_changed_host_key_is_never_trusted() {
    let b = Box_::new();
    b.say(Some(KEY));
    std::fs::write(
        b.known_hosts(),
        "devbox ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOZhZmFrZWtleWZha2VrZXlmYWtla2V5ZmFrZWtleWY=\n",
    )
    .unwrap();
    let r = fleet(&b, "0.2.0", true);
    let p = r.fleet.probe("devbox").unwrap();
    assert_eq!(
        p.host_key,
        ProbeKey::Changed {
            fingerprint: FINGERPRINT.into(),
            key_type: "ED25519".into()
        }
    );
    assert!(r.fleet.trust("devbox", FINGERPRINT).is_err());
    assert_eq!(
        std::fs::read_to_string(b.known_hosts())
            .unwrap()
            .lines()
            .count(),
        1
    );
}

#[test]
fn a_cancel_runs_nothing_there() {
    let b = Box_::new();
    let r = fleet(&b, "0.2.0", false);
    assert!(r.fleet.probe("devbox").unwrap_err().contains("cancelled"));
    assert!(r.fleet.add("-oProxyCommand=x", "x").is_err());
    assert!(b.calls().is_empty(), "{:?}", b.calls());
    assert!(r.fleet.list().is_empty());
}

#[test]
fn a_copy_that_fails_its_check_is_never_flipped_to() {
    let b = Box_::new();
    let _hub = serve(&b);
    std::fs::write(b.fake("check-fails"), "").unwrap();
    let r = fleet(&b, "0.2.0", true);
    let id = r.fleet.add("devbox", "devbox").unwrap();
    until("failed", || {
        step(&r, "install", StepState::Failed).is_some()
    });
    let failed = step(&r, "install", StepState::Failed).unwrap();
    assert!(
        failed
            .message
            .unwrap()
            .contains("this machine can't run Desk"),
        "the machine's words"
    );
    assert_eq!(b.installed(), None);
    assert!(matches!(r.fleet.state(&id), Some(State::Failed { .. })));
    // Not kept: it was never added.
    assert!(!b.dir.path().join("mac/machines.json").exists());
    // An unsigned development build is said where it is added.
    // (Among its progress, which says no message.)
    assert!(
        r.said
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e.state == StepState::Running
                && e.message
                    .as_deref()
                    .is_some_and(|m| m.contains("isn't checked"))),
        "the development build is said"
    );

    // "Try again" once the machine can: added from the start.
    std::fs::remove_file(b.fake("check-fails")).unwrap();
    std::fs::write(b.fake("linger-allowed"), "").unwrap();
    r.fleet.reconnect(&id).unwrap();
    until("ready", || r.fleet.state(&id) == Some(State::Ready));
    assert_eq!(b.installed().as_deref(), Some("0.2.0"));
    let kept: Value = serde_json::from_str(
        &std::fs::read_to_string(b.dir.path().join("mac/machines.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(kept[0]["id"], "devbox");
}

#[test]
fn engines_installed_there_restart_desk_so_its_hub_finds_them() {
    let b = Box_::new();
    let _hub = serve(&b);
    std::fs::write(b.fake("linger-allowed"), "").unwrap();
    for e in ["claude", "codex"] {
        std::fs::remove_file(b.dir.path().join("fakebin").join(e)).unwrap();
    }
    script(&b.dir.path().join("fakebin/curl"), CURL);
    let r = fleet(&b, "0.2.0", true);
    let id = r.fleet.add("devbox", "devbox").unwrap();
    until("ready", || r.fleet.state(&id) == Some(State::Ready));
    let engines = step(&r, "engines", StepState::Done).unwrap();
    assert_eq!(
        engines.detail.as_deref(),
        Some("Claude Code 1.0.0 and Codex 1.0.0 installed")
    );
    assert!(b.home().join(".local/bin/claude").exists());
    // Started once by its service, and again after the engines came.
    let starts: u32 = std::fs::read_to_string(b.fake("starts"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(starts >= 2, "{starts}");
    let c = r.machines.get(&id).unwrap().connection().unwrap().unwrap();
    assert_eq!(c.device_token, Some(format!("DEVICE-{starts}")));
}

#[test]
fn a_config_with_forwards_is_never_connected_to_to_trust_its_key() {
    let b = Box_::new();
    b.say_with(
        Some(KEY),
        "localforward [127.0.0.1]:5432 [10.0.1.30]:5432\n",
    );
    let r = fleet(&b, "0.2.0", true);
    // The look is refused (after the yes, before connecting); so is trusting.
    assert!(r.fleet.probe("devbox").unwrap_err().contains("forwards"));
    assert!(
        r.fleet
            .trust("devbox", FINGERPRINT)
            .unwrap_err()
            .contains("forwards")
    );
    assert!(
        b.calls().iter().all(|c| c.contains(&"-G".to_string())),
        "nothing but ssh -G ran: {:?}",
        b.calls()
    );
    assert!(!b.known_hosts().exists());
}

#[test]
fn an_account_that_runs_desktop_desk_is_never_taken_over() {
    let b = Box_::new();
    let _hub = serve(&b);
    std::fs::write(b.fake("linger-allowed"), "").unwrap();
    // Desktop Desk there: its folder, its keyring store, its own service.
    let root = b.home().join(".local/share/Desk");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("keys.toml"), "store = \"system\"\n").unwrap();
    let unit = b.home().join(".config/systemd/user/desk-helper.service");
    std::fs::create_dir_all(unit.parent().unwrap()).unwrap();
    std::fs::write(&unit, "[Service]\nExecStart=/usr/bin/desk-helper\n").unwrap();
    let r = fleet(&b, "0.2.0", true);
    let p = r.fleet.probe("devbox").unwrap();
    assert!(
        matches!(&p.access, Some(Access::Unreachable { message, .. }) if message.contains("desktop app")),
        "{p:?}"
    );
    let id = r.fleet.add("devbox", "devbox").unwrap();
    until("refused", || {
        step(&r, "connect", StepState::Failed).is_some()
    });
    assert!(matches!(r.fleet.state(&id), Some(State::Failed { .. })));
    // Nothing there changed.
    assert_eq!(b.installed(), None);
    assert!(!root.join("machine").exists());
    assert_eq!(
        std::fs::read_to_string(&unit).unwrap(),
        "[Service]\nExecStart=/usr/bin/desk-helper\n"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("keys.toml")).unwrap(),
        "store = \"system\"\n"
    );
}

#[test]
fn a_windows_desks_wsl_backend_is_never_taken_over() {
    let b = Box_::new();
    let _hub = serve(&b);
    std::fs::write(b.fake("linger-allowed"), "").unwrap();
    // As desk-wsl installs it: versions under bin, current flipped, file
    // keys; no marker, no service.
    let root = b.home().join(".local/share/Desk");
    std::fs::create_dir_all(root.join("bin/0.1.0")).unwrap();
    std::os::unix::fs::symlink("0.1.0", root.join("bin/current")).unwrap();
    std::fs::write(root.join("keys.toml"), "store = \"file\"\n").unwrap();
    let r = fleet(&b, "0.2.0", true);
    let p = r.fleet.probe("devbox").unwrap();
    assert!(
        matches!(&p.access, Some(Access::Unreachable { message, .. }) if message.contains("desktop app")),
        "{p:?}"
    );
    let id = r.fleet.add("devbox", "devbox").unwrap();
    until("refused", || {
        step(&r, "connect", StepState::Failed).is_some()
    });
    assert!(matches!(r.fleet.state(&id), Some(State::Failed { .. })));
    assert_eq!(b.installed().as_deref(), Some("0.1.0"), "not flipped");
    assert!(!root.join("machine").exists());
}

#[test]
fn a_machine_installed_before_the_marker_is_still_a_machine() {
    let b = Box_::new();
    let _hub = serve(&b);
    std::fs::write(b.fake("linger-allowed"), "").unwrap();
    // As devbox was: installed, its service in machine mode, no marker.
    let root = b.home().join(".local/share/Desk");
    std::fs::create_dir_all(root.join("bin/0.1.0")).unwrap();
    std::os::unix::fs::symlink("0.1.0", root.join("bin/current")).unwrap();
    std::fs::write(root.join("keys.toml"), "store = \"file\"\n").unwrap();
    let unit = b.home().join(".config/systemd/user/desk-helper.service");
    std::fs::create_dir_all(unit.parent().unwrap()).unwrap();
    std::fs::write(
        &unit,
        format!(
            "[Service]\nExecStart=\"{}/bin/current/desk-helper\" \"--machine\"\n",
            root.display()
        ),
    )
    .unwrap();
    let r = fleet(&b, "0.2.0", true);
    let p = r.fleet.probe("devbox").unwrap();
    assert!(matches!(p.access, Some(Access::Ok { .. })), "{p:?}");
    let id = r.fleet.add("devbox", "devbox").unwrap();
    until("ready", || r.fleet.state(&id) == Some(State::Ready));
    assert_eq!(b.installed().as_deref(), Some("0.2.0"));
    assert!(root.join("machine").is_file(), "marked now");
}

/// Another machine's key, which isn't devbox's.
const OTHER_KEY: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAa7mm1xLPFHiFjUNvJ+jVhN2gEvLPoSIMWB0+6fIOGs";

/// devbox added, its key known, and kept by Desk.
fn added_with_key(b: &Box_, r: &Run) -> String {
    // Known as ssh looks it up: by its HostName.
    std::fs::write(
        b.known_hosts(),
        format!("devbox {KEY}\n203.0.113.7 {KEY}\n"),
    )
    .unwrap();
    b.say(Some(KEY));
    std::fs::write(b.fake("linger-allowed"), "").unwrap();
    let id = r.fleet.add("devbox", "devbox").unwrap();
    until("ready", || r.fleet.state(&id) == Some(State::Ready));
    until("its key kept", || r.fleet.list()[0].host_key.is_some());
    id
}

#[test]
fn a_machine_is_reached_at_another_address_only_when_it_shows_the_same_key() {
    let b = Box_::new();
    let _hub = serve(&b);
    let r = fleet(&b, "0.2.0", true);
    let id = added_with_key(&b, &r);
    let row = serde_json::to_value(&r.fleet.list()[0]).unwrap();
    assert_eq!(row["hostKey"]["fingerprint"], FINGERPRINT);
    assert_eq!(row["hostKey"]["kind"], "ED25519");
    assert!(row["connectedSince"].is_i64() && row["lastConnected"].is_i64());
    assert_eq!(row["reach"]["user"], "dev");
    assert_eq!(row["reach"]["hostname"], "203.0.113.7");

    // The same machine by another name (another Host entry, a new address).
    b.say_hosts(&[
        ("devbox", Some(KEY)),
        ("devbox-new", Some(KEY)),
        ("imposter", Some(OTHER_KEY)),
    ]);
    let asked = r.asked.0.load(Ordering::SeqCst);
    let done = r.fleet.edit(&id, Some("devbox-new"), None).unwrap();
    assert_eq!(
        serde_json::to_value(&done).unwrap(),
        json!({"kind": "done"})
    );
    assert_eq!(
        r.asked.0.load(Ordering::SeqCst),
        asked + 1,
        "asked once, natively"
    );
    // Its key was learnt for the new address, as ssh would.
    let known = std::fs::read_to_string(b.known_hosts()).unwrap();
    assert!(known.contains(&format!("devbox-new {KEY}")), "{known}");
    assert_eq!(r.fleet.list()[0].target, "devbox-new");
    until("ready at the new address", || {
        r.fleet.state(&id) == Some(State::Ready)
            && b.calls().iter().any(|c| {
                c.iter().any(|a| a == "devbox-new")
                    && c.iter().any(|a| a.starts_with("-L") || a == "-N")
            })
    });
    let kept: Value = serde_json::from_str(
        &std::fs::read_to_string(b.dir.path().join("mac/machines.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(kept[0]["target"], "devbox-new");
    assert_eq!(
        kept[0]["id"], "devbox",
        "the same machine: its sessions and settings stay"
    );

    // Another machine's key: refused, with both keys, and nothing changed.
    let different = r.fleet.edit(&id, Some("imposter"), None).unwrap();
    let said = serde_json::to_value(&different).unwrap();
    assert_eq!(said["kind"], "differentKey");
    assert_eq!(said["known"]["fingerprint"], FINGERPRINT);
    assert_ne!(said["shown"]["fingerprint"], FINGERPRINT);
    assert_eq!(r.fleet.list()[0].target, "devbox-new");
    assert!(
        !std::fs::read_to_string(b.known_hosts())
            .unwrap()
            .contains("imposter")
    );
    assert!(
        r.fleet
            .log(&id)
            .unwrap()
            .iter()
            .any(|l| l.text.contains("another host key"))
    );
}

#[test]
fn an_address_is_checked_first_and_then_switched_to_without_asking_again() {
    let b = Box_::new();
    let _hub = serve(&b);
    let r = fleet(&b, "0.2.0", true);
    let id = added_with_key(&b, &r);
    b.say_hosts(&[("devbox", Some(KEY)), ("devbox-new", Some(KEY))]);
    let asked = r.asked.0.load(Ordering::SeqCst);
    let checked = serde_json::to_value(r.fleet.check_reach(&id, "devbox-new").unwrap()).unwrap();
    assert_eq!(checked["kind"], "same");
    assert_eq!(checked["key"]["fingerprint"], FINGERPRINT);
    assert!(checked["tookMs"].is_u64());
    assert_eq!(r.list_target(), "devbox", "a check moves nothing");
    r.fleet.edit(&id, Some("devbox-new"), None).unwrap();
    assert_eq!(r.list_target(), "devbox-new");
    assert_eq!(
        r.asked.0.load(Ordering::SeqCst),
        asked + 1,
        "asked once, for the check"
    );
}

#[test]
fn a_no_to_reaching_it_elsewhere_runs_nothing_there() {
    let b = Box_::new();
    let _hub = serve(&b);
    let r = fleet(&b, "0.2.0", true);
    let id = added_with_key(&b, &r);
    b.say_hosts(&[("devbox", Some(KEY)), ("devbox-new", Some(KEY))]);
    let asked = Arc::clone(&r.asked);
    // From now on, the person says no.
    let no = fleet_answering(&b, &r, false);
    let before = b.calls().len();
    let done = no.edit(&id, Some("devbox-new"), None).unwrap();
    assert_eq!(
        serde_json::to_value(&done).unwrap(),
        json!({"kind": "cancelled"})
    );
    assert!(
        b.calls()[before..]
            .iter()
            .all(|c| !c.iter().any(|a| a == "devbox-new")),
        "nothing ran there"
    );
    assert_eq!(no.list()[0].target, "devbox");
    let _ = asked;
}

/// The same machines file, its fleet answering every question with `yes`.
fn fleet_answering(b: &Box_, r: &Run, yes: bool) -> Arc<Fleet> {
    r.fleet.shutdown();
    let asked = Arc::new(Yes(AtomicUsize::new(0), yes));
    let fleet = Fleet::new(
        b.ssh.clone(),
        Arc::clone(&r.machines),
        b.dir.path().join("mac/machines.json"),
        b.dir.path().join("mac"),
        Arc::new(TestHost {
            said: Arc::clone(&r.said),
            wanted: "0.2.0".into(),
            tarball: b.dir.path().join("backends/0.2.0.tar.gz"),
        }),
        asked.clone(),
        asked,
        timing(),
    );
    fleet.load();
    fleet
}

#[test]
fn a_key_not_in_known_hosts_is_never_kept_and_nothing_moves_without_one() {
    let b = Box_::new();
    let _hub = serve(&b);
    let r = fleet(&b, "0.2.0", true);
    // devbox is known only by its alias: ssh looks its key up by its
    // HostName, which known_hosts has nothing for.
    std::fs::write(b.known_hosts(), format!("devbox {KEY}\n")).unwrap();
    b.say(Some(KEY));
    std::fs::write(b.fake("linger-allowed"), "").unwrap();
    let id = r.fleet.add("devbox", "devbox").unwrap();
    until("ready", || r.fleet.state(&id) == Some(State::Ready));
    until("said why it isn't kept", || {
        r.fleet.log(&id).unwrap().iter().any(|l| {
            l.text
                .contains("isn't in your known_hosts for it: not kept")
        })
    });
    assert!(r.fleet.list()[0].host_key.is_none());
    b.say_hosts(&[("devbox", Some(KEY)), ("devbox-new", Some(KEY))]);
    let asked = r.asked.0.load(Ordering::SeqCst);
    let refused = r.fleet.edit(&id, Some("devbox-new"), None).unwrap_err();
    assert!(
        refused.contains("no host key for devbox checked against your known_hosts"),
        "{refused}"
    );
    assert_eq!(r.asked.0.load(Ordering::SeqCst), asked, "nothing asked");
    assert_eq!(r.fleet.list()[0].target, "devbox");
}

#[test]
fn a_changed_key_shows_both_and_a_trust_again_is_the_one_kept() {
    let b = Box_::new();
    let _hub = serve(&b);
    let r = fleet(&b, "0.2.0", true);
    let id = added_with_key(&b, &r);
    // devbox is reinstalled: it shows another key now.
    b.say(Some(OTHER_KEY));
    r.fleet.reconnect(&id).unwrap();
    until("its key said to have changed", || {
        matches!(r.fleet.state(&id), Some(State::Failed { .. }))
            && r.fleet.list()[0].shown_key.is_some()
    });
    let row = serde_json::to_value(&r.fleet.list()[0]).unwrap();
    assert_eq!(row["hostKey"]["fingerprint"], FINGERPRINT);
    assert_ne!(row["shownKey"]["fingerprint"], FINGERPRINT);
    assert_eq!(row["reach"]["forgetKey"], "ssh-keygen -R 203.0.113.7");
    let shown = row["shownKey"]["fingerprint"].as_str().unwrap().to_string();

    // The person removes the old key, and trusts the new one as shown.
    std::fs::write(b.known_hosts(), "").unwrap();
    r.fleet.probe("devbox").unwrap();
    r.fleet.trust("devbox", &shown).unwrap();
    let row = serde_json::to_value(&r.fleet.list()[0]).unwrap();
    assert_eq!(row["hostKey"]["fingerprint"], shown.as_str());
    assert!(row.get("shownKey").is_none(), "{row}");
}

#[test]
fn reading_its_key_before_asking_anything_gives_up_in_time() {
    let b = Box_::new();
    let _hub = serve(&b);
    let r = fleet(&b, "0.2.0", true);
    // Added with no key kept (known only by its alias).
    std::fs::write(b.known_hosts(), format!("devbox {KEY}\n")).unwrap();
    b.say(Some(KEY));
    std::fs::write(b.fake("linger-allowed"), "").unwrap();
    let id = r.fleet.add("devbox", "devbox").unwrap();
    until("ready", || r.fleet.state(&id) == Some(State::Ready));
    // Now devbox doesn't answer at all.
    let scenario: Value =
        serde_json::from_str(&std::fs::read_to_string(b.dir.path().join("scenario.json")).unwrap())
            .unwrap();
    let mut hosts = scenario["hosts"].as_array().unwrap().clone();
    hosts[0]["hang"] = json!(true);
    std::fs::write(
        b.dir.path().join("scenario.json"),
        json!({"log": scenario["log"], "hosts": hosts}).to_string(),
    )
    .unwrap();
    let asked = r.asked.0.load(Ordering::SeqCst);
    let started = Instant::now();
    let e = r.fleet.check_reach(&id, "devbox-new").unwrap_err();
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
    assert!(e.contains("no host key for devbox"), "{e}");
    assert_eq!(r.asked.0.load(Ordering::SeqCst), asked, "nothing asked");
}

#[test]
fn reaching_it_elsewhere_gives_up_in_time_and_changes_nothing() {
    let b = Box_::new();
    let _hub = serve(&b);
    let r = fleet(&b, "0.2.0", true);
    let id = added_with_key(&b, &r);
    let scenario: Value =
        serde_json::from_str(&std::fs::read_to_string(b.dir.path().join("scenario.json")).unwrap())
            .unwrap();
    let mut hosts = scenario["hosts"].as_array().unwrap().clone();
    let mut slow = hosts[0].clone();
    slow["target"] = json!("devbox-slow");
    slow["hang"] = json!(true);
    hosts.push(slow);
    std::fs::write(
        b.dir.path().join("scenario.json"),
        json!({"log": scenario["log"], "hosts": hosts}).to_string(),
    )
    .unwrap();
    let started = Instant::now();
    let e = r.fleet.edit(&id, Some("devbox-slow"), None).unwrap_err();
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
    assert!(e.contains("didn't answer"), "{e}");
    assert_eq!(r.fleet.list()[0].target, "devbox");
}

#[test]
fn a_machine_is_renamed_but_never_to_another_machines_name() {
    let b = Box_::new();
    let _hub = serve(&b);
    let r = fleet(&b, "0.2.0", true);
    let id = added_with_key(&b, &r);
    let asked = r.asked.0.load(Ordering::SeqCst);
    r.fleet.edit(&id, None, Some("devbox (dev)")).unwrap();
    assert_eq!(r.fleet.list()[0].name, "devbox (dev)");
    assert_eq!(
        r.asked.0.load(Ordering::SeqCst),
        asked,
        "a name asks nothing"
    );
    assert!(r.fleet.edit(&id, None, Some("  ")).is_err());
    // Nothing that would make it read as something else.
    for odd in ["devbox\u{202e}xob", "dev\u{200b}box"] {
        assert!(
            r.fleet
                .edit(&id, None, Some(odd))
                .unwrap_err()
                .contains("letters, numbers, spaces and punctuation"),
            "{odd:?}"
        );
    }
    assert!(
        r.fleet
            .edit(&id, Some("-oProxyCommand=x"), None)
            .unwrap_err()
            .contains("can't start with -")
    );
}

#[test]
fn an_offline_machine_says_why_in_ssh_s_words_when_it_last_and_next_tries() {
    let b = Box_::new();
    // Kept from before; its address no longer resolves.
    std::fs::create_dir_all(b.dir.path().join("mac")).unwrap();
    std::fs::write(
        b.dir.path().join("mac/machines.json"),
        r#"[{"id": "gone", "name": "gone", "target": "gone-box", "version": "0.2.0", "last_connected": 1700000000000}]"#,
    )
    .unwrap();
    let r = fleet(&b, "0.2.0", true);
    r.fleet.load();
    until("offline, with when it tries next", || {
        r.fleet
            .list()
            .first()
            .is_some_and(|m| m.state == State::Unreachable && m.next_try.is_some())
    });
    let m = &r.fleet.list()[0];
    assert!(
        m.reason
            .as_deref()
            .unwrap()
            .contains("SSH couldn't reach gone"),
        "{:?}",
        m.reason
    );
    assert!(
        m.said
            .as_deref()
            .unwrap()
            .contains("Could not resolve hostname gone-box"),
        "{:?}",
        m.said
    );
    assert!(!m.said.as_deref().unwrap().starts_with('“'));
    assert_eq!(m.last_connected, Some(1_700_000_000_000));
    assert!(m.last_try.unwrap() <= m.next_try.unwrap());
    let log = r.fleet.log("gone").unwrap();
    let kinds: Vec<String> = log
        .iter()
        .map(|l| format!("{:?} {}", l.kind, l.text))
        .collect();
    assert!(
        kinds
            .iter()
            .any(|k| k.starts_with("Info connecting to gone")),
        "{kinds:?}"
    );
    assert!(
        kinds
            .iter()
            .any(|k| k.starts_with("Error ") && k.contains("Could not resolve hostname")),
        "{kinds:?}"
    );
    assert!(
        kinds.iter().any(|k| k.starts_with("Info next try in")),
        "{kinds:?}"
    );
}

#[test]
fn desks_log_there_is_read_over_ssh_cleaned_and_given_up_on_in_time() {
    let b = Box_::new();
    let _hub = serve(&b);
    let r = fleet(&b, "0.2.0", true);
    let id = added_with_key(&b, &r);
    script(
        &b.dir.path().join("fakebin/journalctl"),
        "#!/bin/sh\necho \"$*\" > \"$HOME/.fake/journalctl-args\"\nprintf '2026-11-06T09:41:27+0000 devbox desk-helper[12]: hub starting\\n\\033[31mred\\033[0m and a\\ttab\\n'\n",
    );
    let said = r.fleet.remote_log(&id, Duration::from_secs(10)).unwrap();
    assert!(
        said.starts_with("2026-11-06T09:41:27+0000 devbox desk-helper[12]: hub starting"),
        "{said}"
    );
    assert!(!said.contains('\u{1b}'), "{said:?}");
    assert!(said.contains("and a tab"), "{said:?}");
    let args = std::fs::read_to_string(b.fake("journalctl-args")).unwrap();
    assert_eq!(
        args.trim(),
        "--user -u desk-helper.service -n 200 --no-pager -o short-iso"
    );

    script(
        &b.dir.path().join("fakebin/journalctl"),
        "#!/bin/sh\nsleep 5\n",
    );
    let started = Instant::now();
    let late = r.fleet.remote_log(&id, Duration::from_secs(1)).unwrap_err();
    assert!(late.contains("didn't answer within 1 s"), "{late}");
    assert!(started.elapsed() < Duration::from_secs(4));
}

#[test]
fn the_ssh_configs_host_entries_are_listed() {
    let b = Box_::new();
    std::fs::write(
        b.dir.path().join("mac/.ssh/config"),
        "Host devbox\n  HostName 2.29.244.189\n  User dev\nHost buildbox\n  ProxyJump bastion\nHost *\n  User me\n",
    )
    .unwrap();
    let r = fleet(&b, "0.2.0", true);
    let hosts = serde_json::to_value(r.fleet.ssh_hosts()).unwrap();
    assert_eq!(
        hosts,
        json!([
            {"host": "devbox", "hostname": "2.29.244.189", "user": "dev", "port": null, "jump": null, "file": "~/.ssh/config"},
            {"host": "buildbox", "hostname": null, "user": "me", "port": null, "jump": "bastion", "file": "~/.ssh/config"}
        ])
    );
    assert!(b.calls().is_empty(), "nothing was run to read it");
}

/// A Claude Code there that takes `secs` to say its version: the engines
/// step runs that long.
fn slow_engines(b: &Box_, secs: u32) {
    script(
        &b.dir.path().join("fakebin/claude"),
        &format!("#!/bin/sh\nsleep {secs}\necho \"9.9.9 (fake)\"\n"),
    );
}

#[test]
fn adding_is_cancelled_mid_step_at_once_and_the_machine_is_forgotten() {
    let b = Box_::new();
    let _hub = serve(&b);
    std::fs::write(b.fake("linger-allowed"), "").unwrap();
    slow_engines(&b, 30);
    let r = fleet(&b, "0.2.0", true);
    let id = r.fleet.add("devbox", "devbox").unwrap();
    until("the engines step running", || {
        step(&r, "engines", StepState::Running).is_some()
    });
    let asked = Instant::now();
    r.fleet.cancel_add(&id).unwrap();
    until("forgotten", || r.fleet.list().is_empty());
    assert!(
        asked.elapsed() < Duration::from_secs(5),
        "{:?}",
        asked.elapsed()
    );
    let said = step(&r, "engines", StepState::Failed)
        .unwrap_or_else(|| panic!("{:#?}", r.said.events.lock().unwrap()));
    assert_eq!(said.message.as_deref(), Some("Adding it was cancelled."));
    assert!(r.machines.get(&id).is_none());
    let kept = std::fs::read_to_string(b.dir.path().join("mac/machines.json"))
        .unwrap_or_else(|_| "[]".into());
    assert_eq!(serde_json::from_str::<Value>(&kept).unwrap(), json!([]));
    // Adding it again asks again.
    let before = r.asked.0.load(Ordering::SeqCst);
    slow_engines(&b, 0);
    r.fleet.add("devbox", "devbox").unwrap();
    assert_eq!(r.asked.0.load(Ordering::SeqCst), before + 1);
}

#[test]
fn a_step_that_runs_past_its_limit_is_stopped_and_says_so() {
    let b = Box_::new();
    let _hub = serve(&b);
    std::fs::write(b.fake("linger-allowed"), "").unwrap();
    slow_engines(&b, 30);
    let mut r = fleet(&b, "0.2.0", true);
    // The same fleet, its steps limited to 2 s.
    let mut t = timing();
    t.step_within = Duration::from_secs(2);
    r.fleet = Fleet::new(
        b.ssh.clone(),
        Arc::clone(&r.machines),
        b.dir.path().join("mac/machines.json"),
        b.dir.path().join("mac"),
        Arc::new(TestHost {
            said: Arc::clone(&r.said),
            wanted: "0.2.0".into(),
            tarball: b.dir.path().join("backends/0.2.0.tar.gz"),
        }),
        r.asked.clone(),
        r.asked.clone(),
        t,
    );
    let id = r.fleet.add("devbox", "devbox").unwrap();
    let started = Instant::now();
    until("the engines step stopped", || {
        step(&r, "engines", StepState::Failed).is_some()
    });
    let said = step(&r, "engines", StepState::Failed).unwrap();
    assert_eq!(
        said.message.as_deref(),
        Some("That step took longer than 3 minutes, so Desk stopped it.")
    );
    assert!(started.elapsed() < Duration::from_secs(15));
    // Installed and connected all the same: only the engines step stopped.
    until("ready", || r.fleet.state(&id) == Some(State::Ready));
    assert!(
        r.fleet
            .log(&id)
            .unwrap()
            .iter()
            .any(|l| l.text.contains("longer than 3 minutes"))
    );
}

#[test]
fn copying_desk_there_says_how_far_it_got_and_names_are_never_shared() {
    let b = Box_::new();
    let _hub = serve(&b);
    std::fs::write(b.fake("linger-allowed"), "").unwrap();
    let r = fleet(&b, "0.2.0", true);
    let id = r.fleet.add("devbox", "devbox").unwrap();
    until("ready", || r.fleet.state(&id) == Some(State::Ready));
    let copying: Vec<String> = r
        .said
        .events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|e| e.detail.clone())
        .filter(|d| d.starts_with("Copying Desk 0.2.0 to devbox… "))
        .collect();
    assert!(!copying.is_empty(), "said while copying");
    assert!(copying.last().unwrap().ends_with(" MB"), "{copying:?}");
    // No progress is left once it's done.
    assert_eq!(r.fleet.list()[0].progress, None);
    let refused = r.fleet.add("root@devbox", "DevBox").unwrap_err();
    assert!(
        refused.contains("Two machines can't share a name"),
        "{refused}"
    );
}

#[test]
fn a_failed_add_is_cancelled_at_once() {
    let b = Box_::new();
    std::fs::write(b.fake("linger-allowed"), "").unwrap();
    std::fs::write(b.fake("check-fails"), "").unwrap();
    let _hub = serve(&b);
    let r = fleet(&b, "0.2.0", true);
    let id = r.fleet.add("devbox", "devbox").unwrap();
    until("failed", || {
        matches!(r.fleet.state(&id), Some(State::Failed { .. }))
    });
    r.fleet.cancel_add(&id).unwrap();
    assert!(r.fleet.list().is_empty());
    assert!(r.fleet.cancel_add(&id).is_err());
}
