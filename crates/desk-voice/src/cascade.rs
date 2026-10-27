//! The local cascade engine: VAD → keyword spotting → ASR in; speech out in
//! the agent's voice (Kokoro on this Mac, or a cloud voice through the
//! hub), on two threads. The listener thread owns the models and the
//! conversation; the speaker thread synthesises sentence by sentence so long
//! answers start playing quickly, and stops the moment the user talks over it.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use eyre::Result;

use crate::conversation::Timing;
use crate::decode::Audio;
use crate::hub::CloudSpeech;
use crate::resample::{Resampler, SPEECH_RATE};
use crate::speech::{Heard, Listener, Speaker, sentences};
use crate::voices::{Member, VoiceSpec};
use crate::{AudioIn, Models, SharedAudioOut, VoiceEngine, VoiceEvents, VoiceState};

enum Input {
    Audio(Vec<f32>, u32),
    Names(Vec<String>),
    PushToTalk(bool),
    Speak(Speech, bool),
    StopSpeaking,
    Spoken { generation: u64, more: bool },
    Shutdown,
}

/// What to say: text in a voice, or audio already made.
enum Speech {
    Text(String, Option<VoiceSpec>),
    Audio(Audio),
}

struct Job {
    speech: Speech,
    more: bool,
    generation: u64,
}

/// How the cascade speaks: Kokoro here, cloud voices through the hub.
pub struct Voices {
    pub kokoro: Arc<Speaker>,
    pub cloud: Option<Arc<dyn CloudSpeech>>,
}

pub struct Cascade {
    tx: Sender<Input>,
    state: Arc<Mutex<VoiceState>>,
    threads: Vec<JoinHandle<()>>,
}

const TICK: Duration = Duration::from_millis(100);

impl Cascade {
    /// Loads the listening models, then opens audio with `open`, which is
    /// handed the callback microphone samples go to.
    pub fn start(
        models: &Models,
        voices: Voices,
        events: Arc<dyn VoiceEvents>,
        open: impl FnOnce(AudioIn) -> Result<SharedAudioOut>,
    ) -> Result<Self> {
        let listener = Listener::new(models, Timing::default(), Instant::now())?;
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
            let mouth = Mouth {
                voices,
                out: out.clone(),
                generation: generation.clone(),
                tx: tx.clone(),
                events: events.clone(),
            };
            std::thread::Builder::new()
                .name("voice-speaker".into())
                .spawn(move || mouth.run(&jobs_rx))?
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
    fn set_roster(&self, roster: Vec<Member>) {
        self.send(Input::Names(roster.into_iter().map(|m| m.name).collect()));
    }

    fn push_to_talk(&self, pressed: bool) {
        self.send(Input::PushToTalk(pressed));
    }

    fn speak(&self, text: String, more: bool, voice: Option<VoiceSpec>) {
        self.send(Input::Speak(Speech::Text(text, voice), more));
    }

    fn play(&self, audio: Audio) {
        self.send(Input::Speak(Speech::Audio(audio), false));
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
            Input::Speak(speech, more) => {
                self.pending += 1;
                self.listener.speaking();
                let generation = self.generation.load(Ordering::SeqCst);
                let _ = self.jobs.send(Job {
                    speech,
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

/// The speaker thread.
struct Mouth {
    voices: Voices,
    out: SharedAudioOut,
    generation: Arc<AtomicU64>,
    tx: Sender<Input>,
    events: Arc<dyn VoiceEvents>,
}

impl Mouth {
    fn run(&self, jobs: &Receiver<Job>) {
        while let Ok(Job {
            speech,
            more,
            generation,
        }) = jobs.recv()
        {
            let parts = match speech {
                Speech::Audio(audio) => vec![Part::Audio(audio)],
                Speech::Text(text, voice) => sentences(&text)
                    .into_iter()
                    .map(|s| Part::Text(s, voice.clone()))
                    .collect(),
            };
            self.say(parts, generation, more);
        }
    }

    fn say(&self, parts: Vec<Part>, generation: u64, more: bool) {
        let current = || self.generation.load(Ordering::SeqCst) == generation;
        let mut cloud_failed = false;
        let mut scheduled = false;
        let count = parts.len();
        for (i, part) in parts.into_iter().enumerate() {
            if !current() {
                break;
            }
            let Some(audio) = self.render(part, &mut cloud_failed) else {
                continue;
            };
            if !current() {
                break;
            }
            let last = i + 1 == count;
            let done: Box<dyn FnOnce() + Send> = if last {
                let tx = self.tx.clone();
                Box::new(move || {
                    let _ = tx.send(Input::Spoken { generation, more });
                })
            } else {
                Box::new(|| {})
            };
            self.out.play(&audio.samples, audio.rate, done);
            scheduled = last;
        }
        if !scheduled {
            let _ = self.tx.send(Input::Spoken { generation, more });
        }
    }

    /// A sentence as audio, in its voice. A cloud voice that can't speak is
    /// reported once, and Kokoro says the rest.
    fn render(&self, part: Part, cloud_failed: &mut bool) -> Option<Audio> {
        let (text, voice) = match part {
            Part::Audio(audio) => return Some(audio),
            Part::Text(text, voice) => (text, voice),
        };
        if let (Some(spec), Some(cloud), false) = (&voice, &self.voices.cloud, *cloud_failed)
            && spec.provider.is_cloud_speech()
        {
            match cloud.speak(spec, &text) {
                Ok(audio) => return Some(audio),
                Err(e) => {
                    *cloud_failed = true;
                    self.events.error(&e.to_string());
                }
            }
        }
        let kokoro = voice
            .as_ref()
            .filter(|v| v.provider == crate::voices::Provider::Kokoro)
            .and_then(|v| v.voice.as_deref());
        self.voices.kokoro.synthesize(&text, kokoro)
    }
}

enum Part {
    Text(String, Option<VoiceSpec>),
    Audio(Audio),
}
