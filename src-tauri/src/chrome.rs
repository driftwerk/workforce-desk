//! Brings the person's Chrome forward, for "Connect my Chrome".
//!
//! Chrome refuses a `chrome://` address handed to it from outside (on its
//! command line or forwarded to a running Chrome it opens a New Tab page
//! instead), so Desk can't open `chrome://inspect/#remote-debugging` for
//! the person: it opens Chrome itself, with no address, and the page has
//! the person paste the one it copied. Nothing is passed that turns
//! debugging on: Chrome ignores the debugging switches on the person's own
//! profile, and the opt-in is theirs to give on Chrome's own page.

use std::path::{Path, PathBuf};
use std::process::Command;

/// How Desk opens Chrome on this computer: a program and its arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// Where Chrome is on Windows, by its usual install folders.
fn windows_chrome(
    env: &dyn Fn(&str) -> Option<String>,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
        .iter()
        .filter_map(|v| env(v))
        .map(|base| PathBuf::from(base).join(r"Google\Chrome\Application\chrome.exe"))
        .find(|p| exists(p))
}

/// The folders Chrome's launchers install to on Linux. Fixed, never read
/// from `PATH`: a relative or planted entry there can't pick what runs.
const LINUX_DIRS: &[&str] = &[
    "/usr/bin",
    "/usr/local/bin",
    "/opt/google/chrome",
    "/snap/bin",
];

/// Where Chrome is on Linux: the first of its launchers in [`LINUX_DIRS`].
fn linux_chrome(exists: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    LINUX_DIRS
        .iter()
        .flat_map(|dir| {
            ["google-chrome-stable", "google-chrome", "chrome"]
                .iter()
                .map(move |name| Path::new(dir).join(name))
        })
        .find(|p| exists(p))
}

/// Whether `path` is a program this person can run: a file, executable.
fn runnable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

/// How to open Chrome on `os` (`std::env::consts::OS`), with no address
/// and no switches; none where Chrome isn't installed.
pub fn launch(
    os: &str,
    env: &dyn Fn(&str) -> Option<String>,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<Launch> {
    match os {
        "macos" => Some(Launch {
            program: PathBuf::from("/usr/bin/open"),
            args: vec!["-b".into(), "com.google.Chrome".into()],
        }),
        "windows" => windows_chrome(env, exists).map(|program| Launch {
            program,
            args: vec![],
        }),
        _ => linux_chrome(exists).map(|program| Launch {
            program,
            args: vec![],
        }),
    }
}

pub const NOT_INSTALLED: &str = "Chrome isn't installed on this computer.";

/// Opens the person's Chrome (or brings it forward when it's open).
pub fn open() -> Result<(), String> {
    let env = |k: &str| std::env::var(k).ok();
    let exists = |p: &Path| runnable(p);
    let Some(how) = launch(std::env::consts::OS, &env, &exists) else {
        return Err(NOT_INSTALLED.into());
    };
    let mut command = Command::new(&how.program);
    command.args(&how.args);
    if cfg!(target_os = "macos") {
        // `open` says whether Chrome is there; it returns once it's asked.
        let out = command.output().map_err(|e| e.to_string())?;
        return if out.status.success() {
            Ok(())
        } else {
            Err(NOT_INSTALLED.into())
        };
    }
    // Chrome hands itself to a running Chrome and exits, or keeps running:
    // either way it is waited for on a thread of its own, so it never
    // lingers as a zombie of Desk's.
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of<'a>(vars: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| {
            vars.iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn on_a_mac_chrome_opens_by_its_bundle_id_with_no_address_or_switch() {
        let how = launch("macos", &|_| None, &|_| false).unwrap();
        assert_eq!(how.program, PathBuf::from("/usr/bin/open"));
        assert_eq!(how.args, ["-b", "com.google.Chrome"]);
    }

    #[test]
    fn on_windows_chrome_is_found_where_it_installs_and_given_nothing() {
        let env = env_of(&[
            (r"ProgramFiles", r"C:\Program Files"),
            ("LOCALAPPDATA", r"C:\Users\sarah\AppData\Local"),
        ]);
        let local = PathBuf::from(r"C:\Users\sarah\AppData\Local")
            .join(r"Google\Chrome\Application\chrome.exe");
        let how = launch("windows", &env, &|p| p == local).unwrap();
        assert_eq!(how.program, local);
        assert!(how.args.is_empty());
        assert_eq!(launch("windows", &env, &|_| false), None, "not installed");
    }

    #[test]
    fn on_linux_chrome_is_found_in_its_install_folders_never_by_path() {
        let chrome = Path::new("/opt/google/chrome").join("google-chrome");
        let env = env_of(&[("PATH", "bin:.:/home/sarah/evil")]);
        let how = launch("linux", &env, &|p| p == chrome).unwrap();
        assert_eq!(how.program, chrome);
        assert!(how.args.is_empty());
        let planted = Path::new("/home/sarah/evil").join("google-chrome");
        assert_eq!(
            launch("linux", &env, &|p| p == planted),
            None,
            "a PATH entry never picks what runs"
        );
        assert_eq!(launch("linux", &env, &|_| false), None);
    }

    #[cfg(unix)]
    #[test]
    fn only_an_executable_file_is_run() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("google-chrome");
        std::fs::write(&file, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!runnable(&file), "not executable");
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(runnable(&file));
        assert!(!runnable(dir.path()), "a folder");
        assert!(!runnable(&dir.path().join("missing")));
    }

    #[test]
    fn nothing_desk_passes_turns_debugging_on_or_names_a_page() {
        let env = env_of(&[("ProgramFiles", "C:/P"), ("PATH", "/usr/bin")]);
        for os in ["macos", "windows", "linux"] {
            if let Some(how) = launch(os, &env, &|_| true) {
                for a in &how.args {
                    assert!(!a.contains("debug") && !a.contains("://"), "{os}: {a}");
                }
            }
        }
    }
}
