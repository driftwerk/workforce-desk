//! Microphone and speaker through one AVAudioEngine with voice processing
//! on: the input node's echo canceller takes the engine's own output as its
//! reference, so speech played through the player node is removed from what
//! the microphone hears. The player takes one fixed mono format (a buffer in
//! any other format makes AVFAudio throw), so speech is resampled to it.

use std::ptr::NonNull;
use std::sync::{Arc, Mutex};

use block2::RcBlock;
use eyre::{Result, eyre};
use objc2::AllocAnyThread;
use objc2::rc::Retained;
use objc2_avf_audio::{
    AVAudioEngine, AVAudioFormat, AVAudioPCMBuffer, AVAudioPlayerNode, AVAudioTime,
};

use crate::resample::Resampler;
use crate::{AudioIn, AudioOut, SharedAudioOut};

const TAP_FRAMES: u32 = 4096;
const PLAYBACK_RATE: u32 = 48_000;

struct Engine {
    engine: Retained<AVAudioEngine>,
    player: Retained<AVAudioPlayerNode>,
}

// SAFETY: AVAudioEngine and its nodes may be used from any thread as long as
// calls aren't concurrent; every use goes through the `Mutex` in `MacAudio`,
// and completion handlers never call back into the engine.
unsafe impl Send for Engine {}

type Tap = RcBlock<dyn Fn(NonNull<AVAudioPCMBuffer>, NonNull<AVAudioTime>)>;

pub struct MacAudio {
    engine: Mutex<Engine>,
    format: Retained<AVAudioFormat>,
    resampler: Mutex<Option<Resampler>>,
    _tap: Option<Tap>,
}

// SAFETY: the engine is behind a `Mutex`; the format is an immutable object.
unsafe impl Send for MacAudio {}
unsafe impl Sync for MacAudio {}

/// Starts the engine: the microphone (voice-processed) goes to `input` as
/// mono samples at the hardware rate; the returned output plays speech.
pub fn open(input: AudioIn) -> Result<SharedAudioOut> {
    Ok(Arc::new(build(Some(input))?))
}

fn build(input: Option<AudioIn>) -> Result<MacAudio> {
    unsafe {
        let engine = AVAudioEngine::new();
        let format = AVAudioFormat::initStandardFormatWithSampleRate_channels(
            AVAudioFormat::alloc(),
            f64::from(PLAYBACK_RATE),
            1,
        )
        .ok_or_else(|| eyre!("no mono playback format"))?;
        let tap = input.map(|input| listen(&engine, input)).transpose()?;

        let player = AVAudioPlayerNode::new();
        engine.attachNode(&player);
        engine.connect_to_format(&player, &engine.mainMixerNode(), Some(&format));

        engine.prepare();
        if let Err(e) = engine.startAndReturnError() {
            if tap.is_some() {
                engine.inputNode().removeTapOnBus(0);
            }
            return Err(eyre!("starting audio: {}", e.localizedDescription()));
        }
        Ok(MacAudio {
            engine: Mutex::new(Engine { engine, player }),
            format,
            resampler: Mutex::new(None),
            _tap: tap,
        })
    }
}

/// Voice processing on, and a tap on the processed microphone.
unsafe fn listen(engine: &AVAudioEngine, input: AudioIn) -> Result<Tap> {
    unsafe {
        let mic = engine.inputNode();
        mic.setVoiceProcessingEnabled_error(true)
            .map_err(|e| eyre!("voice processing: {}", e.localizedDescription()))?;
        let format = mic.outputFormatForBus(0);
        let rate = format.sampleRate() as u32;
        if rate == 0 || format.channelCount() == 0 {
            return Err(eyre!("no microphone input"));
        }
        let tap: Tap = RcBlock::new(
            move |buffer: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| {
                let buffer = buffer.as_ref();
                let data = buffer.floatChannelData();
                if data.is_null() {
                    return;
                }
                let frames = buffer.frameLength() as usize;
                // With voice processing on, the first channel is the processed
                // voice; any others are the unprocessed microphones.
                let voice = std::slice::from_raw_parts((*data).as_ptr(), frames);
                input(voice, rate);
            },
        );
        mic.installTapOnBus_bufferSize_format_block(0, TAP_FRAMES, None, RcBlock::as_ptr(&tap));
        Ok(tap)
    }
}

impl MacAudio {
    /// `samples` at `rate`, at the player's rate. The resampler carries
    /// across buffers so a stream of small chunks joins up smoothly.
    fn at_playback_rate(&self, samples: &[f32], rate: u32) -> Vec<f32> {
        let Ok(mut slot) = self.resampler.lock() else {
            return Vec::new();
        };
        let resampler = match &mut *slot {
            Some(r) if r.from_rate() == rate => r,
            slot => slot.insert(Resampler::new(rate, PLAYBACK_RATE)),
        };
        resampler.process(samples)
    }
}

impl AudioOut for MacAudio {
    fn play(&self, samples: &[f32], rate: u32, done: Box<dyn FnOnce() + Send>) {
        let Some(buffer) = pcm(&self.format, &self.at_playback_rate(samples, rate)) else {
            done();
            return;
        };
        let done = Mutex::new(Some(done));
        let finished = RcBlock::new(move || {
            if let Some(done) = done.lock().ok().and_then(|mut d| d.take()) {
                done();
            }
        });
        let Ok(engine) = self.engine.lock() else {
            return;
        };
        unsafe {
            engine
                .player
                .scheduleBuffer_completionHandler(&buffer, RcBlock::as_ptr(&finished));
            if !engine.player.isPlaying() {
                engine.player.play();
            }
        }
    }

    fn stop(&self) {
        if let Ok(engine) = self.engine.lock() {
            unsafe { engine.player.stop() };
        }
        if let Ok(mut r) = self.resampler.lock() {
            *r = None;
        }
    }
}

impl Drop for MacAudio {
    fn drop(&mut self) {
        if let Ok(engine) = self.engine.lock() {
            unsafe {
                engine.player.stop();
                if self._tap.is_some() {
                    engine.engine.inputNode().removeTapOnBus(0);
                }
                engine.engine.stop();
            }
        }
    }
}

fn pcm(format: &AVAudioFormat, samples: &[f32]) -> Option<Retained<AVAudioPCMBuffer>> {
    let frames = u32::try_from(samples.len()).ok().filter(|n| *n > 0)?;
    unsafe {
        let buffer = AVAudioPCMBuffer::initWithPCMFormat_frameCapacity(
            AVAudioPCMBuffer::alloc(),
            format,
            frames,
        )?;
        buffer.setFrameLength(frames);
        let data = buffer.floatChannelData();
        if data.is_null() {
            return None;
        }
        std::ptr::copy_nonoverlapping(samples.as_ptr(), (*data).as_ptr(), samples.len());
        Some(buffer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;
    use std::time::Duration;

    /// Plays through the real output without the microphone (no permission
    /// needed): each engine's rate must reach the player as its own format.
    #[test]
    #[ignore = "plays a little silence on the default output device"]
    fn plays_mono_speech_at_each_engines_rate() {
        let audio = build(None).unwrap();
        let (tx, rx) = channel();
        for rate in [16_000, 24_000, 48_000] {
            let tx = tx.clone();
            audio.play(
                &vec![0.0; rate as usize / 10],
                rate,
                Box::new(move || tx.send(rate).unwrap()),
            );
        }
        let played: Vec<u32> = (0..3)
            .map(|_| rx.recv_timeout(Duration::from_secs(5)).unwrap())
            .collect();
        assert_eq!(played, [16_000, 24_000, 48_000]);
        let (tx, rx) = channel();
        audio.play(
            &vec![0.0; 48_000],
            24_000,
            Box::new(move || tx.send(()).unwrap()),
        );
        audio.stop();
        rx.recv_timeout(Duration::from_secs(1))
            .expect("stopping completes what was queued");
    }
}
