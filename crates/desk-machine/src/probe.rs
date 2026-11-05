//! A first look at a machine, before it is added: its host key, whether
//! this computer's SSH key gets in, and what the machine is (its account,
//! system and processor, and what Desk has installed there). The same look
//! starts every connect.
//!
//! Everything a machine says is its own words: what Desk shows of it is cut
//! short, on one line, without control or formatting characters.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use desk_core::machine::{MACHINE_ROOT, Machine};
use serde::Serialize;

use crate::hostkey::{self, Files, KeyTrouble};
use crate::ssh::{self, SSH_FAILED, SshExe};

/// The most of a machine's words Desk keeps.
const MAX_WORDS: usize = 80;

use desk_core::machine::is_format as formatting;

/// A machine's words as Desk shows them: one line, nothing invisible, cut
/// short; none when nothing is left.
pub fn words(text: &str) -> Option<String> {
    let line: String = text
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .filter(|c| !c.is_control() && !formatting(*c))
        .collect();
    let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
    (!line.is_empty()).then(|| line.chars().take(MAX_WORDS).collect())
}

/// A machine's system, as the page shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct System {
    /// `Ubuntu 24.04`.
    pub os: String,
    /// `x86_64`.
    pub arch: String,
}

/// What the look found there.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Look {
    pub user: String,
    pub root: bool,
    /// The account's home there (`/home/dev`).
    pub home: String,
    pub kernel: String,
    pub arch: String,
    pub os: Option<String>,
    pub glibc: Option<String>,
    /// The backend version `bin/current` points at.
    pub installed: Option<String>,
    /// Whether the account has a systemd user manager.
    pub systemd: bool,
    pub linger: Option<bool>,
    /// Whether Desk's service there is enabled.
    pub service: bool,
    /// The account already runs Desk as a desktop app (its folder isn't a
    /// machine's, its secrets are in a keyring, or its service isn't
    /// machine mode's): installing would take them over.
    pub desktop: bool,
}

impl Look {
    pub fn system(&self) -> System {
        System {
            os: self.os.clone().unwrap_or_else(|| self.kernel.clone()),
            arch: self.arch.clone(),
        }
    }

    /// Where the backend's versions are there, from its home.
    pub fn bin(&self) -> String {
        format!("{}/{MACHINE_ROOT}/bin", self.home)
    }
}

/// The look, as a script: one `key=value` a line.
pub fn look_script() -> String {
    format!(
        "printf 'user=%s\\n' \"$(id -un)\"\n\
         printf 'uid=%s\\n' \"$(id -u)\"\n\
         printf 'home=%s\\n' \"$HOME\"\n\
         printf 'kernel=%s\\n' \"$(uname -s)\"\n\
         printf 'arch=%s\\n' \"$(uname -m)\"\n\
         if [ -r /etc/os-release ]; then ( . /etc/os-release; printf 'os=%s %s\\n' \"${{NAME:-}}\" \"${{VERSION_ID:-}}\" ); fi\n\
         printf 'glibc=%s\\n' \"$(getconf GNU_LIBC_VERSION 2>/dev/null | cut -d' ' -f2)\"\n\
         printf 'installed=%s\\n' \"$(readlink \"$HOME/{MACHINE_ROOT}/bin/current\" 2>/dev/null)\"\n\
         printf 'systemd=%s\\n' \"$(systemctl --user show-environment >/dev/null 2>&1 && echo yes || echo no)\"\n\
         printf 'linger=%s\\n' \"$(loginctl show-user \"$(id -un)\" -p Linger --value 2>/dev/null)\"\n\
         printf 'service=%s\\n' \"$(systemctl --user is-enabled {unit} 2>/dev/null)\"\n\
         d=\"$HOME/{root}\"\n\
         printf 'desk_root=%s\\n' \"$([ -d \"$d\" ] && echo yes)\"\n\
         printf 'desk_marker=%s\\n' \"$([ -e \"$d/{marker}\" ] && echo yes)\"\n\
         p=$(cat \"$d/hub/run/desk-hubd.pid\" 2>/dev/null)\n\
         printf 'desk_running=%s\\n' \"$([ -n \"$p\" ] && tr '\\000' ' ' < \"/proc/$p/cmdline\" 2>/dev/null | grep -q -- '{flag}' && echo machine)\"\n\
         printf 'desk_autostart=%s\\n' \"$(ls \"${{XDG_CONFIG_HOME:-$HOME/.config}}\"/autostart/*[Dd]esk*.desktop >/dev/null 2>&1 && echo yes)\"\n\
         printf 'desk_keys=%s\\n' \"$(sed -n 's/^store *= *\"\\(.*\\)\"/\\1/p' \"$d/keys.toml\" 2>/dev/null | head -n 1)\"\n\
         u=\"${{XDG_CONFIG_HOME:-$HOME/.config}}/systemd/user/{unit}\"\n\
         printf 'desk_unit=%s\\n' \"$(if [ -f \"$u\" ]; then if grep -q -- '{flag}' \"$u\"; then echo machine; else echo desktop; fi; fi)\"\n",
        unit = desk_core::systemd::UNIT,
        root = MACHINE_ROOT,
        marker = desk_core::MACHINE_MARKER,
        flag = desk_core::backend_install::MACHINE_FLAG,
    )
}

impl Look {
    pub fn parse(said: &str) -> Result<Look, String> {
        let mut look = Look::default();
        let mut uid = None;
        let (mut root, mut marker, mut keyring, mut desktop_unit, mut autostart) =
            (false, false, false, false, false);
        let (mut machine_unit, mut running_machine) = (false, false);
        for line in said.lines() {
            let Some((k, v)) = line.split_once('=') else {
                continue;
            };
            let v = v.trim();
            let some = || words(v);
            match k {
                "user" => look.user = some().unwrap_or_default(),
                "uid" => uid = v.parse::<u32>().ok(),
                "home" => look.home = v.to_string(),
                "kernel" => look.kernel = some().unwrap_or_default(),
                "arch" => look.arch = some().unwrap_or_default(),
                "os" => look.os = some(),
                "glibc" => look.glibc = some(),
                "installed" => {
                    look.installed = Some(v)
                        .filter(|v| desk_core::backend_install::valid_version(v))
                        .map(str::to_string)
                }
                "systemd" => look.systemd = v == "yes",
                "linger" => {
                    look.linger = match v {
                        "yes" => Some(true),
                        "no" => Some(false),
                        _ => None,
                    }
                }
                "service" => look.service = v == "enabled",
                "desk_root" => root = v == "yes",
                "desk_marker" => marker = v == "yes",
                "desk_running" => running_machine = v == "machine",
                "desk_autostart" => autostart = v == "yes",
                "desk_keys" => keyring = v == "system",
                "desk_unit" => {
                    desktop_unit = v == "desktop";
                    machine_unit = v == "machine";
                }
                _ => {}
            }
        }
        look.root = uid == Some(0);
        // A folder without the marker is a machine's only on positive
        // evidence: its service, or the helper running there, is machine
        // mode's (one installed before the marker). Installed versions alone
        // aren't: a Windows Desk's backend in WSL has them too.
        let machine_mode = machine_unit || running_machine;
        look.desktop = keyring || desktop_unit || autostart || (root && !marker && !machine_mode);
        if look.user.is_empty() || look.arch.is_empty() {
            return Err("The machine didn't say what it is.".into());
        }
        if !look.home.starts_with('/')
            || look.home.len() > 255
            || !look
                .home
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "/._-@+".contains(c))
        {
            return Err("The machine's home has a name Desk can't use.".into());
        }
        Ok(look)
    }
}

/// How a look ended without one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Missed {
    /// The key it showed isn't one this computer knows.
    Key(KeyTrouble),
    /// This computer's key didn't get in.
    Refused,
    /// Anything else: no route, no such host, a timeout; in plain words.
    Unreachable(String),
}

/// Looks at `machine`. Blocking.
pub fn look(ssh: &SshExe, machine: &Machine) -> Result<Look, Missed> {
    let out = ssh
        .output(&machine.command(&["sh".into(), "-c".into(), look_script()]))
        .map_err(|e| Missed::Unreachable(format!("Desk couldn't run ssh: {e}")))?;
    if out.status.success() {
        return Look::parse(&String::from_utf8_lossy(&out.stdout)).map_err(Missed::Unreachable);
    }
    if let Some(t) = KeyTrouble::of(&out.stderr) {
        return Err(Missed::Key(t));
    }
    let said = String::from_utf8_lossy(&out.stderr);
    if out.status.code() == Some(SSH_FAILED)
        && (said.contains("Permission denied") || said.contains("Too many authentication failures"))
    {
        return Err(Missed::Refused);
    }
    Err(Missed::Unreachable(ssh::problem(machine, &out.stderr)))
}

/// Why Desk won't install on an account that runs desktop Desk.
pub const DESKTOP: &str = "This account already runs Desk as a desktop app; use another account for a machine. Desk won't change anything there.";

/// What the page is told of the machine's host key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProbeKey {
    Known,
    New {
        fingerprint: String,
        #[serde(rename = "keyType")]
        key_type: String,
    },
    Changed {
        fingerprint: String,
        #[serde(rename = "keyType")]
        key_type: String,
    },
}

/// What the page is told of signing in there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Access {
    Ok {
        user: String,
        system: Option<System>,
    },
    Refused {
        user: Option<String>,
    },
    Locked,
    Unreachable {
        message: String,
    },
}

/// A first look, as `machine_probe` answers it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub target: String,
    pub name: String,
    pub host_key: ProbeKey,
    /// None while the host key isn't known: nothing is sent before then.
    pub access: Option<Access>,
}

/// The name a target gives a machine: its host (`devbox` of `dev@devbox`).
pub fn name_of(target: &str) -> String {
    let host = target.rsplit('@').next().unwrap_or(target);
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .to_string()
}

/// Looks at `machine` for the page: its host key first, then signing in.
/// `user` is the account the person's SSH settings name for it, `files`
/// what they say of the keys. Blocking; only after the person's yes.
pub fn probe(ssh: &SshExe, machine: &Machine, user: Option<String>, files: &Files) -> Probe {
    let answer = |host_key, access| Probe {
        target: machine.target.to_string(),
        name: machine.name.clone(),
        host_key,
        access,
    };
    match look(ssh, machine) {
        Ok(look) if look.desktop => answer(
            ProbeKey::Known,
            Some(Access::Unreachable {
                message: DESKTOP.into(),
            }),
        ),
        Ok(look) => answer(
            ProbeKey::Known,
            Some(Access::Ok {
                user: look.user.clone(),
                system: Some(look.system()),
            }),
        ),
        Err(Missed::Key(trouble)) => match hostkey::capture(ssh, machine) {
            Ok((key, _)) => {
                let (fingerprint, key_type) = (key.fingerprint.clone(), key.kind());
                answer(
                    match trouble {
                        KeyTrouble::Unknown => ProbeKey::New {
                            fingerprint,
                            key_type,
                        },
                        KeyTrouble::Changed => ProbeKey::Changed {
                            fingerprint,
                            key_type,
                        },
                    },
                    None,
                )
            }
            Err(message) => answer(ProbeKey::Known, Some(Access::Unreachable { message })),
        },
        Err(Missed::Refused) if locked(files) => answer(ProbeKey::Known, Some(Access::Locked)),
        Err(Missed::Refused) => answer(ProbeKey::Known, Some(Access::Refused { user })),
        Err(Missed::Unreachable(message)) => {
            answer(ProbeKey::Known, Some(Access::Unreachable { message }))
        }
    }
}

/// The key part (`<type> <base64>`) of a public key line.
fn key_part(line: &str) -> Option<String> {
    let mut w = line.split_whitespace();
    Some(format!("{} {}", w.next()?, w.next()?))
}

/// Whether a key ssh would sign in with needs a passphrase that no agent
/// holds (BatchMode then skips it, and the machine says only "Permission
/// denied"). `ssh-keygen -y` with an empty passphrase tells: it fails on a
/// key that needs one. Nothing it prints is kept.
fn locked(files: &Files) -> bool {
    let agent: Vec<String> = std::process::Command::new("/usr/bin/ssh-add")
        .arg("-L")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(key_part)
                .collect()
        })
        .unwrap_or_default();
    files.identities.iter().filter(|k| k.is_file()).any(|key| {
        let held = std::fs::read_to_string(pub_of(key))
            .ok()
            .and_then(|l| key_part(&l))
            .is_some_and(|k| agent.contains(&k));
        if held {
            return false;
        }
        std::process::Command::new("/usr/bin/ssh-keygen")
            .args(["-y", "-P", "", "-f"])
            .arg(key)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .output()
            .is_ok_and(|o| {
                !o.status.success() && String::from_utf8_lossy(&o.stderr).contains("passphrase")
            })
    })
}

fn pub_of(key: &Path) -> PathBuf {
    let mut p = key.as_os_str().to_owned();
    p.push(".pub");
    PathBuf::from(p)
}

/// The keys ssh tries when the person's settings name none.
const DEFAULT_KEYS: &[&str] = &[
    "id_ed25519",
    "id_ecdsa",
    "id_ed25519_sk",
    "id_ecdsa_sk",
    "id_rsa",
];

/// Whether `line` is one public key: `<type> <base64 blob of that type>
/// [comment]`, nothing more.
pub fn public_key_line(text: &str) -> Option<String> {
    let line = text.trim();
    if line.lines().count() != 1 || line.contains("PRIVATE") || line.len() > 16 * 1024 {
        return None;
    }
    // A known_hosts line is `<host> <type> <key>`: one with a stand-in host.
    desk_core::machine::HostKey::of_line(&format!("x {line}"))?;
    if line.chars().any(|c| c.is_control() || formatting(c)) {
        return None;
    }
    Some(line.to_string())
}

/// This computer's public key for a machine, to put in its
/// `authorized_keys`: the `.pub` beside the first key ssh would sign in
/// with (`files`, or ssh's defaults under `home`), else the first key the
/// agent holds. Only ever a `.pub` file or the agent's public keys.
pub fn public_key(files: Option<&Files>, home: &Path) -> Option<String> {
    let mut keys: Vec<PathBuf> = files.map(|f| f.identities.clone()).unwrap_or_default();
    if keys.is_empty() {
        keys = DEFAULT_KEYS
            .iter()
            .map(|k| home.join(".ssh").join(k))
            .collect();
    }
    keys.iter()
        .find_map(|k| {
            std::fs::read_to_string(pub_of(k))
                .ok()
                .and_then(|t| public_key_line(&t))
        })
        .or_else(|| {
            let out = std::process::Command::new("/usr/bin/ssh-add")
                .arg("-L")
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output()
                .ok()?;
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .find_map(public_key_line)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_machines_words_are_one_plain_line() {
        assert_eq!(
            words("Ubuntu\u{202E} 24.04\n\x1b[31m").as_deref(),
            Some("Ubuntu 24.04 [31m")
        );
        assert_eq!(words("\u{200B}\n"), None);
        assert!(words(&"x".repeat(500)).unwrap().len() <= MAX_WORDS);
    }

    #[test]
    fn the_look_is_read() {
        let look = Look::parse(
            "user=dev\nuid=1000\nhome=/home/dev\nkernel=Linux\narch=x86_64\nos=Ubuntu 24.04\nglibc=2.39\ninstalled=0.3.0\nsystemd=yes\nlinger=no\nservice=enabled\n",
        )
        .unwrap();
        assert_eq!(look.user, "dev");
        assert!(!look.root);
        assert_eq!(look.bin(), "/home/dev/.local/share/Desk/bin");
        assert_eq!(look.installed.as_deref(), Some("0.3.0"));
        assert_eq!(look.linger, Some(false));
        assert!(look.service && look.systemd);
        assert_eq!(
            look.system(),
            System {
                os: "Ubuntu 24.04".into(),
                arch: "x86_64".into()
            }
        );
        let fresh = Look::parse(
            "user=root\nuid=0\nhome=/root\nkernel=Linux\narch=aarch64\ninstalled=\nservice=\n",
        )
        .unwrap();
        assert!(fresh.root);
        assert_eq!(fresh.installed, None);
        assert_eq!(fresh.system().os, "Linux");
        // An installed version that can't name a folder is none at all.
        let odd =
            Look::parse("user=dev\nhome=/home/dev\narch=x86_64\ninstalled=../../x\n").unwrap();
        assert_eq!(odd.installed, None);
        assert!(Look::parse("user=dev\nhome=/home/a b\narch=x86_64\n").is_err());
        assert!(Look::parse("home=/home/dev\n").is_err());
        // An account that runs desktop Desk; a machine's, before and after
        // the marker.
        let base = "user=dev\nhome=/home/dev\nkernel=Linux\narch=x86_64\n";
        let desktop = |more: &str| Look::parse(&format!("{base}{more}")).unwrap().desktop;
        assert!(desktop("desk_root=yes\ndesk_marker=\n"));
        // A Windows Desk's WSL backend: installed versions, file keys, no
        // marker, no service.
        assert!(desktop(
            "desk_root=yes\ndesk_marker=\ndesk_keys=file\ndesk_unit=\ndesk_running=\n"
        ));
        assert!(desktop(
            "desk_root=yes\ndesk_marker=yes\ndesk_autostart=yes\n"
        ));
        // devbox, installed before the marker: its service and its running
        // helper are machine mode's.
        assert!(!desktop(
            "desk_root=yes\ndesk_marker=\ndesk_keys=file\ndesk_unit=machine\n"
        ));
        assert!(!desktop(
            "desk_root=yes\ndesk_marker=\ndesk_keys=file\ndesk_running=machine\n"
        ));
        assert!(desktop(
            "desk_root=yes\ndesk_marker=yes\ndesk_keys=system\n"
        ));
        assert!(desktop("desk_unit=desktop\n"));
        assert!(!desktop(
            "desk_root=yes\ndesk_marker=yes\ndesk_keys=file\ndesk_unit=machine\n"
        ));
        assert!(!desktop(""));
    }

    #[test]
    fn a_target_names_its_machine() {
        assert_eq!(name_of("devbox"), "devbox");
        assert_eq!(name_of("dev@203.0.113.7"), "203.0.113.7");
        assert_eq!(name_of("dev@[2001:db8::1]"), "2001:db8::1");
    }

    #[test]
    fn only_a_public_key_line_is_given() {
        let key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINVryCC2LMDehVH2s0X1phBfYDkIBfEp4uRw/+7lxe8F dev@mac";
        assert_eq!(public_key_line(&format!("{key}\n")).as_deref(), Some(key));
        for bad in [
            "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
            "ssh-ed25519 notbase64",
            "",
            &format!("{key}\n{key}"),
        ] {
            assert_eq!(public_key_line(bad), None, "{bad}");
        }
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".ssh")).unwrap();
        std::fs::write(dir.path().join(".ssh/id_rsa"), "PRIVATE").unwrap();
        std::fs::write(dir.path().join(".ssh/id_rsa.pub"), format!("{key}\n")).unwrap();
        assert_eq!(public_key(None, dir.path()).as_deref(), Some(key));
        let files = Files {
            identities: vec![dir.path().join("work")],
            ..Files::default()
        };
        std::fs::write(dir.path().join("work.pub"), "not a key").unwrap();
        // Not a key: the agent's, if any, never the private file.
        assert_ne!(
            public_key(Some(&files), dir.path()).as_deref(),
            Some("PRIVATE")
        );
    }
}
