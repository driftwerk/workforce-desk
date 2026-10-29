//! What Desk's grid terminals need from this Mac: where Desk's Claude Code
//! plugin is (its hooks, which register a `claude` started in one of them
//! with the hub), and what is running in one (Codex is recognised this way,
//! by its process, not tracked).

use std::collections::BTreeMap;
use std::path::PathBuf;

use tauri::Manager;

/// Desk's Claude Code plugin folder, shipped in the app's resources.
pub fn plugin_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?.join("claude-plugin");
    dir.join("hooks")
        .join("hooks.json")
        .is_file()
        .then_some(dir)
}

/// One process as `ps` lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Process {
    pub pid: u32,
    pub ppid: u32,
    /// The executable's name, without its folder (or a login shell's `-`).
    pub name: String,
}

/// `ps -axo pid=,ppid=,comm=`: two numbers, then the command, which can
/// contain spaces.
pub fn parse_ps(text: &str) -> Vec<Process> {
    text.lines()
        .filter_map(|line| {
            let (pid, rest) = line.trim_start().split_once(char::is_whitespace)?;
            let (ppid, comm) = rest.trim_start().split_once(char::is_whitespace)?;
            let (pid, ppid, comm) = (pid.parse().ok()?, ppid.parse().ok()?, comm.trim());
            let name = comm.rsplit('/').next().unwrap_or(comm);
            let name = name.strip_prefix('-').unwrap_or(name).to_string();
            (!name.is_empty()).then_some(Process { pid, ppid, name })
        })
        .collect()
}

/// The process `pid` and everything it started, outermost first (each
/// generation in pid order).
pub fn under(all: &[Process], pid: u32) -> Vec<String> {
    let mut children: BTreeMap<u32, Vec<&Process>> = BTreeMap::new();
    for p in all {
        children.entry(p.ppid).or_default().push(p);
    }
    let Some(root) = all.iter().find(|p| p.pid == pid) else {
        return Vec::new();
    };
    let mut out = vec![root.name.clone()];
    let mut generation = vec![root.pid];
    while !generation.is_empty() {
        let mut next: Vec<&Process> = generation
            .iter()
            .flat_map(|pid| children.get(pid).into_iter().flatten().copied())
            .collect();
        next.sort_by_key(|p| p.pid);
        out.extend(next.iter().map(|p| p.name.clone()));
        generation = next.iter().map(|p| p.pid).collect();
    }
    out
}

/// What's running in a terminal whose shell is `pid`, shell first.
pub fn programs_under(pid: u32) -> eyre::Result<Vec<String>> {
    let out = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,comm="])
        .output()?;
    if !out.status.success() {
        eyre::bail!("ps failed: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(under(&parse_ps(&String::from_utf8_lossy(&out.stdout)), pid))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PS: &str = "    1     0 /sbin/launchd
  400     1 /Applications/Desk.app/Contents/MacOS/Desk Helper
  501   400 -zsh
  620   501 /Users/someone/.local/bin/claude
  640   620 /bin/sh
  521   400 /bin/zsh
  700   521 node
  701   700 /usr/local/lib/node_modules/@openai/codex/bin/codex
  junk line
";

    #[test]
    fn reads_ps_with_spaces_and_login_shells() {
        let all = parse_ps(PS);
        assert_eq!(all.len(), 8);
        assert_eq!(all[1].name, "Desk Helper");
        assert_eq!(all[2].name, "zsh");
        assert_eq!(
            all[3],
            Process {
                pid: 620,
                ppid: 501,
                name: "claude".into()
            }
        );
    }

    #[test]
    fn lists_a_shell_and_what_it_started() {
        let all = parse_ps(PS);
        assert_eq!(under(&all, 501), ["zsh", "claude", "sh"]);
        assert_eq!(under(&all, 521), ["zsh", "node", "codex"]);
        assert!(under(&all, 9999).is_empty());
    }

    #[test]
    fn this_process_is_found() {
        let names = programs_under(std::process::id()).unwrap();
        assert!(!names.is_empty());
    }
}
