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

/// Where Chrome is on Linux: the first of its launchers on `PATH`.
fn linux_chrome(
    env: &dyn Fn(&str) -> Option<String>,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let path = env("PATH")?;
    ["google-chrome-stable", "google-chrome"]
        .iter()
        .flat_map(|name| std::env::split_paths(&path).map(move |dir| dir.join(name)))
        .find(|p| exists(p))
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
        _ => linux_chrome(env, exists).map(|program| Launch {
            program,
            args: vec![],
        }),
    }
}

pub const NOT_INSTALLED: &str = "Chrome isn't installed on this computer.";

/// Opens the person's Chrome (or brings it forward when it's open).
pub fn open() -> Result<(), String> {
    let env = |k: &str| std::env::var(k).ok();
    let exists = |p: &Path| p.is_file();
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
    // Chrome hands itself to a running Chrome and exits, or keeps running.
    command.spawn().map(|_| ()).map_err(|e| e.to_string())
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
    fn on_linux_chrome_is_its_launcher_on_the_path() {
        let env = env_of(&[("PATH", "/usr/local/bin:/usr/bin")]);
        let how = launch("linux", &env, &|p| p == Path::new("/usr/bin/google-chrome")).unwrap();
        assert_eq!(how.program, PathBuf::from("/usr/bin/google-chrome"));
        assert_eq!(launch("linux", &env, &|_| false), None);
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
