//! Microphone and speaker through one AVAudioEngine with voice processing
//! on: the input node's echo canceller takes the engine's own output as its
//! reference, so speech played through the player node is removed from what
//! the microphone hears. The player takes one fixed mono format (a buffer in
//! any other format makes AVFAudio throw), so speech is resampled to it.
//!
//! Some Macs refuse to start voice processing (AVFAudio error -10875). The
//! microphone is then opened plainly and goes quiet while Desk speaks, and
//! for a moment after, so Desk never hears itself.

use std::ptr::NonNull;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

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
/// How long the microphone stays quiet after Desk stops speaking, when there
/// is no echo canceller: the tail of the speech still in the room.
const ECHO_TAIL_MS: u64 = 400;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Whether Desk is speaking, for a microphone without an echo canceller.
#[derive(Default)]
struct Speaking {
    queued: AtomicUsize,
    quiet_after: AtomicU64,
}

impl Speaking {
    fn started(&self) {
        self.queued.fetch_add(1, Ordering::SeqCst);
    }
    fn finished(&self) {
        let _ = self
            .queued
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1));
        self.quiet_after
            .store(now_ms() + ECHO_TAIL_MS, Ordering::SeqCst);
    }
    fn stopped(&self) {
        self.queued.store(0, Ordering::SeqCst);
        self.quiet_after
            .store(now_ms() + ECHO_TAIL_MS, Ordering::SeqCst);
    }
    fn now(&self) -> bool {
        self.queued.load(Ordering::SeqCst) > 0 || now_ms() < self.quiet_after.load(Ordering::SeqCst)
    }
}

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
    engine: Arc<Mutex<Engine>>,
    alive: Arc<std::sync::atomic::AtomicBool>,
    format: Retained<AVAudioFormat>,
    resampler: Mutex<Option<Resampler>>,
    speaking: Arc<Speaking>,
    _tap: Option<Tap>,
}

// SAFETY: the engine is behind a `Mutex`; the format is an immutable object.
unsafe impl Send for MacAudio {}
unsafe impl Sync for MacAudio {}

/// Starts the engine: the microphone (voice-processed) goes to `input` as
/// mono samples at the hardware rate; the returned output plays speech.
pub fn open(input: AudioIn) -> Result<SharedAudioOut> {
    let input: SharedIn = Arc::from(input);
    // In a pool of its own, so a failed attempt's objects are gone before the retry.
    match objc2::rc::autoreleasepool(|_| build(Some((input.clone(), true)))) {
        Ok(audio) => Ok(Arc::new(audio)),
        Err(e) => {
            tracing::warn!(
                "voice processing won't start ({e:#}); listening without it, quiet while speaking"
            );
            // The failed voice-processing unit winds down in the background;
            // the plain microphone starts once it has.
            let mut last = None;
            for _ in 0..5 {
                std::thread::sleep(std::time::Duration::from_millis(300));
                match objc2::rc::autoreleasepool(|_| build(Some((input.clone(), false)))) {
                    Ok(audio) => return Ok(Arc::new(audio)),
                    Err(e) => last = Some(e),
                }
            }
            Err(last.unwrap_or_else(|| eyre!("the microphone won't start")))
        }
    }
}

/// Just the speaker side: for playing a sample while voice is off.
pub fn output() -> Result<SharedAudioOut> {
    Ok(Arc::new(build(None)?))
}

type SharedIn = Arc<dyn Fn(&[f32], u32) + Send + Sync>;

/// The engine, with the microphone when `input` is given: voice-processed
/// (echo cancelled), or plain and quiet while Desk speaks.
fn build(input: Option<(SharedIn, bool)>) -> Result<MacAudio> {
    let speaking = Arc::new(Speaking::default());
    unsafe {
        let engine = AVAudioEngine::new();
        let format = AVAudioFormat::initStandardFormatWithSampleRate_channels(
            AVAudioFormat::alloc(),
            f64::from(PLAYBACK_RATE),
            1,
        )
        .ok_or_else(|| eyre!("no mono playback format"))?;
        let tap = input
            .map(|(input, cancel_echo)| {
                let gate = (!cancel_echo).then(|| speaking.clone());
                listen(&engine, input, cancel_echo, gate)
            })
            .transpose()?;

        let player = AVAudioPlayerNode::new();
        engine.attachNode(&player);
        engine.connect_to_format(&player, &engine.mainMixerNode(), Some(&format));

        engine.prepare();
        if let Err(e) = engine.startAndReturnError() {
            // Leave the microphone as found: a voice-processing unit left
            // behind keeps the next engine's plain microphone from starting.
            if tap.is_some() {
                let mic = engine.inputNode();
                mic.removeTapOnBus(0);
                let _ = mic.setVoiceProcessingEnabled_error(false);
            }
            engine.stop();
            engine.reset();
            return Err(eyre!(
                "starting audio: {} ({} {})",
                e.localizedDescription(),
                e.domain(),
                e.code()
            ));
        }
        let engine = Arc::new(Mutex::new(Engine { engine, player }));
        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        keep_running(engine.clone(), alive.clone());
        Ok(MacAudio {
            engine,
            alive,
            format,
            resampler: Mutex::new(None),
            speaking,
            _tap: tap,
        })
    }
}

/// A tap on the microphone: voice-processed when `cancel_echo`; otherwise
/// silence goes to `input` while `gate` says Desk is speaking.
unsafe fn listen(
    engine: &AVAudioEngine,
    input: SharedIn,
    cancel_echo: bool,
    gate: Option<Arc<Speaking>>,
) -> Result<Tap> {
    unsafe {
        let mic = engine.inputNode();
        mic.setVoiceProcessingEnabled_error(cancel_echo)
            .map_err(|e| {
                eyre!(
                    "voice processing: {} ({} {})",
                    e.localizedDescription(),
                    e.domain(),
                    e.code()
                )
            })?;
        let format = mic.outputFormatForBus(0);
        if format.sampleRate() == 0.0 || format.channelCount() == 0 {
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
                // The buffer's own rate: a device can change it under a running tap.
                let rate = buffer.format().sampleRate() as u32;
                // With voice processing on, the first channel is the processed
                // voice; any others are the unprocessed microphones.
                let voice = std::slice::from_raw_parts((*data).as_ptr(), frames);
                if gate.as_ref().is_some_and(|g| g.now()) {
                    input(&vec![0.0; frames], rate);
                } else {
                    input(voice, rate);
                }
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
        let speaking = self.speaking.clone();
        speaking.started();
        let finished = RcBlock::new(move || {
            speaking.finished();
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
        self.speaking.stopped();
        if let Ok(mut r) = self.resampler.lock() {
            *r = None;
        }
    }
}

/// macOS stops an engine whenever the audio device's configuration changes
/// (another app, a device switch, a voice-processing unit winding down) and
/// leaves restarting it to the app: this does, until the engine is dropped.
fn keep_running(engine: Arc<Mutex<Engine>>, alive: Arc<std::sync::atomic::AtomicBool>) {
    std::thread::spawn(move || {
        let mut failures = 0u32;
        while alive.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(250));
            let Ok(e) = engine.lock() else { break };
            if !alive.load(Ordering::SeqCst) || unsafe { e.engine.isRunning() } {
                failures = 0;
                continue;
            }
            match unsafe {
                e.engine.prepare();
                e.engine.startAndReturnError()
            } {
                Ok(()) => {
                    tracing::info!("voice: the audio device changed; audio restarted");
                    failures = 0;
                }
                Err(err) => {
                    failures += 1;
                    if failures == 1 || failures.is_multiple_of(40) {
                        tracing::warn!(
                            "voice: audio stopped and won't restart yet: {}",
                            err.localizedDescription()
                        );
                    }
                }
            }
        }
    });
}

impl Drop for MacAudio {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::SeqCst);
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

    /// The microphone keeps delivering, second after second, once open.
    #[test]
    #[ignore = "uses the microphone"]
    fn keeps_hearing_the_microphone() {
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        let input: AudioIn = Box::new(move |samples: &[f32], _rate: u32| {
            c.fetch_add(samples.len(), Ordering::SeqCst);
        });
        let _audio = open(input).unwrap();
        let mut per_second = Vec::new();
        let mut last = 0;
        for _ in 0..8 {
            std::thread::sleep(Duration::from_secs(1));
            let now = count.load(Ordering::SeqCst);
            per_second.push(now - last);
            last = now;
        }
        eprintln!("samples per second: {per_second:?}");
        assert!(
            per_second.iter().skip(1).all(|n| *n > 10_000),
            "{per_second:?}"
        );
    }

    #[test]
    fn the_microphone_is_quiet_while_desk_speaks_and_just_after() {
        let s = Speaking::default();
        assert!(!s.now());
        s.started();
        s.started();
        assert!(s.now());
        s.finished();
        assert!(s.now(), "one buffer still playing");
        s.finished();
        assert!(s.now(), "the tail of the speech is still in the room");
        s.quiet_after.store(0, Ordering::SeqCst);
        assert!(!s.now());
        s.started();
        s.stopped();
        s.quiet_after.store(0, Ordering::SeqCst);
        assert!(!s.now(), "stopping clears what was queued");
        s.finished();
        s.quiet_after.store(0, Ordering::SeqCst);
        assert!(!s.now(), "a late completion after stop never goes negative");
    }

    /// Opens the real microphone (the terminal running the test needs
    /// microphone permission) and hears at least one buffer.
    #[test]
    #[ignore = "uses the microphone"]
    fn hears_the_microphone() {
        let (tx, rx) = channel();
        let tx = Mutex::new(tx);
        let input: AudioIn = Box::new(move |samples: &[f32], rate: u32| {
            let _ = tx.lock().unwrap().send((samples.len(), rate));
        });
        let _audio = open(input).unwrap();
        let (n, rate) = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("a buffer from the microphone");
        assert!(n > 0 && rate > 0);
    }

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
