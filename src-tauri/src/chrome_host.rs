//! Tells Google Chrome where Desk's native messaging host is, at every
//! start, so Desk's extension can reach Desk: a manifest in Chrome's
//! `NativeMessagingHosts` folder (on Windows, a registry key naming it)
//! whose `path` is the installed Desk Helper and whose `allowed_origins` is
//! Desk's extension alone. Chrome only, this person only.

#[cfg(not(windows))]
use std::collections::BTreeMap;
#[cfg(not(windows))]
use std::path::Path;
use std::path::PathBuf;

use desk_chrome_host::manifest;
use desk_core::Paths;
#[cfg(not(windows))]
use desk_core::install::Install;

/// The program Chrome starts as Desk's host, for this install, on macOS
/// and Linux (on Windows it is always `Desk Helper.exe`).
#[cfg(not(windows))]
pub fn host_program(install: &Install, exe: &Path) -> Option<PathBuf> {
    match install {
        // The helper beside the app, which Desk's login item runs too.
        Install::MacBundle => Some(exe.with_file_name(desk_core::HELPER_EXECUTABLE)),
        Install::Package => Some(exe.with_file_name(desk_core::LINUX_HELPER_EXECUTABLE)),
        // The AppImage itself: Desk takes Chrome's launch in-process.
        Install::AppImage { path } => Some(path.clone()),
        // The Windows launcher, `Desk Helper.exe`, beside the app.
        Install::Versioned { .. } => None,
        Install::Development => {
            if cfg!(windows) {
                Some(exe.with_file_name(format!("{}.exe", desk_core::HELPER_EXECUTABLE)))
            } else {
                Some(exe.with_file_name("desk-hubd"))
            }
        }
    }
}

/// Writes (or, with no extension to serve, removes) Desk's host for
/// Chrome. What it wrote, for the log.
pub fn install(paths: &Paths) -> eyre::Result<Option<PathBuf>> {
    #[cfg(windows)]
    let program = Some(crate::helper::launcher()?);
    #[cfg(not(windows))]
    let program = {
        let exe = std::env::current_exe()?;
        let env: BTreeMap<String, String> = std::env::vars().collect();
        host_program(&Install::of(&exe, &env, paths), &exe)
    };
    let Some(program) = program else {
        return Ok(None);
    };
    let ids = desk_chrome_host::extension_ids();
    let m = manifest::manifest(&program, &ids);
    #[cfg(windows)]
    {
        let file = manifest::write(&paths.root.join("chrome"), &m)?;
        if !ids.is_empty() {
            manifest::register(&file)?;
        }
        Ok(Some(file))
    }
    #[cfg(not(windows))]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| eyre::eyre!("no home folder"))?;
        let Some(folder) = manifest::hosts_folder(std::env::consts::OS, &home) else {
            return Ok(None);
        };
        Ok(Some(manifest::write(&folder, &m)?))
    }
}

/// The local hub, for Chrome's host run from the AppImage itself.
#[cfg(target_os = "linux")]
pub fn native_hub() -> eyre::Result<Option<desk_chrome_host::Hub>> {
    let backend = desk_core::backend::Backend::native(Paths::new()?);
    Ok(backend.connection()?.and_then(|c| {
        c.device_token.map(|token| desk_chrome_host::Hub {
            gateway_url: c.gateway_url,
            token,
        })
    }))
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;

    #[test]
    fn chrome_starts_the_installed_helper() {
        let exe = Path::new("/Applications/Desk.app/Contents/MacOS/Desk");
        assert_eq!(
            host_program(&Install::MacBundle, exe).unwrap(),
            Path::new("/Applications/Desk.app/Contents/MacOS").join(desk_core::HELPER_EXECUTABLE)
        );
        let pkg = Path::new("/usr/bin/desk");
        assert_eq!(
            host_program(&Install::Package, pkg).unwrap(),
            Path::new("/usr/bin").join(desk_core::LINUX_HELPER_EXECUTABLE)
        );
        let image = PathBuf::from("/home/sarah/Apps/Desk.AppImage");
        assert_eq!(
            host_program(
                &Install::AppImage {
                    path: image.clone()
                },
                Path::new("/tmp/.mount/desk")
            )
            .unwrap(),
            image
        );
    }
}
