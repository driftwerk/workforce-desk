//! A whole cascade with test doubles for the microphone, the speaker, the
//! models and the voices: what the speaker plays comes back into the
//! microphone, as it would in a room, and each model is simulated.

use std::collections::VecDeque;
use std::sync::atomic::AtomicBool;

use super::*;
use crate::Utterance;
use crate::hub::{CloudSpeech, SpeechError};
use crate::speech::{Ears, Sound};
use crate::voices::Provider;

const FRAME: usize = 512;
/// How loud the agent's voice comes back, and a person.
const ECHO_LEVEL: f32 = 0.05;
const PERSON_LEVEL: f32 = 0.4;
/// The simulated model's own timings, as Silero is configured.
const ONSET_FRAMES: usize = 8;
const SILENCE_FRAMES: usize = 22;

/// What the simulated recogniser makes of the agent's voice coming back.
#[derive(Clone, Copy)]
enum EchoHeardAs {
    Nothing,
    /// The sentence that was playing when it was heard.
    Reply,
}

/// Simulated models: the voice model fires on anything above a low level; the
/// recogniser tells a person from the echo by how loud it is.
struct FakeEars {
    heard_as: EchoHeardAs,
    person_says: String,
    room: Arc<Room>,
    /// The sentence playing in the last frame heard.
    sentence: usize,
    onset: VecDeque<f32>,
    audio: Vec<f32>,
    loud_run: usize,
    quiet_run: usize,
    in_speech: bool,
    window: Vec<f32>,
    transcriptions: Arc<AtomicU64>,
}

impl Ears for FakeEars {
    fn feed(&mut self, samples: &[f32], out: &mut dyn FnMut(Sound)) {
        for &s in samples {
            self.window.push(s);
            if self.window.len() < FRAME {
                continue;
            }
            if let Some(sentence) = self.room.heard_over.lock().unwrap().pop_front() {
                self.sentence = sentence;
            }
            let level = (self.window.iter().map(|x| x * x).sum::<f32>() / FRAME as f32).sqrt();
            if self.in_speech {
                self.audio.extend_from_slice(&self.window);
            } else {
                self.onset.extend(self.window.iter().copied());
                let excess = self.onset.len().saturating_sub(FRAME * ONSET_FRAMES);
                self.onset.drain(..excess);
            }
            self.window.clear();
            if level > 0.02 {
                self.loud_run += 1;
                self.quiet_run = 0;
            } else {
                self.quiet_run += 1;
                self.loud_run = 0;
            }
            if !self.in_speech && self.loud_run >= ONSET_FRAMES {
                self.in_speech = true;
                self.audio = self.onset.drain(..).collect();
                out(Sound::SpeechStarted);
            }
            if self.in_speech && self.quiet_run >= SILENCE_FRAMES {
                self.in_speech = false;
                out(Sound::Segment(std::mem::take(&mut self.audio)));
            }
        }
    }

    fn flush(&mut self, _out: &mut dyn FnMut(Sound)) {}

    fn set_names(&mut self, _names: &[String]) -> Result<()> {
        Ok(())
    }

    fn names(&self) -> &[String] {
        &[]
    }

    fn since_onset(&self, max: usize) -> Vec<f32> {
        self.audio[self.audio.len().saturating_sub(max)..].to_vec()
    }

    fn reset(&mut self) {}

    fn reset_spotter(&self) {}

    fn transcribe(&mut self, samples: &[f32]) -> String {
        self.transcriptions.fetch_add(1, Ordering::SeqCst);
        let peak = samples.iter().fold(0.0f32, |p, s| p.max(s.abs()));
        if peak > PERSON_LEVEL / 2.0 {
            return self.person_says.clone();
        }
        match self.heard_as {
            EchoHeardAs::Nothing => String::new(),
            EchoHeardAs::Reply => {
                let rendered = self.room.rendered.lock().unwrap();
                rendered.get(self.sentence).cloned().unwrap_or_default()
            }
        }
    }
}

/// The speaker and the microphone: played audio comes back at `ECHO_LEVEL`,
/// faster than real time, mixed with whatever the person says.
/// What's queued to play, and what to call when it has.
type Playing = (Vec<f32>, Option<Box<dyn FnOnce() + Send>>);

struct Room {
    /// How loud the agent's voice comes back.
    echo: f32,
    /// What every sentence sounds like.
    voice: Audio,
    /// Played audio on its way to the microphone, with the sentence it's of:
    /// a speaker may say a sentence is done this long before the room has
    /// heard the end of it.
    in_flight: Mutex<VecDeque<(Vec<f32>, usize)>>,
    playing: Mutex<VecDeque<Playing>>,
    /// Every sentence the voices have made, in order.
    rendered: Mutex<Vec<String>>,
    /// Which of them was playing in each frame the microphone heard.
    heard_over: Mutex<VecDeque<usize>>,
    person: Mutex<VecDeque<f32>>,
    played: AtomicU64,
    stops: AtomicU64,
    /// How much the person had said when playback stopped, in samples.
    person_said: AtomicU64,
    person_fed: AtomicU64,
    /// Frames the microphone has been given.
    frames: AtomicU64,
    closed: AtomicBool,
}

impl Room {
    fn with_echo(echo: f32) -> Self {
        Self {
            echo,
            voice: second(),
            in_flight: Mutex::default(),
            playing: Mutex::default(),
            rendered: Mutex::default(),
            heard_over: Mutex::default(),
            person: Mutex::default(),
            played: AtomicU64::new(0),
            stops: AtomicU64::new(0),
            person_said: AtomicU64::new(0),
            person_fed: AtomicU64::new(0),
            frames: AtomicU64::new(0),
            closed: AtomicBool::new(false),
        }
    }

    /// Every sentence sounds like `voice`.
    fn saying(self, voice: Audio) -> Self {
        Self { voice, ..self }
    }

    /// What's played reaches the microphone `lag` after the speaker says it's done.
    fn lagging(self, lag: Duration) -> Self {
        let frames = (lag.as_secs_f32() * 16_000.0) as usize / FRAME;
        let in_flight = (0..frames).map(|_| (vec![0.0; FRAME], 0)).collect();
        Self {
            in_flight: Mutex::new(in_flight),
            ..self
        }
    }
}

struct RoomOut(Arc<Room>);

impl AudioOut for RoomOut {
    fn play(&self, samples: &[f32], rate: u32, done: Box<dyn FnOnce() + Send>) {
        assert_eq!(
            rate, 16_000,
            "the voices here make speech at the mic's rate"
        );
        let mut playing = self.0.playing.lock().unwrap();
        playing.push_back((samples.to_vec(), Some(done)));
    }

    fn lag(&self) -> Duration {
        let frames = self.0.in_flight.lock().unwrap().len();
        Duration::from_secs_f32((frames * FRAME) as f32 / 16_000.0)
    }

    fn stop(&self) {
        self.0.stops.fetch_add(1, Ordering::SeqCst);
        self.0
            .person_said
            .store(self.0.person_fed.load(Ordering::SeqCst), Ordering::SeqCst);
        let dropped: Vec<_> = self.0.playing.lock().unwrap().drain(..).collect();
        for (_, done) in dropped {
            if let Some(done) = done {
                done();
            }
        }
    }
}

use crate::AudioOut;

impl Room {
    /// The next frame the microphone hears, and what's finished playing.
    fn frame(&self) -> Vec<f32> {
        let mut frame = vec![0.0; FRAME];
        let mut finished = None;
        let played = self.played.load(Ordering::SeqCst) as usize;
        let sentence;
        {
            let mut playing = self.playing.lock().unwrap();
            // With nothing playing, what's heard is what played last.
            sentence = if playing.is_empty() {
                played.saturating_sub(1)
            } else {
                played
            };
            if let Some((samples, done)) = playing.front_mut() {
                let n = FRAME.min(samples.len());
                for (slot, s) in frame.iter_mut().zip(samples.drain(..n)) {
                    *slot += s * self.echo;
                }
                if samples.is_empty() {
                    finished = done.take();
                    playing.pop_front();
                    self.played.fetch_add(1, Ordering::SeqCst);
                }
            }
        }
        if let Some(done) = finished {
            done();
        }
        let (mut frame, sentence) = {
            let mut in_flight = self.in_flight.lock().unwrap();
            in_flight.push_back((frame, sentence));
            in_flight.pop_front().unwrap()
        };
        self.heard_over.lock().unwrap().push_back(sentence);
        self.frames.fetch_add(1, Ordering::SeqCst);
        let mut person = self.person.lock().unwrap();
        for slot in &mut frame {
            if let Some(s) = person.pop_front() {
                *slot += s;
                self.person_fed.fetch_add(1, Ordering::SeqCst);
            }
        }
        frame
    }

    fn says(&self, seconds: f32) {
        let n = (16_000.0 * seconds) as usize;
        self.person.lock().unwrap().extend((0..n).map(|i| {
            if i % 2 == 0 {
                PERSON_LEVEL
            } else {
                -PERSON_LEVEL
            }
        }));
    }
}

/// A sentence as a second of tone at full level; it comes back at `ECHO_LEVEL`.
fn second() -> Audio {
    Audio {
        samples: (0..16_000)
            .map(|i| if i % 2 == 0 { 1.0 } else { -1.0 })
            .collect(),
        rate: 16_000,
    }
}

struct Local {
    said: Mutex<Vec<String>>,
    room: Arc<Room>,
}

impl LocalSpeech for Local {
    fn synthesize(&self, text: &str, _voice: Option<&str>) -> Option<Audio> {
        self.said.lock().unwrap().push(text.to_string());
        self.room.rendered.lock().unwrap().push(text.to_string());
        Some(self.room.voice.clone())
    }
}

/// A cloud voice that speaks its first `works` sentences, then fails.
struct Cloud {
    works: usize,
    said: Mutex<Vec<String>>,
    room: Arc<Room>,
}

impl CloudSpeech for Cloud {
    fn speak(&self, _voice: &VoiceSpec, text: &str) -> Result<Audio, SpeechError> {
        let mut said = self.said.lock().unwrap();
        if said.len() >= self.works {
            return Err(SpeechError::Provider("the voice is down".into()));
        }
        said.push(text.to_string());
        self.room.rendered.lock().unwrap().push(text.to_string());
        Ok(self.room.voice.clone())
    }
}

#[derive(Default)]
struct Recorded {
    utterances: Mutex<Vec<Utterance>>,
    errors: Mutex<Vec<String>>,
    stopped: Mutex<Vec<StopReason>>,
}

impl VoiceEvents for Recorded {
    fn state(&self, _state: &VoiceState) {}

    fn utterance(&self, utterance: &Utterance) {
        self.utterances.lock().unwrap().push(utterance.clone());
    }

    fn unheard(&self) {}

    fn error(&self, message: &str) {
        self.errors.lock().unwrap().push(message.to_string());
    }

    fn stopped(&self, reason: StopReason) {
        self.stopped.lock().unwrap().push(reason);
    }
}

struct Sim {
    engine: Cascade,
    room: Arc<Room>,
    events: Arc<Recorded>,
    local: Arc<Local>,
    cloud: Arc<Cloud>,
    transcriptions: Arc<AtomicU64>,
    feeder: Option<JoinHandle<()>>,
}

const REPLY: &str =
    "The build failed at three today. Two tests timed out again. Want me to rerun them now?";

/// A reply of about 300 words, which has most short phrases somewhere in it.
pub(crate) const LONG_REPLY: &str = "\
I looked at the failing job this morning and went through the logs from the last three runs. \
The build fails because the cache key changed when the lockfile was updated last week. \
So the runner restored an old dependency set and carried on as if nothing had happened. \
Two tests then timed out waiting for a service that never started on that runner. \
Nothing in the application code caused it, and the same commit passes on a clean machine. \
I can fix it by pinning the key to the lockfile hash and adding a health check. \
The health check runs before the tests and fails quickly if the service isn't up. \
That should also make the nightly run faster, since it will reuse the cache properly. \
The nightly run has been taking about forty minutes, and most of that is installing packages. \
With the cache working I would expect it to come down to around fifteen minutes. \
There is one more thing I noticed while reading through the workflow file yesterday. \
The retry step wraps the whole suite, which hides flaky tests instead of reporting them. \
I would rather retry only the tests that failed and print a summary at the end. \
That is a separate change, so I would keep it out of this one and do it next. \
The other open question is the deploy job, which still depends on the old cache. \
It won't break today, but it will once the old key expires at the end of the month. \
I can update it in the same change, or leave it for whoever owns the deploy job. \
Do you want me to open a pull request with that change now? \
Or would you rather look at the workflow file first and tell me what you think? \
If you do want the pull request, I will ask for a review from the platform team. \
Then I can run the whole suite twice on a clean runner to be sure it holds. \
And I can tell you what I find about the timeout once that has finished running.";

impl Sim {
    fn new(heard_as: EchoHeardAs, person_says: &str, cloud_works: usize) -> Self {
        Self::in_room(
            Room::with_echo(ECHO_LEVEL),
            heard_as,
            person_says,
            cloud_works,
        )
    }

    fn in_room(room: Room, heard_as: EchoHeardAs, person_says: &str, cloud_works: usize) -> Self {
        let room = Arc::new(room);
        let events = Arc::new(Recorded::default());
        let local = Arc::new(Local {
            said: Mutex::new(Vec::new()),
            room: room.clone(),
        });
        let cloud = Arc::new(Cloud {
            works: cloud_works,
            said: Mutex::new(Vec::new()),
            room: room.clone(),
        });
        let transcriptions = Arc::new(AtomicU64::new(0));
        let ears = FakeEars {
            heard_as,
            person_says: person_says.to_string(),
            room: room.clone(),
            sentence: 0,
            onset: VecDeque::new(),
            audio: Vec::new(),
            loud_run: 0,
            quiet_run: 0,
            in_speech: false,
            window: Vec::new(),
            transcriptions: transcriptions.clone(),
        };
        let listener = Listener::with_ears(Box::new(ears), Timing::default(), Instant::now());
        let voices = Voices {
            kokoro: local.clone(),
            cloud: Some(cloud.clone()),
        };
        let mic: Arc<Mutex<Option<AudioIn>>> = Arc::new(Mutex::new(None));
        let (out_room, mic_slot) = (room.clone(), mic.clone());
        let engine = Cascade::with_listener(listener, voices, events.clone(), move |input| {
            *mic_slot.lock().unwrap() = Some(input);
            Ok(Arc::new(RoomOut(out_room)))
        })
        .unwrap();
        engine.set_mode(ListenMode::Open);
        let feeder = {
            let room = room.clone();
            std::thread::spawn(move || {
                while !room.closed.load(Ordering::SeqCst) {
                    let frame = room.frame();
                    if let Some(input) = mic.lock().unwrap().as_ref() {
                        input(&frame, 16_000);
                    }
                    // Faster than real time, still in order with the threads.
                    std::thread::sleep(Duration::from_micros(1_500));
                }
            })
        };
        Self {
            engine,
            room,
            events,
            local,
            cloud,
            transcriptions,
            feeder: Some(feeder),
        }
    }

    fn fish(&self) -> Option<VoiceSpec> {
        Some(VoiceSpec {
            provider: Provider::FishAudio,
            model: Some("s1".into()),
            voice: None,
        })
    }

    fn played(&self) -> u64 {
        self.room.played.load(Ordering::SeqCst)
    }

    fn wait_for(&self, what: &str, done: impl Fn(&Self) -> bool) {
        let start = Instant::now();
        while !done(self) {
            assert!(
                start.elapsed() < Duration::from_secs(20),
                "waiting for {what}"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// Lets `seconds` of the room's audio reach the microphone. Counted in
    /// frames, not waited for on the clock: a slow runner feeds fewer frames
    /// a millisecond, and the listener only knows the time from the audio.
    fn hears_for(&self, seconds: f32) {
        let from = self.room.frames.load(Ordering::SeqCst);
        let frames = (16_000.0 * seconds) as u64 / FRAME as u64;
        self.wait_for("the room's audio to reach the microphone", |s| {
            s.room.frames.load(Ordering::SeqCst) >= from + frames
        });
    }

    fn spoke_to_the_end(&self) {
        self.wait_for("the reply to finish", |s| {
            s.played() >= 3 && s.engine.state() != VoiceState::Speaking
        });
        std::thread::sleep(Duration::from_millis(50));
    }
}

impl Drop for Sim {
    fn drop(&mut self) {
        self.room.closed.store(true, Ordering::SeqCst);
        if let Some(feeder) = self.feeder.take() {
            let _ = feeder.join();
        }
    }
}

/// Its own voice keeps the voice model firing the whole reply, and transcribes
/// as the reply. Every sentence is said; nothing is sent as if the person said it.
#[test]
fn playback_is_not_stopped_by_its_own_echo() {
    let sim = Sim::new(EchoHeardAs::Reply, "", 9);
    sim.engine.speak(REPLY.into(), sim.fish());
    sim.spoke_to_the_end();
    assert_eq!(sim.room.stops.load(Ordering::SeqCst), 0);
    assert_eq!(sim.cloud.said.lock().unwrap().len(), 3);
    assert!(sim.events.stopped.lock().unwrap().is_empty());
    assert!(
        sim.events.utterances.lock().unwrap().is_empty(),
        "its own voice went to the agent"
    );
    assert!(
        sim.transcriptions.load(Ordering::SeqCst) <= 4,
        "a steady echo becomes the level to beat, so it stops costing transcriptions: {}",
        sim.transcriptions.load(Ordering::SeqCst)
    );
}

/// What set the voice model off had no words in it.
#[test]
fn playback_is_not_stopped_by_noise_with_no_words() {
    let sim = Sim::new(EchoHeardAs::Nothing, "", 9);
    sim.engine.speak(REPLY.into(), sim.fish());
    sim.spoke_to_the_end();
    assert_eq!(sim.room.stops.load(Ordering::SeqCst), 0);
    assert!(sim.events.utterances.lock().unwrap().is_empty());
}

/// A real barge-in stops it within a second of speech, drops the rest of the
/// reply, and what was said goes to the agent, whole.
#[test]
fn someone_talking_over_it_stops_it() {
    let sim = Sim::new(EchoHeardAs::Reply, "hold on a second", 9);
    sim.engine.speak(REPLY.into(), sim.fish());
    sim.wait_for("the reply to start", |s| {
        s.engine.state() == VoiceState::Speaking
    });
    sim.room.says(2.0);
    sim.wait_for("it to stop", |s| s.room.stops.load(Ordering::SeqCst) > 0);
    let heard = sim.room.person_said.load(Ordering::SeqCst) as f32 / 16_000.0;
    assert!(heard <= 1.0, "stopped after {heard} s of speech");
    assert_eq!(*sim.events.stopped.lock().unwrap(), [StopReason::BargeIn]);
    sim.wait_for("what they said", |s| {
        !s.events.utterances.lock().unwrap().is_empty()
    });
    let said = sim.events.utterances.lock().unwrap();
    assert_eq!(said.len(), 1);
    assert_eq!(said[0].text, "hold on a second");
    assert!(sim.played() < 3, "the rest of the reply was dropped");
}

/// The echo canceller has it all, and a word too short to be sustained still
/// interrupts, once it's over.
#[test]
fn a_short_word_stops_it_too() {
    let sim = Sim::in_room(Room::with_echo(0.0), EchoHeardAs::Nothing, "wait", 9);
    sim.engine.speak(REPLY.into(), sim.fish());
    sim.wait_for("the reply to start", |s| {
        s.engine.state() == VoiceState::Speaking
    });
    sim.room.says(0.3);
    sim.wait_for("it to stop", |s| s.room.stops.load(Ordering::SeqCst) > 0);
    assert_eq!(*sim.events.stopped.lock().unwrap(), [StopReason::BargeIn]);
    sim.wait_for("what they said", |s| {
        !s.events.utterances.lock().unwrap().is_empty()
    });
    assert_eq!(sim.events.utterances.lock().unwrap()[0].text, "wait");
}

/// Someone talks over an echo the voice model has been firing on throughout.
#[test]
fn someone_talking_over_a_steady_echo_still_stops_it() {
    let sim = Sim::new(EchoHeardAs::Reply, "no leave that one", 9);
    sim.engine.speak(REPLY.into(), sim.fish());
    sim.wait_for("the echo to be judged", |s| {
        s.transcriptions.load(Ordering::SeqCst) >= 1
    });
    sim.room.says(2.0);
    sim.wait_for("it to stop", |s| s.room.stops.load(Ordering::SeqCst) > 0);
    assert_eq!(*sim.events.stopped.lock().unwrap(), [StopReason::BargeIn]);
}

/// The cloud voice fails mid-reply: Kokoro says the rest. Not silence, and the
/// person is told.
#[test]
fn a_failing_voice_falls_back_without_silence() {
    let sim = Sim::new(EchoHeardAs::Nothing, "", 1);
    sim.engine.speak(REPLY.into(), sim.fish());
    sim.spoke_to_the_end();
    assert_eq!(
        *sim.cloud.said.lock().unwrap(),
        ["The build failed at three today."]
    );
    assert_eq!(
        *sim.local.said.lock().unwrap(),
        ["Two tests timed out again.", "Want me to rerun them now?"]
    );
    assert_eq!(*sim.events.errors.lock().unwrap(), ["the voice is down"]);
    assert_eq!(sim.played(), 3);
    assert_eq!(sim.room.stops.load(Ordering::SeqCst), 0);
}

/// Kokoro told to speak directions it can't perform: they're gone.
#[test]
fn the_fallback_voice_never_reads_a_direction() {
    let sim = Sim::new(EchoHeardAs::Nothing, "", 0);
    sim.engine
        .speak("(excited) Found it today.".into(), sim.fish());
    sim.wait_for("the fallback", |s| !s.local.said.lock().unwrap().is_empty());
    assert_eq!(*sim.local.said.lock().unwrap(), ["Found it today."]);
}

/// Stop asks to stop, and says so.
#[test]
fn being_asked_to_stop_stops_and_says_why() {
    let sim = Sim::new(EchoHeardAs::Nothing, "", 9);
    sim.engine.speak(REPLY.into(), sim.fish());
    sim.wait_for("the reply to start", |s| {
        s.engine.state() == VoiceState::Speaking
    });
    sim.engine.stop_speaking();
    sim.wait_for("it to stop", |s| s.room.stops.load(Ordering::SeqCst) > 0);
    assert_eq!(*sim.events.stopped.lock().unwrap(), [StopReason::Asked]);
}

/// Just after the reply, its tail isn't the person either.
#[test]
fn the_tail_of_the_reply_is_not_sent_to_the_agent() {
    let sim = Sim::new(EchoHeardAs::Reply, "", 9);
    sim.engine
        .speak("Two tests timed out again.".into(), sim.fish());
    sim.wait_for("the reply to finish", |s| {
        s.played() >= 1 && s.engine.state() != VoiceState::Speaking
    });
    std::thread::sleep(Duration::from_millis(100));
    assert!(sim.events.utterances.lock().unwrap().is_empty());
}

/// A sentence of tone with a pause in it, long enough for the voice model to
/// end a stretch, and a short last word after it.
fn paused() -> Audio {
    let tone = |seconds: f32| {
        (0..(16_000.0 * seconds) as usize).map(|i| if i % 2 == 0 { 1.0 } else { -1.0 })
    };
    Audio {
        samples: tone(0.4)
            .chain(std::iter::repeat_n(0.0, 16_000 * 4 / 5))
            .chain(tone(0.3))
            .collect(),
        rate: 16_000,
    }
}

/// A speaker that says a sentence is done when it has taken it, before the
/// room has heard the end of it: the last word after a pause starts a stretch
/// of its own once the reply looks over. It's still the reply, not the person.
#[test]
fn the_tail_is_not_sent_however_late_the_room_hears_it() {
    let room = Room::with_echo(ECHO_LEVEL)
        .saying(paused())
        .lagging(Duration::from_millis(700));
    let sim = Sim::in_room(room, EchoHeardAs::Reply, "", 9);
    sim.engine
        .speak("Two tests timed out again.".into(), sim.fish());
    sim.wait_for("the reply to finish", |s| {
        s.played() >= 1 && s.engine.state() != VoiceState::Speaking
    });
    // What was in flight, and the stretch it starts, have ended.
    std::thread::sleep(Duration::from_millis(700));
    assert!(sim.events.utterances.lock().unwrap().is_empty());
}

/// A real phrase over a long reply, whose words are all further on in it.
#[test]
fn a_short_phrase_stops_a_long_reply_and_is_sent() {
    let sim = Sim::new(EchoHeardAs::Nothing, "open the pull request", 99);
    sim.engine.speak(LONG_REPLY.into(), sim.fish());
    sim.wait_for("the reply to start", |s| s.played() >= 1);
    sim.room.says(2.0);
    sim.wait_for("it to stop", |s| s.room.stops.load(Ordering::SeqCst) > 0);
    assert_eq!(*sim.events.stopped.lock().unwrap(), [StopReason::BargeIn]);
    sim.wait_for("what they said", |s| {
        !s.events.utterances.lock().unwrap().is_empty()
    });
    assert_eq!(
        sim.events.utterances.lock().unwrap()[0].text,
        "open the pull request"
    );
}

/// Said in the moments after a long reply: it's the person answering it.
#[test]
fn what_is_said_just_after_a_long_reply_is_sent() {
    let sim = Sim::new(EchoHeardAs::Nothing, "what about the timeout", 99);
    sim.engine.speak(LONG_REPLY.into(), sim.fish());
    sim.wait_for("the reply to finish", |s| {
        s.played() >= 22 && s.engine.state() != VoiceState::Speaking
    });
    // Long enough for what the echo left going to end: under the 4 s of memory.
    sim.hears_for(1.0);
    sim.room.says(1.0);
    sim.wait_for("what they said", |s| {
        !s.events.utterances.lock().unwrap().is_empty()
    });
    assert_eq!(
        sim.events.utterances.lock().unwrap()[0].text,
        "what about the timeout"
    );
}

/// The same words, said out loud over the sentence they're in: louder than the
/// playback, so someone said them.
#[test]
fn a_fragment_of_what_is_playing_said_out_loud_stops_it() {
    let sim = Sim::in_room(Room::with_echo(0.0), EchoHeardAs::Nothing, "two tests", 9);
    sim.engine.speak(
        "Two tests timed out again. Want me to rerun them?".into(),
        sim.fish(),
    );
    sim.wait_for("the reply to start", |s| {
        s.engine.state() == VoiceState::Speaking && !s.room.rendered.lock().unwrap().is_empty()
    });
    sim.room.says(0.3);
    sim.wait_for("it to stop", |s| s.room.stops.load(Ordering::SeqCst) > 0);
    assert_eq!(*sim.events.stopped.lock().unwrap(), [StopReason::BargeIn]);
}

/// Words of the sentence playing, whole, said after the audio went quiet: it can't
/// be coming back, so it's the person, whatever the words.
#[test]
fn the_replys_own_words_after_it_went_quiet_are_the_person() {
    let sim = Sim::new(EchoHeardAs::Nothing, "two tests timed out again", 9);
    sim.engine
        .speak("Two tests timed out again.".into(), sim.fish());
    sim.wait_for("the reply to finish", |s| {
        s.played() >= 1 && s.engine.state() != VoiceState::Speaking
    });
    sim.hears_for(1.0);
    sim.room.says(1.0);
    sim.wait_for("what they said", |s| {
        !s.events.utterances.lock().unwrap().is_empty()
    });
    assert_eq!(
        sim.events.utterances.lock().unwrap()[0].text,
        "two tests timed out again"
    );
}

/// Once what was said has stopped a reply as someone talking, it isn't then held
/// to be the reply when it ends, whatever words it came to.
#[test]
fn what_stopped_a_reply_is_sent_whatever_it_says() {
    let sim = Sim::new(EchoHeardAs::Nothing, "no not the build failed at three", 9);
    sim.engine.speak(REPLY.into(), sim.fish());
    sim.wait_for("the reply to start", |s| s.played() >= 1);
    sim.room.says(2.0);
    sim.wait_for("what they said", |s| {
        !s.events.utterances.lock().unwrap().is_empty()
    });
    assert_eq!(
        sim.events.utterances.lock().unwrap()[0].text,
        "no not the build failed at three"
    );
}
