//! What Act fully's setup suggests from the folders Desk's sessions run in:
//! each folder's repository (its `origin` remote, else its top folder) and
//! the GitHub workflows it tracks. Read only, with `git`, on the backend's
//! host (WSL on Windows).

use std::process::Stdio;
use std::time::{Duration, Instant};

use desk_core::host::Host;
use serde::Serialize;

/// The most folders one ask reads.
const MOST: usize = 40;

/// One folder's repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoFacts {
    /// The folder as asked.
    pub folder: String,
    /// The repository's top folder: one for every worktree of it.
    pub top: String,
    /// Its `origin` remote's address, when it has one.
    pub remote: Option<String>,
    /// The workflow files `.github/workflows` tracks, by file name.
    pub workflows: Vec<String>,
}

/// The repositories of `folders`, each read once; a folder that isn't in
/// one (or that `git` can't read) is left out.
pub fn repo_facts(host: &Host, folders: &[String]) -> Vec<RepoFacts> {
    let git = |dir: &str, args: &[&str]| -> Option<String> {
        // No fsmonitor daemon or hook a repository's config names: this
        // only reads.
        let mut all = vec!["-c", "core.fsmonitor=false", "-C", dir];
        all.extend_from_slice(args);
        run_within(host.invocation("git", &all).command(), PER_CALL)
    };
    let mut seen = Vec::new();
    let mut out = Vec::new();
    for folder in folders.iter().take(MOST) {
        // The main checkout, whichever worktree the session runs in.
        let Some(common) = git(
            folder,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        ) else {
            continue;
        };
        let top = common.strip_suffix("/.git").unwrap_or(&common).to_string();
        if seen.contains(&top) {
            continue;
        }
        seen.push(top.clone());
        let remote = git(folder, &["remote", "get-url", "origin"])
            .map(|r| without_credentials(&r))
            .filter(|r| !r.is_empty());
        let workflows = git(
            folder,
            &["ls-files", "--full-name", "--", ":/.github/workflows"],
        )
        .map(|listed| workflow_names(&listed))
        .unwrap_or_default();
        out.push(RepoFacts {
            folder: folder.clone(),
            top,
            remote,
            workflows,
        });
    }
    out
}

/// The longest one `git` call may take before it is stopped and the
/// folder left out.
const PER_CALL: Duration = Duration::from_secs(5);

/// What `command` printed, when it succeeded within `limit`; stopped and
/// `None` past it.
fn run_within(mut command: std::process::Command, limit: Duration) -> Option<String> {
    use std::io::Read;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    // Read as it runs, so a full pipe never holds it.
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < limit => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let out = reader.join().ok()?;
    status
        .success()
        .then(|| String::from_utf8_lossy(&out).trim().to_string())
}

/// `remote` without any user name, password or token in it
/// (`https://user:token@host/…` → `https://host/…`): an address can carry
/// one, and nothing of it may leave this computer's repository config.
pub fn without_credentials(remote: &str) -> String {
    let t = remote.trim();
    if let Some((scheme, rest)) = t.split_once("://") {
        let (authority, path) = rest.split_once('/').map_or((rest, ""), |(a, p)| (a, p));
        let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
        return if path.is_empty() {
            format!("{scheme}://{host}")
        } else {
            format!("{scheme}://{host}/{path}")
        };
    }
    // scp-like `[user@]host:path`: `git@`, the user every host names, is
    // kept (it is how the address is written); any other is dropped, as a
    // token can sit there too.
    match t.split_once('@') {
        Some((user, rest)) if !user.contains('/') && rest.contains(':') => {
            let (host, path) = rest.split_once(':').unwrap_or((rest, ""));
            match user {
                "git" => format!("git@{host}:{path}"),
                _ => format!("{host}:{path}"),
            }
        }
        _ => t.to_string(),
    }
}

/// The workflow file names in `git ls-files` output: `.yml` and `.yaml`
/// directly in `.github/workflows`.
fn workflow_names(listed: &str) -> Vec<String> {
    let mut names: Vec<String> = listed
        .lines()
        .filter_map(|l| l.trim().strip_prefix(".github/workflows/"))
        .filter(|n| !n.contains('/') && (n.ends_with(".yml") || n.ends_with(".yaml")))
        .map(str::to_string)
        .collect();
    names.sort();
    names.dedup();
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workflows_are_the_yaml_files_directly_in_the_folder() {
        let listed = ".github/workflows/deploy.yml\n.github/workflows/ci.yaml\n\
                      .github/workflows/scripts/x.yml\n.github/workflows/README.md\n";
        assert_eq!(workflow_names(listed), ["ci.yaml", "deploy.yml"]);
        assert!(workflow_names("").is_empty());
    }

    #[test]
    fn credentials_never_leave_a_remote() {
        let cases = [
            (
                "https://oauth2:glpat-SECRET@gitlab.example.com/acme/web.git",
                "https://gitlab.example.com/acme/web.git",
            ),
            (
                "https://x-access-token:ghs_SECRET@github.com/acme/web",
                "https://github.com/acme/web",
            ),
            (
                "https://ghp_SECRET@github.com/acme/web/extra",
                "https://github.com/acme/web/extra",
            ),
            (
                "ssh://git:SECRET@github.com:22/acme/web.git",
                "ssh://github.com:22/acme/web.git",
            ),
            ("git@github.com:acme/web.git", "git@github.com:acme/web.git"),
            (
                "tok:SECRET@github.com:acme/web.git",
                "github.com:acme/web.git",
            ),
            ("/srv/git/web.git", "/srv/git/web.git"),
        ];
        for (remote, kept) in cases {
            let out = without_credentials(remote);
            assert_eq!(out, kept, "{remote}");
            assert!(!out.contains("SECRET"), "{out}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_call_past_its_time_is_stopped() {
        let mut slow = std::process::Command::new("sleep");
        slow.arg("5");
        let started = Instant::now();
        assert_eq!(run_within(slow, Duration::from_millis(200)), None);
        assert!(started.elapsed() < Duration::from_secs(2));
        let mut quick = std::process::Command::new("echo");
        quick.arg("hi");
        assert_eq!(run_within(quick, PER_CALL).as_deref(), Some("hi"));
    }

    #[cfg(unix)]
    #[test]
    fn a_repo_is_read_once_with_its_remote_and_workflows_and_other_folders_left_out() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("acme-web");
        let run = |args: &[&str]| {
            assert!(
                std::process::Command::new("git")
                    .args(args)
                    .current_dir(&repo)
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
        };
        std::fs::create_dir_all(repo.join(".github/workflows")).unwrap();
        std::fs::write(repo.join(".github/workflows/deploy.yml"), "on: push\n").unwrap();
        run(&["init", "-q"]);
        run(&[
            "remote",
            "add",
            "origin",
            "git@github.com:acme/acme-web.git",
        ]);
        run(&["add", "."]);
        let sub = repo.join(".github").to_string_lossy().into_owned();
        let outside = dir.path().to_string_lossy().into_owned();
        let facts = repo_facts(
            &Host::Native,
            &[repo.to_string_lossy().into_owned(), sub, outside],
        );
        assert_eq!(facts.len(), 1, "{facts:?}");
        assert_eq!(
            facts[0].remote.as_deref(),
            Some("git@github.com:acme/acme-web.git")
        );
        assert_eq!(facts[0].workflows, ["deploy.yml"]);
        assert!(facts[0].top.ends_with("acme-web"), "{}", facts[0].top);
    }
}
