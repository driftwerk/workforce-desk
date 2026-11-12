//! Whether Google Chrome started this host: its parent process (on Windows
//! the parent, or the grandparent behind the `cmd.exe` Chrome starts hosts
//! through) is Chrome's own program, signed by Google, and still the
//! process that started this one once that is checked.
//!
//! - macOS: the running process's own code signature (`codesign --verify`
//!   on its pid, which checks the process, not the file on disk) must be
//!   Google's (team `EQHXZ8M8AV`).
//! - Windows: the program must be named `chrome.exe`, wherever it is
//!   installed (machine-wide under Program Files, or per person under
//!   AppData, common without admin rights), and its Authenticode signature
//!   must verify (`WinVerifyTrust`) with Google LLC as the signer: the
//!   signature is the check, not the path.
//! - Linux: Chrome's own path under `/opt/google`, which only root writes.
//! - Everywhere: the parent is read again after the checks, and a parent
//!   that changed (it exited, and its pid went to another) is refused.
//!
//! It raises the bar for a program that starts Desk Helper pretending to be
//! Chrome; it is not proof (a program running as the person can still
//! drive their real Chrome), and the hub never takes it as such: the
//! profile's key, confirmed once by the person, is what it trusts.

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
        "windows" => {
            // Any path: Google's signature, checked after, is what counts.
            last_part(&s).eq_ignore_ascii_case("chrome.exe")
        }
        _ => false,
    }
}

/// Whether `exe`, on Windows, is the `cmd.exe` Chrome starts a host
/// through: the one in Windows' own `system` folder.
pub fn is_cmd(exe: &Path, system: &Path) -> bool {
    let s = exe
        .to_string_lossy()
        .to_ascii_lowercase()
        .replace('/', "\\");
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
    let want = system
        .join("cmd.exe")
        .to_string_lossy()
        .to_ascii_lowercase()
        .replace('/', "\\");
    s == want
}

/// A Windows path's last part, whichever separator it uses.
fn last_part(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

/// One process above this one: its pid and its program.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Up {
    pub pid: u32,
    pub exe: PathBuf,
}

/// The process that started this one, and the one that started that.
pub fn ancestry() -> Vec<Up> {
    let mut out = Vec::new();
    let mut pid = parent_of(std::process::id());
    for _ in 0..2 {
        let Some(p) = pid else { break };
        match exe_of(p) {
            Some(exe) => out.push(Up { pid: p, exe }),
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
    let system = system_dir();
    let chrome = match (os, up.as_slice()) {
        ("windows", [first, ..]) if is_chrome(os, &first.exe, development) => Some(first),
        ("windows", [first, second, ..])
            if system.as_deref().is_some_and(|s| is_cmd(&first.exe, s))
                && is_chrome(os, &second.exe, development) =>
        {
            Some(second)
        }
        ("windows", _) => None,
        (_, [first, ..]) if is_chrome(os, &first.exe, development) => Some(first),
        _ => None,
    };
    let Some(chrome) = chrome else {
        return false;
    };
    if !signed_by_google(chrome) {
        return false;
    }
    // Still the processes checked: one that exited meanwhile, its pid
    // reused by another, or this host left to the system, is refused.
    ancestry()
        .iter()
        .map(|u| u.pid)
        .eq(up.iter().map(|u| u.pid))
}

/// On macOS, in a release, the running Chrome's signature is Google's own:
/// checked on the process itself (its pid), not the file it was read from.
#[cfg(target_os = "macos")]
fn signed_by_google(chrome: &Up) -> bool {
    if cfg!(debug_assertions) {
        return true;
    }
    std::process::Command::new("/usr/bin/codesign")
        .args([
            "--verify",
            "-R=anchor apple generic and certificate leaf[subject.OU] = EQHXZ8M8AV",
        ])
        .arg(chrome.pid.to_string())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// On Windows, in a release, Chrome's program verifies by Authenticode with
/// Google LLC as its signer.
#[cfg(windows)]
fn signed_by_google(chrome: &Up) -> bool {
    if cfg!(debug_assertions) {
        return true;
    }
    authenticode::signer_of(&chrome.exe).is_some_and(|o| o == "Google LLC")
}

#[cfg(not(any(target_os = "macos", windows)))]
fn signed_by_google(_chrome: &Up) -> bool {
    true
}

/// Windows' own `system` folder (`C:\Windows\System32`), from Windows,
/// never from the environment the parent gave this process.
#[cfg(windows)]
fn system_dir() -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    let mut buf = vec![0u16; 512];
    // SAFETY: `buf` is a valid, writable buffer of the length passed.
    let n = unsafe {
        windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW(
            buf.as_mut_ptr(),
            buf.len() as u32,
        )
    } as usize;
    (n > 0 && n < buf.len()).then(|| PathBuf::from(std::ffi::OsString::from_wide(&buf[..n])))
}

#[cfg(not(windows))]
fn system_dir() -> Option<PathBuf> {
    None
}

#[cfg(windows)]
mod authenticode {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Security::Cryptography::{
        CERT_NAME_ATTR_TYPE, CertGetNameStringW, szOID_ORGANIZATION_NAME,
    };
    use windows_sys::Win32::Security::WinTrust::{
        WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO,
        WTD_CHOICE_FILE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY,
        WTD_UI_NONE, WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData, WinVerifyTrust,
    };

    /// The organisation `exe` is signed by, if its Authenticode signature
    /// verifies.
    pub fn signer_of(exe: &Path) -> Option<String> {
        let wide: Vec<u16> = exe.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut file = WINTRUST_FILE_INFO {
            cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
            pcwszFilePath: wide.as_ptr(),
            hFile: std::ptr::null_mut(),
            pgKnownSubject: std::ptr::null_mut(),
        };
        let mut data = WINTRUST_DATA {
            cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
            dwUIChoice: WTD_UI_NONE,
            fdwRevocationChecks: WTD_REVOKE_NONE,
            dwUnionChoice: WTD_CHOICE_FILE,
            Anonymous: WINTRUST_DATA_0 { pFile: &mut file },
            dwStateAction: WTD_STATEACTION_VERIFY,
            ..Default::default()
        };
        let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
        // SAFETY: `data` and `file` are initialised as WinVerifyTrust
        // requires and outlive the calls; the state it opens is closed on
        // every path below.
        unsafe {
            let verified =
                WinVerifyTrust(std::ptr::null_mut(), &mut action, (&raw mut data).cast()) == 0;
            let signer = verified.then(|| organisation(data.hWVTStateData)).flatten();
            data.dwStateAction = WTD_STATEACTION_CLOSE;
            WinVerifyTrust(std::ptr::null_mut(), &mut action, (&raw mut data).cast());
            signer
        }
    }

    /// The organisation on the leaf certificate of the first signer.
    ///
    /// # Safety
    /// `state` is a verified WinVerifyTrust state not yet closed.
    unsafe fn organisation(state: HANDLE) -> Option<String> {
        // SAFETY: as the caller promises; each pointer is checked before use.
        unsafe {
            let prov = WTHelperProvDataFromStateData(state);
            if prov.is_null() {
                return None;
            }
            let signer = WTHelperGetProvSignerFromChain(prov, 0, 0, 0);
            if signer.is_null() || (*signer).csCertChain == 0 || (*signer).pasCertChain.is_null() {
                return None;
            }
            let cert = (*(*signer).pasCertChain).pCert;
            if cert.is_null() {
                return None;
            }
            let mut buf = vec![0u16; 256];
            let n = CertGetNameStringW(
                cert,
                CERT_NAME_ATTR_TYPE,
                0,
                szOID_ORGANIZATION_NAME.cast(),
                buf.as_mut_ptr(),
                buf.len() as u32,
            ) as usize;
            (n > 1).then(|| String::from_utf16_lossy(&buf[..n - 1]))
        }
    }
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
        assert!(win(
            r"c:\program files (x86)\google\chrome\application\CHROME.EXE"
        ));
        assert!(win(
            r"\\?\C:\Program Files\Google\Chrome Beta\Application\chrome.exe"
        ));
        assert!(!win(r"C:\Users\sarah\evil.exe"));
        assert!(!win(r"C:\Users\sarah\chrome.exe.bak"));
        // A per-person install under AppData is Chrome too: on Windows the
        // path proves nothing, so Google's signature is what decides
        // (`signed_by_google`), wherever the program is.
        assert!(win(
            r"C:\Users\sarah\AppData\Local\Google\Chrome\Application\chrome.exe"
        ));
        assert!(win(r"D:\Apps\Chrome\chrome.exe"));
        assert!(is_chrome(
            "windows",
            Path::new(r"C:\Users\sarah\cft\chrome.exe"),
            true
        ));
        let system = Path::new(r"C:\Windows\System32");
        assert!(is_cmd(Path::new(r"C:\Windows\System32\cmd.exe"), system));
        assert!(is_cmd(Path::new(r"c:\windows\system32\CMD.EXE"), system));
        assert!(!is_cmd(Path::new(r"C:\Users\sarah\cmd.exe"), system));
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
