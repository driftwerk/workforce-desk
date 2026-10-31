//! Starting `Desk Helper.exe` at Windows sign-in (the Run key), whether the
//! person turned it off in Startup apps, and the named objects that tell a
//! running one apart (a mutex it holds) and ask it to stop (an event).

use std::path::Path;

pub const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
/// Where Settings → Apps → Startup keeps whether each Run entry is on.
pub const APPROVED_KEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
/// The Run entry's name, as Startup apps lists it.
pub const VALUE: &str = "Desk Helper";
/// Held by the running `Desk Helper.exe`.
pub const MUTEX: &str = r"Local\xyz.driftwerk.desk.helper";
/// Set to ask the running one to stop starting Desk Helper again.
pub const STOP_EVENT: &str = r"Local\xyz.driftwerk.desk.helper.stop";

/// The Run entry: the launcher's path, quoted.
pub fn run_value(exe: &Path) -> String {
    format!("\"{}\"", exe.display())
}

/// Whether Startup apps' record of an entry says it is turned off: its
/// first byte is odd (2 on, 3 off).
pub fn turned_off(approved: &[u8]) -> bool {
    approved.first().is_some_and(|b| b & 1 == 1)
}

#[cfg(windows)]
pub use self::windows::*;

#[cfg(windows)]
mod windows {
    use std::path::Path;

    use eyre::{Context, Result};
    use windows_registry::CURRENT_USER;
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Threading::{
        CreateEventW, CreateMutexW, EVENT_MODIFY_STATE, OpenEventW, OpenMutexW,
        SYNCHRONIZATION_SYNCHRONIZE, SetEvent, WaitForSingleObject,
    };

    use super::{APPROVED_KEY, MUTEX, RUN_KEY, STOP_EVENT, VALUE, run_value, turned_off};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn register(exe: &Path) -> Result<()> {
        CURRENT_USER
            .create(RUN_KEY)
            .and_then(|k| k.set_string(VALUE, run_value(exe)))
            .context("adding Desk Helper to Startup apps")
    }

    /// The Run entry, when there is one.
    pub fn registered() -> Option<String> {
        CURRENT_USER.open(RUN_KEY).ok()?.get_string(VALUE).ok()
    }

    pub fn unregister() -> Result<()> {
        if registered().is_none() {
            return Ok(());
        }
        CURRENT_USER
            .create(RUN_KEY)
            .and_then(|k| k.remove_value(VALUE))
            .context("taking Desk Helper out of Startup apps")
    }

    /// Whether the person turned Desk Helper off in Startup apps.
    pub fn disabled() -> bool {
        CURRENT_USER
            .open(APPROVED_KEY)
            .ok()
            .and_then(|k| k.get_value(VALUE).ok())
            .is_some_and(|v| turned_off(&v))
    }

    /// A handle closed when dropped.
    pub struct Named(HANDLE);

    // SAFETY: a kernel handle may be used and closed from any thread.
    unsafe impl Send for Named {}

    impl Drop for Named {
        fn drop(&mut self) {
            // SAFETY: a handle this process opened and owns.
            unsafe { CloseHandle(self.0) };
        }
    }

    /// Takes the launcher's mutex; none when another launcher holds it.
    pub fn hold() -> Option<Named> {
        let name = wide(MUTEX);
        // SAFETY: a NUL-terminated name; the handle is owned by `Named`.
        let handle = unsafe { CreateMutexW(std::ptr::null(), 1, name.as_ptr()) };
        if handle.is_null() {
            return None;
        }
        let held = Named(handle);
        // SAFETY: reads this thread's last error, set by CreateMutexW.
        (unsafe { GetLastError() } != ERROR_ALREADY_EXISTS).then_some(held)
    }

    /// Whether a launcher is running (holds the mutex).
    pub fn running() -> bool {
        let name = wide(MUTEX);
        // SAFETY: a NUL-terminated name; the handle is closed at once.
        let handle = unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, 0, name.as_ptr()) };
        if handle.is_null() {
            return false;
        }
        drop(Named(handle));
        true
    }

    /// The stop event, made if it isn't there yet.
    pub fn stop_event() -> Option<Named> {
        let name = wide(STOP_EVENT);
        // SAFETY: a NUL-terminated name; manual reset, not set.
        let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, name.as_ptr()) };
        (!handle.is_null()).then_some(Named(handle))
    }

    impl Named {
        /// Whether the event is set, without waiting.
        pub fn is_set(&self) -> bool {
            // SAFETY: a handle this process owns.
            unsafe { WaitForSingleObject(self.0, 0) == WAIT_OBJECT_0 }
        }

        /// Waits up to `ms` for the event; true once it is set.
        pub fn wait(&self, ms: u32) -> bool {
            // SAFETY: a handle this process owns.
            unsafe { WaitForSingleObject(self.0, ms) == WAIT_OBJECT_0 }
        }
    }

    /// Asks the running launcher to stop starting Desk Helper again.
    pub fn ask_to_stop() {
        let name = wide(STOP_EVENT);
        // SAFETY: a NUL-terminated name; the handle is closed at once.
        let handle = unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr()) };
        if !handle.is_null() {
            let event = Named(handle);
            // SAFETY: a handle opened with EVENT_MODIFY_STATE.
            unsafe { SetEvent(event.0) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_run_entry_is_the_quoted_launcher() {
        assert_eq!(
            run_value(Path::new(
                r"C:\Users\Sarah\AppData\Local\Programs\Desk\Desk Helper.exe"
            )),
            r#""C:\Users\Sarah\AppData\Local\Programs\Desk\Desk Helper.exe""#
        );
    }

    #[test]
    fn startup_apps_off_is_an_odd_first_byte() {
        assert!(!turned_off(&[2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
        assert!(turned_off(&[
            3, 0, 0, 0, 0x80, 0x5c, 0x1e, 0x3a, 0x11, 0x2d, 0xdb, 0x01
        ]));
        assert!(!turned_off(&[]));
    }
}
