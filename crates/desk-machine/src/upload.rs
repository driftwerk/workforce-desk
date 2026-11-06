//! Copying files dropped on a machine's terminal to that machine, over the
//! person's own `ssh` with Desk's fixed options, so the terminal can be
//! given their paths there.
//!
//! Each file goes on one `ssh` of its own, its bytes on ssh's input, into
//! `~/.local/share/Desk/uploads/<terminal>/<drop>/<name>` on the machine: a
//! folder per terminal and one per drop inside it, so two drops of a
//! `screenshot.png` never overwrite each other. The command run there is a
//! fixed script; the terminal, the drop and the name reach it only as its
//! arguments, each quoted as one word and checked first, so nothing in a
//! file's name is ever read by the machine's shell. A copy is written to a
//! hidden `.part` beside where it goes and renamed once all of it has
//! arrived; a broken one is removed. Drops older than a week are removed
//! when the next is copied.

use std::io::{Read, Write};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use desk_core::machine::{MACHINE_ROOT, Machine, is_format, plain};

use crate::ssh::{self, SSH_FAILED, SshExe};

/// The folder under the backend's where dropped files go.
pub const UPLOADS: &str = "uploads";

/// The most one drop copies to a machine, all its files together.
pub const MAX_DROP_BYTES: u64 = 1024 * 1024 * 1024;

/// The longest name a copied file may have, in bytes: under the 255 a
/// Linux file name has, leaving room for the `.part` it is written as.
pub const MAX_NAME_BYTES: usize = 240;

/// How much is written to ssh at a time; progress is said after each.
const CHUNK: usize = 256 * 1024;

/// What the machine runs for each file: `$1` the terminal's folder, `$2`
/// the drop's, `$3` the name, `$4` how many bytes are coming. It says the
/// path it wrote. Exits 3 when fewer bytes came than were sent (the copy
/// stopped here, ssh's input ending early). The partial is removed however
/// it ends: `cat` runs in the background so that a hang-up or a signal
/// is acted on at once (a shell defers its traps while a command in the
/// foreground runs), ending it and exiting, and leaving runs the EXIT trap.
const SCRIPT: &str = r#"set -e
umask 077
up="$HOME/.local/share/Desk/uploads"
find "$up" -mindepth 2 -maxdepth 2 -type d -mtime +7 -exec rm -rf -- {} + 2>/dev/null || true
d="$up/$1/$2"
mkdir -p -- "$d"
part="$d/.$3.part"
trap 'rm -f -- "$part"' EXIT
exec 3<&0
cat <&3 > "$part" &
c=$!
exec 3<&-
trap 'kill "$c" 2>/dev/null; exit 129' HUP INT TERM
wait "$c"
n=$(wc -c < "$part" | tr -d ' ')
if [ "$n" != "$4" ]; then echo "only $n of $4 bytes arrived" >&2; exit 3; fi
mv -f -- "$part" "$d/$3"
trap - EXIT
printf '%s\n' "$d/$3""#;

/// Why `name` can't be a copied file's name on a machine, if it can't: it
/// must be one plain name (no `/`, not `.` or `..`), short enough, and
/// hold no control character nor invisible formatting (a bidi override
/// that shows `gpj.exe` as `exe.jpg`). Spaces, quotes and any other
/// Unicode are fine: the name is only ever an argument.
pub fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." {
        return Err("A file needs a name to be copied.".into());
    }
    if name.contains('/') || name.contains('\0') {
        return Err(format!("“{}” isn't one file's name.", printable(name)));
    }
    if !plain(name) {
        return Err(format!(
            "“{}” has a control or invisible character in its name, which Desk won't type into a terminal.",
            printable(name)
        ));
    }
    if name.len() > MAX_NAME_BYTES {
        return Err(format!(
            "“{}…” has too long a name to copy.",
            name.chars().take(40).collect::<String>()
        ));
    }
    Ok(())
}

/// Why `id` can't name a terminal's or a drop's folder: a plain token of
/// letters, digits, `-` and `_`, at most 128 long.
pub fn check_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err("Desk couldn't tell which terminal the files were for.".into())
    }
}

/// Why a drop of `total` bytes is too big to copy to a machine, if it is.
pub fn check_total(total: u64) -> Result<(), String> {
    if total > MAX_DROP_BYTES {
        return Err(format!(
            "That's {} MB; Desk copies up to {} MB at a time to a machine.",
            total.div_ceil(1024 * 1024),
            MAX_DROP_BYTES / (1024 * 1024)
        ));
    }
    Ok(())
}

/// `name` with its control and format characters shown as `?`, for a
/// message.
pub fn printable(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_control() || is_format(c) {
                '?'
            } else {
                c
            }
        })
        .take(80)
        .collect()
}

/// `names`, each as it is unless an earlier one has it: then with ` (2)`,
/// ` (3)`… before its extension, so files of one name in one drop don't
/// overwrite each other.
pub fn unique(names: &[String]) -> Vec<String> {
    let mut taken = std::collections::BTreeSet::new();
    names
        .iter()
        .map(|name| {
            let (stem, ext) = match name.rfind('.') {
                Some(i) if i > 0 => name.split_at(i),
                _ => (name.as_str(), ""),
            };
            let mut n = 1;
            let mut candidate = name.clone();
            while !taken.insert(candidate.clone()) {
                n += 1;
                candidate = format!("{stem} ({n}){ext}");
            }
            candidate
        })
        .collect()
}

/// The longest any one drop is given to copy.
pub const MAX_COPY_TIME: Duration = Duration::from_secs(60 * 60);

/// How long a drop of `bytes` may take: a minute, and a second for each
/// 256 KB (a slow link's pace), at most [`MAX_COPY_TIME`].
pub fn time_limit(bytes: u64) -> Duration {
    (Duration::from_secs(60) + Duration::from_secs(bytes / (256 * 1024))).min(MAX_COPY_TIME)
}

/// What a copy stopped by its [`Stop`] answers.
pub const CANCELLED: &str = "The copy was cancelled.";

/// What stops a drop's copy before it is done: the person cancelling it,
/// or its time running out. Stopped, its `ssh` is ended, the machine's
/// input ends early, and the partial there is removed.
#[derive(Clone)]
pub struct Stop {
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
}

impl Stop {
    pub fn new(deadline: Instant) -> Self {
        Self {
            cancelled: Arc::default(),
            deadline,
        }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    /// Why it stopped, once it has.
    fn fired(&self) -> Option<&'static str> {
        if self.cancelled.load(Ordering::SeqCst) {
            Some(CANCELLED)
        } else if Instant::now() >= self.deadline {
            Some("took too long, and was stopped")
        } else {
            None
        }
    }
}

/// Where a file copied for terminal `scope` in drop `batch` lands, as the
/// machine names it from `home`.
pub fn remote_path(home: &str, scope: &str, batch: &str, name: &str) -> String {
    format!(
        "{}/{MACHINE_ROOT}/{UPLOADS}/{scope}/{batch}/{name}",
        home.trim_end_matches('/')
    )
}

/// One file to copy: its name there, its length, and its bytes.
pub struct File<R> {
    pub name: String,
    pub len: u64,
    pub bytes: R,
}

/// Copies `file` to `machine` (whose home is `home`) for terminal `scope`,
/// in drop `batch`; `sent` is told how many of its bytes have gone so far.
/// Only `file.len` bytes are sent, however many more its reader has.
/// Answers the path it has there. Blocking; `stop` ends it early.
#[allow(clippy::too_many_arguments)]
pub fn copy<R: Read>(
    ssh: &SshExe,
    machine: &Machine,
    home: &str,
    scope: &str,
    batch: &str,
    file: File<R>,
    stop: &Stop,
    mut sent: impl FnMut(u64),
) -> Result<String, String> {
    check_id(scope)?;
    check_id(batch)?;
    check_name(&file.name)?;
    let invocation = machine.command(&[
        "sh".into(),
        "-c".into(),
        SCRIPT.into(),
        "sh".into(),
        scope.into(),
        batch.into(),
        file.name.clone(),
        file.len.to_string(),
    ]);
    if let Some(why) = stop.fired() {
        return Err(stopped(&file.name, machine, why));
    }
    let mut child = ssh
        .command(&invocation)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Desk couldn't run ssh: {e}"))?;
    // Its output and errors are read while the bytes go, so neither can
    // fill and stall it.
    let mut stdout = child.stdout.take().expect("piped");
    let mut stderr = child.stderr.take().expect("piped");
    let out = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = stdout.read_to_end(&mut b);
        b
    });
    let err = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = stderr.read_to_end(&mut b);
        b
    });
    let mut input = child.stdin.take().expect("piped");
    let child = Arc::new(Mutex::new(child));
    // Ends ssh once `stop` fires, even while a write to it is stuck on a
    // stalled link.
    let finished = Arc::new(AtomicBool::new(false));
    let watchdog = {
        let (child, finished, stop) = (Arc::clone(&child), Arc::clone(&finished), stop.clone());
        std::thread::spawn(move || {
            while !finished.load(Ordering::SeqCst) {
                if stop.fired().is_some() {
                    let _ = child.lock().unwrap_or_else(|e| e.into_inner()).kill();
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        })
    };
    let mut bytes = file.bytes.take(file.len);
    let mut buf = vec![0; CHUNK];
    let mut done = 0u64;
    let mut local: Option<String> = None;
    loop {
        if stop.fired().is_some() {
            break;
        }
        let n = match bytes.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                local = Some(format!("Desk couldn't read {}: {e}", file.name));
                break;
            }
        };
        // A write that fails is ssh gone: what it said is read below.
        if input.write_all(&buf[..n]).is_err() {
            break;
        }
        done += n as u64;
        sent(done);
    }
    // The end of the file (early, when it was stopped: the machine then
    // removes what arrived).
    drop(input);
    let status = loop {
        let exited = child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .try_wait()
            .map_err(|e| format!("Desk couldn't run ssh: {e}"))?;
        if let Some(status) = exited {
            break status;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    finished.store(true, Ordering::SeqCst);
    let _ = watchdog.join();
    let out = out.join().unwrap_or_default();
    let err = err.join().unwrap_or_default();
    if let Some(why) = stop.fired() {
        return Err(stopped(&file.name, machine, why));
    }
    if let Some(why) = local {
        return Err(why);
    }
    match status.code() {
        Some(0) => {}
        Some(SSH_FAILED) => return Err(ssh::problem(machine, &err)),
        Some(3) => {
            return Err(format!(
                "The copy of {} to {} broke off.",
                file.name, machine.name
            ));
        }
        _ => {
            let said = String::from_utf8_lossy(&err);
            let line = said.lines().rev().find(|l| !l.trim().is_empty());
            let said = line
                .and_then(|l| desk_core::machine::said_by(&machine.name, l))
                .map(|s| format!(" {s}"))
                .unwrap_or_default();
            return Err(format!(
                "Desk couldn't copy {} to {}.{said}",
                file.name, machine.name
            ));
        }
    }
    let wanted = remote_path(home, scope, batch, &file.name);
    let said = String::from_utf8_lossy(&out);
    if said.trim_end_matches('\n') != wanted {
        return Err(format!(
            "{} didn't say where it put {}.",
            machine.name, file.name
        ));
    }
    Ok(wanted)
}

/// What a copy stopped for `why` answers.
fn stopped(name: &str, machine: &Machine, why: &str) -> String {
    if why == CANCELLED {
        CANCELLED.into()
    } else {
        format!("The copy of {name} to {} {why}.", machine.name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_with_spaces_quotes_and_unicode_are_fine() {
        for ok in [
            "Screenshot 2026-11-06 at 10.15.32.png",
            "it's \"quoted\" $(rm -rf ~) `x`; & | *.png",
            "café.png",
            "cafe\u{301}.png",
            "日本語のファイル.pdf",
            "-rf",
            ".hidden",
        ] {
            assert_eq!(check_name(ok), Ok(()), "{ok}");
        }
    }

    #[test]
    fn names_that_arent_one_plain_name_are_refused() {
        for bad in [
            "",
            ".",
            "..",
            "a/b",
            "line\nbreak",
            "esc\x1b[201~",
            "nul\0",
            "c1\u{9b}",
            "del\x7f",
            "rtl\u{202e}gnp.exe",
            "zero\u{200b}width",
            "bom\u{feff}",
        ] {
            assert!(check_name(bad).is_err(), "{bad:?}");
        }
        assert!(check_name(&"x".repeat(MAX_NAME_BYTES + 1)).is_err());
        assert!(check_name(&"é".repeat(MAX_NAME_BYTES / 2)).is_ok());
    }

    #[test]
    fn files_of_one_name_in_a_drop_are_kept_apart() {
        let names = [
            "a.png",
            "a.png",
            "b",
            "b",
            "a.png",
            ".env",
            ".env",
            "a (2).png",
        ]
        .map(String::from);
        assert_eq!(
            unique(&names),
            [
                "a.png",
                "a (2).png",
                "b",
                "b (2)",
                "a (3).png",
                ".env",
                ".env (2)",
                "a (2) (2).png"
            ]
        );
    }

    #[test]
    fn a_copy_has_time_for_its_size() {
        assert_eq!(time_limit(0), Duration::from_secs(60));
        assert_eq!(time_limit(256 * 1024 * 600), Duration::from_secs(660));
        assert_eq!(time_limit(u64::MAX), MAX_COPY_TIME);
    }

    #[test]
    fn ids_are_plain_tokens() {
        assert!(check_id("0f7c2e1a-3b44-4c1e-9d0b-6a1f2e3d4c5b").is_ok());
        assert!(check_id("t_12").is_ok());
        for bad in ["", "../x", "a b", "a/b", "$(x)", &"a".repeat(129)] {
            assert!(check_id(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_copy_lands_under_the_backends_folder() {
        assert_eq!(
            remote_path("/home/dev/", "s1", "d1", "a b.png"),
            "/home/dev/.local/share/Desk/uploads/s1/d1/a b.png"
        );
    }
}
