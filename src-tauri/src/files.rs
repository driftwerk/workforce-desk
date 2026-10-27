//! Desk's own files: `settings.json` and the themes folder (watched, so a
//! theme saved in any editor applies at once).

use std::path::Path;

use desk_core::Paths;
use eyre::Result;
use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Agents can be asked from Tuple calls.
    #[serde(default)]
    pub tuple: bool,
    /// The plan agents on this Mac run on: `claude` or `chatgpt`; unset
    /// means whichever is connected.
    #[serde(default)]
    pub plan: Option<String>,
    /// Wake-by-name and push-to-talk.
    #[serde(default)]
    pub voice: bool,
    /// Which voice engine: "cascade" (on-device), "gpt-live" or
    /// "gemini-live". Kept as text so a newer Desk's choice survives.
    #[serde(default = "default_voice_engine")]
    pub voice_engine: String,
}

fn default_theme() -> String {
    "system".into()
}

fn default_voice_engine() -> String {
    "cascade".into()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            tuple: false,
            plan: None,
            voice: false,
            voice_engine: default_voice_engine(),
        }
    }
}

pub fn load_settings(paths: &Paths) -> Result<Settings> {
    match std::fs::read_to_string(paths.settings()) {
        Ok(s) => Ok(serde_json::from_str(&s)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(e.into()),
    }
}

pub fn save_settings(paths: &Paths, settings: &Settings) -> Result<()> {
    desk_core::write_private(&paths.settings(), &serde_json::to_string_pretty(settings)?)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ThemeFile {
    pub id: String,
    pub source: String,
}

pub fn valid_theme_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub fn list_themes(dir: &Path) -> Result<Vec<ThemeFile>> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(vec![]);
    };
    let mut themes: Vec<ThemeFile> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "toml"))
        .filter_map(|p| {
            let id = p.file_stem()?.to_str()?.to_string();
            valid_theme_id(&id).then_some(())?;
            Some(ThemeFile {
                id,
                source: std::fs::read_to_string(&p).ok()?,
            })
        })
        .collect();
    themes.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(themes)
}

pub fn write_theme(dir: &Path, id: &str, source: &str) -> Result<()> {
    if !valid_theme_id(id) {
        eyre::bail!("theme names are lowercase letters, digits and dashes");
    }
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(format!("{id}.toml")), source)?;
    Ok(())
}

/// Emits `themes-changed` whenever a file in the themes folder changes.
pub fn watch_themes(app: AppHandle, dir: &Path) -> Result<notify::RecommendedWatcher> {
    std::fs::create_dir_all(dir)?;
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if event.is_ok() {
            let _ = app.emit("themes-changed", ());
        }
    })?;
    watcher.watch(dir, RecursiveMode::NonRecursive)?;
    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_default_to_following_the_system_theme() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        assert_eq!(load_settings(&paths).unwrap().theme, "system");
        save_settings(
            &paths,
            &Settings {
                theme: "harbour".into(),
                tuple: true,
                ..Settings::default()
            },
        )
        .unwrap();
        assert!(load_settings(&paths).unwrap().tuple);
        assert_eq!(load_settings(&paths).unwrap().theme, "harbour");
    }

    #[test]
    fn the_voice_engine_round_trips_and_defaults_to_the_cascade() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        assert_eq!(load_settings(&paths).unwrap().voice_engine, "cascade");
        std::fs::write(paths.settings(), r#"{"theme":"system","voice":true}"#).unwrap();
        assert_eq!(load_settings(&paths).unwrap().voice_engine, "cascade");
        let chosen = Settings {
            voice_engine: "gemini-live".into(),
            ..Settings::default()
        };
        save_settings(&paths, &chosen).unwrap();
        assert!(
            std::fs::read_to_string(paths.settings())
                .unwrap()
                .contains(r#""voiceEngine": "gemini-live""#)
        );
        assert_eq!(load_settings(&paths).unwrap(), chosen);
    }

    #[test]
    fn only_well_named_toml_files_are_themes() {
        let dir = tempfile::tempdir().unwrap();
        write_theme(dir.path(), "harbour", "name = \"Harbour\"").unwrap();
        std::fs::write(dir.path().join("Bad Name.toml"), "x").unwrap();
        std::fs::write(dir.path().join("notes.txt"), "x").unwrap();
        let ids: Vec<_> = list_themes(dir.path())
            .unwrap()
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(ids, ["harbour"]);
        assert!(write_theme(dir.path(), "../escape", "x").is_err());
    }
}
