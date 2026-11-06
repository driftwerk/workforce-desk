//! The person's SSH config, read as text: its `Host` entries, to pick a
//! machine from (Add, and changing how Desk reaches one), and "Did you mean
//! devbox?": when an address doesn't resolve, whether the
//! person's SSH config has a `Host` entry that is the same word in other
//! letters. OpenSSH matches `Host` case-sensitively but DNS doesn't care,
//! so `Devbox` falls through to DNS while `devbox` is the alias.
//!
//! This only reads the config's text (`Host`, `HostName`, `ProxyJump`,
//! `ProxyCommand`, `Include`); it runs nothing, not even `ssh -G`, which
//! can run a config's `Match exec`. Desk asks its native question again for
//! the suggested address before it runs anything there.

use std::fs;
use std::path::Path;

/// How deep `Include` is followed.
const DEPTH: usize = 3;

/// One `Host` block: its patterns, whether it says where to go, and the
/// options it sets that say where and as whom.
struct Block {
    patterns: Vec<String>,
    routes: bool,
    /// `hostname`, `user`, `port`, `proxyjump`, `proxycommand`, as written
    /// (the first of each in the block).
    options: Vec<(String, String)>,
    /// The file it is in, for "from ~/.ssh/config".
    file: std::path::PathBuf,
}

/// One `Host` entry the person can pick: an alias with no wildcard, and
/// what the config's text says of it (every block that matches it, in
/// order, the first value of each option winning, as ssh reads it; `Match`
/// blocks aren't read).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostEntry {
    pub host: String,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<String>,
    /// How it is reached, when not directly: `ProxyJump`'s hosts, or that a
    /// `ProxyCommand` runs.
    pub jump: Option<String>,
    /// The file its `Host` line is in, with `~` for home.
    pub file: String,
}

/// The most entries listed.
const MAX_HOSTS: usize = 200;

/// The `Host` entries in `home/.ssh/config` and the files it includes, in
/// the order ssh reads them: each alias once, none with a wildcard or a
/// negation. Nothing is run.
pub fn hosts(home: &Path) -> Vec<HostEntry> {
    let mut blocks = Vec::new();
    let dir = home.join(".ssh");
    read(&dir.join("config"), &dir, home, 0, &mut blocks);
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for b in &blocks {
        for alias in &b.patterns {
            if alias.contains(['*', '?', '!']) || alias.is_empty() || !seen.insert(alias.clone()) {
                continue;
            }
            let get = |key: &str| {
                blocks
                    .iter()
                    .filter(|o| matches(&o.patterns, alias))
                    .find_map(|o| {
                        o.options
                            .iter()
                            .find(|(k, _)| k == key)
                            .map(|(_, v)| v.clone())
                    })
                    .filter(|v| !v.is_empty() && v != "none")
            };
            let jump = get("proxyjump")
                .or_else(|| get("proxycommand").map(|_| "a ProxyCommand".to_string()));
            // With `/` on every computer, as the person reads a path in ssh's config.
            let slashed = |p: &Path| {
                p.components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/")
            };
            let file = b.file.strip_prefix(home).map_or_else(
                |_| b.file.display().to_string(),
                |rest| format!("~/{}", slashed(rest)),
            );
            out.push(HostEntry {
                host: alias.clone(),
                hostname: get("hostname"),
                user: get("user"),
                port: get("port"),
                jump,
                file,
            });
            if out.len() >= MAX_HOSTS {
                return out;
            }
        }
    }
    out
}

/// Whether a block's patterns take `host`, as ssh's `Host` does: any
/// pattern matches, and no negated one does.
fn matches(patterns: &[String], host: &str) -> bool {
    let mut any = false;
    for p in patterns {
        match p.strip_prefix('!') {
            Some(neg) if glob(neg, host) => return false,
            Some(_) => {}
            None => any |= glob(p, host),
        }
    }
    any
}

/// The address to suggest in place of `target`, from the config at
/// `home/.ssh/config`: None unless one `Host` entry is `target`'s host in
/// other letters, goes somewhere of its own, and no entry matches
/// `target`'s host as typed.
pub fn did_you_mean(home: &Path, target: &str) -> Option<String> {
    let mut blocks = Vec::new();
    let dir = home.join(".ssh");
    read(&dir.join("config"), &dir, home, 0, &mut blocks);
    suggest(&blocks, target)
}

fn suggest(blocks: &[Block], target: &str) -> Option<String> {
    let (user, host) = match target.rsplit_once('@') {
        Some((u, h)) => (Some(u), h),
        None => (None, target),
    };
    if host.is_empty() || host.contains(['*', '?', '!', ':', '/', ' ']) {
        return None;
    }
    let as_typed = |p: &str| {
        let (neg, p) = p.strip_prefix('!').map_or((false, p), |p| (true, p));
        !neg && glob(p, host)
    };
    if blocks
        .iter()
        .any(|b| b.patterns.iter().any(|p| as_typed(p)))
    {
        return None;
    }
    let mut found = blocks
        .iter()
        .filter(|b| b.routes)
        .flat_map(|b| &b.patterns)
        .filter(|p| *p != host && p.eq_ignore_ascii_case(host) && !p.contains(['*', '?', '!']));
    let one = found.next()?;
    if found.any(|p| p != one) {
        return None;
    }
    Some(match user {
        Some(u) => format!("{u}@{one}"),
        None => one.clone(),
    })
}

fn read(file: &Path, dir: &Path, home: &Path, depth: usize, blocks: &mut Vec<Block>) {
    let Ok(text) = fs::read_to_string(file) else {
        return;
    };
    // A file's lines before its first `Host` are outside any block.
    let mut open = false;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, rest) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, r)) => (
                k,
                r.trim_start_matches(|c: char| c.is_whitespace() || c == '='),
            ),
            None => (line, ""),
        };
        match key.to_ascii_lowercase().as_str() {
            "host" => {
                blocks.push(Block {
                    patterns: rest
                        .split_whitespace()
                        .map(|p| p.trim_matches('"').to_string())
                        .collect(),
                    routes: false,
                    options: Vec::new(),
                    file: file.to_path_buf(),
                });
                open = true;
            }
            "match" => open = false,
            k @ ("hostname" | "proxyjump" | "proxycommand" | "user" | "port") if open => {
                if let Some(b) = blocks.last_mut() {
                    if k != "user" && k != "port" {
                        b.routes |= !rest.is_empty() && rest != "none";
                    }
                    if !b.options.iter().any(|(o, _)| o == k) {
                        b.options
                            .push((k.to_string(), rest.trim_matches('"').to_string()));
                    }
                }
            }
            "include" if depth < DEPTH => {
                for word in rest.split_whitespace() {
                    for f in expand(word.trim_matches('"'), dir, home) {
                        read(&f, dir, home, depth + 1, blocks);
                    }
                }
            }
            _ => {}
        }
    }
}

/// The files an `Include` word names: `~` and relative paths (to `~/.ssh`),
/// with `*` and `?` in the last part.
fn expand(word: &str, dir: &Path, home: &Path) -> Vec<std::path::PathBuf> {
    let path = match word.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None if word.starts_with('/') => word.into(),
        None => dir.join(word),
    };
    let (Some(parent), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str()))
    else {
        return Vec::new();
    };
    if !name.contains(['*', '?']) {
        return vec![path];
    }
    let mut files: Vec<_> = fs::read_dir(parent)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_str().is_some_and(|n| glob(name, n)))
        .map(|e| e.path())
        .collect();
    files.sort();
    files
}

/// ssh's pattern match: `*` and `?`, case-sensitive.
fn glob(pattern: &str, text: &str) -> bool {
    fn go(p: &[char], t: &[char]) -> bool {
        match p.split_first() {
            None => t.is_empty(),
            Some(('*', rest)) => (0..=t.len()).any(|i| go(rest, &t[i..])),
            Some(('?', rest)) => !t.is_empty() && go(rest, &t[1..]),
            Some((c, rest)) => t.first() == Some(c) && go(rest, &t[1..]),
        }
    }
    go(
        &pattern.chars().collect::<Vec<_>>(),
        &text.chars().collect::<Vec<_>>(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(config: &str) -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join(".ssh")).unwrap();
        fs::write(home.path().join(".ssh/config"), config).unwrap();
        home
    }

    #[test]
    fn host_entries_are_listed_as_ssh_reads_them_without_wildcards() {
        let h = home(
            "Host devbox\n  HostName 2.29.244.189\n  User dev\n\
             Host devbox-new\n  HostName 2.29.244.190\n\
             Host buildbox\n  HostName 10.0.3.14\n  User ubuntu\n  ProxyJump bastion\n\
             Host hel hel-1\n  HostName hel-1.example.net\n  User james\n  Port 2222\n\
             Host *.internal !secret.internal\n  User x\n\
             Match host devbox\n  User wrong\n\
             Host *\n  User dev\n  ProxyCommand none\n",
        );
        let found = hosts(h.path());
        let names: Vec<&str> = found.iter().map(|e| e.host.as_str()).collect();
        assert_eq!(names, ["devbox", "devbox-new", "buildbox", "hel", "hel-1"]);
        assert_eq!(found[0].hostname.as_deref(), Some("2.29.244.189"));
        assert_eq!(found[0].user.as_deref(), Some("dev"));
        assert_eq!(found[0].jump, None);
        assert_eq!(found[0].file, "~/.ssh/config");
        // From `Host *`: the first value wins, and it comes last.
        assert_eq!(found[1].user.as_deref(), Some("dev"));
        assert_eq!(found[2].jump.as_deref(), Some("bastion"));
        assert_eq!(found[2].user.as_deref(), Some("ubuntu"));
        assert_eq!(
            (found[3].port.as_deref(), found[4].port.as_deref()),
            (Some("2222"), Some("2222"))
        );
        assert!(hosts(Path::new("/nonexistent")).is_empty());
    }

    #[test]
    fn included_files_say_where_an_entry_is() {
        let h = home("Include conf.d/*\nHost devbox\n  HostName 1.2.3.4\n");
        fs::create_dir_all(h.path().join(".ssh/conf.d")).unwrap();
        fs::write(
            h.path().join(".ssh/conf.d/work"),
            "Host atlas\n  HostName 10.1.1.1\n  ProxyCommand nc %h %p\n",
        )
        .unwrap();
        let found = hosts(h.path());
        assert_eq!(found[0].host, "atlas");
        assert_eq!(found[0].file, "~/.ssh/conf.d/work");
        assert_eq!(found[0].jump.as_deref(), Some("a ProxyCommand"));
        assert_eq!(found[1].host, "devbox");
    }

    #[test]
    fn a_host_in_other_letters_is_suggested() {
        let h = home("Host devbox\n  HostName 10.0.0.5\n  User dev\n");
        assert_eq!(did_you_mean(h.path(), "Devbox").as_deref(), Some("devbox"));
        assert_eq!(
            did_you_mean(h.path(), "dev@DEVBOX").as_deref(),
            Some("dev@devbox")
        );
        // Already the alias: nothing to suggest.
        assert_eq!(did_you_mean(h.path(), "devbox"), None);
        assert_eq!(did_you_mean(h.path(), "other"), None);
    }

    #[test]
    fn only_an_entry_that_goes_somewhere_else_counts() {
        // Without a HostName, DNS would have found the same machine.
        let h = home("Host devbox\n  User dev\n");
        assert_eq!(did_you_mean(h.path(), "Devbox"), None);
        let jump = home("Host devbox\n  ProxyJump bastion\n");
        assert_eq!(
            did_you_mean(jump.path(), "Devbox").as_deref(),
            Some("devbox")
        );
    }

    #[test]
    fn an_entry_matching_as_typed_means_the_trouble_is_elsewhere() {
        let h = home("Host Dev*\n  User x\nHost devbox\n  HostName 10.0.0.5\n");
        assert_eq!(did_you_mean(h.path(), "Devbox"), None);
        // Wildcard entries are never suggested.
        let w = home("Host dev*\n  HostName 10.0.0.5\n");
        assert_eq!(did_you_mean(w.path(), "Devbox"), None);
    }

    #[test]
    fn two_different_spellings_are_not_guessed_between() {
        let h = home("Host devbox\n  HostName a\nHost DEVBOX\n  HostName b\n");
        assert_eq!(did_you_mean(h.path(), "Devbox"), None);
    }

    #[test]
    fn includes_are_followed_and_options_are_not_addresses() {
        let h = home("Include conf.d/*\n");
        fs::create_dir_all(h.path().join(".ssh/conf.d")).unwrap();
        fs::write(
            h.path().join(".ssh/conf.d/a"),
            "Host devbox\n  HostName 1.2.3.4\n",
        )
        .unwrap();
        assert_eq!(did_you_mean(h.path(), "Devbox").as_deref(), Some("devbox"));
        assert_eq!(did_you_mean(h.path(), "-Devbox"), None);
        assert_eq!(did_you_mean(h.path(), "host:22"), None);
        assert_eq!(did_you_mean(Path::new("/nonexistent"), "Devbox"), None);
    }
}
