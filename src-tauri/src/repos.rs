//! What Act fully's setup suggests from the folders Desk's sessions run in:
//! each folder's repository (its `origin` remote, else its top folder) and
//! the GitHub workflows it tracks. Read only, with `git`, on the backend's
//! host (WSL on Windows).

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
        let mut all = vec!["-C", dir];
        all.extend_from_slice(args);
        let out = host.invocation("git", &all).command().output().ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
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
        let remote = git(folder, &["remote", "get-url", "origin"]).filter(|r| !r.is_empty());
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
