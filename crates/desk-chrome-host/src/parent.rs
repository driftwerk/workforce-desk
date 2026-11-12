//! Whether Google Chrome started this host: its parent process (on Windows
//! the parent, or the grandparent behind the `cmd.exe` Chrome starts hosts
//! through) is Chrome's own program. It raises the bar for a program that
//! starts Desk Helper pretending to be Chrome; it is not proof, and the hub
//! never takes it as such.

use std::path::{Path, PathBuf};

/// Whether `exe` is Google Chrome's program on `os`. A development build
/// also takes Chrome for Testing, which the end-to-end test runs.
pub fn is_chrome(os: &str, exe: &Path, development: bool) -> bool {
    let s = exe.to_string_lossy();
    match os {
        "macos" => {
            let channels = [
                "Google Chrome",
                "Google Chrome Beta",
                "Google Chrome Dev",
                "Google Chrome Canary",
            ];
            channels
                .iter()
                .any(|c| s.ends_with(&format!("/{c}.app/Contents/MacOS/{c}")))
                || (development
                    && s.ends_with(
                        "/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
                    ))
        }
        "linux" => {
            [
                "/opt/google/chrome/chrome",
                "/opt/google/chrome-beta/chrome",
                "/opt/google/chrome-unstable/chrome",
            ]
            .contains(&s.as_ref())
                || (development && exe.file_name().is_some_and(|n| n == "chrome"))
        }
        "windows" => last_part(&s).eq_ignore_ascii_case("chrome.exe"),
        _ => false,
    }
}

/// Whether `exe`, on Windows, is the `cmd.exe` Chrome starts a host
/// through.
pub fn is_cmd(exe: &Path) -> bool {
    last_part(&exe.to_string_lossy()).eq_ignore_ascii_case("cmd.exe")
}

/// A Windows path's last part, whichever separator it uses.
fn last_part(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

/// The process that started this one, and the one that started that.
pub fn ancestry() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut pid = parent_of(std::process::id());
    for _ in 0..2 {
        let Some(p) = pid else { break };
        match exe_of(p) {
            Some(exe) => out.push(exe),
            None => break,
        }
        pid = parent_of(p);
    }
    out
}

/// Whether this host was started by Google Chrome.
pub fn started_by_chrome() -> bool {
    let os = std::env::consts::OS;
    let development = cfg!(debug_assertions);
    let up = ancestry();
    let ok = match (os, up.as_slice()) {
        ("windows", [first, ..]) if is_chrome(os, first, development) => true,
        ("windows", [first, second, ..]) => is_cmd(first) && is_chrome(os, second, development),
        (_, [first, ..]) => is_chrome(os, first, development),
        _ => false,
    };
    ok && signed_by_google(up.first().map(PathBuf::as_path))
}

/// On macOS, in a release, Chrome's signature is Google's own.
#[cfg(target_os = "macos")]
fn signed_by_google(exe: Option<&Path>) -> bool {
    if cfg!(debug_assertions) {
        return true;
    }
    let Some(app) = exe.and_then(|e| e.ancestors().nth(3)) else {
        return false;
    };
    std::process::Command::new("/usr/bin/codesign")
        .args([
            "--verify",
            "-R=anchor apple generic and certificate leaf[subject.OU] = EQHXZ8M8AV",
        ])
        .arg(app)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg(not(target_os = "macos"))]
fn signed_by_google(_exe: Option<&Path>) -> bool {
    true
}

#[cfg(target_os = "linux")]
fn parent_of(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The command name is in parentheses and may hold spaces: read past it.
    let rest = &stat[stat.rfind(')')? + 2..];
    rest.split_whitespace()
        .nth(1)?
        .parse()
        .ok()
        .filter(|p| *p > 0)
}

#[cfg(target_os = "linux")]
fn exe_of(pid: u32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/exe")).ok()
}

#[cfg(target_os = "macos")]
fn parent_of(pid: u32) -> Option<u32> {
    if pid == std::process::id() {
        // SAFETY: getppid has no preconditions.
        return Some(unsafe { libc::getppid() } as u32).filter(|p| *p > 1);
    }
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    // SAFETY: `info` is a valid, writable buffer of `size` bytes.
    let n = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            (&raw mut info).cast(),
            size,
        )
    };
    (n == size).then_some(info.pbi_ppid).filter(|p| *p > 1)
}

#[cfg(target_os = "macos")]
fn exe_of(pid: u32) -> Option<PathBuf> {
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: `buf` is a valid, writable buffer of the size given.
    let n = unsafe { libc::proc_pidpath(pid as i32, buf.as_mut_ptr().cast(), buf.len() as u32) };
    (n > 0).then(|| {
        buf.truncate(n as usize);
        PathBuf::from(String::from_utf8_lossy(&buf).into_owned())
    })
}

#[cfg(windows)]
fn parent_of(pid: u32) -> Option<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    // SAFETY: plain Win32 calls; the entry is sized as the API requires and
    // the snapshot handle is closed on every path.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = None;
        if Process32FirstW(snap, &mut e) != 0 {
            loop {
                if e.th32ProcessID == pid {
                    found = Some(e.th32ParentProcessID).filter(|p| *p != 0);
                    break;
                }
                if Process32NextW(snap, &mut e) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
        found
    }
}

#[cfg(windows)]
fn exe_of(pid: u32) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
    };
    // SAFETY: plain Win32 calls with a buffer sized as passed; the handle is
    // closed on every path.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let mut buf = vec![0u16; 32_768];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(h);
        (ok != 0).then(|| PathBuf::from(std::ffi::OsString::from_wide(&buf[..len as usize])))
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn parent_of(_pid: u32) -> Option<u32> {
    None
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn exe_of(_pid: u32) -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_google_chromes_own_program_counts() {
        let mac = |p: &str, dev| is_chrome("macos", Path::new(p), dev);
        assert!(mac(
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            false
        ));
        assert!(mac(
            "/Users/sarah/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
            false
        ));
        assert!(
            !mac("/tmp/Google Chrome", false),
            "a program merely named so"
        );
        assert!(!mac(
            "/Applications/Google Chrome.app/Contents/MacOS/evil",
            false
        ));
        let cft = "/x/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
        assert!(!mac(cft, false), "not in a release");
        assert!(mac(cft, true));
        let linux = |p: &str, dev| is_chrome("linux", Path::new(p), dev);
        assert!(linux("/opt/google/chrome/chrome", false));
        assert!(!linux("/home/sarah/bin/chrome", false));
        assert!(linux("/home/sarah/cft/chrome", true));
        let win = |p: &str| is_chrome("windows", Path::new(p), false);
        assert!(win(
            r"C:\Program Files\Google\Chrome\Application\chrome.exe"
        ));
        assert!(!win(r"C:\Users\sarah\evil.exe"));
        assert!(is_cmd(Path::new(r"C:\Windows\System32\cmd.exe")));
    }

    #[test]
    fn this_process_has_a_parent_to_check() {
        // Run by cargo, never by Chrome: it is read, and it isn't Chrome.
        if cfg!(any(target_os = "linux", target_os = "macos", windows)) {
            assert!(!ancestry().is_empty());
            assert!(!started_by_chrome());
        }
    }
}
