//! "Did you mean devbox?": when an address doesn't resolve, whether the
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

/// One `Host` block: its patterns, and whether it says where to go.
struct Block {
    patterns: Vec<String>,
    routes: bool,
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
                });
                open = true;
            }
            "match" => open = false,
            "hostname" | "proxyjump" | "proxycommand" if open => {
                if let Some(b) = blocks.last_mut() {
                    b.routes |= !rest.is_empty() && rest != "none";
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
