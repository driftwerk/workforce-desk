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
    /// Hold to talk, as the global-shortcut plugin reads it. Kept as text;
    /// the UI checks it and falls back to the default.
    #[serde(default = "default_push_to_talk_shortcut")]
    pub push_to_talk_shortcut: String,
    /// Opens "Ask anyone" from any app.
    #[serde(default = "default_ask_shortcut")]
    pub ask_shortcut: String,
}

fn default_theme() -> String {
    "system".into()
}

fn default_voice_engine() -> String {
    "cascade".into()
}

fn default_push_to_talk_shortcut() -> String {
    "Control+Shift+Space".into()
}

fn default_ask_shortcut() -> String {
    "Alt+Space".into()
}

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
            push_to_talk_shortcut: default_push_to_talk_shortcut(),
            ask_shortcut: default_ask_shortcut(),
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
    fn shortcuts_round_trip_and_default_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path());
        std::fs::write(paths.settings(), r#"{"theme":"system","voice":true}"#).unwrap();
        let loaded = load_settings(&paths).unwrap();
        assert_eq!(loaded.push_to_talk_shortcut, "Control+Shift+Space");
        assert_eq!(loaded.ask_shortcut, "Alt+Space");
        let chosen = Settings {
            push_to_talk_shortcut: "Control+Alt+K".into(),
            ask_shortcut: "Control+Alt+J".into(),
            ..Settings::default()
        };
        save_settings(&paths, &chosen).unwrap();
        let written = std::fs::read_to_string(paths.settings()).unwrap();
        assert!(written.contains(r#""pushToTalkShortcut": "Control+Alt+K""#));
        assert!(written.contains(r#""askShortcut": "Control+Alt+J""#));
        assert_eq!(load_settings(&paths).unwrap(), chosen);
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
