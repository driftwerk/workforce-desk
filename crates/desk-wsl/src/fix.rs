//! Desk putting right what keeps it from a distro, each after one yes in
//! the setup: a distro whose only user is root gets a normal one (and it
//! becomes the default), and a Linux too old for Desk gets a current
//! Ubuntu beside it. What `wsl.exe` says when either fails goes to the log,
//! never into the words the person reads.

use crate::WslExe;

/// The Ubuntu Desk installs beside a Linux too old for it: one with a
/// glibc Desk runs on, under a name an older "Ubuntu" doesn't have.
pub const ALONGSIDE: &str = "Ubuntu-24.04";

/// The Linux user Desk makes for the person, from their Windows name:
/// lower case, letters, digits, `-` and `_`, starting with a letter, at
/// most 32 long; `desk` when nothing of it is left.
pub fn user_name(windows: &str) -> String {
    let mut name: String = windows
        .trim()
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    while name.starts_with(|c: char| !c.is_ascii_lowercase()) {
        name.remove(0);
    }
    name.truncate(32);
    if name.is_empty() || name == "root" {
        "desk".into()
    } else {
        name
    }
}

/// Run as root in the distro, with the user's name as `$1`: makes the user
/// (with a home, bash, and in `sudo` where there is one) unless it's there,
/// and makes it the distro's default in `/etc/wsl.conf`, keeping the rest
/// of that file. WSL starts the distro as that user after a restart.
pub const CREATE_USER_SCRIPT: &str = r#"set -eu
u="$1"
if ! id -u "$u" >/dev/null 2>&1; then
  if command -v useradd >/dev/null 2>&1; then useradd -m -s /bin/bash "$u"
  else adduser -D -s /bin/sh "$u"; fi
fi
if getent group sudo >/dev/null 2>&1; then usermod -aG sudo "$u" 2>/dev/null || true; fi
if getent group wheel >/dev/null 2>&1; then usermod -aG wheel "$u" 2>/dev/null || true; fi
f=/etc/wsl.conf
[ -e "$f" ] || : > "$f"
awk -v u="$u" '
  /^\[user\][[:space:]]*$/ { print; print "default=" u; inuser = 1; done = 1; next }
  /^\[/ { inuser = 0 }
  inuser && /^[[:space:]]*default[[:space:]]*=/ { next }
  { print }
  END { if (!done) { print ""; print "[user]"; print "default=" u } }
' "$f" > "$f.desk"
mv "$f.desk" "$f"
"#;

/// Makes a normal user `user` in `distro` and its default, then stops the
/// distro so it starts as that user next time.
pub fn create_user(wsl: &WslExe, distro: &str, user: &str) -> Result<(), String> {
    let out = wsl
        .run(&[
            "-d",
            distro,
            "-u",
            "root",
            "--",
            "sh",
            "-c",
            CREATE_USER_SCRIPT,
            "desk-create-user",
            user,
        ])
        .map_err(|e| {
            tracing::warn!(error = %format!("{e:#}"), "couldn't run wsl.exe to create a user");
            format!("Desk couldn't make a user in {distro}. Try again.")
        })?;
    if !out.status.success() {
        tracing::warn!(
            distro,
            said = %crate::detect::decode(&out.stderr).trim(),
            "creating a user failed"
        );
        return Err(format!(
            "Desk couldn't make a user in {distro}. Try again, or make one there yourself and set it as the default."
        ));
    }
    // Stopped, so it starts as the new default; its files stay.
    let _ = wsl.run(&["--terminate", distro]);
    Ok(())
}

/// Installs [`ALONGSIDE`] next to the person's Linux, registered but not
/// opened (no first-run questions); its only user is root until
/// [`create_user`] makes one.
pub fn install_alongside(wsl: &WslExe) -> Result<(), String> {
    let out = wsl
        .run(&["--install", "-d", ALONGSIDE, "--no-launch"])
        .map_err(|e| {
            tracing::warn!(error = %format!("{e:#}"), "couldn't run wsl.exe to install Ubuntu");
            format!("Desk couldn't install {ALONGSIDE}. Try again.")
        })?;
    if !out.status.success() {
        tracing::warn!(
            said = %crate::detect::decode(&out.stderr).trim(),
            "installing Ubuntu alongside failed"
        );
        return Err(format!(
            "Windows didn't install {ALONGSIDE}. Try again; if it keeps stopping, install it from the Microsoft Store and Desk notices it by itself."
        ));
    }
    // Registered on its first start: started as root, running nothing.
    let started = wsl.run(&["-d", ALONGSIDE, "-u", "root", "--", "true"]);
    if !started.as_ref().is_ok_and(|o| o.status.success()) {
        if let Ok(o) = &started {
            tracing::warn!(said = %crate::detect::decode(&o.stderr).trim(), "the new Ubuntu didn't start");
        }
        return Err(format!(
            "{ALONGSIDE} is installed but didn't start. Open it once from the Start menu, and Desk notices it by itself."
        ));
    }
    Ok(())
}

/// Moves `distro` to WSL 2 (a few minutes; its files stay).
pub fn convert(wsl: &WslExe, distro: &str) -> Result<(), String> {
    let out = wsl.run(&["--set-version", distro, "2"]).map_err(|e| {
        tracing::warn!(error = %format!("{e:#}"), "couldn't run wsl.exe to convert");
        format!("Desk couldn't move {distro} to WSL 2. Try again.")
    })?;
    if !out.status.success() {
        let said = crate::detect::decode(&out.stderr);
        tracing::warn!(distro, said = %said.trim(), "moving to WSL 2 failed");
        // The one cause people can fix: virtualization off in the BIOS.
        if said.contains("Virtual Machine Platform")
            || said.to_lowercase().contains("virtualization")
        {
            return Err(format!(
                "{distro} didn't move to WSL 2: Windows needs virtualization turned on (in the BIOS) and the Virtual Machine Platform feature. Turn them on, then try again."
            ));
        }
        return Err(format!(
            "{distro} didn't move to WSL 2. Try again; Settings → Help can save a report."
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_new_user_is_named_after_the_windows_one_and_plain() {
        assert_eq!(user_name("Kingsley"), "kingsley");
        assert_eq!(user_name("Ana María"), "anamara");
        assert_eq!(user_name("1st.User"), "stuser");
        assert_eq!(user_name("Administrator"), "administrator");
        assert_eq!(user_name("Root"), "desk");
        assert_eq!(user_name("  "), "desk");
        assert_eq!(user_name(&"x".repeat(40)).len(), 32);
    }

    /// The script's wsl.conf part, run for real against a file here.
    #[cfg(unix)]
    #[test]
    fn the_default_user_is_set_keeping_the_rest_of_wsl_conf() {
        let dir = tempfile::tempdir().unwrap();
        let conf = dir.path().join("wsl.conf");
        let part = CREATE_USER_SCRIPT.split("f=/etc/wsl.conf").nth(1).unwrap();
        let run = |before: Option<&str>| {
            match before {
                Some(b) => std::fs::write(&conf, b).unwrap(),
                None => {
                    let _ = std::fs::remove_file(&conf);
                }
            }
            let script = format!("set -eu\nu=\"$1\"\nf={}{part}", conf.display());
            let ok = std::process::Command::new("sh")
                .args(["-c", &script, "t", "kings"])
                .status()
                .unwrap()
                .success();
            assert!(ok);
            std::fs::read_to_string(&conf).unwrap()
        };
        assert_eq!(run(None), "\n[user]\ndefault=kings\n");
        assert_eq!(
            run(Some(
                "[boot]\nsystemd=true\n[user]\ndefault=root\n[network]\nhostname=box\n"
            )),
            "[boot]\nsystemd=true\n[user]\ndefault=kings\n[network]\nhostname=box\n"
        );
        assert_eq!(
            run(Some("[boot]\nsystemd=true\n")),
            "[boot]\nsystemd=true\n\n[user]\ndefault=kings\n"
        );
    }
}
