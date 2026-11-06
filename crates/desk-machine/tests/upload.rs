//! Copying dropped files to a machine, against the fake `ssh` running each
//! command for real in a home of its own: the bytes arrive whole under the
//! backend's folder, names are only ever arguments, and what fails says
//! why and leaves nothing half-written.
#![cfg(unix)]

use std::path::Path;

use desk_core::machine::{Machine, MachineId, Target};
use desk_machine::SshExe;
use desk_machine::upload::{self, File};
use serde_json::{Value, json};

struct Fake {
    dir: tempfile::TempDir,
    ssh: SshExe,
}

impl Fake {
    fn new() -> Fake {
        let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
        let exe = dir.path().join("ssh");
        let fake = Path::new(env!("CARGO_BIN_EXE_fake-ssh"));
        if !(cfg!(target_os = "linux") && std::fs::hard_link(fake, &exe).is_ok()) {
            std::fs::copy(fake, &exe).unwrap();
        }
        std::fs::create_dir(dir.path().join("home")).unwrap();
        let f = Fake {
            ssh: SshExe::at(exe),
            dir,
        };
        f.say(json!([{"target": "devbox", "exec": {"home": f.home(), "path": "/nonexistent"}}]));
        f
    }

    fn home(&self) -> String {
        self.dir.path().join("home").to_string_lossy().into_owned()
    }

    fn say(&self, hosts: Value) {
        std::fs::write(
            self.dir.path().join("scenario.json"),
            json!({"log": self.dir.path().join("calls.jsonl"), "hosts": hosts}).to_string(),
        )
        .unwrap();
    }
}

fn devbox() -> Machine {
    Machine {
        id: MachineId::new("devbox").unwrap(),
        name: "devbox".into(),
        target: Target::new("devbox").unwrap(),
    }
}

fn file(name: &str, bytes: &[u8]) -> File<std::io::Cursor<Vec<u8>>> {
    File {
        name: name.into(),
        len: bytes.len() as u64,
        bytes: std::io::Cursor::new(bytes.to_vec()),
    }
}

#[test]
fn a_dropped_file_arrives_whole_under_the_backends_folder() {
    let f = Fake::new();
    let bytes: Vec<u8> = (0..700_000u32).map(|i| (i % 251) as u8).collect();
    let mut progress = Vec::new();
    let name = "Screenshot 2026-11-06 at 10.15.32 it's \"$(touch pwned)\" `x`; café ☕.png";
    let at = upload::copy(
        &f.ssh,
        &devbox(),
        &f.home(),
        "s-1",
        "d1",
        file(name, &bytes),
        |n| progress.push(n),
    )
    .unwrap();
    assert_eq!(
        at,
        format!("{}/.local/share/Desk/uploads/s-1/d1/{name}", f.home())
    );
    assert_eq!(std::fs::read(&at).unwrap(), bytes);
    // Its progress rose to the whole of it.
    assert_eq!(progress.last(), Some(&(bytes.len() as u64)));
    assert!(progress.windows(2).all(|w| w[0] < w[1]));
    assert!(progress.len() > 1);
    // The name was never read by a shell: nothing ran from it.
    assert!(!Path::new(&f.home()).join("pwned").exists());
    assert!(
        !Path::new(&f.home())
            .join(".local/share/Desk/uploads/s-1/pwned")
            .exists()
    );
    // No partial is left beside it.
    let left: Vec<_> = std::fs::read_dir(Path::new(&at).parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(left.len(), 1, "{left:?}");
    // Only the person can read it.
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(&at).unwrap().permissions().mode();
    assert_eq!(mode & 0o077, 0, "{mode:o}");
}

#[test]
fn two_drops_of_the_same_name_keep_both() {
    let f = Fake::new();
    let a = upload::copy(
        &f.ssh,
        &devbox(),
        &f.home(),
        "s",
        "d1",
        file("a.png", b"one"),
        |_| {},
    )
    .unwrap();
    let b = upload::copy(
        &f.ssh,
        &devbox(),
        &f.home(),
        "s",
        "d2",
        file("a.png", b"two"),
        |_| {},
    )
    .unwrap();
    assert_ne!(a, b);
    assert_eq!(std::fs::read(a).unwrap(), b"one");
    assert_eq!(std::fs::read(b).unwrap(), b"two");
}

#[test]
fn a_machine_that_turns_ssh_away_says_so_and_nothing_is_written() {
    let f = Fake::new();
    f.say(json!([{"target": "devbox", "refuse": {"stderr": "dev@devbox: Permission denied (publickey).\n", "code": 255}}]));
    let err = upload::copy(
        &f.ssh,
        &devbox(),
        &f.home(),
        "s",
        "d",
        file("a.png", b"x"),
        |_| {},
    )
    .unwrap_err();
    assert!(err.contains("ssh-add"), "{err}");
    assert!(
        !Path::new(&f.home())
            .join(".local/share/Desk/uploads")
            .exists()
    );
}

#[test]
fn a_copy_that_breaks_off_leaves_no_partial() {
    let f = Fake::new();
    // Says more bytes are coming than are sent: as a read cut short.
    let mut short = file("a.png", b"abc");
    short.len = 10;
    let err = upload::copy(&f.ssh, &devbox(), &f.home(), "s", "d", short, |_| {}).unwrap_err();
    assert!(err.contains("broke off"), "{err}");
    let dir = Path::new(&f.home()).join(".local/share/Desk/uploads/s/d");
    assert_eq!(std::fs::read_dir(dir).unwrap().count(), 0);
}

#[test]
fn a_machine_without_room_says_what_it_said() {
    let f = Fake::new();
    f.say(json!([{"target": "devbox", "commands": [{"contains": "uploads", "stderr": "mkdir: cannot create directory: No space left on device\n", "code": 1}]}]));
    let err = upload::copy(
        &f.ssh,
        &devbox(),
        &f.home(),
        "s",
        "d",
        file("a.png", b"x"),
        |_| {},
    )
    .unwrap_err();
    assert!(
        err.starts_with("Desk couldn't copy a.png to devbox."),
        "{err}"
    );
    assert!(err.contains("No space left"), "{err}");
}

#[test]
fn bad_names_and_too_much_are_refused_before_ssh_runs() {
    let f = Fake::new();
    for bad in ["a/b.png", "x\n.png", "..", "esc\x1b[201~"] {
        assert!(
            upload::copy(
                &f.ssh,
                &devbox(),
                &f.home(),
                "s",
                "d",
                file(bad, b"x"),
                |_| {}
            )
            .is_err()
        );
    }
    assert!(
        upload::copy(
            &f.ssh,
            &devbox(),
            &f.home(),
            "../s",
            "d",
            file("a", b"x"),
            |_| {}
        )
        .is_err()
    );
    assert!(!f.dir.path().join("calls.jsonl").exists(), "ssh ran");
    assert!(upload::check_total(upload::MAX_DROP_BYTES).is_ok());
    let err = upload::check_total(upload::MAX_DROP_BYTES + 1).unwrap_err();
    assert!(err.contains("1024 MB"), "{err}");
}
