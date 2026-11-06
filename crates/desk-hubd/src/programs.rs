//! The programs Desk Helper starts: the hub (and, as `pty-holder`, the PTY
//! holder) and the memory store. They get the hub's secrets, so a release
//! build only ever starts the ones installed beside it, and on macOS only
//! when they are signed by the same team as the helper itself. Choosing
//! others (`--workforce <path>`, `--memory <path>`, development names, and
//! `PATH`) is for development builds alone: `--features dev-overrides`.

use std::path::{Path, PathBuf};

use desk_core::{HUB_EXECUTABLE, MEMORY_EXECUTABLE};
use eyre::Result;

/// What a release build says of an override it was given.
pub const DEV_ONLY: &str = "--workforce and --memory are only for development builds of Desk Helper (built with --features dev-overrides)";

/// The flags that choose another program to start.
pub const OVERRIDES: [&str; 2] = ["--workforce", "--memory"];

/// Whether this build takes [`OVERRIDES`].
pub const TAKES_OVERRIDES: bool = cfg!(feature = "dev-overrides");

/// Refuses `args` that choose another program, unless this is a
/// development build.
pub fn check_args(args: &[String]) -> Result<()> {
    if !TAKES_OVERRIDES && args.iter().any(|a| OVERRIDES.contains(&a.as_str())) {
        eyre::bail!(DEV_ONLY);
    }
    Ok(())
}

fn beside_me() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
}

#[cfg(feature = "dev-overrides")]
fn given(flag: &str) -> Option<PathBuf> {
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == flag
            && let Some(p) = args.next()
        {
            return Some(p.into());
        }
    }
    None
}

#[cfg(feature = "dev-overrides")]
fn on_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|d| d.join(name))
            .find(|p| p.is_file())
    })
}

/// The hub: the one beside this program ("Desk Agents" in the app bundle,
/// `desk-agents` on Linux). In a development build, `--workforce <path>`
/// first, then `workforce` beside it or on `PATH`.
pub fn hub() -> Result<PathBuf> {
    #[cfg(feature = "dev-overrides")]
    {
        if let Some(p) = given("--workforce") {
            return Ok(p);
        }
        if let Some(p) = beside_me()
            .map(|d| [d.join(HUB_EXECUTABLE), d.join("workforce")])
            .and_then(|c| c.into_iter().find(|p| p.is_file()))
        {
            return Ok(p);
        }
        Ok(on_path("workforce").unwrap_or_else(|| "workforce".into()))
    }
    #[cfg(not(feature = "dev-overrides"))]
    {
        let dir = beside_me()
            .ok_or_else(|| eyre::eyre!("Desk Helper can't tell where it is installed"))?;
        let hub = dir.join(HUB_EXECUTABLE);
        same_team(&hub)?;
        Ok(hub)
    }
}

/// The memory store: the one beside this program ("Desk Memory", or
/// `desk-memory` on Linux); none when there is none, and memories stay in
/// the hub's SQLite. In a development build, `--memory <path>` first, then
/// `vellev` beside it or on `PATH`.
pub fn memory() -> Option<PathBuf> {
    #[cfg(feature = "dev-overrides")]
    {
        if let Some(p) = given("--memory") {
            return Some(p);
        }
        beside_me()
            .map(|d| [d.join(MEMORY_EXECUTABLE), d.join("vellev")])
            .and_then(|c| c.into_iter().find(|p| p.is_file()))
            .or_else(|| on_path("vellev"))
    }
    #[cfg(not(feature = "dev-overrides"))]
    {
        let store = beside_me()?.join(MEMORY_EXECUTABLE);
        if !store.is_file() {
            return None;
        }
        match same_team(&store) {
            Ok(()) => Some(store),
            Err(e) => {
                tracing::error!(error = %e, "not starting the memory store beside Desk Helper");
                None
            }
        }
    }
}

/// On macOS, that `program` passes `codesign --verify --strict` against a
/// requirement naming this helper's own team. A release helper signed by
/// no team starts nothing (fails closed). Elsewhere, nothing to check: a
/// program beside this one is the install's own.
#[cfg_attr(feature = "dev-overrides", allow(dead_code))]
fn same_team(program: &Path) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let me = std::env::current_exe()?;
        let Some(mine) = team_of(&me) else {
            eyre::bail!(
                "Desk Helper isn't signed by a team, so it starts nothing: {} won't be started",
                program.display()
            );
        };
        let ok = std::process::Command::new("/usr/bin/codesign")
            .args(["--verify", "--strict"])
            .arg(format!("-R={}", requirement(&mine)))
            .arg(program)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if !ok {
            eyre::bail!(
                "{} isn't signed by the same team as Desk Helper, so it won't be started",
                program.display()
            );
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = program;
    Ok(())
}

/// The code requirement a program must meet: signed through Apple by the
/// team `team` (its leaf certificate's organisational unit).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn requirement(team: &str) -> String {
    format!("anchor apple generic and certificate leaf[subject.OU] = \"{team}\"")
}

/// Where a release Desk Helper may run from: an app bundle in
/// /Applications or ~/Applications on macOS; on Linux, a version Desk
/// installed under its own `bin`, a system package (/usr, /opt) or a
/// mounted AppImage. Its path is canonical (links resolved), so a copy
/// elsewhere, or a link to one, is refused.
pub fn installed_in_place(exe: &Path, home: &Path, bin: &Path, appimage: bool) -> Result<()> {
    let ok = if cfg!(target_os = "macos") {
        let s = exe.to_string_lossy();
        s.contains(".app/Contents/MacOS/")
            && (exe.starts_with("/Applications") || exe.starts_with(home.join("Applications")))
    } else {
        exe.starts_with(bin)
            || exe.starts_with("/usr/")
            || exe.starts_with("/opt/")
            || (appimage && exe.to_string_lossy().starts_with("/tmp/.mount_"))
    };
    if !ok {
        eyre::bail!(
            "Desk Helper runs only from where Desk installs it, not {}",
            exe.display()
        );
    }
    Ok(())
}

/// [`installed_in_place`] for this program, in a release build; a
/// development build runs from anywhere.
pub fn check_place(
    paths: &desk_core::Paths,
    env: &std::collections::BTreeMap<String, String>,
) -> Result<()> {
    if TAKES_OVERRIDES {
        return Ok(());
    }
    let exe = std::env::current_exe()?.canonicalize()?;
    let home = env.get("HOME").map(PathBuf::from).unwrap_or_default();
    let bin = paths.bin().canonicalize().unwrap_or_else(|_| paths.bin());
    installed_in_place(&exe, &home, &bin, env.contains_key("APPIMAGE"))
}

/// The team that signed `program` (`TeamIdentifier=…` as `codesign` says
/// it); none for one signed by no team.
#[cfg(target_os = "macos")]
fn team_of(program: &Path) -> Option<String> {
    let out = std::process::Command::new("/usr/bin/codesign")
        .args(["-dv", "--verbose=2"])
        .arg(program)
        .output()
        .ok()?;
    team_in(&String::from_utf8_lossy(&out.stderr))
}

/// The team in what `codesign -dv` printed.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn team_in(said: &str) -> Option<String> {
    said.lines()
        .find_map(|l| l.strip_prefix("TeamIdentifier="))
        .map(str::trim)
        .filter(|t| !t.is_empty() && *t != "not set")
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[cfg(not(feature = "dev-overrides"))]
    #[test]
    fn a_release_build_never_starts_a_program_it_is_pointed_at() {
        for flag in OVERRIDES {
            let e = check_args(&args(&[flag, "/tmp/evil"]))
                .unwrap_err()
                .to_string();
            assert_eq!(e, DEV_ONLY);
        }
        assert!(check_args(&args(&["--machine"])).is_ok());
        // Only what is installed beside it, by its installed name; on macOS
        // a helper signed by no team (this test) starts nothing at all.
        let macos = cfg!(target_os = "macos");
        match hub() {
            Ok(hub) => {
                assert!(!macos);
                assert_eq!(hub.file_name().unwrap(), HUB_EXECUTABLE);
                assert_eq!(hub.parent(), beside_me().as_deref());
            }
            Err(e) => {
                assert!(macos, "{e}");
                assert!(e.to_string().contains("isn't signed by a team"), "{e}");
            }
        }
    }

    #[test]
    fn a_release_helper_runs_only_from_where_desk_installs_it() {
        let home = Path::new("/Users/ana");
        let bin = Path::new("/home/ana/.local/share/Desk/bin");
        let ok =
            |p: &str, appimage: bool| installed_in_place(Path::new(p), home, bin, appimage).is_ok();
        if cfg!(target_os = "macos") {
            assert!(ok(
                "/Applications/Desk.app/Contents/MacOS/Desk Helper",
                false
            ));
            assert!(ok(
                "/Users/ana/Applications/Desk.app/Contents/MacOS/Desk Helper",
                false
            ));
            assert!(!ok("/tmp/x/Desk.app/Contents/MacOS/Desk Helper", false));
            assert!(!ok("/Users/ana/Downloads/Desk Helper", false));
        } else {
            assert!(ok(
                "/home/ana/.local/share/Desk/bin/0.3.0/desk-helper",
                false
            ));
            assert!(ok("/usr/lib/desk/desk-helper", false));
            assert!(ok("/tmp/.mount_DeskAb12/usr/bin/desk-helper", true));
            assert!(!ok("/tmp/.mount_DeskAb12/usr/bin/desk-helper", false));
            assert!(!ok("/tmp/evil/desk-helper", false));
            assert!(!ok("/home/ana/desk-helper", false));
        }
    }

    #[test]
    fn the_requirement_names_the_team() {
        assert_eq!(
            requirement("ABCDE12345"),
            "anchor apple generic and certificate leaf[subject.OU] = \"ABCDE12345\""
        );
    }

    #[cfg(feature = "dev-overrides")]
    #[test]
    fn a_development_build_takes_the_programs_it_is_given() {
        assert!(check_args(&args(&["--workforce", "/x/workforce"])).is_ok());
    }

    #[test]
    fn the_team_is_read_from_what_codesign_says() {
        assert_eq!(
            team_in("Identifier=xyz\nTeamIdentifier=ABCDE12345\nSealed Resources version=2\n")
                .as_deref(),
            Some("ABCDE12345")
        );
        assert_eq!(team_in("TeamIdentifier=not set\n"), None);
        assert_eq!(team_in("code object is not signed at all\n"), None);
    }
}
