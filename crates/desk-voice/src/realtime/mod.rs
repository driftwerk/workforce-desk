//! Cloud realtime engines: GPT-Live or Gemini Live is the conversational
//! surface and the named Desk agent does the work. The local wake path
//! still decides when the cloud may listen: a session opens on a roster name
//! (with the audio from that stretch of speech) or on push-to-talk, and
//! closes on the cascade's silence and "thanks" rules. Audio in and out goes
//! through the same voice-processing audio unit as the cascade.

pub mod gemini_live;
pub mod gpt_live;
pub mod lifetime;
pub mod pcm;
pub mod protocol;
mod socket;

use std::collections::HashSet;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use eyre::Result;

use self::lifetime::Lifetime;
use self::protocol::{Call, Live, Protocol};
use self::socket::{Opening, Outgoing};
use crate::conversation::Timing;
use crate::decode::Audio;
use crate::hub::Sessions;
use crate::resample::{Resampler, SPEECH_RATE};
use crate::speech::{Sound, Wake};
use crate::voices::{Member, VoiceSpec, live_voice};
use crate::{AudioIn, Models, SharedAudioOut, Utterance, VoiceEngine, VoiceEvents, VoiceState};

/// The most of what came before a wake the cloud may hear: enough for the
/// name and the start of the request, not the conversation before it.
const MAX_LOOKBACK: usize = SPEECH_RATE as usize * 3 / 2;
/// Buffered audio goes out in chunks of this many samples (100 ms).
const CHUNK: usize = SPEECH_RATE as usize / 10;
const TICK: Duration = Duration::from_millis(50);

/// What a realtime model asked an agent, as the app's utterance.
pub fn utterance(call: &Call) -> Utterance {
    Utterance {
        agent: call.agent.clone(),
        text: call.request.clone(),
        call_id: Some(call.id.clone()),
    }
}

enum Input {
    Audio(Vec<f32>, u32),
    Roster(Vec<Member>),
    Play(Audio),
    PushToTalk(bool),
    Say(String),
    ToolResult { id: String, text: String },
    StopSpeaking,
    Played,
    Live { session: u64, event: Live },
    Shutdown,
}

pub struct Realtime {
    tx: Sender<Input>,
    state: Arc<Mutex<VoiceState>>,
    thread: Option<JoinHandle<()>>,
}

impl Realtime {
    /// Loads the wake models, then opens audio with `open`.
    pub fn start(
        models: &Models,
        protocol: Arc<dyn Protocol>,
        sessions: Arc<dyn Sessions>,
        events: Arc<dyn VoiceEvents>,
        open: impl FnOnce(AudioIn) -> Result<SharedAudioOut>,
    ) -> Result<Self> {
        let wake = Wake::new(models)?;
        let (tx, rx) = channel();
        let audio_tx = tx.clone();
        let out = open(Box::new(move |samples, rate| {
            let _ = audio_tx.send(Input::Audio(samples.to_vec(), rate));
        }))?;
        let state = Arc::new(Mutex::new(VoiceState::Listening { conversation: None }));
        events.state(&VoiceState::Listening { conversation: None });
        let worker = Worker {
            wake,
            protocol,
            sessions,
            out,
            events,
            state: Arc::clone(&state),
            tx: tx.clone(),
            resampler: None,
            session: None,
            next_session: 0,
            playing: 0,
            decoder: pcm::Decoder::default(),
            roster: Vec::new(),
        };
        let thread = std::thread::Builder::new()
            .name("voice-realtime".into())
            .spawn(move || worker.run(&rx))?;
        Ok(Self {
            tx,
            state,
            thread: Some(thread),
        })
    }

    fn send(&self, input: Input) {
        let _ = self.tx.send(input);
    }
}

impl VoiceEngine for Realtime {
    fn set_roster(&self, roster: Vec<Member>) {
        self.send(Input::Roster(roster));
    }

    fn push_to_talk(&self, pressed: bool) {
        self.send(Input::PushToTalk(pressed));
    }

    /// The model says it, in its own words and the session's voice.
    fn speak(&self, text: String, _voice: Option<VoiceSpec>) {
        self.send(Input::Say(text));
    }

    fn play(&self, audio: Audio) {
        self.send(Input::Play(audio));
    }

    fn stop_speaking(&self) {
        self.send(Input::StopSpeaking);
    }

    fn tool_result(&self, call_id: String, text: String) {
        self.send(Input::ToolResult { id: call_id, text });
    }

    fn state(&self) -> VoiceState {
        self.state
            .lock()
            .map(|s| s.clone())
            .unwrap_or(VoiceState::Off)
    }
}

impl Drop for Realtime {
    fn drop(&mut self) {
        self.send(Input::Shutdown);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Opened by a name: the microphone streams until the session ends.
    Open,
    /// Push-to-talk held.
    Held,
    /// Push-to-talk released: listening for the answer, not to the room.
    Released,
}

struct Session {
    id: u64,
    link: Sender<Outgoing>,
    ready: bool,
    pending: Vec<f32>,
    opened_by: Option<String>,
    mode: Mode,
    calls: HashSet<String>,
    lifetime: Lifetime,
}

impl Session {
    fn send(&self, message: String) {
        let _ = self.link.send(Outgoing::Text(message));
    }

    fn streams(&self) -> bool {
        self.mode != Mode::Released
    }
}

struct Worker {
    wake: Wake,
    protocol: Arc<dyn Protocol>,
    sessions: Arc<dyn Sessions>,
    out: SharedAudioOut,
    events: Arc<dyn VoiceEvents>,
    state: Arc<Mutex<VoiceState>>,
    tx: Sender<Input>,
    resampler: Option<Resampler>,
    session: Option<Session>,
    next_session: u64,
    playing: usize,
    decoder: pcm::Decoder,
    roster: Vec<Member>,
}

impl Worker {
    fn run(mut self, rx: &Receiver<Input>) {
        loop {
            match rx.recv_timeout(TICK) {
                Ok(Input::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
                Ok(input) => self.handle(input, Instant::now()),
                Err(RecvTimeoutError::Timeout) => {}
            }
            self.tick(Instant::now());
            self.publish();
        }
        self.close();
    }

    fn handle(&mut self, input: Input, now: Instant) {
        match input {
            Input::Audio(samples, rate) => self.audio(&samples, rate, now),
            Input::Roster(roster) => {
                let names: Vec<String> = roster.iter().map(|m| m.name.clone()).collect();
                if let Err(e) = self.wake.set_names(&names) {
                    tracing::warn!("voice: {e:#}");
                }
                self.roster = roster;
            }
            Input::Play(audio) => self.play(&audio.samples, audio.rate, now),
            Input::PushToTalk(pressed) => self.push_to_talk(pressed, now),
            Input::Say(text) => match &self.session {
                Some(s) if s.ready => s.send(self.protocol.say(&text)),
                _ => tracing::debug!("nothing to say it in: no voice session is open"),
            },
            Input::ToolResult { id, text } => {
                if let Some(s) = &mut self.session
                    && s.calls.remove(&id)
                {
                    s.lifetime.settled(&id, now);
                    for m in self.protocol.tool_result(&id, &text) {
                        s.send(m);
                    }
                }
            }
            Input::StopSpeaking => self.out.stop(),
            Input::Played => {
                self.playing = self.playing.saturating_sub(1);
                if self.playing == 0 {
                    if let Some(s) = &mut self.session {
                        s.lifetime.playing(false, now);
                    }
                    self.wake.reset_spotter();
                }
            }
            Input::Live { session, event } => {
                if self.session.as_ref().is_some_and(|s| s.id == session) {
                    self.live(event, now);
                }
            }
            Input::Shutdown => {}
        }
    }

    fn audio(&mut self, samples: &[f32], rate: u32, now: Instant) {
        let resampler = match &mut self.resampler {
            Some(r) if r.from_rate() == rate => r,
            slot => slot.insert(Resampler::new(rate, SPEECH_RATE)),
        };
        let samples = resampler.process(samples);
        if let Some(s) = &mut self.session
            && s.streams()
        {
            if s.ready {
                s.send(self.protocol.audio(&samples));
            } else {
                s.pending.extend_from_slice(&samples);
            }
        }
        let mut sounds = Vec::new();
        self.wake.feed(&samples, &mut |s| sounds.push(s));
        for sound in sounds {
            match (sound, &mut self.session) {
                (Sound::Name(name), None) => {
                    let heard = self.wake.since_onset(MAX_LOOKBACK);
                    self.open(Some(name), Mode::Open, heard, now);
                }
                (Sound::SpeechStarted, Some(s)) => s.lifetime.speech_started(now),
                (Sound::Segment(_), Some(s)) => s.lifetime.speech_ended(now),
                _ => {}
            }
        }
    }

    fn push_to_talk(&mut self, pressed: bool, now: Instant) {
        if pressed {
            self.out.stop();
        }
        match (&mut self.session, pressed) {
            (None, true) => self.open(None, Mode::Held, Vec::new(), now),
            (Some(s), true) => {
                if s.mode != Mode::Open {
                    s.mode = Mode::Held;
                }
                s.lifetime.speech_started(now);
            }
            (Some(s), false) => {
                if s.mode == Mode::Held {
                    s.mode = Mode::Released;
                    if let Some(end) = self.protocol.audio_end() {
                        s.send(end);
                    }
                }
                s.lifetime.speech_ended(now);
            }
            (None, false) => {}
        }
    }

    fn open(&mut self, opened_by: Option<String>, mode: Mode, heard: Vec<f32>, now: Instant) {
        self.next_session += 1;
        let id = self.next_session;
        let tx = self.tx.clone();
        let engine = self.protocol.provider();
        let voice = opened_by
            .as_deref()
            .and_then(|name| self.roster.iter().find(|m| m.name == name))
            .and_then(|m| live_voice(m, engine))
            .map(String::from);
        let opening = Opening {
            sessions: Arc::clone(&self.sessions),
            protocol: Arc::clone(&self.protocol),
            names: self.roster.iter().map(|m| m.name.clone()).collect(),
            opened_by: opened_by.clone(),
            voice,
        };
        match socket::open(opening, move |event| {
            let _ = tx.send(Input::Live { session: id, event });
        }) {
            Ok(link) => {
                self.session = Some(Session {
                    id,
                    link,
                    ready: false,
                    pending: heard,
                    opened_by,
                    mode,
                    calls: HashSet::new(),
                    lifetime: Lifetime::new(Timing::default(), now),
                });
            }
            Err(e) => self
                .events
                .error(&format!("couldn't start a voice session: {e:#}")),
        }
    }

    fn live(&mut self, event: Live, now: Instant) {
        let Some(s) = &mut self.session else { return };
        match event {
            Live::Ready => {
                s.ready = true;
                for chunk in std::mem::take(&mut s.pending).chunks(CHUNK) {
                    s.send(self.protocol.audio(chunk));
                }
            }
            Live::Audio(bytes) => {
                let samples = self.decoder.decode(&bytes);
                self.play(&samples, self.protocol.output_rate(), now);
            }
            Live::Interrupted => {
                if self.playing > 0 {
                    self.out.stop();
                }
            }
            Live::Heard(text) => {
                if self.playing > 0 && s.lifetime.in_speech() {
                    self.out.stop();
                }
                s.lifetime.heard(&text, now);
            }
            Live::Call(call) => {
                s.calls.insert(call.id.clone());
                s.lifetime.call(&call.id, now);
                self.events.utterance(&utterance(&call));
            }
            Live::Cancelled(ids) => {
                for id in ids {
                    s.calls.remove(&id);
                    s.lifetime.settled(&id, now);
                }
            }
            Live::Error(message) => {
                tracing::warn!(message, "voice session");
                self.events.error(&message);
            }
            Live::Closed => self.ended(),
        }
    }

    fn play(&mut self, samples: &[f32], rate: u32, now: Instant) {
        if samples.is_empty() {
            return;
        }
        self.playing += 1;
        if let Some(s) = &mut self.session {
            s.lifetime.playing(true, now);
        }
        let tx = self.tx.clone();
        self.out.play(
            samples,
            rate,
            Box::new(move || {
                let _ = tx.send(Input::Played);
            }),
        );
    }

    fn tick(&mut self, now: Instant) {
        let Some(s) = &mut self.session else { return };
        if let Some(end) = s.lifetime.tick(now) {
            tracing::debug!(?end, "voice session over");
            self.close();
        }
    }

    fn close(&mut self) {
        if let Some(s) = &self.session {
            let _ = s.link.send(Outgoing::Close);
        }
        self.ended();
    }

    fn ended(&mut self) {
        self.session = None;
        self.out.stop();
        self.decoder = pcm::Decoder::default();
        self.wake.reset_spotter();
    }

    fn publish(&self) {
        let state = match &self.session {
            _ if self.playing > 0 => VoiceState::Speaking,
            Some(s) if s.ready => VoiceState::Live {
                agent: s.opened_by.clone(),
            },
            Some(Session {
                opened_by: Some(agent),
                ..
            }) => VoiceState::HeardName {
                agent: agent.clone(),
            },
            Some(_) => VoiceState::Live { agent: None },
            None => VoiceState::Listening { conversation: None },
        };
        let Ok(mut current) = self.state.lock() else {
            return;
        };
        if *current != state {
            self.events.state(&state);
            *current = state;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_call_becomes_an_utterance_that_carries_its_id() {
        let call = Call {
            id: "fc-1".into(),
            agent: Some("Atlas".into()),
            request: "what failed overnight?".into(),
        };
        let u = utterance(&call);
        assert_eq!(u.agent.as_deref(), Some("Atlas"));
        assert_eq!(u.text, "what failed overnight?");
        let json = serde_json::to_value(&u).unwrap();
        assert_eq!(json["callId"], "fc-1");
        let spoken = serde_json::to_value(Utterance::new(None, "hi")).unwrap();
        assert!(spoken.get("callId").is_none());
    }
}
