//! The real sherpa-onnx models end to end: Kokoro says a request, and the
//! listener has to wake on the name and transcribe the rest. Ignored by
//! default because it needs the models (about 240 MB, downloaded into the
//! Desk folder on first run):
//!
//! `cargo test -p desk-voice --test pipeline -- --ignored --nocapture`

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use desk_voice::cascade::Voices;
use desk_voice::conversation::Timing;
use desk_voice::hub::{CloudSpeech, SpeechError};
use desk_voice::keywords::{Keywords, SentencePiece, vocabulary};
use desk_voice::models::{self, KWS, Models};
use desk_voice::resample::{Resampler, SPEECH_RATE};
use desk_voice::speech::{Heard, Listener, Speaker};
use desk_voice::voices::{Member, Provider, VoiceSpec};
use desk_voice::{
    Audio, AudioIn, AudioOut, Cascade, Utterance, VoiceEngine, VoiceEvents, VoiceState,
};

fn models() -> &'static Models {
    static MODELS: OnceLock<Models> = OnceLock::new();
    MODELS.get_or_init(|| {
        let models = Models::new(models::default_dir(&desk_core::Paths::new().unwrap()));
        let mut shown = -1;
        models
            .ensure(&models::ALL, &AtomicBool::new(false), &mut |p| {
                let pct = (p.fraction() * 100.0) as i32;
                if pct / 10 != shown / 10 {
                    shown = pct;
                    eprintln!("downloading {} {pct}%", p.model);
                }
            })
            .unwrap();
        models
    })
}

fn speaker() -> Arc<Speaker> {
    static SPEAKER: OnceLock<Arc<Speaker>> = OnceLock::new();
    SPEAKER
        .get_or_init(|| Arc::new(Speaker::new(models()).unwrap()))
        .clone()
}

fn spoken(text: &str) -> Vec<f32> {
    let audio = speaker().synthesize(text, None).unwrap();
    Resampler::new(audio.rate, SPEECH_RATE).process(&audio.samples)
}

fn silence(seconds: f32) -> Vec<f32> {
    vec![0.0; (SPEECH_RATE as f32 * seconds) as usize]
}

fn names() -> Vec<String> {
    ["Allan", "Atlas", "scout"].map(String::from).to_vec()
}

/// Feeds audio as if it arrived in real time, returning what was sent.
/// Each request is answered at once, as if the reply had been read out.
fn listen(listener: &mut Listener, audio: &[f32]) -> Vec<Utterance> {
    let start = Instant::now();
    let at = |fed: usize| start + Duration::from_secs_f64(fed as f64 / f64::from(SPEECH_RATE));
    let mut said = Vec::new();
    let mut fed = 0;
    for chunk in audio.chunks(1_600) {
        fed += chunk.len();
        let before = said.len();
        listener.feed(chunk, at(fed), &mut |h| {
            if let Heard::Utterance(u) = h {
                said.push(u);
            }
        });
        if said.len() > before {
            listener.speaking("", at(fed));
            listener.spoken(at(fed));
        }
        listener.tick(at(fed));
    }
    listener.flush(at(fed), &mut |h| {
        if let Heard::Utterance(u) = h {
            said.push(u);
        }
    });
    said
}

fn listener() -> Listener {
    let mut l = Listener::new(models(), Timing::default(), Instant::now()).unwrap();
    l.set_names(&names()).unwrap();
    l
}

fn words(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect()
}

#[test]
#[ignore = "needs the speech models"]
fn tokenizer_spells_keywords_as_the_model_does() {
    let sp =
        SentencePiece::parse(&std::fs::read(models().file(&KWS, "bpe.model")).unwrap()).unwrap();
    let oracle = [
        ("HELLO WORLD", "▁HE LL O ▁WORLD"),
        ("HI GOOGLE", "▁HI ▁GO O G LE"),
        ("HEY SIRI", "▁HE Y ▁S I RI"),
        ("ALEXA", "▁A LE X A"),
        ("LOVE AND PEACE", "▁LOVE ▁AND ▁P E A CE"),
        ("PLAY MUSIC", "▁PLAY ▁MU S IC"),
        ("GO HOME", "▁GO ▁HOME"),
        ("HAPPY NEW YEAR", "▁HA PP Y ▁NEW ▁YEAR"),
        ("MERRY CHRISTMAS", "▁ME R RY ▁ CH R IST MA S"),
        ("LIGHT UP", "▁ L IGHT ▁UP"),
        ("LOVELY CHILD", "▁LOVE LY ▁CHI L D"),
        ("FOREVER", "▁FOR E VER"),
    ];
    for (raw, tokens) in oracle {
        assert_eq!(sp.encode(raw).join(" "), tokens, "{raw}");
    }
    let vocab = vocabulary(&std::fs::read_to_string(models().file(&KWS, "tokens.txt")).unwrap());
    let k = Keywords::build(
        &["Atlas".into(), "cc-auth-fix".into(), "Zoë".into()],
        &sp,
        &vocab,
    );
    eprintln!("{}", k.buffer());
    assert_eq!(k.names(), ["Atlas", "cc-auth-fix", "Zoë"]);
}

#[test]
#[ignore = "needs the speech models"]
fn wakes_on_a_name_follows_up_and_stops_at_thanks() {
    let audio = [
        silence(1.0),
        spoken("Atlas, what failed overnight?"),
        silence(2.0),
        spoken("And what about the night before?"),
        silence(2.0),
        spoken("Thanks, that's all."),
        silence(2.0),
        spoken("What is the weather like?"),
        silence(1.5),
    ]
    .concat();
    let said = listen(&mut listener(), &audio);
    eprintln!("{said:#?}");
    assert_eq!(said.len(), 2, "{said:?}");
    assert_eq!(said[0].agent.as_deref(), Some("Atlas"));
    let first = words(&said[0].text);
    assert!(
        first.contains("failed") && first.contains("overnight"),
        "{first}"
    );
    assert_eq!(said[1].agent, None);
    assert!(
        words(&said[1].text).contains("night before"),
        "{}",
        said[1].text
    );
}

#[test]
#[ignore = "needs the speech models"]
fn a_request_without_a_name_is_not_heard() {
    let audio = [silence(1.0), spoken("What failed overnight?"), silence(2.0)].concat();
    assert_eq!(listen(&mut listener(), &audio), []);
}

#[test]
#[ignore = "needs the speech models"]
fn after_eight_quiet_seconds_a_name_is_needed_again() {
    let audio = [
        silence(1.0),
        spoken("Scout, run the flaky test again."),
        silence(9.0),
        spoken("And then the whole suite."),
        silence(1.5),
    ]
    .concat();
    let said = listen(&mut listener(), &audio);
    assert_eq!(said.len(), 1, "{said:?}");
    assert_eq!(said[0].agent.as_deref(), Some("scout"));
}

#[derive(Default)]
struct Recorded {
    states: Mutex<Vec<VoiceState>>,
    said: Mutex<Vec<Utterance>>,
    errors: Mutex<Vec<String>>,
}

impl VoiceEvents for Recorded {
    fn state(&self, state: &VoiceState) {
        self.states.lock().unwrap().push(state.clone());
    }
    fn utterance(&self, utterance: &Utterance) {
        self.said.lock().unwrap().push(utterance.clone());
    }
    fn unheard(&self) {}
    fn error(&self, message: &str) {
        self.errors.lock().unwrap().push(message.into());
    }
}

/// Plays nothing; holds each buffer's completion until stopped, like a
/// player that is still talking.
#[derive(Default)]
struct HeldPlayback {
    played: Mutex<Vec<u32>>,
    stops: Mutex<usize>,
    pending: Mutex<Vec<Box<dyn FnOnce() + Send>>>,
}

impl AudioOut for HeldPlayback {
    fn play(&self, _samples: &[f32], rate: u32, done: Box<dyn FnOnce() + Send>) {
        self.played.lock().unwrap().push(rate);
        self.pending.lock().unwrap().push(done);
    }
    fn stop(&self) {
        *self.stops.lock().unwrap() += 1;
        let pending: Vec<_> = self.pending.lock().unwrap().drain(..).collect();
        pending.into_iter().for_each(|done| done());
    }
}

fn wait_for(what: &str, f: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
#[ignore = "needs the speech models"]
fn the_engine_stops_talking_when_talked_over_and_takes_push_to_talk() {
    let events = Arc::new(Recorded::default());
    let out = Arc::new(HeldPlayback::default());
    let mic: Arc<Mutex<Option<AudioIn>>> = Arc::default();
    let engine = {
        let (out, mic) = (out.clone(), mic.clone());
        let voices = Voices {
            kokoro: speaker(),
            cloud: None,
        };
        Cascade::start(models(), voices, events.clone(), move |input| {
            *mic.lock().unwrap() = Some(input);
            Ok(out)
        })
        .unwrap()
    };
    let feed = |samples: &[f32], rate: u32| {
        let mic = mic.lock().unwrap();
        for chunk in samples.chunks(4_096) {
            mic.as_ref().unwrap()(chunk, rate);
        }
    };
    engine.set_roster(roster());

    engine.speak(
        "The nightly build failed in the integration suite, in the payments tests.".into(),
        None,
    );
    wait_for("playback", || !out.played.lock().unwrap().is_empty());
    wait_for("speaking", || engine.state() == VoiceState::Speaking);

    let raw = speaker()
        .synthesize("Atlas, stop. Which test was it?", None)
        .unwrap();
    feed(&silence(0.5), SPEECH_RATE);
    feed(&raw.samples, raw.rate);
    feed(&silence(2.0), SPEECH_RATE);
    wait_for("barge-in", || *out.stops.lock().unwrap() > 0);
    wait_for("the interrupting request", || {
        !events.said.lock().unwrap().is_empty()
    });
    let said = events.said.lock().unwrap()[0].clone();
    eprintln!("{said:?}");
    assert_eq!(said.agent.as_deref(), Some("Atlas"));
    assert!(words(&said.text).contains("which test"), "{}", said.text);

    engine.push_to_talk(true);
    feed(
        &spoken("Allan, what's left before the release?"),
        SPEECH_RATE,
    );
    engine.push_to_talk(false);
    wait_for("the push-to-talk request", || {
        events.said.lock().unwrap().len() > 1
    });
    let ptt = events.said.lock().unwrap()[1].clone();
    eprintln!("{ptt:?}");
    assert_eq!(ptt.agent.as_deref(), Some("Allan"));
    assert!(words(&ptt.text).contains("release"), "{}", ptt.text);

    let states = events.states.lock().unwrap().clone();
    assert!(states.contains(&VoiceState::Transcribing));
    assert!(states.contains(&VoiceState::HeardName {
        agent: "Atlas".into()
    }));
    assert!(events.errors.lock().unwrap().is_empty());
    drop(engine);
}

/// A reply coming back into the microphone, far louder than an echo canceller
/// leaves it: the voice model fires and the recogniser hears the words, and it's
/// still the reply. It isn't stopped, and isn't sent to the agent as the person.
#[test]
#[ignore = "needs the speech models"]
fn its_own_voice_coming_back_doesnt_stop_it() {
    const REPLY: &str = "The nightly build failed in the integration suite, in the payments tests.";
    let events = Arc::new(Recorded::default());
    let out = Arc::new(HeldPlayback::default());
    let mic: Arc<Mutex<Option<AudioIn>>> = Arc::new(Mutex::new(None));
    let engine = {
        let (out, mic) = (out.clone(), mic.clone());
        Cascade::start(
            models(),
            Voices {
                kokoro: speaker(),
                cloud: None,
            },
            events.clone(),
            move |input| {
                *mic.lock().unwrap() = Some(input);
                Ok(out)
            },
        )
        .unwrap()
    };
    engine.set_mode(desk_voice::ListenMode::Open);
    engine.speak(REPLY.into(), None);
    wait_for("playback", || !out.played.lock().unwrap().is_empty());
    wait_for("speaking", || engine.state() == VoiceState::Speaking);

    let reply = speaker().synthesize(REPLY, None).unwrap();
    for gain in [0.3f32, 0.1] {
        let echo: Vec<f32> = reply.samples.iter().map(|s| s * gain).collect();
        {
            let mic = mic.lock().unwrap();
            let feed = mic.as_ref().unwrap();
            for chunk in echo.chunks(4_096) {
                feed(chunk, reply.rate);
            }
            for chunk in silence(1.5).chunks(1_600) {
                feed(chunk, SPEECH_RATE);
            }
        }
        std::thread::sleep(Duration::from_secs(3));
    }
    assert_eq!(*out.stops.lock().unwrap(), 0);
    assert_eq!(engine.state(), VoiceState::Speaking);
    assert!(events.said.lock().unwrap().is_empty());
    drop(engine);
}

fn roster() -> Vec<Member> {
    names()
        .into_iter()
        .map(|name| Member { name, voice: None })
        .collect()
}

/// A hub that speaks Fish Audio at 44.1 kHz and has no ElevenLabs key.
struct FakeCloud;

impl CloudSpeech for FakeCloud {
    fn speak(&self, voice: &VoiceSpec, _text: &str) -> Result<Audio, SpeechError> {
        match voice.provider {
            Provider::FishAudio => Ok(Audio {
                samples: vec![0.1; 4_410],
                rate: 44_100,
            }),
            _ => Err(SpeechError::NoKey(
                "Add an ElevenLabs key under Plans.".into(),
            )),
        }
    }
}

#[test]
#[ignore = "needs the speech models"]
fn each_answer_is_spoken_in_its_agents_voice() {
    let events = Arc::new(Recorded::default());
    let out = Arc::new(HeldPlayback::default());
    let voices = Voices {
        kokoro: speaker(),
        cloud: Some(Arc::new(FakeCloud)),
    };
    let engine = {
        let out = out.clone();
        Cascade::start(models(), voices, events.clone(), move |_| Ok(out)).unwrap()
    };
    let fish = VoiceSpec {
        provider: Provider::FishAudio,
        model: None,
        voice: Some("802e3bc2b27e49c2995d23ef70e6ac89".into()),
    };
    let played = |n: usize| {
        wait_for("playback", || out.played.lock().unwrap().len() >= n);
        out.stop();
        out.played.lock().unwrap()[n - 1]
    };
    engine.speak("Two tests failed.".into(), Some(fish));
    assert_eq!(played(1), 44_100, "the cloud voice, at its own rate");
    engine.speak(
        "Two tests failed.".into(),
        Some(VoiceSpec::kokoro("am_adam")),
    );
    assert_eq!(played(2), speaker().sample_rate());
    let eleven = VoiceSpec {
        provider: Provider::Elevenlabs,
        model: None,
        voice: Some("x".into()),
    };
    engine.speak("Two tests failed.".into(), Some(eleven));
    assert_eq!(
        played(3),
        speaker().sample_rate(),
        "Kokoro says it when the cloud can't"
    );
    assert_eq!(
        events.errors.lock().unwrap().as_slice(),
        ["Add an ElevenLabs key under Plans."]
    );
    engine.play(Audio {
        samples: vec![0.0; 800],
        rate: 8_000,
    });
    assert_eq!(played(4), 8_000);
}

#[test]
#[ignore = "needs the speech models"]
fn kokoro_voices_sound_different() {
    let say = |voice| speaker().synthesize("Hello there, Allan.", voice).unwrap();
    let distance = |a: &Audio, b: &Audio| {
        let n = a.samples.len().min(b.samples.len());
        let diff: f32 = a.samples[..n]
            .iter()
            .zip(&b.samples[..n])
            .map(|(x, y)| (x - y).abs())
            .sum();
        diff / n as f32 + a.samples.len().abs_diff(b.samples.len()) as f32 / n as f32
    };
    let (heart, adam) = (say(Some("af_heart")), say(Some("am_adam")));
    let (default, bella) = (say(None), say(Some("af_bella")));
    eprintln!(
        "heart vs adam {:.4}, default vs bella {:.6}",
        distance(&heart, &adam),
        distance(&default, &bella)
    );
    assert!(distance(&default, &bella) * 20.0 < distance(&heart, &adam));
    assert_eq!(heart.rate, 24_000);
}
