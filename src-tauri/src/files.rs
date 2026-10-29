//! Desk's own files: `settings.json` and the themes folder (watched, so a
//! theme saved in any editor applies at once).

use std::path::Path;

use desk_core::Paths;
use eyre::Result;
use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// A voice from any provider Desk speaks with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VoiceSpec {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
}

/// How new agents think: a provider, and optionally one of its models and
/// efforts (its defaults when unset).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BrainChoice {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

fn default_voice() -> VoiceSpec {
    VoiceSpec {
        provider: "fish_audio".into(),
        model: None,
        voice: Some("802e3bc2b27e49c2995d23ef70e6ac89".into()),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Agents can be asked from Tuple calls.
    #[serde(default)]
    pub tuple: bool,
    /// How new agents on this Mac think; unset means whichever plan is
    /// connected.
    #[serde(default)]
    pub new_agent: Option<BrainChoice>,
    /// Older Desks' plan (`claude` or `chatgpt`), read once into
    /// `new_agent` and never written again.
    #[serde(default, skip_serializing)]
    pub plan: Option<String>,
    /// The voice agents speak with unless they have their own.
    #[serde(default = "default_voice")]
    pub default_voice: VoiceSpec,
    /// Agents' own voices, by agent key (`hub/agent`).
    #[serde(default)]
    pub agent_voices: std::collections::BTreeMap<String, VoiceSpec>,
    /// Wake-by-name and push-to-talk.
    #[serde(default)]
    pub voice: bool,
    /// Which voice engine: "cascade" (on-device), "gpt-live" or
    /// "gemini-live". Kept as text so a newer Desk's choice survives.
    #[serde(default = "default_voice_engine")]
    pub voice_engine: String,
    /// The keyboard shortcuts chosen in place of their defaults, by id
    /// (`ask`, `newSession`), as the global-shortcut plugin reads them
    /// (`Control+Shift+Space`). Kept as text so a newer Desk's survive; the
    /// UI checks them and falls back to the defaults, which it owns.
    #[serde(default)]
    pub shortcuts: std::collections::BTreeMap<String, String>,
    /// Older Desks' hold-to-talk and Ask anyone keys, read once into
    /// `shortcuts` and never written again.
    #[serde(default, skip_serializing)]
    pub push_to_talk_shortcut: Option<String>,
    #[serde(default, skip_serializing)]
    pub ask_shortcut: Option<String>,
}

fn default_theme() -> String {
    "system".into()
}

fn default_voice_engine() -> String {
    "cascade".into()
}

/// Hold to talk's default, then and now.
const PUSH_TO_TALK_DEFAULT: &str = "Control+Shift+Space";
/// Ask anyone's old default, which launchers like Raycast and Alfred take.
const OLD_ASK_DEFAULT: &str = "Alt+Space";
/// Ask anyone's default now (the UI's `DEFAULT_SHORTCUTS.ask`).
const ASK_DEFAULT: &str = "Control+Shift+K";

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            tuple: false,
            new_agent: None,
            plan: None,
            default_voice: default_voice(),
            agent_voices: Default::default(),
            voice: false,
            voice_engine: default_voice_engine(),
            shortcuts: Default::default(),
            push_to_talk_shortcut: None,
            ask_shortcut: None,
        }
    }
}

pub fn load_settings(paths: &Paths) -> Result<Settings> {
    match std::fs::read_to_string(paths.settings()) {
        Ok(s) => Ok(migrated(serde_json::from_str(&s)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(e.into()),
    }
}

/// An older Desk's plan as the provider new agents start on, with that
/// provider's default model and effort.
fn migrated(mut settings: Settings) -> Settings {
    if let Some(plan) = settings.plan.take()
        && settings.new_agent.is_none()
    {
        let provider = match plan.as_str() {
            "claude" => Some("claude-code"),
            "chatgpt" => Some("chatgpt"),
            _ => None,
        };
        settings.new_agent = provider.map(|provider| BrainChoice {
            provider: provider.into(),
            model: None,
            effort: None,
        });
    }
    // An older Desk saved both shortcuts whether or not they were chosen, so
    // the old defaults mean untouched: hold to talk stays as it was, and Ask
    // anyone moves to the new default — unless hold to talk already has
    // those keys.
    if let Some(keys) = settings.push_to_talk_shortcut.take()
        && keys != PUSH_TO_TALK_DEFAULT
    {
        settings
            .shortcuts
            .entry("pushToTalk".into())
            .or_insert(keys);
    }
    if let Some(keys) = settings.ask_shortcut.take() {
        let hold = settings
            .shortcuts
            .get("pushToTalk")
            .map_or(PUSH_TO_TALK_DEFAULT, String::as_str);
        if keys != OLD_ASK_DEFAULT || hold == ASK_DEFAULT {
            settings.shortcuts.entry("ask".into()).or_insert(keys);
        }
    }
    settings
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
    fn chosen_shortcuts_round_trip_and_none_means_the_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        std::fs::write(paths.settings(), r#"{"theme":"system","voice":true}"#).unwrap();
        assert!(load_settings(&paths).unwrap().shortcuts.is_empty());
        let chosen = Settings {
            shortcuts: [
                ("ask".into(), "Alt+Space".into()),
                ("newSession".into(), "Super+J".into()),
            ]
            .into(),
            ..Settings::default()
        };
        save_settings(&paths, &chosen).unwrap();
        let written = std::fs::read_to_string(paths.settings()).unwrap();
        assert!(written.contains(r#""ask": "Alt+Space""#));
        assert!(!written.contains("askShortcut"));
        assert_eq!(load_settings(&paths).unwrap(), chosen);
    }

    #[test]
    fn an_older_desks_shortcuts_move_ask_anyone_off_the_launchers_keys() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        let load = |json: &str| {
            std::fs::write(paths.settings(), json).unwrap();
            load_settings(&paths).unwrap().shortcuts
        };
        let untouched =
            load(r#"{"pushToTalkShortcut":"Control+Shift+Space","askShortcut":"Alt+Space"}"#);
        assert!(untouched.is_empty());
        let chosen =
            load(r#"{"pushToTalkShortcut":"Control+Alt+J","askShortcut":"Control+Alt+A"}"#);
        assert_eq!(
            chosen.get("pushToTalk").map(String::as_str),
            Some("Control+Alt+J")
        );
        assert_eq!(chosen.get("ask").map(String::as_str), Some("Control+Alt+A"));
        // Hold to talk already has the new default, so Ask anyone keeps its keys.
        let taken = load(r#"{"pushToTalkShortcut":"Control+Shift+K","askShortcut":"Alt+Space"}"#);
        assert_eq!(taken.get("ask").map(String::as_str), Some("Alt+Space"));
        // Once this Desk has saved, ⌥Space is a choice and stays.
        let saved = load(r#"{"shortcuts":{"ask":"Alt+Space"}}"#);
        assert_eq!(saved.get("ask").map(String::as_str), Some("Alt+Space"));
    }

    #[test]
    fn an_older_plan_becomes_where_new_agents_start() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        std::fs::write(paths.settings(), r#"{"theme":"system","plan":"chatgpt"}"#).unwrap();
        let loaded = load_settings(&paths).unwrap();
        assert_eq!(
            loaded.new_agent,
            Some(BrainChoice {
                provider: "chatgpt".into(),
                model: None,
                effort: None
            })
        );
        save_settings(&paths, &loaded).unwrap();
        let written = std::fs::read_to_string(paths.settings()).unwrap();
        assert!(!written.contains(r#""plan""#));
        assert!(written.contains(r#""newAgent""#));
        assert_eq!(load_settings(&paths).unwrap(), loaded);

        std::fs::write(paths.settings(), r#"{"plan":"claude"}"#).unwrap();
        assert_eq!(
            load_settings(&paths).unwrap().new_agent.unwrap().provider,
            "claude-code"
        );
    }

    #[test]
    fn a_chosen_brain_wins_over_an_older_plan_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        std::fs::write(
            paths.settings(),
            r#"{"plan":"claude","newAgent":{"provider":"anthropic","model":"claude-opus-5-5","effort":"high"}}"#,
        )
        .unwrap();
        let loaded = load_settings(&paths).unwrap();
        let brain = loaded.new_agent.clone().unwrap();
        assert_eq!(brain.provider, "anthropic");
        assert_eq!(brain.effort.as_deref(), Some("high"));
        assert_eq!(loaded.plan, None);
        std::fs::write(paths.settings(), r#"{"plan":"something-else"}"#).unwrap();
        assert_eq!(load_settings(&paths).unwrap().new_agent, None);
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
