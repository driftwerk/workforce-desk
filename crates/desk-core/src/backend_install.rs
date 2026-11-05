//! Installing and updating the Linux backend where the app doesn't run it
//! itself — inside a WSL distro, or on a machine (a Linux box Desk drives
//! over SSH): the three programs and Desk's Claude Code plugin in a folder
//! of their own version under `bin` (`~/.local/share/Desk/bin` there),
//! checked there, then `current` flipped to it. A running backend notices
//! the flip and hands over, as it does when an update replaces it anywhere
//! else. Each step is a script for `sh` there, made here from `bin` alone,
//! so the same scripts serve every way of reaching it.

use std::cmp::Ordering;

use eyre::Result;
use serde::Serialize;

use crate::systemd::{self, Unit};
use crate::{LINUX_HELPER_EXECUTABLE, LINUX_HUB_EXECUTABLE, LINUX_MEMORY_EXECUTABLE};

/// What the app does about the backend there, given the version it wants.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Plan {
    Nothing,
    Install,
    Upgrade {
        from: String,
    },
    /// It has a newer one: refused unless the person asks to reinstall
    /// this version.
    Downgrade {
        from: String,
    },
}

/// `1.2.3` and `1.2.3-rc.1` in order: a pre-release before its release.
/// Build metadata (`+dev.…`) plays no part in the order.
fn version_key(v: &str) -> (Vec<u64>, bool, String) {
    let v = v.trim();
    let v = v.split_once('+').map_or(v, |(v, _)| v);
    let (release, pre) = v.split_once('-').unwrap_or((v, ""));
    let numbers = release.split('.').map(|n| n.parse().unwrap_or(0)).collect();
    (numbers, pre.is_empty(), pre.to_string())
}

pub fn compare(a: &str, b: &str) -> Ordering {
    version_key(a).cmp(&version_key(b))
}

/// Two builds of one version that differ only in their build metadata (a
/// development build, `0.3.0+dev.<hash>`, beside the release `0.3.0`) are
/// different builds: the one wanted replaces the other.
pub fn plan(installed: Option<&str>, wanted: &str) -> Plan {
    match installed {
        None => Plan::Install,
        Some(v) if v.trim() == wanted.trim() => Plan::Nothing,
        Some(v) => match compare(v, wanted) {
            Ordering::Equal | Ordering::Less => Plan::Upgrade { from: v.into() },
            Ordering::Greater => Plan::Downgrade { from: v.into() },
        },
    }
}

/// A word for `sh`, single-quoted.
pub fn quote(word: &str) -> String {
    format!("'{}'", word.replace('\'', r"'\''"))
}

/// The programs a backend version holds.
pub const PROGRAMS: [&str; 3] = [
    LINUX_HELPER_EXECUTABLE,
    LINUX_HUB_EXECUTABLE,
    LINUX_MEMORY_EXECUTABLE,
];

/// Desk's Claude Code plugin, a folder beside the programs.
pub const PLUGIN: &str = "claude-plugin";

/// What Desk Helper is started with on a machine.
pub const MACHINE_FLAG: &str = "--machine";

/// Who the machine's owner is, given to Desk Helper by its service there
/// (the machine's own account may say nothing useful).
pub const PERSON_NAME_ENV: &str = "DESK_PERSON_NAME";
pub const PERSON_EMAIL_ENV: &str = "DESK_PERSON_EMAIL";

/// Whether `version` can name a folder under `bin`: letters, digits and
/// `.+-` only, never `..`, so it stays one folder inside `bin`.
pub fn valid_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 64
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-'))
        && !version.starts_with(['.', '-'])
        && !version.contains("..")
}

fn version_dir(bin: &str, version: &str) -> Result<String> {
    if !valid_version(version) {
        eyre::bail!("{version:?} isn't a version Desk installs");
    }
    Ok(format!("{bin}/{version}"))
}

/// Desk Helper of one installed version.
pub fn helper_in(bin: &str, version: &str) -> Result<String> {
    Ok(format!(
        "{}/{LINUX_HELPER_EXECUTABLE}",
        version_dir(bin, version)?
    ))
}

/// Desk Helper of the version that runs, through the `current` link.
pub fn current_helper(bin: &str) -> String {
    format!("{bin}/current/{LINUX_HELPER_EXECUTABLE}")
}

/// Desk's Claude Code plugin of the version that runs.
pub fn current_plugin(bin: &str) -> String {
    format!("{bin}/current/{PLUGIN}")
}

/// Installs the programs and the plugin from the folder in `$src` into
/// `bin/<version>`: what follows a line that sets `src`.
pub fn install_from_src(bin: &str, version: &str) -> Result<String> {
    let dest = quote(&version_dir(bin, version)?);
    let installs: String = PROGRAMS
        .iter()
        .map(|p| format!("install -Dm755 \"$src/{p}\" {dest}/{p}\n"))
        .collect();
    Ok(format!(
        "{installs}\
         rm -rf {dest}/{PLUGIN}\n\
         cp -R \"$src/{PLUGIN}\" {dest}/{PLUGIN}\n"
    ))
}

/// Unpacks a backend tarball given on standard input (the programs and the
/// plugin at its top, no folder around them) into `bin/<version>`: into a
/// folder beside it first, which only becomes that version once it holds
/// everything, executable (an archive may have lost the modes).
pub fn unpack_script(bin: &str, version: &str) -> Result<String> {
    let dest = version_dir(bin, version)?;
    let programs = PROGRAMS.join(" ");
    Ok(format!(
        "set -eu\n\
         dest={dest}\n\
         partial={partial}\n\
         rm -rf \"$partial\"\n\
         mkdir -p \"$partial\"\n\
         tar -xzf - -C \"$partial\"\n\
         for p in {programs}; do\n  \
           [ -f \"$partial/$p\" ] || {{ echo \"the backend has no $p\" >&2; exit 1; }}\n  \
           chmod 755 \"$partial/$p\"\n\
         done\n\
         [ -d \"$partial/{PLUGIN}\" ] || {{ echo \"the backend has no {PLUGIN}\" >&2; exit 1; }}\n\
         rm -rf \"$dest\"\n\
         mv \"$partial\" \"$dest\"\n",
        dest = quote(&dest),
        partial = quote(&format!("{dest}.partial")),
    ))
}

/// Asks the copied `version` whether it can run there (`--check`).
pub fn check_script(bin: &str, version: &str) -> Result<String> {
    Ok(format!("{} --check", quote(&helper_in(bin, version)?)))
}

/// Points `bin/current` at `version` in one step, then removes every
/// version but it and the one before.
pub fn flip_script(bin: &str, version: &str) -> Result<String> {
    version_dir(bin, version)?;
    Ok(format!(
        "set -eu\n\
         bin={bin}\n\
         previous=$(readlink \"$bin/current\" 2>/dev/null || true)\n\
         ln -sfn {version} \"$bin/current.next\"\n\
         mv -Tf \"$bin/current.next\" \"$bin/current\"\n\
         for dir in \"$bin\"/*/; do\n  \
           name=$(basename \"$dir\")\n  \
           case \"$name\" in current | {version} | \"$previous\") ;; *) rm -rf \"$bin/$name\" ;; esac\n\
         done\n",
        bin = quote(bin),
        version = quote(version),
    ))
}

/// The version `bin/current` points at; empty when none is installed.
pub fn installed_script(bin: &str) -> String {
    format!("readlink {}/current 2>/dev/null || true", quote(bin))
}

/// The installed version, from what [`installed_script`] printed.
pub fn parse_installed(said: &str) -> Option<String> {
    let version = said.trim();
    (!version.is_empty()).then(|| version.to_string())
}

/// The machine's service: Desk Helper of the version that runs, in machine
/// mode, told who its owner is.
pub fn machine_unit(bin: &str, name: Option<&str>, email: Option<&str>) -> Unit {
    let person = [(PERSON_NAME_ENV, name), (PERSON_EMAIL_ENV, email)];
    Unit {
        program: current_helper(bin),
        args: vec![MACHINE_FLAG.into()],
        env: person
            .into_iter()
            .filter_map(|(k, v)| {
                let v = v?.trim();
                (!v.is_empty()).then(|| (k.to_string(), v.to_string()))
            })
            .collect(),
    }
}

/// Writes the service's unit (`systemd::UNIT` unless a test names
/// another), reloads systemd when it changed, and enables and starts it;
/// one already running is restarted when its unit changed.
pub fn service_script(name: &str, unit: &Unit) -> String {
    format!(
        "set -eu\n\
         dir=\"${{XDG_CONFIG_HOME:-$HOME/.config}}/systemd/user\"\n\
         unit=\"$dir\"/{name}\n\
         mkdir -p \"$dir\"\n\
         printf '%s' {text} > \"$unit.next\"\n\
         changed=\n\
         if [ -f \"$unit\" ] && [ \"$(cat \"$unit\")\" = \"$(cat \"$unit.next\")\" ]; then rm -f \"$unit.next\"; else mv -f \"$unit.next\" \"$unit\"; changed=1; fi\n\
         was=$(systemctl --user is-active {name} 2>/dev/null || true)\n\
         if [ -n \"$changed\" ]; then systemctl --user daemon-reload; fi\n\
         systemctl --user enable --now {name}\n\
         if [ -n \"$changed\" ] && [ \"$was\" = active ]; then systemctl --user restart {name}; fi\n",
        name = quote(name),
        text = quote(&systemd::unit_text(unit)),
    )
}

/// How Desk Helper is kept running on a machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Keeping {
    /// The systemd user service, with linger: started at boot with nobody
    /// logged in, restarted when it stops, and sessions resumed after a
    /// reboot.
    Service,
    /// Started by Desk each time it connects ([`start_script`]), outside
    /// systemd, so it outlives the SSH session. It isn't started again
    /// after a reboot or a crash until Desk next connects.
    OnConnect { why: String },
}

/// How Desk Helper can be kept running there, given whether the account has
/// a systemd user manager and whether linger is on. A service without
/// linger is stopped by systemd at the last logout — when Desk's own SSH
/// connection ends — taking the sessions with it, so it is never used.
pub fn keeping(user: &str, systemd_user: bool, linger: Option<bool>) -> Keeping {
    match (systemd_user, linger) {
        (true, Some(true)) => Keeping::Service,
        (true, _) => Keeping::OnConnect {
            why: format!(
                "Desk can't start itself there at boot: that needs linger, which only an \
                 administrator can turn on for {user} ({}). Until then Desk starts it each \
                 time it connects, and sessions wait for that after the machine restarts.",
                linger_by_hand(user)
            ),
        },
        (false, _) => Keeping::OnConnect {
            why: "That machine has no systemd for its users, so Desk starts itself there each \
                  time it connects, and sessions wait for that after the machine restarts."
                .into(),
        },
    }
}

/// Whether the account has a systemd user manager to run services.
pub fn systemd_user_script() -> &'static str {
    "systemctl --user show-environment >/dev/null 2>&1 && echo yes || echo no"
}

/// Starts Desk Helper of the version that runs in machine mode, in its own
/// session so it outlives the SSH connection, with the owner's name and
/// email; when one is already running the new one sees it and goes.
pub fn start_script(bin: &str, name: Option<&str>, email: Option<&str>) -> String {
    let unit = machine_unit(bin, name, email);
    let env: String = unit
        .env
        .iter()
        .map(|(k, v)| format!("{k}={} ", quote(v)))
        .collect();
    // Desk Helper writes its own log, under Desk's folder there.
    format!(
        "{env}setsid -f {helper} {MACHINE_FLAG} </dev/null >/dev/null 2>&1\n",
        helper = quote(&unit.program),
    )
}

/// Whether systemd keeps the account's services running with nobody
/// logged in (and starts them at boot): `Linger=yes` or `Linger=no`.
pub fn linger_script() -> &'static str {
    "loginctl show-user \"$(id -un)\" -p Linger"
}

/// Turns linger on for the account, by itself where polkit lets it, else
/// through `sudo` where that needs no password; then says whether it is.
pub fn enable_linger_script() -> &'static str {
    "user=$(id -un)\n\
     loginctl enable-linger \"$user\" 2>/dev/null || sudo -n loginctl enable-linger \"$user\" 2>/dev/null || true\n\
     loginctl show-user \"$user\" -p Linger\n"
}

/// What [`linger_script`] or [`enable_linger_script`] printed; none when
/// it said neither (`loginctl` missing, or the account unknown to it).
pub fn parse_linger(said: &str) -> Option<bool> {
    said.lines()
        .filter_map(|l| l.trim().strip_prefix("Linger="))
        .find_map(|v| match v.trim() {
            "yes" => Some(true),
            "no" => Some(false),
            _ => None,
        })
}

/// The line the person runs there when Desk can't turn linger on itself.
pub fn linger_by_hand(user: &str) -> String {
    format!("sudo loginctl enable-linger {}", quote(user))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BIN: &str = "/home/dev/.local/share/Desk/bin";

    #[test]
    fn the_plan_follows_the_versions() {
        assert_eq!(plan(None, "0.3.0"), Plan::Install);
        assert_eq!(plan(Some("0.3.0"), "0.3.0"), Plan::Nothing);
        assert_eq!(
            plan(Some("0.2.9"), "0.3.0"),
            Plan::Upgrade {
                from: "0.2.9".into()
            }
        );
        assert_eq!(
            plan(Some("0.10.0"), "0.9.0"),
            Plan::Downgrade {
                from: "0.10.0".into()
            }
        );
        assert_eq!(
            plan(Some("0.3.0-rc.1"), "0.3.0"),
            Plan::Upgrade {
                from: "0.3.0-rc.1".into()
            }
        );
        assert_eq!(
            plan(Some("0.3.0-rc.2"), "0.3.0-rc.10"),
            Plan::Downgrade {
                from: "0.3.0-rc.2".into()
            }
        );
    }

    #[test]
    fn a_development_build_never_matches_a_release() {
        let dev = "0.3.0+dev.4f2a9c1e0b7d";
        // The release of its version, and a later one, replace it.
        assert_eq!(plan(Some(dev), "0.3.0"), Plan::Upgrade { from: dev.into() });
        assert_eq!(plan(Some(dev), "0.3.1"), Plan::Upgrade { from: dev.into() });
        // Another development build of it does too; the same one is kept.
        assert_eq!(
            plan(Some(dev), "0.3.0+dev.000000000000"),
            Plan::Upgrade { from: dev.into() }
        );
        assert_eq!(plan(Some(dev), dev), Plan::Nothing);
        // A development build is installed over the release of its version,
        // and is never taken for newer than a later release.
        assert_eq!(
            plan(Some("0.3.0"), dev),
            Plan::Upgrade {
                from: "0.3.0".into()
            }
        );
        assert_eq!(
            plan(Some("0.3.1"), dev),
            Plan::Downgrade {
                from: "0.3.1".into()
            }
        );
    }

    #[test]
    fn words_are_quoted_for_sh() {
        assert_eq!(
            quote("C:\\Program Files\\Desk\\backend"),
            "'C:\\Program Files\\Desk\\backend'"
        );
        assert_eq!(quote("it's"), r"'it'\''s'");
    }

    #[test]
    fn only_a_plain_version_names_a_folder() {
        for ok in ["0.3.0", "0.3.0-rc.1", "0.3.0+dev.4f2a9c1e0b7d", "1"] {
            assert!(valid_version(ok), "{ok}");
        }
        for bad in [
            "",
            "..",
            "../x",
            "0.3/0",
            ".hidden",
            "-rf",
            "0.3.0 x",
            "0.3.0'",
            "0.3..0",
            &"9".repeat(65),
        ] {
            assert!(!valid_version(bad), "{bad}");
            assert!(unpack_script(BIN, bad).is_err(), "{bad}");
            assert!(flip_script(BIN, bad).is_err(), "{bad}");
            assert!(check_script(BIN, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_install_copies_each_program_and_the_plugin_into_its_version() {
        assert_eq!(
            install_from_src(BIN, "0.3.0").unwrap(),
            "install -Dm755 \"$src/desk-helper\" '/home/dev/.local/share/Desk/bin/0.3.0'/desk-helper\n\
             install -Dm755 \"$src/desk-agents\" '/home/dev/.local/share/Desk/bin/0.3.0'/desk-agents\n\
             install -Dm755 \"$src/desk-memory\" '/home/dev/.local/share/Desk/bin/0.3.0'/desk-memory\n\
             rm -rf '/home/dev/.local/share/Desk/bin/0.3.0'/claude-plugin\n\
             cp -R \"$src/claude-plugin\" '/home/dev/.local/share/Desk/bin/0.3.0'/claude-plugin\n"
        );
    }

    #[test]
    fn the_unpack_becomes_the_version_only_when_whole() {
        let script = unpack_script(BIN, "0.3.0").unwrap();
        assert!(script.starts_with(
            "set -eu\n\
             dest='/home/dev/.local/share/Desk/bin/0.3.0'\n\
             partial='/home/dev/.local/share/Desk/bin/0.3.0.partial'\n"
        ));
        assert!(script.contains("tar -xzf - -C \"$partial\"\n"));
        assert!(script.ends_with("rm -rf \"$dest\"\nmv \"$partial\" \"$dest\"\n"));
    }

    #[test]
    fn the_flip_is_one_rename_and_keeps_the_version_before() {
        let script = flip_script(BIN, "0.3.0").unwrap();
        assert!(script.contains(
            "ln -sfn '0.3.0' \"$bin/current.next\"\nmv -Tf \"$bin/current.next\" \"$bin/current\"\n"
        ));
        assert!(script.contains("case \"$name\" in current | '0.3.0' | \"$previous\") ;;"));
        assert!(script.starts_with("set -eu\nbin='/home/dev/.local/share/Desk/bin'\n"));
    }

    #[test]
    fn the_check_runs_the_copied_helper() {
        assert_eq!(
            check_script(BIN, "0.3.0").unwrap(),
            "'/home/dev/.local/share/Desk/bin/0.3.0/desk-helper' --check"
        );
        assert_eq!(
            installed_script(BIN),
            "readlink '/home/dev/.local/share/Desk/bin'/current 2>/dev/null || true"
        );
        assert_eq!(parse_installed("0.3.0\n").as_deref(), Some("0.3.0"));
        assert_eq!(parse_installed("\n"), None);
    }

    #[test]
    fn the_machines_service_runs_the_current_helper_in_machine_mode() {
        let unit = machine_unit(BIN, Some("Sarah O'Neil"), Some(" "));
        assert_eq!(
            unit,
            Unit {
                program: "/home/dev/.local/share/Desk/bin/current/desk-helper".into(),
                args: vec!["--machine".into()],
                env: vec![("DESK_PERSON_NAME".into(), "Sarah O'Neil".into())],
            }
        );
        let script = service_script(systemd::UNIT, &unit);
        assert!(script.contains("unit=\"$dir\"/'desk-helper.service'\n"));
        // The unit's text goes in as one quoted word.
        assert!(script.contains("Environment=\"DESK_PERSON_NAME=Sarah O'\\''Neil\""));
        assert!(script.contains("systemctl --user enable --now 'desk-helper.service'\n"));
    }

    #[test]
    fn the_service_is_used_only_with_linger() {
        assert_eq!(keeping("ana", true, Some(true)), Keeping::Service);
        let Keeping::OnConnect { why } = keeping("ana", true, Some(false)) else {
            panic!("a service without linger stops at logout")
        };
        assert!(why.contains("sudo loginctl enable-linger 'ana'"), "{why}");
        assert!(matches!(
            keeping("ana", true, None),
            Keeping::OnConnect { .. }
        ));
        let Keeping::OnConnect { why } = keeping("ana", false, Some(true)) else {
            panic!("no systemd, no service")
        };
        assert!(why.contains("no systemd"), "{why}");
    }

    #[test]
    fn starting_on_connect_runs_the_current_helper_in_its_own_session() {
        assert_eq!(
            start_script(BIN, Some("Ana"), None),
            "DESK_PERSON_NAME='Ana' setsid -f '/home/dev/.local/share/Desk/bin/current/desk-helper' \
             --machine </dev/null >/dev/null 2>&1\n"
        );
    }

    #[test]
    fn linger_is_read_from_what_loginctl_says() {
        assert_eq!(parse_linger("Linger=yes\n"), Some(true));
        assert_eq!(parse_linger("Linger=no"), Some(false));
        assert_eq!(parse_linger("Failed to get user: …"), None);
        assert_eq!(parse_linger(""), None);
        assert_eq!(linger_by_hand("dev"), "sudo loginctl enable-linger 'dev'");
        assert!(enable_linger_script().contains("|| sudo -n loginctl enable-linger \"$user\""));
    }

    #[cfg(target_os = "linux")]
    fn sh(script: &str, stdin: Option<&[u8]>) -> std::process::Output {
        use std::io::Write;
        let mut child = std::process::Command::new("sh")
            .args(["-c", script])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        input.write_all(stdin.unwrap_or_default()).unwrap();
        drop(input);
        child.wait_with_output().unwrap()
    }

    #[cfg(target_os = "linux")]
    fn ok(out: std::process::Output) -> String {
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[cfg(target_os = "linux")]
    /// A backend tarball as the release makes it: the programs (without
    /// their modes, as a downloaded artifact has them) and the plugin, at
    /// its top; `without` left out.
    fn tarball(dir: &std::path::Path, without: Option<&str>) -> Vec<u8> {
        let source = dir.join(format!("backend-{}", without.unwrap_or("whole")));
        std::fs::create_dir_all(source.join("claude-plugin/hooks")).unwrap();
        std::fs::write(source.join("claude-plugin/hooks/hooks.json"), "{}").unwrap();
        for p in PROGRAMS.into_iter().filter(|p| Some(*p) != without) {
            std::fs::write(source.join(p), "#!/bin/sh\necho ran\n").unwrap();
        }
        let out = std::process::Command::new("tar")
            .args(["-czf", "-", "-C"])
            .arg(&source)
            .arg(".")
            .output()
            .unwrap();
        assert!(out.status.success());
        out.stdout
    }

    /// The scripts run as written, in a Linux shell, against a fake home:
    /// three versions unpacked from a tarball and flipped to in turn.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_scripts_unpack_flip_and_prune_in_a_real_shell() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("home/.local/share/Desk/bin");
        let bin_s = bin.to_string_lossy().into_owned();
        let whole = tarball(dir.path(), None);
        for v in ["0.1.0", "0.2.0", "0.3.0+dev.4f2a9c1e0b7d"] {
            ok(sh(&unpack_script(&bin_s, v).unwrap(), Some(&whole)));
            assert_eq!(ok(sh(&check_script(&bin_s, v).unwrap(), None)), "ran");
            ok(sh(&flip_script(&bin_s, v).unwrap(), None));
            assert_eq!(
                parse_installed(&ok(sh(&installed_script(&bin_s), None))).as_deref(),
                Some(v)
            );
        }
        let mut kept: Vec<_> = std::fs::read_dir(&bin)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        kept.sort();
        assert_eq!(kept, ["0.2.0", "0.3.0+dev.4f2a9c1e0b7d", "current"]);
        assert!(bin.join("current/claude-plugin/hooks/hooks.json").is_file());
        let mode = std::fs::metadata(bin.join("current/desk-helper"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);

        // A tarball missing a program never becomes a version, and leaves
        // the one that runs as it was.
        let broken = tarball(dir.path(), Some("desk-agents"));
        let out = sh(&unpack_script(&bin_s, "0.4.0").unwrap(), Some(&broken));
        assert!(!out.status.success());
        assert!(String::from_utf8_lossy(&out.stderr).contains("no desk-agents"));
        assert!(!bin.join("0.4.0").exists());
        assert_eq!(
            ok(sh(&installed_script(&bin_s), None)),
            "0.3.0+dev.4f2a9c1e0b7d"
        );
        // Its leftover goes at the next flip.
        assert!(bin.join("0.4.0.partial").exists());
        ok(sh(&unpack_script(&bin_s, "0.4.0").unwrap(), Some(&whole)));
        ok(sh(&flip_script(&bin_s, "0.4.0").unwrap(), None));
        assert!(!bin.join("0.4.0.partial").exists());
    }

    /// The service script, against a stand-in `systemctl` that logs what
    /// it is asked: written and started once, left alone when unchanged,
    /// restarted when its unit changed under a running service.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_service_is_written_once_and_restarted_only_when_it_changed() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("fake");
        std::fs::create_dir_all(&fake).unwrap();
        let log = dir.path().join("systemctl.log");
        let systemctl = fake.join("systemctl");
        std::fs::write(
            &systemctl,
            format!(
                "#!/bin/sh\necho \"$*\" >> '{}'\n[ \"$2\" = is-active ] && echo active\nexit 0\n",
                log.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&systemctl, std::fs::Permissions::from_mode(0o755)).unwrap();
        let run = |unit: &Unit| {
            let script = format!(
                "export PATH='{}':\"$PATH\" XDG_CONFIG_HOME='{}'\n{}",
                fake.display(),
                dir.path().join("config").display(),
                service_script("desk-test.service", unit)
            );
            ok(sh(&script, None));
            let said = std::fs::read_to_string(&log).unwrap_or_default();
            let _ = std::fs::remove_file(&log);
            said
        };
        let unit = machine_unit(BIN, Some("Sarah"), None);
        let first = run(&unit);
        assert!(first.contains("--user daemon-reload\n"));
        assert!(first.contains("--user enable --now desk-test.service\n"));
        assert!(first.contains("--user restart"), "running already: {first}");
        let written =
            std::fs::read_to_string(dir.path().join("config/systemd/user/desk-test.service"))
                .unwrap();
        assert_eq!(written, systemd::unit_text(&unit));
        let same = run(&unit);
        assert!(!same.contains("daemon-reload"), "{same}");
        assert!(!same.contains("restart"), "{same}");
        let other = run(&machine_unit(BIN, Some("Sarah"), Some("s@example.com")));
        assert!(other.contains("daemon-reload") && other.contains("restart"));
    }
}
