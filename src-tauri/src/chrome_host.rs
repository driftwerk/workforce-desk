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

/// Opens `page`, Chrome's page for Desk's extension, in Google Chrome:
/// where the person reloads a build too old to update itself. Only
/// `chrome://extensions/`, or it for an extension id Desk ships. Chrome
/// opens its own pages when started with one; the default browser can't.
#[tauri::command]
pub fn open_chrome_extensions(page: String) -> crate::CommandResult<()> {
    if !is_extensions_page(&page) {
        return Err("That isn't Chrome's page for Desk's extension.".into());
    }
    chrome_with(&page)
        .spawn()
        .map(drop)
        .map_err(|e| format!("Desk couldn't open Chrome: {e}"))
}

/// Whether `page` is Chrome's extensions page, or it for one extension.
/// Any id shaped like one is: an unpacked build's comes from its folder's
/// path, so no list holds it, and the page only shows the extension.
fn is_extensions_page(page: &str) -> bool {
    match page.strip_prefix("chrome://extensions/") {
        Some("") => true,
        Some(rest) => rest
            .strip_prefix("?id=")
            .is_some_and(desk_chrome_host::is_extension_id),
        None => false,
    }
}

/// Google Chrome started on `page`.
fn chrome_with(page: &str) -> std::process::Command {
    #[cfg(target_os = "macos")]
    {
        let mut c = std::process::Command::new("open");
        c.args(["-a", "Google Chrome", page]);
        c
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", "chrome", page])
            .creation_flags(CREATE_NO_WINDOW);
        c
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut c = std::process::Command::new("google-chrome");
        c.arg(page);
        c
    }
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

#[cfg(test)]
mod extensions_page {
    use super::*;

    #[test]
    fn only_chromes_page_for_an_extension_is_opened() {
        assert!(is_extensions_page("chrome://extensions/"));
        // An unpacked build's id, from its folder's path
        // (/Users/sarah/Desk/extension/dist), is in no list.
        let unpacked = "jnfacggogodlefcelomggcoebafiefom";
        for id in desk_chrome_host::extension_ids()
            .into_iter()
            .chain([unpacked])
        {
            assert!(is_extensions_page(&format!("chrome://extensions/?id={id}")));
        }
        for page in [
            "chrome://extensions/?id=qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
            "chrome://extensions/?id=jnfacggogodlefcelomggcoebafiefo",
            "chrome://extensions/?id=jnfacggogodlefcelomggcoebafiefom&x=1",
            "chrome://settings/",
            "chrome://extensions/?id=",
            "https://chrome://extensions/",
            "chrome://extensions",
        ] {
            assert!(!is_extensions_page(page), "{page}");
        }
    }
}
