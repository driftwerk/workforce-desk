//! Desk Helper on Linux: a systemd user service where the session has
//! systemd, else an XDG autostart entry, which Desk also starts itself when
//! it finds the helper isn't running. An AppImage runs the helper through
//! itself (`--helper`), so its mount lives as long as the helper does.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};

use desk_core::backend::Backend;
use desk_core::install::Install;
use desk_core::{LINUX_HELPER_EXECUTABLE, Paths, process};
use eyre::{Context, Result};

use super::{Login, Status, development};

/// The service's name, and its file's.
pub const UNIT: &str = "desk-helper.service";
/// The autostart entry's file.
pub const DESKTOP: &str = "desk-helper.desktop";

/// How Desk Helper is started for an install: the packaged program, or the
/// AppImage asked to run the one inside it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub appimage: Option<PathBuf>,
}

/// None for a development run (or an install Linux doesn't have).
pub fn launch(install: &Install, exe: &Path) -> Option<Launch> {
    match install {
        Install::AppImage { path } => Some(Launch {
            program: path.clone(),
            args: vec!["--helper".into()],
            appimage: Some(path.clone()),
        }),
        Install::Package => Some(Launch {
            program: exe.with_file_name(LINUX_HELPER_EXECUTABLE),
            args: Vec::new(),
            appimage: None,
        }),
        Install::MacBundle | Install::Wsl { .. } | Install::Development => None,
    }
}

/// A value in a systemd unit, quoted: `%` is a specifier there.
fn systemd_value(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%");
    format!("\"{escaped}\"")
}

/// A word of a systemd command line, quoted: `$` expands there too.
fn systemd_word(word: &str) -> String {
    systemd_value(&word.replace('$', "$$"))
}

/// A word of a desktop entry's `Exec`, quoted, then escaped as the entry's
/// string values are.
fn desktop_word(word: &str) -> String {
    let quoted: String = word
        .chars()
        .flat_map(|c| match c {
            '"' | '`' | '$' | '\\' => vec!['\\', c],
            '%' => vec!['%', '%'],
            c => vec![c],
        })
        .collect();
    format!("\"{}\"", quoted.replace('\\', "\\\\"))
}

fn command_line(launch: &Launch, word: fn(&str) -> String) -> String {
    std::iter::once(word(&launch.program.to_string_lossy()))
        .chain(launch.args.iter().map(|a| word(a)))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The systemd user service that runs Desk Helper from login, restarting it
/// as launchd's KeepAlive does.
pub fn unit_text(launch: &Launch) -> String {
    let environment = launch
        .appimage
        .as_ref()
        .map(|path| {
            format!(
                "Environment={}\n",
                systemd_value(&format!("APPIMAGE={}", path.display()))
            )
        })
        .unwrap_or_default();
    format!(
        "[Unit]\n\
         Description=Desk Helper: keeps Desk's agents and sessions running\n\
         \n\
         [Service]\n\
         ExecStart={}\n\
         {environment}\
         Restart=always\n\
         RestartSec=2\n\
         TimeoutStopSec=90\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        command_line(launch, systemd_word),
    )
}

/// The XDG autostart entry for a session without systemd.
pub fn desktop_text(launch: &Launch) -> String {
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Desk Helper\n\
         Comment=Keeps Desk's agents and sessions running\n\
         Exec={}\n\
         Terminal=false\n\
         NoDisplay=true\n\
         X-GNOME-Autostart-enabled=true\n",
        command_line(launch, desktop_word),
    )
}

/// Whether an autostart entry is turned off: `Hidden`, or GNOME's own switch.
pub fn turned_off(entry: &str) -> bool {
    entry.lines().map(|l| l.replace(' ', "")).any(|l| {
        l.eq_ignore_ascii_case("Hidden=true")
            || l.eq_ignore_ascii_case("X-GNOME-Autostart-enabled=false")
    })
}

/// `systemctl --user is-enabled`'s answer as a status.
pub fn enabled_status(answer: &str) -> Status {
    match answer.trim() {
        "enabled" | "enabled-runtime" | "linked" | "linked-runtime" | "alias" | "static"
        | "indirect" | "generated" => Status::Running,
        "disabled" | "masked" | "masked-runtime" => Status::NeedsApproval,
        "" | "not-found" => Status::NotRegistered,
        other => Status::Failed {
            message: format!("systemd says Desk Helper is {other}"),
        },
    }
}

fn systemctl(args: &[&str]) -> std::io::Result<Output> {
    Command::new("systemctl").arg("--user").args(args).output()
}

fn checked(args: &[&str]) -> Result<()> {
    let out =
        systemctl(args).with_context(|| format!("running systemctl --user {}", args.join(" ")))?;
    if !out.status.success() {
        eyre::bail!(
            "systemctl --user {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}

/// How this session starts programs at login.
enum Starter {
    Systemd { unit: PathBuf },
    Autostart { entry: PathBuf },
}

impl Starter {
    fn here() -> Result<Starter> {
        let config = dirs::config_dir().ok_or_else(|| eyre::eyre!("no config folder"))?;
        let systemd = systemctl(&["show-environment"]).is_ok_and(|o| o.status.success());
        Ok(if systemd {
            Starter::Systemd {
                unit: config.join("systemd/user").join(UNIT),
            }
        } else {
            Starter::Autostart {
                entry: config.join("autostart").join(DESKTOP),
            }
        })
    }
}

pub struct Helper {
    paths: Paths,
}

impl Helper {
    pub fn new(backend: Backend) -> Self {
        Self {
            paths: backend.paths,
        }
    }

    /// How Desk Helper is started for this install; none in development.
    fn launch(&self) -> Option<Launch> {
        if development() {
            return None;
        }
        let exe = std::env::current_exe().ok()?;
        let env: BTreeMap<String, String> = std::env::vars().collect();
        launch(&Install::of(&exe, &env, &self.paths), &exe)
    }

    fn running(&self) -> bool {
        std::fs::read_to_string(self.paths.helper_pid())
            .ok()
            .and_then(|p| p.trim().parse::<u32>().ok())
            .and_then(process::command_of)
            .is_some_and(|comm| process::is_program(&comm, LINUX_HELPER_EXECUTABLE))
    }

    /// Starts Desk Helper on its own, outliving this window, when an
    /// autostart session hasn't (Desk was just installed, or it stopped).
    fn start(&self, launch: &Launch) -> Result<()> {
        use std::os::unix::process::CommandExt;
        if self.running() {
            return Ok(());
        }
        let mut command = Command::new(&launch.program);
        command
            .args(&launch.args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        if let Some(path) = &launch.appimage {
            command.env("APPIMAGE", path);
        }
        command
            .spawn()
            .with_context(|| format!("starting {}", launch.program.display()))?;
        Ok(())
    }

    fn try_ensure(&self, launch: &Launch) -> Result<Status> {
        match Starter::here()? {
            Starter::Systemd { unit } => {
                let wanted = unit_text(launch);
                let before = self.status();
                if std::fs::read_to_string(&unit).ok().as_deref() != Some(wanted.as_str()) {
                    std::fs::create_dir_all(unit.parent().expect("the unit's folder"))?;
                    std::fs::write(&unit, &wanted)
                        .with_context(|| format!("writing {}", unit.display()))?;
                    checked(&["daemon-reload"])?;
                    if before == Status::Running {
                        tracing::info!("Desk Helper's service changed; restarting it");
                        checked(&["restart", UNIT])?;
                    }
                }
                if before == Status::NotRegistered {
                    checked(&["enable", "--now", UNIT])?;
                }
            }
            Starter::Autostart { entry } => {
                let current = std::fs::read_to_string(&entry).ok();
                if current.as_deref().is_some_and(turned_off) {
                    return Ok(Status::NeedsApproval);
                }
                let wanted = desktop_text(launch);
                if current.as_deref() != Some(wanted.as_str()) {
                    std::fs::create_dir_all(entry.parent().expect("the entry's folder"))?;
                    std::fs::write(&entry, &wanted)
                        .with_context(|| format!("writing {}", entry.display()))?;
                }
                self.start(launch)?;
            }
        }
        Ok(self.status())
    }
}

impl Login for Helper {
    fn status(&self) -> Status {
        if self.launch().is_none() {
            return Status::Development;
        }
        match Starter::here() {
            Ok(Starter::Systemd { unit }) if !unit.is_file() => Status::NotRegistered,
            Ok(Starter::Systemd { .. }) => match systemctl(&["is-enabled", UNIT]) {
                Ok(out) => enabled_status(&String::from_utf8_lossy(&out.stdout)),
                Err(e) => Status::Failed {
                    message: e.to_string(),
                },
            },
            Ok(Starter::Autostart { entry }) => match std::fs::read_to_string(&entry) {
                Ok(text) if turned_off(&text) => Status::NeedsApproval,
                Ok(_) => Status::Running,
                Err(_) => Status::NotRegistered,
            },
            Err(e) => Status::Failed {
                message: e.to_string(),
            },
        }
    }

    fn ensure(&self) -> Status {
        let Some(launch) = self.launch() else {
            return Status::Development;
        };
        self.try_ensure(&launch).unwrap_or_else(|e| {
            tracing::error!(error = %e, "could not set Desk Helper to start at login");
            Status::Failed {
                message: e.to_string(),
            }
        })
    }

    fn unregister(&self) -> Result<()> {
        let Some(launch) = self.launch() else {
            return Ok(());
        };
        match Starter::here()? {
            Starter::Systemd { unit } => {
                if unit.is_file() {
                    checked(&["disable", "--now", UNIT])?;
                    std::fs::remove_file(&unit)?;
                    checked(&["daemon-reload"])?;
                }
            }
            Starter::Autostart { entry } => {
                match std::fs::remove_file(&entry) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => {
                        return Err(e).with_context(|| format!("removing {}", entry.display()));
                    }
                }
                let helper = match &launch.appimage {
                    Some(_) => std::env::current_exe()?.with_file_name(LINUX_HELPER_EXECUTABLE),
                    None => launch.program.clone(),
                };
                let out = Command::new(&helper).arg("--stop").output()?;
                if !out.status.success() {
                    eyre::bail!(
                        "Desk Helper didn't stop: {}",
                        String::from_utf8_lossy(&out.stderr).trim()
                    );
                }
            }
        }
        Ok(())
    }

    /// Linux has no one place that lists what starts at login: Help says
    /// where instead.
    fn open_settings(&self) {}
}

/// The helper `--helper` runs, for its signals.
static CHILD: AtomicI32 = AtomicI32::new(0);

extern "C" fn forward(signal: libc::c_int) {
    let pid = CHILD.load(Ordering::SeqCst);
    if pid > 0 {
        // SAFETY: kill is async-signal-safe.
        unsafe { libc::kill(pid, signal) };
    }
}

/// `Desk.AppImage --helper`: runs the Desk Helper inside this AppImage and
/// waits for it, passing on the signals that stop it, so the AppImage's
/// mount stays while it runs. Answers its exit code.
pub fn run_bundled() -> i32 {
    let helper = match std::env::current_exe() {
        Ok(exe) => exe.with_file_name(LINUX_HELPER_EXECUTABLE),
        Err(e) => {
            eprintln!("Desk Helper isn't in this AppImage: {e}");
            return 1;
        }
    };
    let mut child = match Command::new(&helper).spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("couldn't start {}: {e}", helper.display());
            return 1;
        }
    };
    CHILD.store(i32::try_from(child.id()).unwrap_or(0), Ordering::SeqCst);
    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        // SAFETY: installs a handler that only reads an atomic and calls kill.
        unsafe { libc::signal(signal, forward as *const () as libc::sighandler_t) };
    }
    match child.wait() {
        Ok(status) => {
            use std::os::unix::process::ExitStatusExt;
            status
                .code()
                .or_else(|| status.signal().map(|s| 128 + s))
                .unwrap_or(1)
        }
        Err(e) => {
            eprintln!("waiting for Desk Helper: {e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn appimage() -> Launch {
        launch(
            &Install::AppImage {
                path: "/home/sarah/Apps/Desk 0.3.AppImage".into(),
            },
            Path::new("/tmp/.mount_Desk/usr/bin/desk"),
        )
        .unwrap()
    }

    #[test]
    fn each_install_starts_its_own_helper() {
        assert_eq!(
            launch(&Install::Package, Path::new("/usr/bin/desk")),
            Some(Launch {
                program: "/usr/bin/desk-helper".into(),
                args: Vec::new(),
                appimage: None,
            })
        );
        assert_eq!(
            appimage().program,
            PathBuf::from("/home/sarah/Apps/Desk 0.3.AppImage")
        );
        assert_eq!(appimage().args, ["--helper"]);
        assert_eq!(
            launch(&Install::Development, Path::new("/src/target/debug/desk")),
            None
        );
    }

    #[test]
    fn the_service_runs_the_appimage_with_its_path_and_restarts() {
        assert_eq!(
            unit_text(&appimage()),
            "[Unit]\n\
             Description=Desk Helper: keeps Desk's agents and sessions running\n\
             \n\
             [Service]\n\
             ExecStart=\"/home/sarah/Apps/Desk 0.3.AppImage\" \"--helper\"\n\
             Environment=\"APPIMAGE=/home/sarah/Apps/Desk 0.3.AppImage\"\n\
             Restart=always\n\
             RestartSec=2\n\
             TimeoutStopSec=90\n\
             \n\
             [Install]\n\
             WantedBy=default.target\n"
        );
        let package = launch(&Install::Package, Path::new("/usr/bin/desk")).unwrap();
        let text = unit_text(&package);
        assert!(text.contains("ExecStart=\"/usr/bin/desk-helper\"\n"));
        assert!(!text.contains("APPIMAGE"));
    }

    #[test]
    fn the_autostart_entry_runs_the_helper_hidden() {
        assert_eq!(
            desktop_text(&appimage()),
            "[Desktop Entry]\n\
             Type=Application\n\
             Name=Desk Helper\n\
             Comment=Keeps Desk's agents and sessions running\n\
             Exec=\"/home/sarah/Apps/Desk 0.3.AppImage\" \"--helper\"\n\
             Terminal=false\n\
             NoDisplay=true\n\
             X-GNOME-Autostart-enabled=true\n"
        );
    }

    #[test]
    fn odd_characters_are_quoted_for_each_format() {
        assert_eq!(
            systemd_word(r#"/a/100% "b"$c\d"#),
            r#""/a/100%% \"b\"$$c\\d""#
        );
        assert_eq!(
            desktop_word(r#"/a/100% "b"$c"#),
            r#""/a/100%% \\"b\\"\\$c""#
        );
    }

    #[test]
    fn what_systemd_and_the_entry_say_is_read_as_a_status() {
        assert_eq!(enabled_status("enabled\n"), Status::Running);
        assert_eq!(enabled_status("disabled\n"), Status::NeedsApproval);
        assert_eq!(enabled_status("masked"), Status::NeedsApproval);
        assert_eq!(enabled_status(""), Status::NotRegistered);
        assert!(matches!(enabled_status("bad"), Status::Failed { .. }));
        assert!(turned_off("[Desktop Entry]\nHidden=true\n"));
        assert!(turned_off(
            "[Desktop Entry]\nX-GNOME-Autostart-enabled = false\n"
        ));
        assert!(!turned_off(&desktop_text(&appimage())));
    }
}
