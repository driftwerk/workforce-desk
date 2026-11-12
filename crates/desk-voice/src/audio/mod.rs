//! The microphone and the speaker: AVAudioEngine with Apple's echo
//! canceller on macOS, cpal elsewhere. Without an echo canceller the
//! microphone goes quiet while Desk speaks ([`gate`]).

#[cfg(not(target_os = "macos"))]
mod cpal_audio;
pub mod gate;
#[cfg(target_os = "macos")]
mod mac;

#[cfg(not(target_os = "macos"))]
use cpal_audio as platform;
#[cfg(target_os = "macos")]
use mac as platform;

use std::sync::Arc;

use eyre::Result;

use crate::{AudioIn, SharedAudioOut};

/// The microphone's samples handler, shared with the audio thread.
type SharedIn = Arc<dyn Fn(&[f32], u32) + Send + Sync>;

/// Whether Desk may use the microphone, as the system says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicAccess {
    Granted,
    Denied,
    /// Not asked yet: the system asks the first time Desk listens.
    NotAsked,
    /// The system doesn't say.
    Unknown,
}

/// What opening the microphone says when the person hasn't let Desk use
/// it: the page knows it by these words and offers the setting.
pub const MIC_NOT_ALLOWED: &str = "Desk isn’t allowed to use the microphone.";

/// Whether Desk may use the microphone.
pub fn mic_access() -> MicAccess {
    platform::mic_access()
}

/// Windows' microphone consent, from its two switches: for every app, and
/// for desktop apps (as Desk is). Either off is a denial.
#[cfg_attr(not(windows), allow(dead_code))]
fn decide(all: Option<&str>, desktop: Option<&str>) -> MicAccess {
    match (all, desktop) {
        (Some("Deny"), _) | (_, Some("Deny")) => MicAccess::Denied,
        (Some("Allow"), Some("Allow")) | (Some("Allow"), None) => MicAccess::Granted,
        _ => MicAccess::Unknown,
    }
}

/// Opens the microphone, which goes to `input` as mono samples at its own
/// rate; the returned output plays speech. Refused in plain words
/// ([`MIC_NOT_ALLOWED`]) when the person hasn't let Desk use it.
pub fn open(input: AudioIn) -> Result<SharedAudioOut> {
    if mic_access() == MicAccess::Denied {
        return Err(eyre::eyre!(MIC_NOT_ALLOWED));
    }
    platform::open(input)
}

/// Just the speaker side: for playing a sample while voice is off.
pub fn output() -> Result<SharedAudioOut> {
    platform::output()
}

#[cfg(test)]
mod access_tests {
    use super::{MicAccess, decide};

    #[test]
    fn windows_denies_the_microphone_when_either_of_its_switches_is_off() {
        assert_eq!(decide(Some("Allow"), Some("Allow")), MicAccess::Granted);
        assert_eq!(decide(Some("Allow"), None), MicAccess::Granted);
        assert_eq!(decide(Some("Deny"), Some("Allow")), MicAccess::Denied);
        assert_eq!(decide(Some("Allow"), Some("Deny")), MicAccess::Denied);
        assert_eq!(decide(None, None), MicAccess::Unknown);
    }
}
