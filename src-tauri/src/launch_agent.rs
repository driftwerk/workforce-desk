//! Installs `desk-hubd` as a LaunchAgent so the local hub — and every
//! session it hosts — runs from login, independent of this window.

use std::path::{Path, PathBuf};
use std::process::Command;

use desk_core::{LAUNCH_AGENT_LABEL, Paths};
use eyre::{Context, Result};
use plist::{Dictionary, Value};

pub fn plist_path() -> Result<PathBuf> {
    Ok(dirs_home()?
        .join("Library/LaunchAgents")
        .join(format!("{LAUNCH_AGENT_LABEL}.plist")))
}

fn dirs_home() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| eyre::eyre!("HOME is not set"))
}

pub fn render(hubd: &Path, workforce: &Path, paths: &Paths) -> Value {
    let mut d = Dictionary::new();
    d.insert("Label".into(), LAUNCH_AGENT_LABEL.into());
    d.insert(
        "ProgramArguments".into(),
        Value::Array(vec![
            hubd.to_string_lossy().into_owned().into(),
            "--workforce".into(),
            workforce.to_string_lossy().into_owned().into(),
        ]),
    );
    d.insert("RunAtLoad".into(), true.into());
    d.insert("KeepAlive".into(), true.into());
    d.insert("ProcessType".into(), "Interactive".into());
    let log = paths
        .logs()
        .join("desk-hubd.log")
        .to_string_lossy()
        .into_owned();
    d.insert("StandardOutPath".into(), log.clone().into());
    d.insert("StandardErrorPath".into(), log.into());
    Value::Dictionary(d)
}

fn launchctl(args: &[&str]) -> Result<std::process::Output> {
    Command::new("launchctl")
        .args(args)
        .output()
        .context("running launchctl")
}

fn domain() -> Result<String> {
    let uid = Command::new("id").arg("-u").output()?;
    Ok(format!(
        "gui/{}",
        String::from_utf8_lossy(&uid.stdout).trim()
    ))
}

/// Writes the agent and (re)loads it when it is new or changed; leaves a
/// running, unchanged agent alone so sessions keep running.
pub fn ensure(hubd: &Path, workforce: &Path, paths: &Paths) -> Result<()> {
    std::fs::create_dir_all(paths.logs())?;
    let path = plist_path()?;
    let mut wanted = Vec::new();
    render(hubd, workforce, paths).to_writer_xml(&mut wanted)?;
    let current = std::fs::read(&path).ok();
    let domain = domain()?;
    let target = format!("{domain}/{LAUNCH_AGENT_LABEL}");
    let loaded = launchctl(&["print", &target])?.status.success();
    if current.as_deref() == Some(wanted.as_slice()) && loaded {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, &wanted)?;
    if loaded {
        launchctl(&["bootout", &target])?;
    }
    let out = launchctl(&["bootstrap", &domain, &path.to_string_lossy()])?;
    if !out.status.success() {
        eyre::bail!(
            "launchctl bootstrap failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_agent_keeps_the_supervisor_alive_and_points_it_at_workforce() {
        let v = render(
            Path::new("/Applications/Desk.app/Contents/MacOS/desk-hubd"),
            Path::new("/Applications/Desk.app/Contents/MacOS/workforce"),
            &Paths::at("/Users/k/Library/Application Support/Desk"),
        );
        let d = v.as_dictionary().unwrap();
        assert_eq!(d["Label"].as_string(), Some(LAUNCH_AGENT_LABEL));
        assert_eq!(d["KeepAlive"].as_boolean(), Some(true));
        let args: Vec<_> = d["ProgramArguments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_string().unwrap())
            .collect();
        assert_eq!(args[1], "--workforce");
        assert!(args[2].ends_with("/workforce"));
    }
}
