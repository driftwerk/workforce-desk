//! Microphone and speaker through cpal: WASAPI on Windows; ALSA, which
//! PulseAudio and PipeWire answer, on Linux. There is no echo canceller, so
//! the microphone goes quiet while Desk speaks and for a moment after.

use std::collections::VecDeque;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, StreamConfig};
use eyre::{Result, eyre};

use super::gate::Speaking;
use crate::resample::Resampler;
use crate::{AudioIn, AudioOut, SharedAudioOut};

type Done = Box<dyn FnOnce() + Send>;

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
    speaking: Arc<Speaking>,
    /// Dropping it ends the thread that owns the streams.
    _streams: mpsc::Sender<()>,
}

/// Opens the microphone (to `input`, mono at its own rate) and the speaker.
pub fn open(input: AudioIn) -> Result<SharedAudioOut> {
    Ok(Arc::new(start(Some(input))?))
}

/// Just the speaker side: for playing a sample while voice is off.
pub fn output() -> Result<SharedAudioOut> {
    Ok(Arc::new(start(None)?))
}

/// Builds and plays the streams on a thread of their own, which keeps them
/// until the returned audio is dropped (a stream needn't be `Send`).
fn start(input: Option<AudioIn>) -> Result<CpalAudio> {
    let queue = Arc::new(Mutex::new(Queue::default()));
    let speaking = Arc::new(Speaking::default());
    let (ready_tx, ready_rx) = mpsc::channel();
    let (keep_tx, keep_rx) = mpsc::channel::<()>();
    {
        let (queue, speaking) = (queue.clone(), speaking.clone());
        std::thread::Builder::new()
            .name("voice-audio".into())
            .spawn(move || {
                let streams = streams(input, queue, speaking);
                let rate = streams
                    .as_ref()
                    .map(|(_, rate)| *rate)
                    .map_err(|e| eyre!("{e:#}"));
                let _ = ready_tx.send(rate);
                // Until the audio is dropped.
                let _ = keep_rx.recv();
                drop(streams);
            })?;
    }
    let rate = ready_rx
        .recv()
        .map_err(|_| eyre!("the audio thread stopped before it started"))??;
    Ok(CpalAudio {
        queue,
        rate,
        resampler: Mutex::new(None),
        speaking,
        _streams: keep_tx,
    })
}

type Streams = (Vec<cpal::Stream>, u32);

fn streams(
    input: Option<AudioIn>,
    queue: Arc<Mutex<Queue>>,
    speaking: Arc<Speaking>,
) -> Result<Streams> {
    let host = cpal::default_host();
    let speaker = host
        .default_output_device()
        .ok_or_else(|| eyre!("no speaker or headphones"))?;
    let out = speaker.default_output_config()?;
    let rate = out.sample_rate();
    let mut streams = vec![match out.sample_format() {
        SampleFormat::F32 => play::<f32>(&speaker, out.config(), queue, speaking.clone())?,
        SampleFormat::I16 => play::<i16>(&speaker, out.config(), queue, speaking.clone())?,
        SampleFormat::U16 => play::<u16>(&speaker, out.config(), queue, speaking.clone())?,
        SampleFormat::I32 => play::<i32>(&speaker, out.config(), queue, speaking.clone())?,
        other => return Err(eyre!("the speaker plays {other} samples, which Desk can't")),
    }];
    if let Some(input) = input {
        let mic = host
            .default_input_device()
            .ok_or_else(|| eyre!("no microphone"))?;
        let config = mic.default_input_config()?;
        let input: Arc<dyn Fn(&[f32], u32) + Send + Sync> = Arc::from(input);
        streams.push(match config.sample_format() {
            SampleFormat::F32 => hear::<f32>(&mic, config.config(), input, speaking)?,
            SampleFormat::I16 => hear::<i16>(&mic, config.config(), input, speaking)?,
            SampleFormat::U16 => hear::<u16>(&mic, config.config(), input, speaking)?,
            SampleFormat::I32 => hear::<i32>(&mic, config.config(), input, speaking)?,
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

fn play<T>(
    device: &cpal::Device,
    config: StreamConfig,
    queue: Arc<Mutex<Queue>>,
    speaking: Arc<Speaking>,
) -> Result<cpal::Stream>
where
    T: SizedSample + FromSample<f32>,
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
                speaking.finished();
                d();
            }
        },
        |e| tracing::warn!("voice: the speaker stopped: {e}"),
        None,
    )?)
}

fn hear<T>(
    device: &cpal::Device,
    config: StreamConfig,
    input: Arc<dyn Fn(&[f32], u32) + Send + Sync>,
    speaking: Arc<Speaking>,
) -> Result<cpal::Stream>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = usize::from(config.channels.max(1));
    let rate = config.sample_rate;
    let (mut mono, mut silence) = (Vec::new(), Vec::new());
    Ok(device.build_input_stream::<T, _, _>(
        config,
        move |data: &[T], _| {
            mono.clear();
            mono.extend(data.chunks(channels).map(|frame| {
                frame.iter().map(|s| f32::from_sample(*s)).sum::<f32>() / frame.len() as f32
            }));
            input(speaking.gated(&mono, &mut silence), rate);
        },
        |e| tracing::warn!("voice: the microphone stopped: {e}"),
        None,
    )?)
}

impl AudioOut for CpalAudio {
    fn play(&self, samples: &[f32], rate: u32, done: Box<dyn FnOnce() + Send>) {
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
        self.speaking.started();
        queue.push(&samples, done);
    }

    fn stop(&self) {
        let done = match self.queue.lock() {
            Ok(mut q) => q.clear(),
            Err(_) => Vec::new(),
        };
        self.speaking.stopped();
        if let Ok(mut r) = self.resampler.lock() {
            *r = None;
        }
        done.into_iter().for_each(|d| d());
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
        let audio = start(None).unwrap();
        let (tx, rx) = mpsc::channel();
        audio.play(
            &vec![0.0; 2400],
            24_000,
            Box::new(move || tx.send(()).unwrap()),
        );
        rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    }
}
