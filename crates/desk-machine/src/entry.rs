//! A Host entry of Desk's own in the person's SSH config, for a machine
//! whose entry forwards ports: the same machine (its address, account,
//! port, jump and keys), without the forwards, under a name of Desk's.
//! Desk keeps its connection open all the time, so it never carries the
//! person's forwards ([`crate::ssh::no_forwards`]).
//!
//! The entry goes first in `~/.ssh/config` (ssh takes the first value it
//! finds for most settings, so a `Host *` further down can't change it) and
//! ends with `Match all`, so everything after it applies as before.

use std::path::{Path, PathBuf};

/// The settings `ssh -G` says that make up how the machine is reached,
/// copied into Desk's entry as they are.
const KEPT: &[&str] = &[
    "hostname",
    "user",
    "port",
    "proxyjump",
    "proxycommand",
    "identityfile",
    "identitiesonly",
    "certificatefile",
    "hostkeyalias",
];

/// The name of Desk's entry for a machine called `name`: `desk-` and its
/// letters, digits, dots and dashes.
pub fn alias_for(name: &str) -> String {
    let plain: String = name
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let plain = plain.trim_matches('-');
    format!("desk-{}", if plain.is_empty() { "machine" } else { plain })
}

/// Desk's entry `alias` for what `said` (`ssh -G` of the person's entry)
/// makes of the machine called `name`: its lines, ending in `Match all`.
pub fn block(alias: &str, name: &str, said: &str) -> String {
    let mut lines = vec![
        format!("# Added by Desk: {name} as Desk reaches it, without its port forwards."),
        format!("Host {alias}"),
    ];
    for line in said.lines() {
        let Some((key, value)) = line.trim().split_once(' ') else {
            continue;
        };
        let key = key.to_ascii_lowercase();
        let value = value.trim();
        if !KEPT.contains(&key.as_str()) || value.is_empty() || value == "none" {
            continue;
        }
        // Not the defaults ssh -G names for every host: they apply anyway.
        if key == "port" && value == "22" {
            continue;
        }
        lines.push(format!("    {} {value}", spelled(&key)));
    }
    lines.push("Match all".into());
    lines.join("\n") + "\n"
}

/// How the config spells `key`.
fn spelled(key: &str) -> &str {
    match key {
        "hostname" => "HostName",
        "user" => "User",
        "port" => "Port",
        "proxyjump" => "ProxyJump",
        "proxycommand" => "ProxyCommand",
        "identityfile" => "IdentityFile",
        "identitiesonly" => "IdentitiesOnly",
        "certificatefile" => "CertificateFile",
        "hostkeyalias" => "HostKeyAlias",
        other => other,
    }
}

/// Whether `config` already has an entry named `alias`.
pub fn has_entry(config: &str, alias: &str) -> bool {
    config.lines().any(|l| {
        let mut words = l.split_whitespace();
        words.next().is_some_and(|w| w.eq_ignore_ascii_case("host")) && words.any(|w| w == alias)
    })
}

/// The file Desk writes: the person's config, or what it links to (a
/// dotfiles manager's link stays a link).
pub fn config_file(home: &Path) -> PathBuf {
    let config = home.join(".ssh").join("config");
    std::fs::canonicalize(&config).unwrap_or(config)
}

/// `file` as the person names it: `~/…` under their home.
pub fn shown(file: &Path, home: &Path) -> String {
    let home = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    file.strip_prefix(&home).map_or_else(
        |_| file.display().to_string(),
        |rest| {
            let parts: Vec<String> = rest
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect();
            format!("~/{}", parts.join("/"))
        },
    )
}

/// The config with `block` first: written beside it, then moved over it,
/// keeping its permissions (0600 for a new one, in a 0700 `~/.ssh`).
pub fn write(home: &Path, block: &str) -> Result<(), String> {
    let dir = home.join(".ssh");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| couldnt(&e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| couldnt(&e))?;
        }
    }
    let file = config_file(home);
    let before = match std::fs::read_to_string(&file) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(couldnt(&e)),
    };
    let text = if before.is_empty() {
        block.to_string()
    } else {
        format!("{block}\n{before}")
    };
    let parent = file.parent().unwrap_or(&dir);
    let tmp = parent.join(format!(".config.desk-{}", std::process::id()));
    std::fs::write(&tmp, text).map_err(|e| couldnt(&e))?;
    let mode = std::fs::metadata(&file).map(|m| m.permissions());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = mode.unwrap_or_else(|_| std::fs::Permissions::from_mode(0o600));
        std::fs::set_permissions(&tmp, perms).map_err(|e| couldnt(&e))?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    std::fs::rename(&tmp, &file).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        couldnt(&e)
    })
}

fn couldnt(e: &std::io::Error) -> String {
    tracing::warn!(error = %e, "couldn't write the SSH config");
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        "Desk isn't allowed to change your SSH config (it may be managed for you), so nothing changed.".into()
    } else {
        "Desk couldn't change your SSH config, so nothing changed.".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAID: &str = "host devbox\nuser ec2-user\nhostname 10.0.1.20\nport 2222\nproxyjump bastion\nidentityfile ~/.ssh/prod\nidentitiesonly yes\nlocalforward [127.0.0.1]:5432 [10.0.1.30]:5432\nforwardagent no\nhostkeyalias none\n";

    #[test]
    fn desks_entry_is_the_machine_without_its_forwards() {
        let b = block("desk-devbox", "devbox", SAID);
        assert_eq!(
            b,
            "# Added by Desk: devbox as Desk reaches it, without its port forwards.\n\
             Host desk-devbox\n    User ec2-user\n    HostName 10.0.1.20\n    Port 2222\n    ProxyJump bastion\n    IdentityFile ~/.ssh/prod\n    IdentitiesOnly yes\n\
             Match all\n"
        );
        assert!(!b.to_lowercase().contains("localforward"));
    }

    #[test]
    fn its_name_is_desks_and_plain() {
        assert_eq!(alias_for("devbox"), "desk-devbox");
        assert_eq!(alias_for("Build Box 2"), "desk-build-box-2");
        assert_eq!(alias_for(" ;rm "), "desk-rm");
        assert_eq!(alias_for(""), "desk-machine");
        assert!(has_entry("Host a desk-devbox\n", "desk-devbox"));
        assert!(!has_entry("Host desk-devbox2\n", "desk-devbox"));
    }

    #[test]
    fn it_goes_first_and_leaves_the_rest_as_it_was() {
        let home = tempfile::tempdir().unwrap();
        // None yet: a private folder and file.
        write(home.path(), "Host desk-a\n    HostName a\nMatch all\n").unwrap();
        let config = home.path().join(".ssh/config");
        assert_eq!(
            std::fs::read_to_string(&config).unwrap(),
            "Host desk-a\n    HostName a\nMatch all\n"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&home.path().join(".ssh")), 0o700);
            assert_eq!(mode(&config), 0o600);
        }
        write(home.path(), "Host desk-b\nMatch all\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(&config).unwrap(),
            "Host desk-b\nMatch all\n\nHost desk-a\n    HostName a\nMatch all\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_config_stays_a_link() {
        let home = tempfile::tempdir().unwrap();
        let dots = home.path().join("dotfiles");
        std::fs::create_dir_all(&dots).unwrap();
        std::fs::write(dots.join("ssh_config"), "Host x\n").unwrap();
        std::fs::create_dir_all(home.path().join(".ssh")).unwrap();
        std::os::unix::fs::symlink(dots.join("ssh_config"), home.path().join(".ssh/config"))
            .unwrap();
        write(home.path(), "Host desk-x\nMatch all\n").unwrap();
        let link = home.path().join(".ssh/config");
        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            std::fs::read_to_string(dots.join("ssh_config")).unwrap(),
            "Host desk-x\nMatch all\n\nHost x\n"
        );
    }

    /// With the real ssh: Desk's entry reaches the machine without its
    /// forwards, and everything after it (an Include, options for every
    /// host, other entries) applies as it did.
    #[cfg(unix)]
    #[test]
    fn ssh_reads_desks_entry_and_the_rest_as_before() {
        let Ok(out) = std::process::Command::new("ssh").arg("-V").output() else {
            return;
        };
        let _ = out;
        let home = tempfile::tempdir().unwrap();
        let ssh_dir = home.path().join(".ssh");
        std::fs::create_dir_all(&ssh_dir).unwrap();
        let extra = ssh_dir.join("extra.conf");
        std::fs::write(&extra, "Host otherhost\n    User other\n").unwrap();
        let config = ssh_dir.join("config");
        let before = format!(
            "Include {}\nServerAliveInterval 17\nHost devbox\n    HostName 10.0.1.20\n    User ec2-user\n    Port 2222\n    LocalForward 5432 10.0.1.30:5432\nHost *\n    Compression yes\n",
            extra.display()
        );
        std::fs::write(&config, &before).unwrap();
        let g = |host: &str| {
            let out = std::process::Command::new("ssh")
                .arg("-F")
                .arg(&config)
                .args(["-G", host])
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        let said = g("devbox");
        assert!(said.contains("localforward"), "{said}");
        write(home.path(), &block("desk-devbox", "devbox", &said)).unwrap();
        let desk = g("desk-devbox");
        assert!(!desk.contains("localforward"), "{desk}");
        for line in [
            "hostname 10.0.1.20",
            "user ec2-user",
            "port 2222",
            "serveraliveinterval 17",
            "compression yes",
        ] {
            assert!(desk.lines().any(|l| l == line), "{line} in {desk}");
        }
        let other = g("otherhost");
        for line in ["user other", "serveraliveinterval 17", "compression yes"] {
            assert!(other.lines().any(|l| l == line), "{line} in {other}");
        }
        assert!(g("devbox").contains("localforward"), "theirs stays");
    }
}
