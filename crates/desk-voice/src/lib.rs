//! Desk's voice: hear an agent's name (or a held hotkey), then either
//! transcribe and answer on-device (the cascade) or open a cloud realtime
//! session that hands requests to the named agent. Audio only: routing what
//! was said to an agent is the app's job.

pub mod address;
pub mod cascade;
pub mod conversation;
pub mod decode;
pub mod hub;
pub mod keywords;
pub mod lookup;
#[cfg(target_os = "macos")]
pub mod mac;
pub mod models;
pub mod realtime;
pub mod resample;
pub mod speech;
pub mod voices;

use std::sync::Arc;

use serde::{Deserialize, Serialize};

pub use cascade::Cascade;
pub use decode::Audio;
pub use models::Models;
pub use realtime::Realtime;
pub use voices::{Member, VoiceSpec};

/// The ways of listening and speaking Desk can run. Settings name them as
/// strings, so an engine a later Desk adds reads here as the default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EngineKind {
    /// OpenAI GPT-Live, through the hub's relay.
    GptLive,
    /// Gemini Live, with an ephemeral token from the hub.
    GeminiLive,
    /// On-device: wake word, Parakeet, Kokoro.
    #[default]
    #[serde(other)]
    Cascade,
}

impl EngineKind {
    pub fn parse(name: &str) -> Self {
        serde_json::from_value(serde_json::Value::String(name.to_string())).unwrap_or_default()
    }

    /// The models it runs on this Mac.
    pub fn models(self) -> &'static [&'static models::Model] {
        match self {
            EngineKind::Cascade => &models::ALL,
            EngineKind::GptLive | EngineKind::GeminiLive => &[&models::VAD, &models::KWS],
        }
    }
}

/// What the voice pill shows.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum VoiceState {
    Off,
    Downloading {
        model: String,
        progress: f32,
    },
    Listening {
        conversation: Option<String>,
    },
    HeardName {
        agent: String,
    },
    Transcribing,
    Speaking,
    /// A cloud session is open; `agent` is the name that opened it.
    Live {
        agent: Option<String>,
    },
}

/// Something said to an agent. `agent` is the roster name it was addressed
/// to, exactly as given to `set_names`; `None` continues the conversation
/// (or, for push-to-talk, leaves the choice to the app).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Utterance {
    pub agent: Option<String>,
    pub text: String,
    /// Set when a realtime model asked for this: the answer goes back with
    /// `tool_result` under this id rather than being spoken.
    #[serde(rename = "callId", skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
}

impl Utterance {
    pub fn new(agent: Option<String>, text: &str) -> Self {
        Self {
            agent,
            text: text.to_string(),
            call_id: None,
        }
    }
}

/// Where an engine reports what it hears and does.
pub trait VoiceEvents: Send + Sync + 'static {
    fn state(&self, state: &VoiceState);
    fn utterance(&self, utterance: &Utterance);
    /// Something went wrong that the person should hear about.
    fn error(&self, message: &str);
}

/// A way of listening and speaking. Dropping it stops it.
pub trait VoiceEngine: Send + Sync {
    /// Who to wake on (the roster names, as plain text) and their voices.
    fn set_roster(&self, roster: Vec<Member>);
    fn push_to_talk(&self, pressed: bool);
    /// Say `text` in `voice` (the engine's default when `None`). `more` when
    /// this is an acknowledgement and the answer is still coming, so the
    /// conversation stays open for it.
    fn speak(&self, text: String, more: bool, voice: Option<VoiceSpec>);
    /// Play speech that is already synthesised, as if spoken.
    fn play(&self, audio: Audio);
    fn stop_speaking(&self);
    /// The answer to an utterance that carried a `call_id`.
    fn tool_result(&self, call_id: String, text: String);
    fn state(&self) -> VoiceState;
}

/// Mono samples at a sample rate, from the microphone.
pub type AudioIn = Box<dyn Fn(&[f32], u32) + Send + Sync>;

/// Where speech is played. Playback must go through the same audio unit
/// that captures, so echo cancellation hears it.
pub trait AudioOut: Send + Sync {
    /// Queue mono `samples` after whatever is already playing; `done` runs
    /// once they have played or playback is stopped.
    fn play(&self, samples: &[f32], rate: u32, done: Box<dyn FnOnce() + Send>);
    /// Stop now, dropping everything queued.
    fn stop(&self);
}

pub type SharedAudioOut = Arc<dyn AudioOut>;
