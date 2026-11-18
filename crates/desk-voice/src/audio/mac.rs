//! Microphone and speaker through one AVAudioEngine with voice processing
//! on: the input node's echo canceller takes the engine's own output as its
//! reference, so speech played through the player node is removed from what
//! the microphone hears. The player takes one fixed mono format (a buffer in
//! any other format makes AVFAudio throw), so speech is resampled to it.
//!
//! Some Macs refuse to start voice processing (AVFAudio error -10875). The
//! microphone is then opened plainly and goes quiet while Desk speaks, and
//! for a moment after, so Desk never hears itself ([`super::live`]).
//!
//! A device other than the system's is set on the engine's I/O unit before
//! the engine starts (`kAudioOutputUnitProperty_CurrentDevice`). With voice
//! processing on, both nodes are one voice-processing unit, and the device
//! goes on its input element (1) and the speaker on its output element (0),
//! as Chromium's voice-processing capture does. Voice processing makes an
//! aggregate device of its own, so it isn't tried on an aggregate.
//!
//! macOS stops an engine whenever the audio device's configuration changes
//! (another app, a device switch, a voice-processing unit winding down);
//! this engine says it's no longer healthy, and a new one is built on the
//! devices there are then, its tap and voice processing made afresh.

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use block2::RcBlock;
use eyre::{Result, eyre};
use objc2::AllocAnyThread;
use objc2::rc::Retained;
use objc2_audio_toolbox::{
    AudioUnit, AudioUnitGetProperty, AudioUnitSetProperty, kAudioOutputUnitProperty_CurrentDevice,
    kAudioUnitScope_Global,
};
use objc2_avf_audio::{
    AVAudioEngine, AVAudioFormat, AVAudioPCMBuffer, AVAudioPlayerNode,
    AVAudioPlayerNodeCompletionCallbackType, AVAudioTime,
};

use super::SharedIn;
use super::devices::{Device, Devices};
use super::live::{Attempt, Backend, Done};
use crate::resample::Resampler;

const TAP_FRAMES: u32 = 4096;
const PLAYBACK_RATE: u32 = 48_000;

/// Apple's voice processing removes Desk's voice from the microphone.
pub(crate) const HAS_ECHO_CANCELLER: bool = true;
/// How long a voice-processing unit takes to wind down once its engine is
/// gone: the next engine's microphone won't start before.
pub(crate) const SETTLE: Duration = Duration::from_millis(300);
/// Tries at the plain microphone after voice processing failed, `SETTLE`
/// apart.
pub(crate) const RETRIES_AFTER_VP: usize = 5;
/// How often the devices are listed, to follow them.
pub(crate) const POLL: Duration = Duration::from_millis(500);

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
    /// The buffers scheduled and not yet answered.
    waiting: Mutex<Vec<Waiting>>,
    tap: Option<Tap>,
}

// SAFETY: the engine is behind a `Mutex`; the format is an immutable object.
unsafe impl Send for MacAudio {}
unsafe impl Sync for MacAudio {}

/// Whether Desk may use the microphone: AVAudioApplication's record
/// permission (macOS 14 and later; before, the system doesn't say).
pub fn mic_access() -> super::MicAccess {
    use objc2_avf_audio::{AVAudioApplication, AVAudioApplicationRecordPermission as P};
    if objc2::runtime::AnyClass::get(c"AVAudioApplication").is_none() {
        return super::MicAccess::Unknown;
    }
    // SAFETY: the shared instance and a plain read of its permission.
    match unsafe { AVAudioApplication::sharedInstance().recordPermission() } {
        P::Granted => super::MicAccess::Granted,
        P::Denied => super::MicAccess::Denied,
        P::Undetermined => super::MicAccess::NotAsked,
        _ => super::MicAccess::Unknown,
    }
}

/// Opens the engine as `attempt` says: the microphone (voice-processed, or
/// plain) to `to` as mono samples at the hardware rate, and the speaker.
pub(crate) fn build(attempt: &Attempt, to: Option<SharedIn>) -> Result<Box<dyn Backend>> {
    Ok(Box::new(build_engine(attempt, to)?))
}

/// Voice processing makes an aggregate device of its own, and can't of one
/// that already is.
pub(crate) fn can_cancel_echo(input: Option<&Device>) -> bool {
    input.is_none_or(|d| !hal::is_aggregate(&d.id))
}

pub(crate) fn devices() -> Devices {
    hal::devices()
}

fn build_engine(attempt: &Attempt, to: Option<SharedIn>) -> Result<MacAudio> {
    unsafe {
        let engine = AVAudioEngine::new();
        let format = AVAudioFormat::initStandardFormatWithSampleRate_channels(
            AVAudioFormat::alloc(),
            f64::from(PLAYBACK_RATE),
            1,
        )
        .ok_or_else(|| eyre!("no mono playback format"))?;
        let tap = match to.filter(|_| attempt.listen) {
            Some(to) => Some(listen(&engine, to, attempt)?),
            None => None,
        };
        if tap.is_none()
            && let Some(uid) = &attempt.output
        {
            // Without the microphone, the output node is a unit of its own.
            set_device(engine.outputNode().audioUnit(), 0, uid)?;
        }

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
        Ok(MacAudio {
            engine: Mutex::new(Engine { engine, player }),
            format,
            resampler: Mutex::new(None),
            waiting: Mutex::new(Vec::new()),
            tap,
        })
    }
}

/// Puts the device with Core Audio UID `uid` on `unit`'s `element`.
unsafe fn set_device(unit: AudioUnit, element: u32, uid: &str) -> Result<()> {
    if unit.is_null() {
        return Err(eyre!("the engine has no audio unit to put {uid} on"));
    }
    let device = hal::device_id(uid).ok_or_else(|| eyre!("no device {uid}"))?;
    let status = unsafe {
        AudioUnitSetProperty(
            unit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            element,
            (&raw const device).cast::<c_void>(),
            size_of_val(&device) as u32,
        )
    };
    if status != 0 {
        return Err(eyre!("couldn’t use device {uid} (OSStatus {status})"));
    }
    Ok(())
}

/// The device on `unit`'s `element`, as the unit says.
unsafe fn current_device(unit: AudioUnit, element: u32) -> Option<u32> {
    if unit.is_null() {
        return None;
    }
    let mut device = 0u32;
    let mut size = size_of_val(&device) as u32;
    let status = unsafe {
        AudioUnitGetProperty(
            unit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            element,
            NonNull::from(&mut device).cast::<c_void>(),
            NonNull::from(&mut size),
        )
    };
    (status == 0).then_some(device)
}

/// A tap on the microphone, voice-processed when `attempt` says, on its
/// device; the speaker's device too, which voice processing shares the
/// microphone's unit with.
unsafe fn listen(engine: &AVAudioEngine, to: SharedIn, attempt: &Attempt) -> Result<Tap> {
    unsafe {
        let mic = engine.inputNode();
        let cancel_echo = attempt.cancel_echo;
        mic.setVoiceProcessingEnabled_error(cancel_echo)
            .map_err(|e| {
                eyre!(
                    "voice processing: {} ({} {})",
                    e.localizedDescription(),
                    e.domain(),
                    e.code()
                )
            })?;
        // The devices go on before the formats are read: the microphone's is
        // the device's own.
        let (input_element, output_element) = if cancel_echo { (1, 0) } else { (0, 0) };
        if let Some(uid) = &attempt.input {
            set_device(mic.audioUnit(), input_element, uid)?;
        }
        if let Some(uid) = &attempt.output {
            set_device(engine.outputNode().audioUnit(), output_element, uid)?;
            // Where the microphone and speaker share one unit, the speaker's
            // device can take the microphone's place: then this pair can't
            // be had, and the chosen microphone is tried on its own.
            let mic_should_be = match &attempt.input {
                Some(mic_uid) => hal::device_id(mic_uid),
                None => hal::default_input(),
            };
            if current_device(mic.audioUnit(), input_element) != mic_should_be {
                return Err(eyre!(
                    "the microphone and speaker can’t be different devices here"
                ));
            }
        }
        let format = mic.outputFormatForBus(0);
        if format.sampleRate() == 0.0 || format.channelCount() == 0 {
            return Err(eyre!("no microphone input"));
        }
        if cancel_echo {
            match_output_to_microphone(engine)?;
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
                // With voice processing on every channel carries the same
                // processed voice (the 3-mic array and the speaker reference
                // come out as one signal), so the first is the voice.
                let voice = std::slice::from_raw_parts((*data).as_ptr(), frames);
                to(voice, rate);
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

impl Backend for MacAudio {
    fn play(&self, samples: &[f32], rate: u32, done: Done) {
        let Some(buffer) = pcm(&self.format, &self.at_playback_rate(samples, rate)) else {
            done();
            return;
        };
        let done: Waiting = Arc::new(Mutex::new(Some(done)));
        let answer = done.clone();
        let finished = RcBlock::new(move |_: AVAudioPlayerNodeCompletionCallbackType| {
            if let Some(done) = answer.lock().ok().and_then(|mut d| d.take()) {
                done();
            }
        });
        if let Ok(mut waiting) = self.waiting.lock() {
            waiting.retain(|w| w.lock().is_ok_and(|d| d.is_some()));
            waiting.push(done.clone());
        }
        let Ok(engine) = self.engine.lock() else {
            answer_all(&[done]);
            return;
        };
        // Called once the buffer has been heard, the output device's latency
        // included, not once the player has taken it: a reply that has "ended"
        // while its last words are still to come out of the speaker would have
        // them taken for the person (AVAudioPlayerNodeCompletionDataPlayedBack;
        // a stopped player calls it too).
        unsafe {
            engine
                .player
                .scheduleBuffer_completionCallbackType_completionHandler(
                    &buffer,
                    AVAudioPlayerNodeCompletionCallbackType::DataPlayedBack,
                    RcBlock::as_ptr(&finished),
                );
            if !engine.player.isPlaying() {
                engine.player.play();
            }
        }
    }

    /// What's played reaches the tap after the microphone's own latency, and
    /// up to a tap's buffer later still. The output's latency is in `done`.
    fn lag(&self) -> Duration {
        if self.tap.is_none() {
            return Duration::ZERO;
        }
        let Ok(engine) = self.engine.lock() else {
            return Duration::ZERO;
        };
        let (latency, rate) = unsafe {
            let mic = engine.engine.inputNode();
            (
                mic.presentationLatency(),
                mic.outputFormatForBus(0).sampleRate(),
            )
        };
        let buffered = if rate > 0.0 {
            f64::from(TAP_FRAMES) / rate
        } else {
            0.0
        };
        Duration::from_secs_f64((latency.max(0.0) + buffered).min(1.0))
    }

    /// Stops the player, which answers what it had; whatever it didn't (an
    /// engine the system already stopped) is answered here, so nothing is
    /// left waiting on speech that will never play.
    fn stop(&self) {
        if let Ok(engine) = self.engine.lock() {
            unsafe { engine.player.stop() };
        }
        let waiting = self
            .waiting
            .lock()
            .map(|mut w| std::mem::take(&mut *w))
            .unwrap_or_default();
        answer_all(&waiting);
        if let Ok(mut r) = self.resampler.lock() {
            *r = None;
        }
    }

    /// The system stops the engine on a configuration change and leaves it
    /// stopped: then it's built again, on the devices there are now.
    fn healthy(&self) -> bool {
        self.engine
            .lock()
            .is_ok_and(|e| unsafe { e.engine.isRunning() })
    }
}

/// A buffer's `done`, until it's called.
type Waiting = Arc<Mutex<Option<Done>>>;

fn answer_all(waiting: &[Waiting]) {
    for w in waiting {
        if let Some(done) = w.lock().ok().and_then(|mut d| d.take()) {
            done();
        }
    }
}

/// The echo canceller won't start unless both its sides run at one rate. The
/// output side is the main mixer's link to the speaker, which AVAudioEngine
/// creates lazily — once voice processing is on it reads the speaker as 0 Hz
/// and falls back to 44.1 kHz against the microphone's 48 kHz (AVFAudio
/// -10875, "client-side input and output formats do not match"). So the link
/// is made explicitly, at the microphone's rate.
unsafe fn match_output_to_microphone(engine: &AVAudioEngine) -> Result<()> {
    unsafe {
        let rate = engine.inputNode().outputFormatForBus(0).sampleRate();
        let stereo = AVAudioFormat::initStandardFormatWithSampleRate_channels(
            AVAudioFormat::alloc(),
            rate,
            2,
        )
        .ok_or_else(|| eyre!("no {rate} Hz output format"))?;
        engine.connect_to_format(&engine.mainMixerNode(), &engine.outputNode(), Some(&stereo));
        Ok(())
    }
}

impl Drop for MacAudio {
    fn drop(&mut self) {
        if let Ok(engine) = self.engine.lock() {
            unsafe {
                engine.player.stop();
                if self.tap.is_some() {
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

/// Core Audio's devices: listed with their UIDs (stable across restarts),
/// names and whether they're the system's default.
mod hal {
    use std::ffi::c_void;
    use std::ptr::NonNull;

    use objc2_core_audio::{
        AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize, AudioObjectID,
        AudioObjectPropertyAddress, kAudioDevicePropertyDeviceUID, kAudioDevicePropertyStreams,
        kAudioDevicePropertyTransportType, kAudioDeviceTransportTypeAggregate,
        kAudioHardwarePropertyDefaultInputDevice, kAudioHardwarePropertyDefaultOutputDevice,
        kAudioHardwarePropertyDevices, kAudioObjectPropertyElementMain, kAudioObjectPropertyName,
        kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyScopeInput,
        kAudioObjectPropertyScopeOutput, kAudioObjectSystemObject,
    };
    use objc2_core_foundation::{CFRetained, CFString};

    use super::{Device, Devices};

    const SYSTEM: AudioObjectID = kAudioObjectSystemObject as AudioObjectID;

    fn address(selector: u32, scope: u32) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress {
            mSelector: selector,
            mScope: scope,
            mElement: kAudioObjectPropertyElementMain,
        }
    }

    /// The property's size in bytes, if the object has it.
    fn size(object: AudioObjectID, selector: u32, scope: u32) -> Option<u32> {
        let address = address(selector, scope);
        let mut size = 0u32;
        // SAFETY: the address and size are ours; no qualifier.
        let status = unsafe {
            AudioObjectGetPropertyDataSize(
                object,
                NonNull::from(&address),
                0,
                std::ptr::null(),
                NonNull::from(&mut size),
            )
        };
        (status == 0).then_some(size)
    }

    /// A plain-data property: a `u32` or an array of them.
    fn get<T: Copy + Default>(object: AudioObjectID, selector: u32, scope: u32) -> Option<T> {
        let address = address(selector, scope);
        let mut value = T::default();
        let mut size = size_of::<T>() as u32;
        // SAFETY: `value` is `size` bytes of plain data.
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                NonNull::from(&address),
                0,
                std::ptr::null(),
                NonNull::from(&mut size),
                NonNull::from(&mut value).cast::<c_void>(),
            )
        };
        (status == 0 && size as usize == size_of::<T>()).then_some(value)
    }

    /// A CFString property (the caller owns what Core Audio returns).
    fn string(object: AudioObjectID, selector: u32) -> Option<String> {
        let address = address(selector, kAudioObjectPropertyScopeGlobal);
        let mut value: *const CFString = std::ptr::null();
        let mut size = size_of::<*const CFString>() as u32;
        // SAFETY: room for one CFStringRef, which the HAL retains for us.
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                NonNull::from(&address),
                0,
                std::ptr::null(),
                NonNull::from(&mut size),
                NonNull::from(&mut value).cast::<c_void>(),
            )
        };
        if status != 0 {
            return None;
        }
        let value = NonNull::new(value.cast_mut())?;
        // SAFETY: a +1 CFString from the HAL, released when dropped.
        let value = unsafe { CFRetained::from_raw(value) };
        Some(value.to_string())
    }

    fn all() -> Vec<AudioObjectID> {
        let Some(bytes) = size(
            SYSTEM,
            kAudioHardwarePropertyDevices,
            kAudioObjectPropertyScopeGlobal,
        ) else {
            return Vec::new();
        };
        let mut ids = vec![0 as AudioObjectID; bytes as usize / size_of::<AudioObjectID>()];
        if ids.is_empty() {
            return ids;
        }
        let address = address(
            kAudioHardwarePropertyDevices,
            kAudioObjectPropertyScopeGlobal,
        );
        let mut size = bytes;
        // SAFETY: `ids` holds `bytes` bytes.
        let status = unsafe {
            AudioObjectGetPropertyData(
                SYSTEM,
                NonNull::from(&address),
                0,
                std::ptr::null(),
                NonNull::from(&mut size),
                NonNull::new(ids.as_mut_ptr().cast::<c_void>()).expect("a vector's pointer"),
            )
        };
        if status != 0 {
            return Vec::new();
        }
        ids.truncate(size as usize / size_of::<AudioObjectID>());
        ids
    }

    /// Whether the device has streams on `scope`'s side.
    fn has_streams(device: AudioObjectID, scope: u32) -> bool {
        size(device, kAudioDevicePropertyStreams, scope).is_some_and(|n| n > 0)
    }

    /// The aggregates voice processing makes for itself, which aren't the
    /// person's to choose.
    fn private(uid: &str) -> bool {
        uid.contains("CADefaultDeviceAggregate") || uid.contains("VPAUAggregateAudioDevice")
    }

    /// The system's microphone now.
    pub(super) fn default_input() -> Option<AudioObjectID> {
        get::<AudioObjectID>(
            SYSTEM,
            kAudioHardwarePropertyDefaultInputDevice,
            kAudioObjectPropertyScopeGlobal,
        )
    }

    pub(super) fn devices() -> Devices {
        let default_in = default_input();
        let default_out = get::<AudioObjectID>(
            SYSTEM,
            kAudioHardwarePropertyDefaultOutputDevice,
            kAudioObjectPropertyScopeGlobal,
        );
        let mut d = Devices::default();
        for id in all() {
            let Some(uid) = string(id, kAudioDevicePropertyDeviceUID).filter(|u| !private(u))
            else {
                continue;
            };
            let name = string(id, kAudioObjectPropertyName).unwrap_or_else(|| uid.clone());
            if has_streams(id, kAudioObjectPropertyScopeInput) {
                d.inputs.push(Device {
                    id: uid.clone(),
                    name: name.clone(),
                    is_default: default_in == Some(id),
                });
            }
            if has_streams(id, kAudioObjectPropertyScopeOutput) {
                d.outputs.push(Device {
                    id: uid,
                    name,
                    is_default: default_out == Some(id),
                });
            }
        }
        d
    }

    /// The device with UID `uid` now.
    pub(super) fn device_id(uid: &str) -> Option<AudioObjectID> {
        all()
            .into_iter()
            .find(|id| string(*id, kAudioDevicePropertyDeviceUID).as_deref() == Some(uid))
    }

    pub(super) fn is_aggregate(uid: &str) -> bool {
        device_id(uid).is_some_and(|id| {
            get::<u32>(
                id,
                kAudioDevicePropertyTransportType,
                kAudioObjectPropertyScopeGlobal,
            ) == Some(kAudioDeviceTransportTypeAggregate)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AudioIn;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc::channel;

    fn attempt(listen: bool, cancel_echo: bool) -> Attempt {
        Attempt {
            input: None,
            output: None,
            listen,
            cancel_echo,
        }
    }

    /// Whether this Mac starts Apple's echo canceller right now (prints the
    /// error when it won't).
    #[test]
    #[ignore = "uses the microphone"]
    fn voice_processing_starts() {
        let input: SharedIn = Arc::new(|_: &[f32], _: u32| {});
        match build_engine(&attempt(true, true), Some(input)) {
            Ok(_) => eprintln!("voice processing: started"),
            Err(e) => panic!("voice processing: {e:#}"),
        }
    }

    /// Voice processing on each microphone there is, by name: whether it
    /// starts on one that isn't the system's.
    #[test]
    #[ignore = "uses every microphone"]
    fn voice_processing_on_each_microphone() {
        for mic in devices().inputs {
            let input: SharedIn = Arc::new(|_: &[f32], _: u32| {});
            let a = Attempt {
                input: Some(mic.id.clone()),
                ..attempt(true, true)
            };
            let r = objc2::rc::autoreleasepool(|_| build_engine(&a, Some(input)).map(drop));
            eprintln!("{}: {r:?}", mic.name);
            std::thread::sleep(SETTLE);
        }
    }

    #[test]
    #[ignore = "reads this Mac's devices"]
    fn lists_this_macs_devices() {
        let d = devices();
        eprintln!("{d:#?}");
        assert!(d.inputs.iter().filter(|m| m.is_default).count() <= 1);
    }

    /// The microphone keeps delivering, second after second, once open.
    #[test]
    #[ignore = "uses the microphone"]
    fn keeps_hearing_the_microphone() {
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        let input: AudioIn = Box::new(move |samples: &[f32], _rate: u32| {
            c.fetch_add(samples.len(), Ordering::SeqCst);
        });
        let _audio = super::super::open(input).unwrap();
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
        let _audio = super::super::open(input).unwrap();
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
        let audio = build_engine(&attempt(false, false), None).unwrap();
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
