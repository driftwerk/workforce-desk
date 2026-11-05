//! WSL scenarios against a fake `wsl.exe` (`src/bin/fake-wsl.rs`): what
//! Desk finds, installs and is told, as on a Windows computer with WSL in
//! each of these states.

use std::path::Path;
use std::time::Duration;

use desk_core::backend::Backend;
use desk_core::host::Wsl;
use desk_wsl::reach::Reach;
use desk_wsl::{WslExe, WslProblem, detect, install, launcher, reach};
use serde_json::{Value, json};

struct Fake {
    dir: tempfile::TempDir,
    wsl: WslExe,
}

/// A `wsl.exe` that answers as `answers` say: the fake, in a folder of its
/// own with its scenario beside it.
fn fake(answers: Value) -> Fake {
    // In the target folder, beside the fake, so it can be linked there (see
    // `place`).
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let log = dir.path().join("calls.jsonl");
    std::fs::write(
        dir.path().join("scenario.json"),
        json!({"log": log, "answers": answers}).to_string(),
    )
    .unwrap();
    let exe = dir
        .path()
        .join(format!("wsl{}", std::env::consts::EXE_SUFFIX));
    place(Path::new(env!("CARGO_BIN_EXE_fake-wsl")), &exe);
    Fake {
        wsl: WslExe::at(exe),
        dir,
    }
}

/// Puts the fake at `exe`. On Linux a copy written here would be open to
/// write in every child another test thread forks meanwhile, until that
/// child execs (`O_CLOEXEC` closes it only then), and running the copy can
/// then fail with "Text file busy" (ETXTBSY); writing it beside and renaming
/// it into place keeps the same file, so it wouldn't help. A hard link is the
/// file cargo wrote, under a new name, so nothing here ever writes it.
/// Elsewhere it's copied, as it always was: the race is Linux's, and macOS
/// runs one file linked under several names at once unreliably.
fn place(fake: &Path, exe: &Path) {
    if cfg!(target_os = "linux") && std::fs::hard_link(fake, exe).is_ok() {
        return;
    }
    std::fs::copy(fake, exe).unwrap();
}

impl Fake {
    fn calls(&self) -> Vec<Vec<String>> {
        std::fs::read_to_string(self.dir.path().join("calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
}

const LIST: &str = "  NAME            STATE           VERSION\r\n\
                    * Ubuntu-24.04    Running         2\r\n  \
                    Ubuntu-20.04    Stopped         1\r\n";

fn probe(user: &str, glibc: &str) -> String {
    format!(
        "x86_64\n6.6.36.6-microsoft-standard-WSL2\n{user}\n/home/{user}\n/mnt/c/\nldd (GNU libc) {glibc}\n"
    )
}

fn sarah() -> Wsl {
    Wsl {
        distro: "Ubuntu-24.04".into(),
        user: "sarah".into(),
        home: "/home/sarah".into(),
        automount: "/mnt/".into(),
    }
}

/// The start of a call into Sarah's distro: `--exec` a program there.
fn into(program: &str) -> Value {
    json!([
        "-d",
        "Ubuntu-24.04",
        "--cd",
        "/home/sarah",
        "--exec",
        program
    ])
}

#[test]
fn without_wsl_desk_offers_to_install_it() {
    let f = fake(
        json!([{"args": ["--status"], "code": 1}, {"args": ["--list", "--verbose"], "code": -1}]),
    );
    let found = detect(&f.wsl);
    assert_eq!(found.problem, Some(WslProblem::NotInstalled));
    assert!(found.distros.is_empty());
}

#[test]
fn wsl_without_a_distro_asks_for_one() {
    let f = fake(json!([
        {"args": ["--status"], "code": 0},
        {"args": ["--list", "--verbose"], "code": 0, "stdout": "Windows Subsystem for Linux has no installed distributions.\r\n", "utf16": true}
    ]));
    assert_eq!(detect(&f.wsl).problem, Some(WslProblem::NoDistro));
}

#[test]
fn two_distros_one_on_wsl_1_are_listed_with_their_fix() {
    let f = fake(json!([
        {"args": ["--status"], "code": 0},
        {"args": ["--list", "--verbose"], "stdout": LIST, "utf16": true},
        {"starts": ["-d", "Ubuntu-24.04", "--exec", "sh", "-c"], "stdout": probe("sarah", "2.39")}
    ]));
    let found = detect(&f.wsl);
    assert_eq!(found.problem, None);
    let [ubuntu, old] = found.distros.as_slice() else {
        panic!("{found:?}")
    };
    assert!(ubuntu.distro.default);
    assert_eq!(ubuntu.host(), Some(desk_core::host::Host::Wsl(sarah())));
    assert_eq!(
        old.problem,
        Some(WslProblem::Wsl1 {
            distro: "Ubuntu-20.04".into()
        })
    );
    // A WSL 1 distro isn't started just to ask it.
    assert!(
        !f.calls()
            .iter()
            .any(|c| c.contains(&"Ubuntu-20.04".to_string()))
    );
}

#[test]
fn an_old_linux_is_refused_with_its_glibc() {
    let f = fake(json!([
        {"args": ["--status"], "code": 0},
        {"args": ["--list", "--verbose"], "stdout": "* Ubuntu-24.04 Running 2\n"},
        {"starts": ["-d", "Ubuntu-24.04", "--exec", "sh", "-c"], "stdout": probe("sarah", "2.31")}
    ]));
    let found = detect(&f.wsl);
    assert_eq!(
        found.distros[0].problem,
        Some(WslProblem::OldLinux {
            glibc: "2.31".into()
        })
    );
    assert_eq!(found.distros[0].host(), None);
}

fn check(ok: bool) -> String {
    json!({"ok": ok, "glibc": if ok { "2.39" } else { "2.31" }, "arch": "x86_64", "loopback": true, "root_on_ext4": true}).to_string()
}

#[test]
fn installing_copies_checks_then_flips() {
    let f = fake(json!([
        {"starts": into("/bin/sh"), "contains": "install -Dm755"},
        {"starts": into("/home/sarah/.local/share/Desk/bin/0.3.0/desk-helper"), "contains": "--check", "stdout": check(true)},
        {"starts": into("/bin/sh"), "contains": "mv -Tf"}
    ]));
    let found = install::install(
        &f.wsl,
        &sarah(),
        Path::new(r"C:\Program Files\Desk\backend"),
        "0.3.0",
    )
    .unwrap();
    assert!(found.ok);
    let calls = f.calls();
    assert_eq!(calls.len(), 3);
    assert!(
        calls[0]
            .last()
            .unwrap()
            .contains(r"wslpath -u 'C:\Program Files\Desk\backend'")
    );
    assert_eq!(calls[1].last().unwrap(), "--check");
    assert!(calls[2].last().unwrap().contains("ln -sfn '0.3.0'"));
}

#[test]
fn a_failed_check_leaves_the_current_version() {
    let f = fake(json!([
        {"starts": into("/bin/sh"), "contains": "install -Dm755"},
        {"starts": into("/home/sarah/.local/share/Desk/bin/0.3.0/desk-helper"), "stdout": check(false)},
        {"starts": into("/bin/sh"), "contains": "mv -Tf"}
    ]));
    let e = install::install(&f.wsl, &sarah(), Path::new(r"C:\Desk\backend"), "0.3.0").unwrap_err();
    assert!(format!("{e:#}").contains("glibc 2.31"), "{e:#}");
    assert_eq!(f.calls().len(), 2, "never flipped");
}

#[test]
fn the_installed_version_is_read_from_current() {
    let f = fake(json!([{"starts": into("/bin/sh"), "contains": "readlink", "stdout": "0.2.0\n"}]));
    assert_eq!(
        install::installed(&f.wsl, &sarah()).unwrap().as_deref(),
        Some("0.2.0")
    );
    let none = fake(json!([{"starts": into("/bin/sh"), "contains": "readlink", "stdout": ""}]));
    assert_eq!(install::installed(&none.wsl, &sarah()).unwrap(), None);
}

fn backend() -> Backend {
    Backend::wsl(sarah())
}

#[test]
fn the_connection_comes_over_the_helpers_output() {
    let said =
        json!({"gateway_url": "http://127.0.0.1:50412", "admin_token": "a", "device_token": "d"})
            .to_string();
    let f = fake(
        json!([{"starts": into("/home/sarah/.local/share/Desk/bin/current/desk-helper"), "contains": "connection --json", "stdout": said}]),
    );
    let c = backend()
        .connection_with(|i| f.wsl.invoke(i).map_err(std::io::Error::other))
        .unwrap()
        .unwrap();
    assert_eq!(
        (c.gateway_url.as_str(), c.device_token.as_deref()),
        ("http://127.0.0.1:50412", Some("d"))
    );
}

#[test]
fn a_failed_connection_says_why() {
    let f = fake(
        json!([{"starts": into("/home/sarah/.local/share/Desk/bin/current/desk-helper"), "code": 1, "stderr": "Desk Helper isn't installed"}]),
    );
    let e = backend()
        .connection_with(|i| f.wsl.invoke(i).map_err(std::io::Error::other))
        .unwrap_err();
    assert!(format!("{e:#}").contains("isn't installed"), "{e:#}");
}

#[test]
fn a_hub_wsl_reaches_and_windows_doesnt_is_a_port_problem() {
    // A port nothing listens on, below the ones handed out for a connection's
    // own end: a free one of those (as a listener bound and let go was) can be
    // taken meanwhile by another test's connection, or by the very connection
    // that tries it, which on Linux then connects to itself.
    let url = "http://127.0.0.1:1";
    let answers =
        |code: &str| json!([{"starts": into("/bin/sh"), "contains": "curl", "stdout": code}]);
    assert_eq!(
        reach::check(&fake(answers("401")).wsl, &sarah(), url),
        Reach::PortUnreachable
    );
    assert_eq!(
        reach::check(&fake(answers("000")).wsl, &sarah(), url),
        Reach::Starting
    );
}

#[test]
fn the_launcher_starts_desk_helper_again_until_asked_to_stop() {
    let f = fake(
        json!([{"starts": into("/home/sarah/.local/share/Desk/bin/current/desk-helper"), "code": 3}]),
    );
    let runs = std::cell::Cell::new(0);
    let paused = std::cell::RefCell::new(Vec::new());
    launcher::run(
        &f.wsl,
        &sarah(),
        "Atlas",
        &|| runs.get() >= 3,
        &|d| {
            runs.set(runs.get() + 1);
            paused.borrow_mut().push(d);
        },
        &|_| {},
    )
    .unwrap();
    assert_eq!(f.calls().len(), 3);
    assert_eq!(
        *paused.borrow(),
        [
            Duration::from_secs(1),
            Duration::from_secs(2),
            Duration::from_secs(4)
        ]
    );
}
