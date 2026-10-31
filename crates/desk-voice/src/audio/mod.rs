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

/// Opens the microphone, which goes to `input` as mono samples at its own
/// rate; the returned output plays speech.
pub fn open(input: AudioIn) -> Result<SharedAudioOut> {
    platform::open(input)
}

/// Just the speaker side: for playing a sample while voice is off.
pub fn output() -> Result<SharedAudioOut> {
    platform::output()
}
