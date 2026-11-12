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
/// (a home, bash, uid 1000 or above) unless it's there, refusing an
/// existing system account (uid below 1000, or a shell that can't log in);
/// lets it use sudo without a password (a file of its own in
/// `/etc/sudoers.d`, checked with visudo where there is one), since it has
/// none: never an existing account that has a password of its own; and makes it the distro's default in `/etc/wsl.conf`, keeping the
/// rest of that file (and the link, when it is one). WSL starts the distro
/// as that user after a restart.
pub const CREATE_USER_SCRIPT: &str = r#"set -eu
u="$1"
nopw=1
if id -u "$u" >/dev/null 2>&1; then
  uid=$(id -u "$u")
  sh_=$(getent passwd "$u" | cut -d: -f7)
  case "$sh_" in */nologin|*/false|"") echo "system-account" >&2; exit 3 ;; esac
  [ "$uid" -ge 1000 ] || { echo "system-account" >&2; exit 3; }
  # An account that has a password of its own keeps asking for it: sudo
  # without one is only for an account with none to type.
  pw=$(awk -F: -v u="$u" '$1 == u { print $2 }' /etc/shadow 2>/dev/null || true)
  case "$pw" in ""|"!"*|"*"*) ;; *) nopw=0 ;; esac
else
  if command -v useradd >/dev/null 2>&1; then useradd -m -s /bin/bash "$u"
  else adduser -D -s /bin/sh "$u"; fi
fi
if [ "$nopw" = 1 ] && [ -d /etc/sudoers.d ]; then
  s="/etc/sudoers.d/desk-$u"
  printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$u" > "$s.desk"
  chmod 0440 "$s.desk"
  if command -v visudo >/dev/null 2>&1 && ! visudo -cf "$s.desk" >/dev/null 2>&1; then rm -f "$s.desk"
  else mv "$s.desk" "$s"; fi
fi
f=/etc/wsl.conf
t=$(readlink -f "$f" 2>/dev/null || echo "$f")
[ -e "$t" ] || : > "$t"
awk -v u="$u" '
  /^[[:space:]]*\[[^]]*\][[:space:]]*$/ {
    name = tolower($0); gsub(/[[:space:]]/, "", name)
    inuser = (name == "[user]")
    print
    if (inuser && !done) { print "default=" u; done = 1 }
    next
  }
  inuser && tolower($0) ~ /^[[:space:]]*default[[:space:]]*=/ { next }
  { print }
  END { if (!done) { print ""; print "[user]"; print "default=" u } }
' "$t" > "$t.desk"
cat "$t.desk" > "$t"
rm -f "$t.desk"
"#;

/// Makes a normal user `user` in `distro` and its default, then stops the
/// distro so it starts as that user next time.
pub fn create_user(wsl: &WslExe, distro: &str, user: &str) -> Result<(), String> {
    named(distro)?;
    let out = wsl
        // --exec: run as given, never through the distro's shell (which
        // would read the script and the name itself).
        .run(&[
            "-d",
            distro,
            "-u",
            "root",
            "--exec",
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
        let said = crate::detect::decode(&out.stderr);
        tracing::warn!(distro, said = %said.trim(), "creating a user failed");
        if said.contains("system-account") {
            return Err(format!(
                "{distro} already has a system account called {user}, which Desk won't log in as. Make a normal user there yourself and set it as the default."
            ));
        }
        return Err(crate::run::plain(&said).unwrap_or_else(|| format!(
            "Desk couldn't make a user in {distro}. Try again, or make one there yourself and set it as the default."
        )));
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
        let said = crate::detect::decode(&out.stderr);
        tracing::warn!(said = %said.trim(), "installing Ubuntu alongside failed");
        if let Some(plain) = crate::run::plain(&said) {
            return Err(plain);
        }
        return Err(format!(
            "Windows didn't install {ALONGSIDE}. Try again; if it keeps stopping, install it from the Microsoft Store and Desk notices it by itself."
        ));
    }
    // Registered on its first start: started as root, running nothing.
    let started = wsl.run(&["-d", ALONGSIDE, "-u", "root", "--exec", "true"]);
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

/// `distro` is a distro's name, never something `wsl.exe` would read as an
/// option of its own (the name comes from the page).
fn named(distro: &str) -> Result<(), String> {
    if distro.is_empty()
        || distro.starts_with('-')
        || distro.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err("That isn't the name of a Linux in WSL. Look again.".into());
    }
    Ok(())
}

/// Moves `distro` to WSL 2 (a few minutes; its files stay).
pub fn convert(wsl: &WslExe, distro: &str) -> Result<(), String> {
    named(distro)?;
    let out = wsl.run(&["--set-version", distro, "2"]).map_err(|e| {
        tracing::warn!(error = %format!("{e:#}"), "couldn't run wsl.exe to convert");
        format!("Desk couldn't move {distro} to WSL 2. Try again.")
    })?;
    if !out.status.success() {
        let said = crate::detect::decode(&out.stderr);
        tracing::warn!(distro, said = %said.trim(), "moving to WSL 2 failed");
        if let Some(plain) = crate::run::plain(&said) {
            return Err(format!("{distro} didn't move to WSL 2. {plain}"));
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
        // Any case, and a second [user]: one default, under the first.
        assert_eq!(
            run(Some(
                "[User]\nDefault = root\n[boot]\nsystemd=true\n[USER]\ndefault=other\n"
            )),
            "[User]\ndefault=kings\n[boot]\nsystemd=true\n[USER]\n"
        );
        // A linked wsl.conf stays a link, its target changed.
        let target = dir.path().join("real.conf");
        std::fs::write(&target, "[boot]\nsystemd=true\n").unwrap();
        let _ = std::fs::remove_file(&conf);
        std::os::unix::fs::symlink(&target, &conf).unwrap();
        let script = format!("set -eu\nu=\"$1\"\nf={}{part}", conf.display());
        assert!(
            std::process::Command::new("sh")
                .args(["-c", &script, "t", "kings"])
                .status()
                .unwrap()
                .success()
        );
        assert!(
            std::fs::symlink_metadata(&conf)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert!(
            std::fs::read_to_string(&target)
                .unwrap()
                .contains("default=kings")
        );
    }

    /// The user part, run for real here: sudo without a password only for
    /// an account with none of its own.
    #[cfg(unix)]
    #[test]
    fn sudo_without_a_password_is_never_given_to_an_account_that_has_one() {
        // Everything before the sudoers part, then what it decides.
        let part = CREATE_USER_SCRIPT
            .split("if [ \"$nopw\" = 1 ]")
            .next()
            .unwrap();
        assert!(part.contains("/etc/shadow"));
        assert!(part.contains("nopw=0"));
        // The shadow lookup, as the script does it, on made-up files.
        let dir = tempfile::tempdir().unwrap();
        let shadow = dir.path().join("shadow");
        std::fs::write(
            &shadow,
            "kings:$6$abc$def:19000:0:99999:7:::\nnew:!:19000:0:99999:7:::\n",
        )
        .unwrap();
        let pw = |u: &str| {
            let out = std::process::Command::new("sh")
                .args([
                    "-c",
                    r#"awk -F: -v u="$1" '$1 == u { print $2 }' "$2""#,
                    "t",
                    u,
                    shadow.to_str().unwrap(),
                ])
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        assert!(pw("kings").starts_with("$6$"));
        assert_eq!(pw("new"), "!");
    }

    #[test]
    fn a_name_wsl_would_read_as_an_option_is_no_distro() {
        assert!(named("Ubuntu-24.04").is_ok());
        for bad in ["", "--shutdown", "-d", "a b", "x\ny"] {
            assert!(named(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_script_and_name_go_to_sh_as_given_never_through_a_shell() {
        // --exec, and the name its own argument after the script's $0.
        assert!(CREATE_USER_SCRIPT.contains(r#"u="$1""#));
        assert!(CREATE_USER_SCRIPT.contains("NOPASSWD"));
        assert!(CREATE_USER_SCRIPT.contains("system-account"));
    }
}
