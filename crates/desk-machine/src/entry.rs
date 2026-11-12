//! Desk's own SSH entries, for machines whose entry in the person's SSH
//! config forwards ports: the same machine, with every setting the
//! person's config gives it (its address, account, jump host, keys, agent,
//! known hosts, algorithms…) except its forwards, under a name of Desk's.
//! Desk keeps its connection open all the time, so it never carries the
//! person's forwards ([`crate::ssh::no_forwards`]).
//!
//! They live in a file of Desk's own, never in `~/.ssh/config`, which Desk
//! doesn't change. Desk's own ssh reads it with `-F` for these machines
//! only ([`crate::ssh::SshExe::with_desk_config`]); the file ends by
//! including the person's config and the system's, so everything else
//! applies as it does for the person.

use std::path::Path;

/// What every one of Desk's entry names starts with.
pub const ALIAS_PREFIX: &str = "desk-m-";

/// What the file ends with, after `Match all`: the person's config
/// (`user_config`), then the system's, as ssh reads them without `-F`.
fn tail(user_config: &Path) -> String {
    format!(
        "Match all\nInclude \"{}\"\nInclude /etc/ssh/ssh_config\n",
        user_config.display()
    )
}

const HEAD: &str = "# Desk's own SSH entries (Settings → Machines): machines whose entry in\n# ~/.ssh/config forwards ports, as Desk reaches them, without the forwards.\n# Desk writes this file; nothing else reads it.\n";

/// The settings never copied: the forwards themselves, the name, and what
/// Desk sets on its own command line.
const NOT_COPIED: &[&str] = &[
    "host",
    "localforward",
    "remoteforward",
    "dynamicforward",
    "clearallforwardings",
    "controlmaster",
    "controlpath",
    "controlpersist",
];

/// Whether `target` is one of Desk's entries.
pub fn is_desks(target: &str) -> bool {
    target.starts_with(ALIAS_PREFIX)
}

/// A new name for an entry of Desk's for the machine called `name`: its
/// letters, digits, dots and dashes, and `nonce`, so no two are the same.
pub fn alias_for(name: &str, nonce: &str) -> String {
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
    let plain = if plain.is_empty() { "machine" } else { plain };
    format!("{ALIAS_PREFIX}{plain}-{nonce}")
}

/// `ssh -G`'s words as (setting, values), each setting's values in order.
fn settings(said: &str) -> Vec<(String, Vec<String>)> {
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    for line in said.lines() {
        let Some((key, value)) = line.trim().split_once(' ') else {
            continue;
        };
        let key = key.to_ascii_lowercase();
        let value = value.trim().to_string();
        match out.iter_mut().find(|(k, _)| *k == key) {
            Some((_, values)) => values.push(value),
            None => out.push((key, vec![value])),
        }
    }
    out
}

/// Settings that take exactly one word, as `ssh -G` prints them: unquoted,
/// so a path with a space in it (`~/Library/Group Containers/…/agent.sock`,
/// a 1Password agent) reads back as two words and ssh refuses the file.
const ONE_WORD: &[&str] = &[
    "hostname",
    "user",
    "hostkeyalias",
    "bindaddress",
    "bindinterface",
    "identityfile",
    "identityagent",
    "certificatefile",
    "pkcs11provider",
    "securitykeyprovider",
    "xauthlocation",
    "revokedhostkeys",
];

/// `key value` as one config line: a one-word setting whose value has
/// white space is quoted, as ssh reads a quoted word back.
fn line(key: &str, value: &str) -> String {
    if ONE_WORD.contains(&key) && value.contains(char::is_whitespace) {
        let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
        format!("{key} \"{escaped}\"")
    } else {
        format!("{key} {value}")
    }
}

/// The lines of Desk's entry: every setting where what the person's config
/// makes of the machine (`said`, `ssh -G <target>`) differs from what it
/// makes of a name it has no entry for (`fresh`), but the forwards.
pub fn lines(said: &str, fresh: &str) -> Vec<String> {
    let fresh = settings(fresh);
    settings(said)
        .into_iter()
        .filter(|(key, values)| {
            !NOT_COPIED.contains(&key.as_str())
                && fresh.iter().find(|(k, _)| k == key).map(|(_, v)| v) != Some(values)
        })
        .flat_map(|(key, values)| values.into_iter().map(move |v| line(&key, &v)))
        .collect()
}

/// Desk's entry `alias` for the person's `target`.
pub fn block(alias: &str, target: &str, lines: &[String]) -> String {
    let mut out = format!("# desk-entry {alias} for {target}\nHost {alias}\n");
    for l in lines {
        out.push_str("    ");
        out.push_str(l);
        out.push('\n');
    }
    out
}

/// An entry in Desk's file: its name, the person's target it stands for,
/// and its text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub alias: String,
    pub target: String,
    pub text: String,
}

/// The entries in Desk's file `text`.
pub fn entries(text: &str) -> Vec<Entry> {
    let mut out: Vec<Entry> = Vec::new();
    for line in text.lines() {
        if let Some((alias, target)) = line
            .strip_prefix("# desk-entry ")
            .and_then(|rest| rest.split_once(" for "))
        {
            out.push(Entry {
                alias: alias.trim().to_string(),
                target: target.trim().to_string(),
                text: format!("{line}\n"),
            });
            continue;
        }
        if line.starts_with("Match all") {
            break;
        }
        // The blank line between entries is the file's, not theirs.
        if line.trim().is_empty() {
            continue;
        }
        if let Some(e) = out.last_mut() {
            e.text.push_str(line);
            e.text.push('\n');
        }
    }
    out
}

/// Desk's file with `entries`, then the person's (`user_config`) and the
/// system's.
pub fn file_text(entries: &[Entry], user_config: &Path) -> String {
    let mut out = HEAD.to_string();
    for e in entries {
        out.push('\n');
        out.push_str(&e.text);
    }
    out.push('\n');
    out.push_str(&tail(user_config));
    out
}

/// Reads Desk's file at `file`; none there is no entries.
pub fn read(file: &Path) -> Vec<Entry> {
    std::fs::read_to_string(file)
        .map(|t| entries(&t))
        .unwrap_or_default()
}

/// Writes Desk's file at `file` with `entries` (its folder private, the
/// file 0600), beside it first then moved over it.
pub fn write(file: &Path, entries: &[Entry], user_config: &Path) -> Result<(), String> {
    let dir = file.parent().ok_or("Desk's SSH entries have no folder.")?;
    std::fs::create_dir_all(dir).map_err(|e| couldnt(&e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| couldnt(&e))?;
    }
    let tmp = dir.join(format!(".config.{}", std::process::id()));
    std::fs::write(&tmp, file_text(entries, user_config)).map_err(|e| couldnt(&e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| couldnt(&e))?;
    }
    std::fs::rename(&tmp, file).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        couldnt(&e)
    })
}

/// One change to Desk's file at a time: each reads the file again under it,
/// so two at once (a machine added as another is forgotten) never write
/// over one another's.
static CHANGING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Keeps `new` in Desk's file at `file`, as it is now (not as it was when
/// `new` was made), taking `replaces` out of it.
pub fn add(
    file: &Path,
    new: Entry,
    replaces: Option<&str>,
    user_config: &Path,
) -> Result<(), String> {
    let _one = CHANGING.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = read(file);
    all.retain(|e| e.alias != new.alias && Some(e.alias.as_str()) != replaces);
    all.push(new);
    write(file, &all, user_config)
}

/// Takes entry `alias` out of Desk's file at `file`, when it is there.
pub fn remove(file: &Path, alias: &str, user_config: &Path) -> Result<(), String> {
    let _one = CHANGING.lock().unwrap_or_else(|e| e.into_inner());
    let all = read(file);
    if !all.iter().any(|e| e.alias == alias) {
        return Ok(());
    }
    let kept: Vec<Entry> = all.into_iter().filter(|e| e.alias != alias).collect();
    write(file, &kept, user_config)
}

fn couldnt(e: &std::io::Error) -> String {
    tracing::warn!(error = %e, "couldn't write Desk's SSH entries");
    "Desk couldn't keep its SSH entry in its own folder, so nothing changed.".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAID: &str = "host devbox\nuser ec2-user\nhostname 10.0.1.20\nport 2222\nproxyjump bastion\nidentityfile ~/.ssh/prod\nidentityfile ~/.ssh/id_ed25519\nidentityagent ~/.1password/agent.sock\nlocalforward [127.0.0.1]:5432 [10.0.1.30]:5432\nforwardagent no\ncompression yes\n";
    const FRESH: &str = "host desk-m-probe\nuser kings\nhostname desk-m-probe\nport 22\nidentityfile ~/.ssh/id_ed25519\nforwardagent no\ncompression yes\n";

    #[test]
    fn desks_entry_has_everything_the_config_gives_the_machine_but_its_forwards() {
        let l = lines(SAID, FRESH);
        assert_eq!(
            l,
            [
                "user ec2-user",
                "hostname 10.0.1.20",
                "port 2222",
                "proxyjump bastion",
                "identityfile ~/.ssh/prod",
                "identityfile ~/.ssh/id_ed25519",
                "identityagent ~/.1password/agent.sock",
            ]
        );
        let b = block("desk-m-devbox-a1b2c3", "devbox", &l);
        assert!(b.starts_with("# desk-entry desk-m-devbox-a1b2c3 for devbox\nHost desk-m-devbox-a1b2c3\n    user ec2-user\n"));
        assert!(!b.contains("localforward"));
    }

    #[test]
    fn a_one_word_setting_with_a_space_in_it_is_quoted_and_the_rest_left_as_is() {
        let said = "host devbox\nidentityagent /Users/k/Library/Group Containers/x/agent.sock\nidentityfile C:\\Users\\J Smith\\.ssh\\id\nproxycommand ssh -W %h:%p \"jump host\"\nsetenv A=b\n";
        assert_eq!(
            lines(said, "host x\n"),
            [
                "identityagent \"/Users/k/Library/Group Containers/x/agent.sock\"",
                "identityfile \"C:\\\\Users\\\\J Smith\\\\.ssh\\\\id\"",
                "proxycommand ssh -W %h:%p \"jump host\"",
                "setenv A=b",
            ]
        );
    }

    #[test]
    fn its_name_is_desks_plain_and_never_the_same_twice() {
        assert_eq!(alias_for("devbox", "a1b2c3"), "desk-m-devbox-a1b2c3");
        assert_eq!(alias_for("Build Box 2", "x"), "desk-m-build-box-2-x");
        assert_eq!(alias_for(" ;rm ", "x"), "desk-m-rm-x");
        assert!(is_desks("desk-m-devbox-a1b2c3"));
        assert!(!is_desks("devbox"));
    }

    #[test]
    fn the_file_is_desks_entries_then_the_persons_config_and_the_systems() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("machines/ssh/config");
        let a = Entry {
            alias: "desk-m-a-1".into(),
            target: "a".into(),
            text: block("desk-m-a-1", "a", &["hostname 10.0.0.1".into()]),
        };
        let b = Entry {
            alias: "desk-m-b-2".into(),
            target: "dev@b".into(),
            text: block("desk-m-b-2", "dev@b", &["hostname 10.0.0.2".into()]),
        };
        let mine = Path::new("/home/k/.ssh/config");
        write(&file, &[a.clone(), b.clone()], mine).unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.ends_with(
            "Match all\nInclude \"/home/k/.ssh/config\"\nInclude /etc/ssh/ssh_config\n"
        ));
        assert_eq!(read(&file), [a.clone(), b.clone()]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(file.parent().unwrap()), 0o700);
            assert_eq!(mode(&file), 0o600);
        }
        remove(&file, "desk-m-a-1", mine).unwrap();
        assert_eq!(read(&file), [b]);
        remove(&file, "desk-m-gone", mine).unwrap();
    }

    /// With the real ssh: through Desk's file, the entry reaches the machine
    /// without its forwards, and a host of the person's own reads as it
    /// does without Desk (their Include, options for every host).
    #[cfg(unix)]
    #[test]
    fn ssh_reads_desks_entry_and_the_persons_config_as_before() {
        if std::process::Command::new("ssh")
            .arg("-V")
            .output()
            .is_err()
        {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let ssh_dir = home.path().join(".ssh");
        std::fs::create_dir_all(&ssh_dir).unwrap();
        std::fs::write(
            ssh_dir.join("extra.conf"),
            "Host otherhost\n    User other\n",
        )
        .unwrap();
        let config = ssh_dir.join("config");
        std::fs::write(
            &config,
            format!(
                "Include {}\nServerAliveInterval 17\nHost devbox\n    HostName 10.0.1.20\n    User ec2-user\n    Port 2222\n    IdentityAgent \"~/Library/Group Containers/x/agent.sock\"\n    LocalForward 5432 10.0.1.30:5432\nHost *\n    Compression yes\n",
                ssh_dir.join("extra.conf").display()
            ),
        )
        .unwrap();
        // ssh -G with the person's config (as ssh reads it with no -F), or
        // with Desk's file.
        let g = |desk: Option<&Path>, host: &str| {
            let out = std::process::Command::new("ssh")
                .arg("-F")
                .arg(desk.unwrap_or(&config))
                .args(["-G", host])
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        let said = g(None, "devbox");
        assert!(said.contains("localforward"), "{said}");
        let alias = alias_for("devbox", "t1");
        let file = home.path().join("desk/ssh/config");
        let text = block(&alias, "devbox", &lines(&said, &g(None, &alias)));
        write(
            &file,
            &[Entry {
                alias: alias.clone(),
                target: "devbox".into(),
                text,
            }],
            &config,
        )
        .unwrap();
        let desk = g(Some(&file), &alias);
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
        // A path with a space in it (a 1Password agent) is read back whole.
        let agent = said
            .lines()
            .find(|l| l.starts_with("identityagent "))
            .unwrap();
        assert!(agent.contains("Group Containers"), "{said}");
        assert!(desk.lines().any(|l| l == agent), "{agent} in {desk}");
        let other = g(Some(&file), "otherhost");
        for line in ["user other", "serveraliveinterval 17", "compression yes"] {
            assert!(other.lines().any(|l| l == line), "{line} in {other}");
        }
        assert!(
            std::fs::read_to_string(ssh_dir.join("config"))
                .unwrap()
                .contains("LocalForward"),
            "the person's config is as it was"
        );
    }
}
