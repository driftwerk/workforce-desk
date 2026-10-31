//! `Desk Helper.exe`, run from the Run key at Windows sign-in: keeps Desk
//! Helper running inside the WSL distro Desk set up (`--stop` stops it).

#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
fn main() -> std::process::ExitCode {
    use std::io::Write;
    use std::process::ExitCode;
    use std::time::Duration;

    use desk_core::backend::read_host;
    use desk_core::host::Host;
    use desk_wsl::{WslExe, launcher, startup};

    let Ok(paths) = desk_core::Paths::new() else {
        return ExitCode::FAILURE;
    };
    let _ = std::fs::create_dir_all(paths.logs());
    let log = std::sync::Mutex::new(
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(paths.logs().join("desk-helper.log"))
            .ok(),
    );
    let say = |line: &str| {
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        if let Ok(mut f) = log.lock()
            && let Some(f) = f.as_mut()
        {
            let _ = writeln!(f, "{at} {line}");
        }
    };
    let w = match read_host(&paths) {
        Ok(Some(Host::Wsl(w))) => w,
        Ok(_) => {
            say("Desk isn't set up in WSL yet");
            return ExitCode::FAILURE;
        }
        Err(e) => {
            say(&format!("{e:#}"));
            return ExitCode::FAILURE;
        }
    };
    let wsl = WslExe::system();
    if std::env::args().any(|a| a == "--stop") {
        startup::ask_to_stop();
        return match launcher::stop(&wsl, &w) {
            Ok(s) if s.success() => ExitCode::SUCCESS,
            Ok(s) => {
                say(&format!("stopping Desk Helper in {}: {s}", w.distro));
                ExitCode::FAILURE
            }
            Err(e) => {
                say(&format!("{e:#}"));
                ExitCode::FAILURE
            }
        };
    }
    let Some(_held) = startup::hold() else {
        return ExitCode::SUCCESS;
    };
    let Some(stop) = startup::stop_event() else {
        say("couldn't make the stop event");
        return ExitCode::FAILURE;
    };
    let name = desk_core::computer_name().unwrap_or_default();
    say(&format!("keeping Desk Helper running in {}", w.distro));
    let pause = |d: Duration| {
        stop.wait(u32::try_from(d.as_millis()).unwrap_or(u32::MAX));
    };
    match launcher::run(&wsl, &w, &name, &|| stop.is_set(), &pause, &say) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            say(&format!("{e:#}"));
            ExitCode::FAILURE
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Desk Helper.exe runs on Windows; macOS and Linux run desk-hubd itself");
    std::process::exit(2);
}
