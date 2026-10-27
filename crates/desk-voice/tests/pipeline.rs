//! The real sherpa-onnx models end to end: Kokoro says a request, and the
//! listener has to wake on the name and transcribe the rest. Ignored by
//! default because it needs the models (about 240 MB, downloaded into the
//! Desk folder on first run):
//!
//! `cargo test -p desk-voice --test pipeline -- --ignored --nocapture`

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use desk_voice::conversation::Timing;
use desk_voice::keywords::{Keywords, SentencePiece, vocabulary};
use desk_voice::models::{self, KWS, Models};
use desk_voice::resample::{Resampler, SPEECH_RATE};
use desk_voice::speech::{Heard, Listener, Speaker};
use desk_voice::{AudioIn, AudioOut, Cascade, Utterance, VoiceEngine, VoiceEvents, VoiceState};

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

fn speaker() -> &'static Speaker {
    static SPEAKER: OnceLock<Speaker> = OnceLock::new();
    SPEAKER.get_or_init(|| Speaker::new(models()).unwrap())
}

fn spoken(text: &str) -> Vec<f32> {
    let samples = speaker().synthesize(text).unwrap();
    Resampler::new(speaker().sample_rate(), SPEECH_RATE).process(&samples)
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
            listener.speaking();
            listener.spoken(at(fed), false);
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
}

impl VoiceEvents for Recorded {
    fn state(&self, state: &VoiceState) {
        self.states.lock().unwrap().push(state.clone());
    }
    fn utterance(&self, utterance: &Utterance) {
        self.said.lock().unwrap().push(utterance.clone());
    }
    fn error(&self, message: &str) {
        panic!("voice error: {message}");
    }
}

/// Plays nothing; holds each buffer's completion until stopped, like a
/// player that is still talking.
#[derive(Default)]
struct HeldPlayback {
    played: Mutex<usize>,
    stops: Mutex<usize>,
    pending: Mutex<Vec<Box<dyn FnOnce() + Send>>>,
}

impl AudioOut for HeldPlayback {
    fn play(&self, _samples: &[f32], _rate: u32, done: Box<dyn FnOnce() + Send>) {
        *self.played.lock().unwrap() += 1;
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
        Cascade::start(models(), events.clone(), move |input| {
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
    engine.set_names(names());

    engine.speak(
        "Atlas is on it. The nightly build failed in the integration suite.".into(),
        false,
    );
    wait_for("playback", || *out.played.lock().unwrap() > 0);
    wait_for("speaking", || engine.state() == VoiceState::Speaking);

    let raw = speaker()
        .synthesize("Atlas, stop. Which test was it?")
        .unwrap();
    feed(&silence(0.5), SPEECH_RATE);
    feed(&raw, speaker().sample_rate());
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
    drop(engine);
}
