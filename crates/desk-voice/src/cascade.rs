//! The local cascade engine: VAD → keyword spotting → ASR in, Kokoro out,
//! on two threads. The listener thread owns the models and the conversation;
//! the speaker thread synthesises sentence by sentence so long answers start
//! playing quickly, and stops the moment the user talks over it.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use eyre::Result;

use crate::conversation::Timing;
use crate::resample::{Resampler, SPEECH_RATE};
use crate::speech::{Heard, Listener, Speaker, sentences};
use crate::{AudioIn, Models, SharedAudioOut, VoiceEngine, VoiceEvents, VoiceState};

enum Input {
    Audio(Vec<f32>, u32),
    Names(Vec<String>),
    PushToTalk(bool),
    Speak { text: String, more: bool },
    StopSpeaking,
    Spoken { generation: u64, more: bool },
    Shutdown,
}

struct Job {
    text: String,
    more: bool,
    generation: u64,
}

pub struct Cascade {
    tx: Sender<Input>,
    state: Arc<Mutex<VoiceState>>,
    threads: Vec<JoinHandle<()>>,
}

const TICK: Duration = Duration::from_millis(100);

impl Cascade {
    /// Loads the models, then opens audio with `open`, which is handed the
    /// callback microphone samples go to.
    pub fn start(
        models: &Models,
        events: Arc<dyn VoiceEvents>,
        open: impl FnOnce(AudioIn) -> Result<SharedAudioOut>,
    ) -> Result<Self> {
        let listener = Listener::new(models, Timing::default(), Instant::now())?;
        let speaker = Speaker::new(models)?;
        let (tx, rx) = channel();
        let audio_tx = tx.clone();
        let out = open(Box::new(move |samples, rate| {
            let _ = audio_tx.send(Input::Audio(samples.to_vec(), rate));
        }))?;
        let generation = Arc::new(AtomicU64::new(0));
        let (jobs_tx, jobs_rx) = channel();
        let state = Arc::new(Mutex::new(VoiceState::Listening { conversation: None }));
        events.state(&VoiceState::Listening { conversation: None });

        let speaking = {
            let (out, generation, tx) = (out.clone(), generation.clone(), tx.clone());
            std::thread::Builder::new()
                .name("voice-speaker".into())
                .spawn(move || speak(&speaker, &out, &generation, &tx, &jobs_rx))?
        };
        let listening = {
            let worker = Worker {
                listener,
                resampler: None,
                out,
                events,
                state: state.clone(),
                generation,
                jobs: jobs_tx,
                pending: 0,
            };
            std::thread::Builder::new()
                .name("voice-listener".into())
                .spawn(move || worker.run(&rx))?
        };
        Ok(Self {
            tx,
            state,
            threads: vec![listening, speaking],
        })
    }

    fn send(&self, input: Input) {
        let _ = self.tx.send(input);
    }
}

impl VoiceEngine for Cascade {
    fn set_names(&self, names: Vec<String>) {
        self.send(Input::Names(names));
    }

    fn push_to_talk(&self, pressed: bool) {
        self.send(Input::PushToTalk(pressed));
    }

    fn speak(&self, text: String, more: bool) {
        self.send(Input::Speak { text, more });
    }

    fn stop_speaking(&self) {
        self.send(Input::StopSpeaking);
    }

    /// The cascade answers by speaking, so no request of its own carries a
    /// call id; a stray result has nothing to go to.
    fn tool_result(&self, call_id: String, _text: String) {
        tracing::debug!(call_id, "the on-device engine has no pending calls");
    }

    fn state(&self) -> VoiceState {
        self.state
            .lock()
            .map(|s| s.clone())
            .unwrap_or(VoiceState::Off)
    }
}

impl Drop for Cascade {
    fn drop(&mut self) {
        self.send(Input::Shutdown);
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }
}

struct Worker {
    listener: Listener,
    resampler: Option<Resampler>,
    out: SharedAudioOut,
    events: Arc<dyn VoiceEvents>,
    state: Arc<Mutex<VoiceState>>,
    generation: Arc<AtomicU64>,
    jobs: Sender<Job>,
    pending: usize,
}

impl Worker {
    fn run(mut self, rx: &Receiver<Input>) {
        loop {
            match rx.recv_timeout(TICK) {
                Ok(Input::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
                Ok(input) => self.handle(input),
                Err(RecvTimeoutError::Timeout) => {}
            }
            self.listener.tick(Instant::now());
            self.publish(self.listener.state());
        }
        self.out.stop();
    }

    fn handle(&mut self, input: Input) {
        let now = Instant::now();
        match input {
            Input::Audio(samples, rate) => {
                let resampler = match &mut self.resampler {
                    Some(r) if r.from_rate() == rate => r,
                    slot => slot.insert(Resampler::new(rate, SPEECH_RATE)),
                };
                let samples = resampler.process(&samples);
                self.listen(|l, out| l.feed(&samples, now, out));
            }
            Input::Names(names) => {
                if let Err(e) = self.listener.set_names(&names) {
                    tracing::warn!("voice: {e:#}");
                }
            }
            Input::PushToTalk(true) => {
                if self.listener.start_push_to_talk(now) {
                    self.silence();
                }
            }
            Input::PushToTalk(false) => self.listen(|l, out| l.finish_push_to_talk(now, out)),
            Input::Speak { text, more } => {
                self.pending += 1;
                self.listener.speaking();
                let generation = self.generation.load(Ordering::SeqCst);
                let _ = self.jobs.send(Job {
                    text,
                    more,
                    generation,
                });
            }
            Input::StopSpeaking => {
                self.silence();
                self.listener.spoken(now, false);
            }
            Input::Spoken { generation, more } => {
                if generation == self.generation.load(Ordering::SeqCst) && self.pending > 0 {
                    self.pending -= 1;
                    if self.pending == 0 {
                        self.listener.spoken(now, more);
                    }
                }
            }
            Input::Shutdown => {}
        }
    }

    /// Runs the listener, acting on what it hears as it hears it: barge-in
    /// must not wait for a transcription to finish.
    fn listen(&mut self, f: impl FnOnce(&mut Listener, &mut dyn FnMut(Heard))) {
        let mut barged = false;
        let (state, events, out, generation) =
            (&self.state, &*self.events, &self.out, &*self.generation);
        f(&mut self.listener, &mut |h| match h {
            Heard::BargeIn => {
                stop(out, generation);
                barged = true;
            }
            Heard::Transcribing => set_state(state, events, VoiceState::Transcribing),
            Heard::Utterance(u) => events.utterance(&u),
        });
        if barged {
            self.pending = 0;
        }
    }

    fn silence(&mut self) {
        stop(&self.out, &self.generation);
        self.pending = 0;
    }

    fn publish(&self, state: VoiceState) {
        set_state(&self.state, &*self.events, state);
    }
}

/// Stops playback and drops whatever was still to be said.
fn stop(out: &SharedAudioOut, generation: &AtomicU64) {
    generation.fetch_add(1, Ordering::SeqCst);
    out.stop();
}

fn set_state(current: &Mutex<VoiceState>, events: &dyn VoiceEvents, state: VoiceState) {
    let Ok(mut current) = current.lock() else {
        return;
    };
    if *current != state {
        events.state(&state);
        *current = state;
    }
}

fn speak(
    speaker: &Speaker,
    out: &SharedAudioOut,
    generation: &AtomicU64,
    tx: &Sender<Input>,
    jobs: &Receiver<Job>,
) {
    let rate = speaker.sample_rate();
    while let Ok(job) = jobs.recv() {
        let current = || generation.load(Ordering::SeqCst) == job.generation;
        let parts = sentences(&job.text);
        let mut scheduled = false;
        for (i, part) in parts.iter().enumerate() {
            if !current() {
                break;
            }
            let Some(samples) = speaker.synthesize(part) else {
                continue;
            };
            if !current() {
                break;
            }
            let done: Box<dyn FnOnce() + Send> = if i + 1 == parts.len() {
                let (tx, generation, more) = (tx.clone(), job.generation, job.more);
                Box::new(move || {
                    let _ = tx.send(Input::Spoken { generation, more });
                })
            } else {
                Box::new(|| {})
            };
            out.play(&samples, rate, done);
            scheduled = i + 1 == parts.len();
        }
        if !scheduled {
            let _ = tx.send(Input::Spoken {
                generation: job.generation,
                more: job.more,
            });
        }
    }
}
