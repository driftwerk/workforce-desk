//! Microphone and speaker through cpal: WASAPI on Windows; ALSA, which
//! PulseAudio and PipeWire answer, on Linux, on the device chosen by its
//! cpal id or the system's. There is no echo canceller, so the microphone
//! goes quiet while Desk speaks and for a moment after (in [`super::live`]).
//! A stream whose device goes away says so, and the audio is built again.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{ErrorKind, FromSample, Sample, SampleFormat, SizedSample, StreamConfig};
use eyre::{Result, eyre};

use super::SharedIn;
use super::devices::{Device, Devices};
use super::live::{Attempt, Backend, Done};
use crate::resample::Resampler;

/// No echo canceller here: the microphone goes quiet while Desk speaks.
pub(crate) const HAS_ECHO_CANCELLER: bool = false;
/// Nothing winds down after a stream closes.
pub(crate) const SETTLE: Duration = Duration::ZERO;
pub(crate) const RETRIES_AFTER_VP: usize = 1;
/// How often the devices are listed, to follow them. Listing ALSA's opens
/// each one, so Linux looks less often.
#[cfg(windows)]
pub(crate) const POLL: Duration = Duration::from_secs(1);
#[cfg(not(windows))]
pub(crate) const POLL: Duration = Duration::from_secs(2);

pub(crate) fn can_cancel_echo(_: Option<&Device>) -> bool {
    false
}

/// What is waiting to play, at the device's rate, and what to call as each
/// buffer finishes.
#[derive(Default)]
struct Queue {
    samples: VecDeque<f32>,
    /// Each buffer's end, counted in samples since the queue was made.
    ends: VecDeque<(u64, Done)>,
    played: u64,
    queued: u64,
}

impl Queue {
    fn push(&mut self, samples: &[f32], done: Done) {
        self.samples.extend(samples);
        self.queued += samples.len() as u64;
        self.ends.push_back((self.queued, done));
    }

    /// Fills `out` (mono) with what is queued, silence after; answers the
    /// buffers that have now finished.
    fn take(&mut self, out: &mut [f32]) -> Vec<Done> {
        for slot in out.iter_mut() {
            *slot = self.samples.pop_front().unwrap_or(0.0);
        }
        self.played = (self.played + out.len() as u64).min(self.queued);
        self.finished()
    }

    fn finished(&mut self) -> Vec<Done> {
        let mut done = Vec::new();
        while self
            .ends
            .front()
            .is_some_and(|(end, _)| *end <= self.played)
        {
            done.extend(self.ends.pop_front().map(|(_, d)| d));
        }
        done
    }

    /// Drops everything queued; answers every buffer that was.
    fn clear(&mut self) -> Vec<Done> {
        self.samples.clear();
        self.played = self.queued;
        self.finished()
    }
}

pub struct CpalAudio {
    queue: Arc<Mutex<Queue>>,
    rate: u32,
    resampler: Mutex<Option<Resampler>>,
    /// A stream reported its device gone, or that it must be built again.
    broken: Arc<AtomicBool>,
    /// Dropping it ends the thread that owns the streams.
    streams: Option<mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for CpalAudio {
    /// Waits for the streams to close, so the next build finds the
    /// devices free.
    fn drop(&mut self) {
        drop(self.streams.take());
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// The devices there are, by cpal's ids, the system's default marked.
pub(crate) fn devices() -> Devices {
    let host = cpal::default_host();
    let id = |d: &cpal::Device| d.id().ok().map(|id| id.to_string());
    let listed = |all: Result<Vec<cpal::Device>, _>, default: Option<cpal::Device>| {
        let default = default.as_ref().and_then(id);
        let mut out: Vec<Device> = Vec::new();
        for d in all.unwrap_or_default() {
            let (Some(device_id), Ok(description)) = (id(&d), d.description()) else {
                continue;
            };
            if out.iter().any(|o| o.id == device_id) {
                continue;
            }
            out.push(Device {
                is_default: default.as_deref() == Some(device_id.as_str()),
                id: device_id,
                name: description.name().to_string(),
            });
        }
        out
    };
    Devices {
        inputs: listed(
            host.input_devices().map(Iterator::collect),
            host.default_input_device(),
        ),
        outputs: listed(
            host.output_devices().map(Iterator::collect),
            host.default_output_device(),
        ),
    }
}

/// The device `id` names, or the system's default.
fn device(host: &cpal::Host, id: Option<&str>, input: bool) -> Result<cpal::Device> {
    let what = if input {
        "no microphone"
    } else {
        "no speaker or headphones"
    };
    match id {
        Some(id) => {
            let id: cpal::DeviceId = id.parse().map_err(|_| eyre!("{id} isn’t a device id"))?;
            host.device_by_id(&id)
                .ok_or_else(|| eyre!("{what} with id {id}"))
        }
        None if input => host.default_input_device().ok_or_else(|| eyre!(what)),
        None => host.default_output_device().ok_or_else(|| eyre!(what)),
    }
}

/// Opens audio as `attempt` says, the microphone's samples to `to`.
pub(crate) fn build(attempt: &Attempt, to: Option<SharedIn>) -> Result<Box<dyn Backend>> {
    Ok(Box::new(start(attempt.clone(), to)?))
}

/// Builds and plays the streams on a thread of their own, which keeps them
/// until the returned audio is dropped (a stream needn't be `Send`).
fn start(attempt: Attempt, to: Option<SharedIn>) -> Result<CpalAudio> {
    let queue = Arc::new(Mutex::new(Queue::default()));
    let broken = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = mpsc::channel();
    let (keep_tx, keep_rx) = mpsc::channel::<()>();
    let thread = {
        let (queue, broken) = (queue.clone(), broken.clone());
        std::thread::Builder::new()
            .name("voice-audio".into())
            .spawn(move || {
                let streams = streams(&attempt, to, queue, broken);
                let rate = streams
                    .as_ref()
                    .map(|(_, rate)| *rate)
                    .map_err(|e| eyre!("{e:#}"));
                let _ = ready_tx.send(rate);
                // Until the audio is dropped.
                let _ = keep_rx.recv();
                drop(streams);
            })?
    };
    let rate = ready_rx
        .recv()
        .map_err(|_| eyre!("the audio thread stopped before it started"))??;
    Ok(CpalAudio {
        queue,
        rate,
        resampler: Mutex::new(None),
        broken,
        streams: Some(keep_tx),
        thread: Some(thread),
    })
}

type Streams = (Vec<cpal::Stream>, u32);

/// What a stream's error says of it: build again, or carry on.
fn on_error(
    broken: Arc<AtomicBool>,
    side: &'static str,
) -> impl FnMut(cpal::Error) + Send + 'static {
    move |e| {
        let fatal = matches!(
            e.kind(),
            ErrorKind::DeviceNotAvailable
                | ErrorKind::StreamInvalidated
                | ErrorKind::HostUnavailable
                | ErrorKind::BackendError
        );
        if fatal {
            broken.store(true, Ordering::SeqCst);
        }
        tracing::warn!(fatal, "voice: the {side} stopped: {e}");
    }
}

fn streams(
    attempt: &Attempt,
    to: Option<SharedIn>,
    queue: Arc<Mutex<Queue>>,
    broken: Arc<AtomicBool>,
) -> Result<Streams> {
    let host = cpal::default_host();
    let speaker = device(&host, attempt.output.as_deref(), false)?;
    let out = speaker.default_output_config()?;
    let rate = out.sample_rate();
    let e = || on_error(broken.clone(), "speaker");
    let mut streams = vec![match out.sample_format() {
        SampleFormat::F32 => play::<f32, _>(&speaker, out.config(), queue, e())?,
        SampleFormat::I16 => play::<i16, _>(&speaker, out.config(), queue, e())?,
        SampleFormat::U16 => play::<u16, _>(&speaker, out.config(), queue, e())?,
        SampleFormat::I32 => play::<i32, _>(&speaker, out.config(), queue, e())?,
        other => return Err(eyre!("the speaker plays {other} samples, which Desk can't")),
    }];
    if let Some(to) = to.filter(|_| attempt.listen) {
        let mic = device(&host, attempt.input.as_deref(), true)?;
        let config = mic.default_input_config()?;
        let e = || on_error(broken.clone(), "microphone");
        streams.push(match config.sample_format() {
            SampleFormat::F32 => hear::<f32, _>(&mic, config.config(), to, e())?,
            SampleFormat::I16 => hear::<i16, _>(&mic, config.config(), to, e())?,
            SampleFormat::U16 => hear::<u16, _>(&mic, config.config(), to, e())?,
            SampleFormat::I32 => hear::<i32, _>(&mic, config.config(), to, e())?,
            other => {
                return Err(eyre!(
                    "the microphone gives {other} samples, which Desk can't read"
                ));
            }
        });
    }
    for s in &streams {
        s.play()?;
    }
    Ok((streams, rate))
}

fn play<T, E>(
    device: &cpal::Device,
    config: StreamConfig,
    queue: Arc<Mutex<Queue>>,
    on_error: E,
) -> Result<cpal::Stream>
where
    T: SizedSample + FromSample<f32>,
    E: FnMut(cpal::Error) + Send + 'static,
{
    let channels = usize::from(config.channels.max(1));
    let mut mono = Vec::new();
    Ok(device.build_output_stream::<T, _, _>(
        config,
        move |data: &mut [T], _| {
            mono.resize(data.len() / channels, 0.0);
            let done = match queue.lock() {
                Ok(mut q) => q.take(&mut mono),
                Err(_) => Vec::new(),
            };
            for (frame, sample) in data.chunks_mut(channels).zip(&mono) {
                frame.fill(T::from_sample(*sample));
            }
            for d in done {
                d();
            }
        },
        on_error,
        None,
    )?)
}

fn hear<T, E>(
    device: &cpal::Device,
    config: StreamConfig,
    to: SharedIn,
    on_error: E,
) -> Result<cpal::Stream>
where
    T: SizedSample,
    f32: FromSample<T>,
    E: FnMut(cpal::Error) + Send + 'static,
{
    let channels = usize::from(config.channels.max(1));
    let rate = config.sample_rate;
    let mut mono = Vec::new();
    Ok(device.build_input_stream::<T, _, _>(
        config,
        move |data: &[T], _| {
            mono.clear();
            mono.extend(data.chunks(channels).map(|frame| {
                frame.iter().map(|s| f32::from_sample(*s)).sum::<f32>() / frame.len() as f32
            }));
            to(&mono, rate);
        },
        on_error,
        None,
    )?)
}

impl Backend for CpalAudio {
    fn play(&self, samples: &[f32], rate: u32, done: Done) {
        let samples = match self.resampler.lock() {
            Ok(mut slot) => match &mut *slot {
                Some(r) if r.from_rate() == rate => r.process(samples),
                slot => slot
                    .insert(Resampler::new(rate, self.rate))
                    .process(samples),
            },
            Err(_) => Vec::new(),
        };
        let Ok(mut queue) = self.queue.lock() else {
            done();
            return;
        };
        queue.push(&samples, done);
    }

    fn stop(&self) {
        let done = match self.queue.lock() {
            Ok(mut q) => q.clear(),
            Err(_) => Vec::new(),
        };
        if let Ok(mut r) = self.resampler.lock() {
            *r = None;
        }
        done.into_iter().for_each(|d| d());
    }

    fn healthy(&self) -> bool {
        !self.broken.load(Ordering::SeqCst)
    }
}

/// Whether Desk may use the microphone: on Windows, Settings → Privacy →
/// Microphone (for every app, and for desktop apps); elsewhere the system
/// doesn't say.
pub fn mic_access() -> super::MicAccess {
    #[cfg(windows)]
    {
        windows_mic::access()
    }
    #[cfg(not(windows))]
    {
        super::MicAccess::Unknown
    }
}

#[cfg(windows)]
mod windows_mic {
    use super::super::MicAccess;
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_SZ, RegGetValueW};

    const STORE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The consent store's `Value` under `key`: "Allow" or "Deny".
    fn value(key: &str) -> Option<String> {
        let (key, name) = (wide(key), wide("Value"));
        let mut buf = [0u16; 32];
        let mut len = std::mem::size_of_val(&buf) as u32;
        // SAFETY: both names end in NUL; the buffer and its length in bytes
        // are ours, and RegGetValueW writes no more than `len` bytes.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buf.as_mut_ptr().cast(),
                &mut len,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let chars = (len as usize / 2).min(buf.len());
        Some(
            String::from_utf16_lossy(&buf[..chars])
                .trim_end_matches('\0')
                .to_string(),
        )
    }

    pub fn access() -> MicAccess {
        let all = value(STORE);
        let desktop = value(&format!(r"{STORE}\NonPackaged"));
        super::super::decide(all.as_deref(), desktop.as_deref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn counting(n: &Arc<AtomicUsize>) -> Done {
        let n = n.clone();
        Box::new(move || {
            n.fetch_add(1, Ordering::SeqCst);
        })
    }

    #[test]
    fn queued_speech_plays_in_order_then_silence() {
        let mut q = Queue::default();
        let done = Arc::new(AtomicUsize::new(0));
        q.push(&[0.1, 0.2, 0.3], counting(&done));
        q.push(&[0.4], counting(&done));
        let mut out = [9.0; 2];
        assert!(q.take(&mut out).is_empty());
        assert_eq!(out, [0.1, 0.2]);
        let mut out = [9.0; 4];
        let finished = q.take(&mut out);
        assert_eq!(out, [0.3, 0.4, 0.0, 0.0]);
        assert_eq!(finished.len(), 2);
        finished.into_iter().for_each(|d| d());
        assert_eq!(done.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn stopping_drops_what_is_queued_and_finishes_it() {
        let mut q = Queue::default();
        let done = Arc::new(AtomicUsize::new(0));
        q.push(&[0.5; 100], counting(&done));
        q.push(&[0.5; 100], counting(&done));
        let mut out = [0.0; 10];
        assert!(q.take(&mut out).is_empty());
        q.clear().into_iter().for_each(|d| d());
        assert_eq!(done.load(Ordering::SeqCst), 2);
        assert!(q.take(&mut out).is_empty());
        assert_eq!(out, [0.0; 10]);
        // Speech queued after a stop still plays and finishes.
        q.push(&[0.7], counting(&done));
        let finished = q.take(&mut out);
        assert_eq!((out[0], finished.len()), (0.7, 1));
    }

    #[test]
    fn an_empty_buffer_finishes_at_once() {
        let mut q = Queue::default();
        let done = Arc::new(AtomicUsize::new(0));
        q.push(&[], counting(&done));
        assert_eq!(q.take(&mut []).len(), 1);
    }

    /// Plays a little silence on the default output device and waits for
    /// it to finish.
    #[test]
    #[ignore = "plays a little silence on the default output device"]
    fn plays_through_the_speaker() {
        let audio = start(
            Attempt {
                input: None,
                output: None,
                listen: false,
                cancel_echo: false,
            },
            None,
        )
        .unwrap();
        let (tx, rx) = mpsc::channel();
        audio.play(
            &vec![0.0; 2400],
            24_000,
            Box::new(move || tx.send(()).unwrap()),
        );
        rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    }
}
