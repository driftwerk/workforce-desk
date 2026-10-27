//! Who speaks: an agent's voice, from any provider Desk can speak with, and
//! the voices the on-device and live engines offer.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Provider {
    /// On this Mac.
    Kokoro,
    #[serde(rename = "fish_audio")]
    FishAudio,
    Elevenlabs,
    Openai,
    /// The live engines speak in their own voices.
    GptLive,
    GeminiLive,
}

impl Provider {
    /// Spoken by the hub's speech endpoint.
    pub fn is_cloud_speech(self) -> bool {
        matches!(
            self,
            Provider::FishAudio | Provider::Elevenlabs | Provider::Openai
        )
    }

    pub fn is_live(self) -> bool {
        matches!(self, Provider::GptLive | Provider::GeminiLive)
    }
}

/// A voice: `{provider, model?, voice?}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VoiceSpec {
    pub provider: Provider,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
}

impl VoiceSpec {
    pub fn kokoro(voice: &str) -> Self {
        Self {
            provider: Provider::Kokoro,
            model: None,
            voice: Some(voice.into()),
        }
    }
}

/// A roster entry: the name to wake on, and the agent's voice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Member {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<VoiceSpec>,
}

/// One voice to choose from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VoiceInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
}

const fn v(id: &'static str, name: &'static str, description: &'static str) -> VoiceInfo {
    VoiceInfo {
        id,
        name,
        description,
    }
}

/// Kokoro v1.0's English speakers, by speaker id in its `voices.bin`
/// (the sherpa-onnx `kokoro-multi-lang-v1_0` table). Its other languages
/// need lexicons Desk doesn't download.
pub const KOKORO_VOICES: [(i32, VoiceInfo); 28] = [
    (0, v("af_alloy", "Alloy", "American, female")),
    (1, v("af_aoede", "Aoede", "American, female")),
    (2, v("af_bella", "Bella", "American, female, warm")),
    (3, v("af_heart", "Heart", "American, female, Kokoro's best")),
    (4, v("af_jessica", "Jessica", "American, female")),
    (5, v("af_kore", "Kore", "American, female")),
    (6, v("af_nicole", "Nicole", "American, female, soft")),
    (7, v("af_nova", "Nova", "American, female")),
    (8, v("af_river", "River", "American, female")),
    (9, v("af_sarah", "Sarah", "American, female")),
    (10, v("af_sky", "Sky", "American, female")),
    (11, v("am_adam", "Adam", "American, male")),
    (12, v("am_echo", "Echo", "American, male")),
    (13, v("am_eric", "Eric", "American, male")),
    (14, v("am_fenrir", "Fenrir", "American, male")),
    (15, v("am_liam", "Liam", "American, male")),
    (16, v("am_michael", "Michael", "American, male")),
    (17, v("am_onyx", "Onyx", "American, male, deep")),
    (18, v("am_puck", "Puck", "American, male")),
    (19, v("am_santa", "Santa", "American, male")),
    (20, v("bf_alice", "Alice", "British, female")),
    (21, v("bf_emma", "Emma", "British, female")),
    (22, v("bf_isabella", "Isabella", "British, female")),
    (23, v("bf_lily", "Lily", "British, female")),
    (24, v("bm_daniel", "Daniel", "British, male")),
    (25, v("bm_fable", "Fable", "British, male")),
    (26, v("bm_george", "George", "British, male")),
    (27, v("bm_lewis", "Lewis", "British, male")),
];

/// The voice the cascade speaks in when none is asked for.
pub const KOKORO_DEFAULT: &str = "af_bella";

/// The speaker id for a Kokoro voice id, or the default's for an unknown one.
pub fn kokoro_speaker(voice: Option<&str>) -> i32 {
    let find = |id: &str| {
        KOKORO_VOICES
            .iter()
            .find(|(_, v)| v.id == id)
            .map(|(sid, _)| *sid)
    };
    voice
        .and_then(find)
        .or_else(|| find(KOKORO_DEFAULT))
        .unwrap_or_default()
}

pub fn kokoro_voices() -> Vec<VoiceInfo> {
    KOKORO_VOICES.iter().map(|(_, v)| v.clone()).collect()
}

/// GPT-Live's built-in voices (`session.audio.output.voice`). OpenAI
/// recommends Marin (the default) and Cedar; the rest are listed with the
/// accent the Live docs give them.
pub const GPT_LIVE_VOICES: [VoiceInfo; 31] = [
    v("marin", "Marin", "Natural, expressive; the default"),
    v("cedar", "Cedar", "Natural, warm"),
    v("alloy", "Alloy", "Neutral, balanced"),
    v("ash", "Ash", "Clear, direct"),
    v("ballad", "Ballad", "Soft, melodic"),
    v("coral", "Coral", "Warm, friendly"),
    v("echo", "Echo", "Calm"),
    v("sage", "Sage", "Soft, thoughtful"),
    v("shimmer", "Shimmer", "Light, upbeat"),
    v("verse", "Verse", "Expressive"),
    v("gleam", "Gleam", "North American, feminine"),
    v("meridian", "Meridian", "North American, masculine"),
    v("vesper", "Vesper", "British, masculine"),
    v("willow", "Willow", "Irish, feminine"),
    v("stone", "Stone", "Irish, masculine"),
    v("quartz", "Quartz", "Australian, feminine"),
    v("ripple", "Ripple", "Australian, masculine"),
    v("delta", "Delta", "Southern U.S., feminine"),
    v("cinder", "Cinder", "Southern U.S., masculine"),
    v("beacon", "Beacon", "Filipino English, masculine"),
    v("bossa", "Bossa", "Brazilian Portuguese, feminine"),
    v("tempo", "Tempo", "Brazilian Portuguese, masculine"),
    v("nuri", "Nuri", "German, feminine"),
    v("juni", "Juni", "German, feminine"),
    v("flitz", "Flitz", "German, masculine"),
    v("brise", "Brise", "French, feminine"),
    v("sillage", "Sillage", "French, masculine"),
    v("nira", "Nira", "Hindi, feminine"),
    v("harema", "Harema", "Japanese, feminine"),
    v("shida", "Shida", "Japanese, masculine"),
    v("noeul", "Noeul", "Korean, feminine"),
];

/// Gemini's 30 prebuilt voices (`speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`),
/// with Google's one-word character for each.
pub const GEMINI_LIVE_VOICES: [VoiceInfo; 30] = [
    v("Kore", "Kore", "Firm"),
    v("Puck", "Puck", "Upbeat"),
    v("Zephyr", "Zephyr", "Bright"),
    v("Charon", "Charon", "Informative"),
    v("Fenrir", "Fenrir", "Excitable"),
    v("Leda", "Leda", "Youthful"),
    v("Orus", "Orus", "Firm"),
    v("Aoede", "Aoede", "Breezy"),
    v("Callirrhoe", "Callirrhoe", "Easy-going"),
    v("Autonoe", "Autonoe", "Bright"),
    v("Enceladus", "Enceladus", "Breathy"),
    v("Iapetus", "Iapetus", "Clear"),
    v("Umbriel", "Umbriel", "Easy-going"),
    v("Algieba", "Algieba", "Smooth"),
    v("Despina", "Despina", "Smooth"),
    v("Erinome", "Erinome", "Clear"),
    v("Algenib", "Algenib", "Gravelly"),
    v("Rasalgethi", "Rasalgethi", "Informative"),
    v("Laomedeia", "Laomedeia", "Upbeat"),
    v("Achernar", "Achernar", "Soft"),
    v("Alnilam", "Alnilam", "Firm"),
    v("Schedar", "Schedar", "Even"),
    v("Gacrux", "Gacrux", "Mature"),
    v("Pulcherrima", "Pulcherrima", "Forward"),
    v("Achird", "Achird", "Friendly"),
    v("Zubenelgenubi", "Zubenelgenubi", "Casual"),
    v("Vindemiatrix", "Vindemiatrix", "Gentle"),
    v("Sadachbia", "Sadachbia", "Lively"),
    v("Sadaltager", "Sadaltager", "Knowledgeable"),
    v("Sulafat", "Sulafat", "Warm"),
];

/// The voices `provider`'s engine offers; empty for providers whose voices
/// come from elsewhere (the hub's speech providers).
pub fn engine_voices(provider: Provider) -> Vec<VoiceInfo> {
    match provider {
        Provider::Kokoro => kokoro_voices(),
        Provider::GptLive => GPT_LIVE_VOICES.to_vec(),
        Provider::GeminiLive => GEMINI_LIVE_VOICES.to_vec(),
        Provider::FishAudio | Provider::Elevenlabs | Provider::Openai => Vec::new(),
    }
}

/// The live voice `member` has for a session of `engine`, if they set one.
pub fn live_voice(member: &Member, engine: Provider) -> Option<&str> {
    member
        .voice
        .as_ref()
        .filter(|v| v.provider == engine)
        .and_then(|v| v.voice.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn voice_specs_read_and_write_as_the_app_spells_them() {
        let spec: VoiceSpec = serde_json::from_value(
            json!({"provider": "fish_audio", "voice": "802e3bc2b27e49c2995d23ef70e6ac89"}),
        )
        .unwrap();
        assert_eq!(spec.provider, Provider::FishAudio);
        assert_eq!(spec.model, None);
        assert_eq!(
            serde_json::to_value(&spec).unwrap(),
            json!({"provider": "fish_audio", "voice": "802e3bc2b27e49c2995d23ef70e6ac89"})
        );
        for (name, p) in [
            ("kokoro", Provider::Kokoro),
            ("elevenlabs", Provider::Elevenlabs),
            ("openai", Provider::Openai),
            ("gpt-live", Provider::GptLive),
            ("gemini-live", Provider::GeminiLive),
        ] {
            assert_eq!(serde_json::from_value::<Provider>(json!(name)).unwrap(), p);
            assert_eq!(serde_json::to_value(p).unwrap(), json!(name));
        }
        let full: VoiceSpec = serde_json::from_value(
            json!({"provider": "elevenlabs", "model": "eleven_flash_v2_5", "voice": "x"}),
        )
        .unwrap();
        assert_eq!(full.model.as_deref(), Some("eleven_flash_v2_5"));
        assert!(serde_json::from_value::<VoiceSpec>(json!({"provider": "piper"})).is_err());
    }

    #[test]
    fn kokoro_voices_map_to_speaker_ids() {
        assert_eq!(kokoro_speaker(Some("af_heart")), 3);
        assert_eq!(kokoro_speaker(Some("am_adam")), 11);
        assert_eq!(kokoro_speaker(Some("bm_lewis")), 27);
        assert_eq!(kokoro_speaker(None), 2);
        assert_eq!(
            kokoro_speaker(Some("zf_xiaobei")),
            2,
            "unlisted voices fall back to the default"
        );
        let ids: Vec<i32> = KOKORO_VOICES.iter().map(|(sid, _)| *sid).collect();
        assert_eq!(ids, (0..28).collect::<Vec<_>>());
        assert!(kokoro_voices().iter().all(|v| v.id.starts_with(['a', 'b'])));
    }

    #[test]
    fn live_engines_offer_their_own_voices() {
        assert_eq!(engine_voices(Provider::GptLive)[0].id, "marin");
        assert!(
            engine_voices(Provider::GeminiLive)
                .iter()
                .any(|v| v.id == "Kore")
        );
        assert!(engine_voices(Provider::FishAudio).is_empty());
        let unique = |vs: Vec<VoiceInfo>| {
            vs.iter()
                .map(|v| v.id)
                .collect::<std::collections::HashSet<_>>()
                .len()
        };
        assert_eq!(unique(engine_voices(Provider::GptLive)), 31);
        assert_eq!(unique(engine_voices(Provider::GeminiLive)), 30);
    }

    #[test]
    fn a_member_keeps_their_live_voice_for_that_engine_only() {
        let member: Member = serde_json::from_value(
            json!({"name": "Atlas", "voice": {"provider": "gpt-live", "voice": "cedar"}}),
        )
        .unwrap();
        assert_eq!(live_voice(&member, Provider::GptLive), Some("cedar"));
        assert_eq!(live_voice(&member, Provider::GeminiLive), None);
        let plain: Member = serde_json::from_value(json!({"name": "Allan"})).unwrap();
        assert_eq!(live_voice(&plain, Provider::GptLive), None);
    }
}
