//! How the person wants their microphone and speaker used: which devices,
//! echo cancelling, how readily speech is heard, and push to talk. One set
//! for the whole app, read by every audio build and by the listener, so a
//! change reaches a running conversation without restarting it.

use std::sync::RwLock;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

/// A device the person chose, remembered by both its stable id and its name:
/// the id can change (a USB device in another port), the name rarely does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceChoice {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioPrefs {
    /// The microphone; `None` is whichever the system uses.
    pub input: Option<DeviceChoice>,
    /// The speaker; `None` is whichever the system uses.
    pub output: Option<DeviceChoice>,
    /// Remove Desk's own voice from what the microphone hears (macOS), or,
    /// where there's no echo canceller, quiet the microphone while Desk
    /// speaks. Off suits headphones: everything is heard, talking over Desk
    /// included.
    pub echo_cancel: bool,
    /// 0 hears only clear, close speech; 1 hears quiet, distant speech (and
    /// more noise). 0.5 is how Desk always listened.
    pub sensitivity: f32,
    /// The microphone hears only while push to talk is held.
    pub push_to_talk_only: bool,
}

impl Default for AudioPrefs {
    fn default() -> Self {
        Self {
            input: None,
            output: None,
            echo_cancel: true,
            sensitivity: DEFAULT_SENSITIVITY,
            push_to_talk_only: false,
        }
    }
}

pub const DEFAULT_SENSITIVITY: f32 = 0.5;

impl AudioPrefs {
    fn sensitivity(&self) -> f32 {
        if self.sensitivity.is_finite() {
            self.sensitivity.clamp(0.0, 1.0)
        } else {
            DEFAULT_SENSITIVITY
        }
    }

    /// The voice activity model's threshold: 0.5 at the default, down to
    /// 0.3 at the most sensitive, up to 0.7 at the least.
    pub fn vad_threshold(&self) -> f32 {
        0.5 + (DEFAULT_SENSITIVITY - self.sensitivity()) * 0.4
    }

    /// The quietest the microphone can be over playback and still be someone
    /// talking: 0.002 at the default, a quarter of it at the most sensitive,
    /// four times it at the least.
    pub fn barge_floor(&self) -> f32 {
        0.002 * 4f32.powf((DEFAULT_SENSITIVITY - self.sensitivity()) * 2.0)
    }

    /// Whether `other` needs the audio built again: a device or echo
    /// cancelling changed. Sensitivity and push to talk apply as they are.
    pub fn rebuilds(&self, other: &AudioPrefs) -> bool {
        self.input != other.input
            || self.output != other.output
            || self.echo_cancel != other.echo_cancel
    }
}

static PREFS: RwLock<Option<AudioPrefs>> = RwLock::new(None);
/// Bumped on every change, so a running build can tell it's out of date.
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// Push to talk is held.
static HELD: AtomicBool = AtomicBool::new(false);
// What the audio thread and the listener read as they go, without a lock.
static PUSH_TO_TALK_ONLY: AtomicBool = AtomicBool::new(false);
static VAD_THRESHOLD: AtomicU32 = AtomicU32::new(0x3f00_0000); // 0.5
static BARGE_FLOOR: AtomicU32 = AtomicU32::new(0x3b03_126f); // 0.002

/// The preferences in force.
pub fn get() -> AudioPrefs {
    PREFS
        .read()
        .ok()
        .and_then(|p| p.clone())
        .unwrap_or_default()
}

/// Puts `prefs` in force. Running audio follows: a new device or echo
/// cancelling rebuilds it, the rest applies at once.
pub fn set(prefs: AudioPrefs) {
    let mut slot = PREFS.write().unwrap_or_else(|e| e.into_inner());
    if slot.as_ref() != Some(&prefs) {
        PUSH_TO_TALK_ONLY.store(prefs.push_to_talk_only, Ordering::SeqCst);
        VAD_THRESHOLD.store(prefs.vad_threshold().to_bits(), Ordering::SeqCst);
        BARGE_FLOOR.store(prefs.barge_floor().to_bits(), Ordering::SeqCst);
        *slot = Some(prefs);
        GENERATION.fetch_add(1, Ordering::SeqCst);
    }
}

pub(crate) fn generation() -> u64 {
    GENERATION.load(Ordering::SeqCst)
}

/// Push to talk pressed or let go.
pub fn set_held(held: bool) {
    HELD.store(held, Ordering::SeqCst);
}

/// Whether the microphone is to be heard now: always, unless push to talk
/// only is on and the key isn't held.
pub(crate) fn hearing() -> bool {
    !PUSH_TO_TALK_ONLY.load(Ordering::SeqCst) || HELD.load(Ordering::SeqCst)
}

/// The voice activity threshold in force ([`AudioPrefs::vad_threshold`]).
pub(crate) fn vad_threshold() -> f32 {
    f32::from_bits(VAD_THRESHOLD.load(Ordering::SeqCst))
}

/// The barge-in floor in force ([`AudioPrefs::barge_floor`]).
pub(crate) fn barge_floor() -> f32 {
    f32::from_bits(BARGE_FLOOR.load(Ordering::SeqCst))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_sensitivity_listens_as_desk_always_did() {
        let p = AudioPrefs::default();
        assert!((p.vad_threshold() - 0.5).abs() < 1e-6);
        assert!((p.barge_floor() - 0.002).abs() < 1e-6);
        assert!(p.echo_cancel);
    }

    #[test]
    fn more_sensitivity_hears_quieter_speech() {
        let at = |s| AudioPrefs {
            sensitivity: s,
            ..Default::default()
        };
        assert!((at(1.0).vad_threshold() - 0.3).abs() < 1e-6);
        assert!((at(0.0).vad_threshold() - 0.7).abs() < 1e-6);
        assert!((at(1.0).barge_floor() - 0.0005).abs() < 1e-6);
        assert!((at(0.0).barge_floor() - 0.008).abs() < 1e-6);
        // Out of range or nonsense reads as the nearest sense.
        assert_eq!(at(7.0).vad_threshold(), at(1.0).vad_threshold());
        assert_eq!(at(f32::NAN).vad_threshold(), at(0.5).vad_threshold());
    }

    #[test]
    fn only_devices_and_echo_cancelling_rebuild_the_audio() {
        let a = AudioPrefs::default();
        let louder = AudioPrefs {
            sensitivity: 0.9,
            push_to_talk_only: true,
            ..a.clone()
        };
        assert!(!a.rebuilds(&louder));
        let yeti = AudioPrefs {
            input: Some(DeviceChoice {
                id: "yeti".into(),
                name: "Yeti".into(),
            }),
            ..a.clone()
        };
        assert!(a.rebuilds(&yeti));
        let no_echo = AudioPrefs {
            echo_cancel: false,
            ..a.clone()
        };
        assert!(a.rebuilds(&no_echo));
    }

    #[test]
    fn the_values_read_without_a_lock_start_at_the_defaults() {
        assert_eq!(0.5f32.to_bits(), 0x3f00_0000);
        assert_eq!(0.002f32.to_bits(), 0x3b03_126f);
    }

    #[test]
    fn older_settings_read_with_the_defaults() {
        let p: AudioPrefs = serde_json::from_str(r#"{"sensitivity":0.8}"#).unwrap();
        assert!(p.echo_cancel);
        assert_eq!(p.input, None);
        assert!((p.sensitivity - 0.8).abs() < 1e-6);
        let json = serde_json::to_string(&AudioPrefs::default()).unwrap();
        assert!(json.contains(r#""echoCancel":true"#), "{json}");
        assert!(json.contains(r#""pushToTalkOnly":false"#), "{json}");
    }
}
