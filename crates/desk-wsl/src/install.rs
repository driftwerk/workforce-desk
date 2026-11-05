//! Installing and updating the backend inside a distro: the three programs
//! and Desk's Claude Code plugin in a folder of their own version under
//! `~/.local/share/Desk/bin`, checked there, then `current` flipped to it.
//! A running backend notices the flip and hands over, as it does when an
//! update replaces it anywhere else.

use std::path::Path;

use desk_core::backend::Check;
use desk_core::backend_install as scripts;
use desk_core::host::{Host, Wsl};
use eyre::{Context, Result};

pub use desk_core::backend_install::{Plan, compare, plan, quote};

use crate::run::WslExe;

/// Copies the bundled backend (`source`, a Windows folder) into
/// `bin/<version>`.
pub fn copy_script(w: &Wsl, source: &str, version: &str) -> Result<String> {
    Ok(format!(
        "set -eu\n\
         src=$(wslpath -u {source})\n\
         {install}",
        source = quote(source),
        install = scripts::install_from_src(&w.bin(), version)?,
    ))
}

/// Points `bin/current` at `version` in one step, then removes every
/// version but it and the one before.
pub fn flip_script(w: &Wsl, version: &str) -> Result<String> {
    scripts::flip_script(&w.bin(), version)
}

/// The version `bin/current` points at; empty when none is installed.
pub fn installed_script(w: &Wsl) -> String {
    scripts::installed_script(&w.bin())
}

pub fn installed(wsl: &WslExe, w: &Wsl) -> Result<Option<String>> {
    let host = Host::Wsl(w.clone());
    let said = wsl.answer(&host.login_invocation(&installed_script(w)))?;
    Ok(scripts::parse_installed(&said))
}

/// Copies `version` from `source` (the app's bundled backend, a Windows
/// folder) into the distro.
pub fn copy(wsl: &WslExe, w: &Wsl, source: &Path, version: &str) -> Result<()> {
    let host = Host::Wsl(w.clone());
    wsl.answer(&host.login_invocation(&copy_script(w, &source.to_string_lossy(), version)?))
        .context("copying Desk into Linux")?;
    Ok(())
}

/// Whether the copied `version` can run in the distro; an error saying why
/// when it can't.
pub fn check(wsl: &WslExe, w: &Wsl, version: &str) -> Result<Check> {
    let host = Host::Wsl(w.clone());
    let helper = scripts::helper_in(&w.bin(), version)?;
    let said = wsl
        .answer(&host.invocation(&helper, &["--check"]))
        .context("checking Desk runs in Linux")?;
    let check: Check =
        serde_json::from_str(said.trim()).context("reading what Desk's check said")?;
    match check.problem() {
        Some(problem) => eyre::bail!("{problem}"),
        None => Ok(check),
    }
}

/// Makes `version` the one that runs.
pub fn flip(wsl: &WslExe, w: &Wsl, version: &str) -> Result<()> {
    let host = Host::Wsl(w.clone());
    wsl.answer(&host.login_invocation(&flip_script(w, version)?))
        .context("switching to the new version")?;
    Ok(())
}

/// Copies, checks and flips to `version`; a check that fails leaves the
/// current version as it was. Answers what the check found.
pub fn install(wsl: &WslExe, w: &Wsl, source: &Path, version: &str) -> Result<Check> {
    copy(wsl, w, source, version)?;
    let found = check(wsl, w, version)?;
    flip(wsl, w, version)?;
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sarah() -> Wsl {
        Wsl {
            distro: "Ubuntu".into(),
            user: "sarah".into(),
            home: "/home/sarah".into(),
            automount: "/mnt/".into(),
        }
    }

    #[test]
    fn the_copy_installs_each_program_and_the_plugin_into_its_version() {
        let script = copy_script(
            &sarah(),
            r"C:\Users\Sarah\AppData\Local\Programs\Desk\backend",
            "0.3.0",
        )
        .unwrap();
        assert_eq!(
            script,
            "set -eu\n\
             src=$(wslpath -u 'C:\\Users\\Sarah\\AppData\\Local\\Programs\\Desk\\backend')\n\
             install -Dm755 \"$src/desk-helper\" '/home/sarah/.local/share/Desk/bin/0.3.0'/desk-helper\n\
             install -Dm755 \"$src/desk-agents\" '/home/sarah/.local/share/Desk/bin/0.3.0'/desk-agents\n\
             install -Dm755 \"$src/desk-memory\" '/home/sarah/.local/share/Desk/bin/0.3.0'/desk-memory\n\
             rm -rf '/home/sarah/.local/share/Desk/bin/0.3.0'/claude-plugin\n\
             cp -R \"$src/claude-plugin\" '/home/sarah/.local/share/Desk/bin/0.3.0'/claude-plugin\n"
        );
    }

    #[test]
    fn the_flip_is_one_rename_and_keeps_the_version_before() {
        let script = flip_script(&sarah(), "0.3.0").unwrap();
        assert!(script.contains(
            "ln -sfn '0.3.0' \"$bin/current.next\"\nmv -Tf \"$bin/current.next\" \"$bin/current\"\n"
        ));
        assert!(script.contains("case \"$name\" in current | '0.3.0' | \"$previous\") ;;"));
        assert!(script.starts_with("set -eu\nbin='/home/sarah/.local/share/Desk/bin'\n"));
    }

    /// The scripts run as written, in a Linux shell, against a fake home.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_scripts_install_flip_and_prune_in_a_real_shell() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let w = Wsl {
            home: home.to_string_lossy().into_owned(),
            ..sarah()
        };
        let source = dir.path().join("backend");
        std::fs::create_dir_all(source.join("claude-plugin/hooks")).unwrap();
        std::fs::write(source.join("claude-plugin/hooks/hooks.json"), "{}").unwrap();
        for p in scripts::PROGRAMS {
            std::fs::write(source.join(p), "#!/bin/sh\n").unwrap();
        }
        let sh = |script: String| {
            // `wslpath -u` stands for itself: the source is already a Linux path.
            let script = format!("wslpath() {{ echo \"$2\"; }}\n{script}");
            let out = std::process::Command::new("sh")
                .args(["-c", &script])
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let source = source.to_string_lossy();
        for v in ["0.1.0", "0.2.0", "0.3.0"] {
            sh(copy_script(&w, &source, v).unwrap());
            sh(flip_script(&w, v).unwrap());
            assert_eq!(sh(installed_script(&w)), v);
        }
        let bin = Path::new(&w.bin()).to_path_buf();
        let mut kept: Vec<_> = std::fs::read_dir(&bin)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        kept.sort();
        assert_eq!(kept, ["0.2.0", "0.3.0", "current"]);
        assert!(bin.join("current/claude-plugin/hooks/hooks.json").is_file());
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(bin.join("current/desk-helper"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);
    }
}
