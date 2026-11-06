//! Files dropped on Desk's windows, and images pasted into its terminals.
//!
//! A drop of files from the Finder (Explorer, a file manager) arrives here
//! first, as the system's own drag and drop with the files' paths, and the
//! page hears of it with where it landed. What the page then asks of a
//! dropped file (how big it is, its bytes for a message, its path in a
//! terminal, a copy of it on a machine) it may ask only of paths that were
//! dropped on its own window in the last few minutes: nothing the page
//! says can make Desk read, or send to a machine, any other file.
//!
//! A terminal is given each file's path as its shell names it: as it is on
//! this computer; inside WSL, its path there; on a machine, the path of a
//! copy made there over SSH (`desk_machine::upload`). An image pasted into
//! a terminal is saved first, then given the same way.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime};

use desk_core::host::Host;
use desk_machine::upload;
use serde::Serialize;
use tauri::Manager;
use tauri::ipc::Channel;

use crate::machines::MachineIo;

type CommandResult<T> = Result<T, String>;

/// How long a drop's paths may be asked about.
const KEEP_FOR: Duration = Duration::from_secs(10 * 60);

/// How many drops are remembered at most.
const KEEP: usize = 32;

/// The largest dropped file the page may read to attach to a message (the
/// composer's own limit, `MAX_FILE_BYTES`).
pub const MAX_READ_BYTES: u64 = 100 * 1024 * 1024;

/// The largest image pasted into a terminal.
pub const MAX_PASTE_BYTES: usize = 50 * 1024 * 1024;

/// How long pasted images are kept.
const PASTES_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);

struct Seen {
    at: Instant,
    window: String,
    paths: Vec<PathBuf>,
}

/// The drops Desk has seen lately, by the window they landed on.
#[derive(Default)]
pub struct Drops {
    seen: Mutex<VecDeque<Seen>>,
}

impl Drops {
    /// Notes that `paths` were dropped on `window`.
    pub fn saw(&self, window: &str, paths: &[PathBuf]) {
        if paths.is_empty() {
            return;
        }
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        seen.retain(|s| s.at.elapsed() < KEEP_FOR);
        while seen.len() >= KEEP {
            seen.pop_front();
        }
        seen.push_back(Seen {
            at: Instant::now(),
            window: window.into(),
            paths: paths.to_vec(),
        });
    }

    /// Whether `path` was dropped on `window` lately.
    pub fn dropped(&self, window: &str, path: &Path) -> bool {
        let seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        seen.iter().any(|s| {
            s.window == window && s.at.elapsed() < KEEP_FOR && s.paths.iter().any(|p| p == path)
        })
    }

    /// `paths`, each checked to have been dropped on `window`.
    fn check(&self, window: &str, paths: &[String]) -> CommandResult<Vec<PathBuf>> {
        paths
            .iter()
            .map(|p| {
                let path = PathBuf::from(p);
                if self.dropped(window, &path) {
                    Ok(path)
                } else {
                    Err("Desk only reads files dropped on it. Drop it again.".to_string())
                }
            })
            .collect()
    }
}

/// Why `path` can't be typed into a terminal, if it can't: a control
/// character in it would act as a key (Return, Escape) rather than be
/// read as text, whatever quoting the page gives it.
pub fn typeable(path: &str) -> CommandResult<()> {
    if path.chars().any(char::is_control) {
        let shown: String = path
            .chars()
            .map(|c| if c.is_control() { '?' } else { c })
            .collect();
        return Err(format!(
            "“{shown}” has a control character in its name, which Desk won't type into a terminal."
        ));
    }
    Ok(())
}

/// `path` on this computer as the shell of a terminal on `host` (this
/// computer's backend) names it.
pub fn local_path(host: &Host, path: &Path) -> CommandResult<String> {
    let named = match host {
        Host::Native => path.to_string_lossy().into_owned(),
        Host::Wsl(w) => host.backend_path(path).ok_or_else(|| {
            format!(
                "{} isn't anywhere {} can reach: drop it from a Windows drive or from inside {}.",
                path.display(),
                w.distro,
                w.distro
            )
        })?,
        Host::Ssh(m) => return Err(format!("{} names its own files.", m.name)),
    };
    typeable(&named)?;
    Ok(named)
}

/// A dropped file as the page sees it.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub folder: bool,
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// What was dropped: each file's name and size, and whether it's a folder.
#[tauri::command]
pub fn dropped_files(
    webview: tauri::Webview,
    drops: tauri::State<'_, Drops>,
    paths: Vec<String>,
) -> CommandResult<Vec<DroppedFile>> {
    drops
        .check(webview.label(), &paths)?
        .into_iter()
        .map(|path| {
            let meta = std::fs::metadata(&path)
                .map_err(|e| format!("Desk couldn't read {}: {e}", name_of(&path)))?;
            Ok(DroppedFile {
                name: name_of(&path),
                path: path.to_string_lossy().into_owned(),
                size: meta.len(),
                folder: meta.is_dir(),
            })
        })
        .collect()
}

/// A dropped file's bytes, for a message it's attached to.
#[tauri::command]
pub async fn dropped_file_read(
    webview: tauri::Webview,
    drops: tauri::State<'_, Drops>,
    path: String,
) -> CommandResult<tauri::ipc::Response> {
    let path = drops
        .check(webview.label(), std::slice::from_ref(&path))?
        .remove(0);
    tauri::async_runtime::spawn_blocking(move || {
        let meta = std::fs::metadata(&path)
            .map_err(|e| format!("Desk couldn't read {}: {e}", name_of(&path)))?;
        if !meta.is_file() {
            return Err(format!("{} is a folder, not a file.", name_of(&path)));
        }
        if meta.len() > MAX_READ_BYTES {
            return Err(format!(
                "{} is over {} MB.",
                name_of(&path),
                MAX_READ_BYTES / (1024 * 1024)
            ));
        }
        std::fs::read(&path)
            .map(tauri::ipc::Response::new)
            .map_err(|e| format!("Desk couldn't read {}: {e}", name_of(&path)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// How far a copy to a machine has got, all its files together.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct Progress {
    pub sent: u64,
    pub total: u64,
}

/// A name for a drop's own folder: unique within this run, and ordered.
fn batch() -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    let ms = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    format!("{ms}-{}", N.fetch_add(1, Ordering::Relaxed))
}

/// Copies the files at `paths` to machine `id` for terminal `scope`;
/// answers their paths there. Folders aren't copied. Blocking.
fn copy_to_machine(
    machines: &MachineIo,
    id: &str,
    scope: &str,
    paths: &[PathBuf],
    progress: impl Fn(Progress),
) -> CommandResult<Vec<String>> {
    upload::check_id(scope)?;
    let link = machines.link(id)?;
    let mut files = Vec::new();
    for path in paths {
        let name = name_of(path);
        let meta =
            std::fs::metadata(path).map_err(|e| format!("Desk couldn't read {name}: {e}"))?;
        if meta.is_dir() {
            return Err(format!(
                "{name} is a folder: Desk copies files to {}, not folders.",
                link.machine().name
            ));
        }
        upload::check_name(&name)?;
        files.push((path, name, meta.len()));
    }
    let total = files.iter().map(|f| f.2).sum();
    upload::check_total(total)?;
    let home = link.home()?;
    let batch = batch();
    let mut before = 0;
    let mut out = Vec::new();
    progress(Progress { sent: 0, total });
    for (path, name, len) in files {
        let bytes =
            std::fs::File::open(path).map_err(|e| format!("Desk couldn't read {name}: {e}"))?;
        let file = upload::File { name, len, bytes };
        out.push(upload::copy(
            link.ssh(),
            link.machine(),
            &home,
            scope,
            &batch,
            file,
            |n| {
                progress(Progress {
                    sent: before + n,
                    total,
                })
            },
        )?);
        before += len;
    }
    Ok(out)
}

/// The files at `paths`, dropped on this window, as the shell of terminal
/// `scope` names them: on this computer (or inside WSL), or on machine
/// `machine`, where they are copied first, `progress` hearing how far.
#[tauri::command]
pub async fn terminal_drop(
    webview: tauri::Webview,
    app: tauri::State<'_, crate::App>,
    drops: tauri::State<'_, Drops>,
    machine: Option<String>,
    scope: String,
    paths: Vec<String>,
    progress: Channel<Progress>,
) -> CommandResult<Vec<String>> {
    let paths = drops.check(webview.label(), &paths)?;
    match machine {
        None => {
            let host = app.backend()?.host;
            paths.iter().map(|p| local_path(&host, p)).collect()
        }
        Some(id) => {
            let handle = webview.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let machines = handle.state::<MachineIo>();
                copy_to_machine(&machines, &id, &scope, &paths, |p| {
                    let _ = progress.send(p);
                })
            })
            .await
            .map_err(|e| e.to_string())?
        }
    }
}

/// The file name an image of type `mime` is saved under.
pub fn image_extension(mime: &str) -> Option<&'static str> {
    Some(match mime.split(';').next()?.trim() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/tiff" => "tiff",
        "image/bmp" => "bmp",
        "image/heic" => "heic",
        _ => return None,
    })
}

/// Saves a pasted image in `dir` (the terminal's own pastes folder), as
/// `pasted-<when>.<ext>`, removing pastes older than a week; answers where.
pub fn save_paste(pastes: &Path, scope: &str, mime: &str, bytes: &[u8]) -> CommandResult<PathBuf> {
    upload::check_id(scope)?;
    let ext = image_extension(mime).ok_or("Desk pastes images, and this isn't one it knows.")?;
    if bytes.is_empty() {
        return Err("The clipboard's image is empty.".into());
    }
    if bytes.len() > MAX_PASTE_BYTES {
        return Err(format!(
            "The clipboard's image is over {} MB.",
            MAX_PASTE_BYTES / (1024 * 1024)
        ));
    }
    prune(pastes);
    let dir = pastes.join(scope);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Desk couldn't save the image: {e}"))?;
    let path = dir.join(format!("pasted-{}.{ext}", batch()));
    std::fs::write(&path, bytes).map_err(|e| format!("Desk couldn't save the image: {e}"))?;
    Ok(path)
}

/// Removes pastes older than a week, and the folders they leave empty.
fn prune(pastes: &Path) {
    let Ok(scopes) = std::fs::read_dir(pastes) else {
        return;
    };
    for scope in scopes.flatten() {
        let Ok(files) = std::fs::read_dir(scope.path()) else {
            continue;
        };
        for file in files.flatten() {
            let old = file
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > PASTES_FOR);
            if old {
                let _ = std::fs::remove_file(file.path());
            }
        }
        let _ = std::fs::remove_dir(scope.path());
    }
}

fn header(request: &tauri::ipc::Request<'_>, name: &str) -> Option<String> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| percent_encoding::percent_decode_str(v).decode_utf8().ok())
        .map(|v| v.into_owned())
        .filter(|v| !v.trim().is_empty())
}

/// An image pasted into terminal `x-desk-scope` (the raw body, of type
/// `x-desk-type`), saved, and named as its shell names it: on this
/// computer, or copied to machine `x-desk-machine`.
#[tauri::command]
pub async fn terminal_paste_image(
    handle: tauri::AppHandle,
    app: tauri::State<'_, crate::App>,
    request: tauri::ipc::Request<'_>,
) -> CommandResult<String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("The paste carried no image.".into());
    };
    let scope = header(&request, "x-desk-scope").ok_or("The paste didn't say its terminal.")?;
    let mime = header(&request, "x-desk-type").unwrap_or_default();
    let machine = header(&request, "x-desk-machine");
    let pastes = app.paths.root.join("pastes");
    let saved = save_paste(&pastes, &scope, &mime, bytes)?;
    match machine {
        None => local_path(&app.backend()?.host, &saved),
        Some(id) => tauri::async_runtime::spawn_blocking(move || {
            let machines = handle.state::<MachineIo>();
            let copied =
                copy_to_machine(&machines, &id, &scope, std::slice::from_ref(&saved), |_| {});
            // The machine's copy is the one its terminal reads.
            let _ = std::fs::remove_file(&saved);
            copied.map(|mut paths| paths.remove(0))
        })
        .await
        .map_err(|e| e.to_string())?,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use desk_core::host::{DEFAULT_AUTOMOUNT, Wsl};

    #[test]
    fn only_what_was_dropped_on_a_window_is_given_to_it() {
        let drops = Drops::default();
        drops.saw(
            "main",
            &[
                PathBuf::from("/Users/a/one.png"),
                PathBuf::from("/Users/a/two b.png"),
            ],
        );
        drops.saw("grid-x", &[PathBuf::from("/Users/a/three.png")]);
        assert!(drops.dropped("main", Path::new("/Users/a/two b.png")));
        assert!(!drops.dropped("main", Path::new("/Users/a/three.png")));
        assert!(!drops.dropped("main", Path::new("/Users/a/.ssh/id_ed25519")));
        assert!(drops.check("main", &["/Users/a/one.png".into()]).is_ok());
        assert!(
            drops
                .check("main", &["/Users/a/one.png".into(), "/etc/passwd".into()])
                .is_err()
        );
        // An empty drop (something dragged within the page) is nothing.
        drops.saw("main", &[]);
        for i in 0..KEEP {
            drops.saw("main", &[PathBuf::from(format!("/x/{i}"))]);
        }
        assert!(
            !drops.dropped("main", Path::new("/Users/a/one.png")),
            "the oldest are let go"
        );
    }

    #[test]
    fn a_drop_is_named_as_the_terminals_shell_names_it() {
        let p = Path::new("/Users/a/Screen Shot ☕ it's.png");
        assert_eq!(local_path(&Host::Native, p).unwrap(), p.to_string_lossy());
        assert!(local_path(&Host::Native, Path::new("/tmp/a\nb")).is_err());
        assert!(local_path(&Host::Native, Path::new("/tmp/a\x1b[201~b")).is_err());
        let wsl = Host::Wsl(Wsl {
            distro: "Ubuntu".into(),
            user: "sarah".into(),
            home: "/home/sarah".into(),
            automount: DEFAULT_AUTOMOUNT.into(),
        });
        assert_eq!(
            local_path(&wsl, Path::new(r"C:\Users\Sarah\Pictures\a b.png")).unwrap(),
            "/mnt/c/Users/Sarah/Pictures/a b.png"
        );
        assert_eq!(
            local_path(&wsl, Path::new(r"\\wsl.localhost\Ubuntu\home\sarah\x.txt")).unwrap(),
            "/home/sarah/x.txt"
        );
        let far = local_path(&wsl, Path::new(r"\\server\share\x.txt")).unwrap_err();
        assert!(far.contains("Ubuntu can reach"), "{far}");
    }

    #[test]
    fn a_pasted_image_is_saved_in_its_terminals_folder() {
        let dir = tempfile::tempdir().unwrap();
        let png = b"\x89PNG\r\n\x1a\nrest";
        let a = save_paste(dir.path(), "s-1", "image/png", png).unwrap();
        assert!(a.starts_with(dir.path().join("s-1")));
        assert_eq!(a.extension().unwrap(), "png");
        assert_eq!(std::fs::read(&a).unwrap(), png);
        let b = save_paste(dir.path(), "s-1", "image/jpeg", b"jpg").unwrap();
        assert_ne!(a, b);
        assert_eq!(b.extension().unwrap(), "jpg");
        assert!(save_paste(dir.path(), "s-1", "text/plain", b"x").is_err());
        assert!(save_paste(dir.path(), "../s", "image/png", png).is_err());
        assert!(save_paste(dir.path(), "s", "image/png", b"").is_err());
        assert!(save_paste(dir.path(), "s", "image/png", &vec![0; MAX_PASTE_BYTES + 1]).is_err());
    }
}
