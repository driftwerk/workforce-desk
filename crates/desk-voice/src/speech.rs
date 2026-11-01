//! The sherpa-onnx models wired together: Silero VAD cuts speech into
//! segments, the keyword spotter listens for roster names, Parakeet
//! transcribes the segments worth hearing, and Kokoro speaks.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use eyre::{Context, Result, eyre};
use sherpa_onnx::{
    GenerationConfig, KeywordSpotter, KeywordSpotterConfig, OfflineRecognizer,
    OfflineRecognizerConfig, OfflineTransducerModelConfig, OfflineTts, OfflineTtsConfig,
    OfflineTtsKokoroModelConfig, OfflineTtsModelConfig, OnlineStream, OnlineTransducerModelConfig,
    SileroVadModelConfig, VadModelConfig, VoiceActivityDetector,
};

use crate::barge::{Barge, Verdict, judge};
use crate::conversation::{Conversation, ListenMode, Phase, Timing};
use crate::decode::Audio;
use crate::directions::without_directions;
use crate::keywords::{Keywords, SentencePiece, vocabulary};
use crate::models::{ASR, KWS, Models, TTS, VAD};
use crate::resample::SPEECH_RATE;
use crate::voices::kokoro_speaker;
use crate::{Utterance, VoiceState};

const VAD_WINDOW: usize = 512;
const MAX_SPEECH_SECONDS: f32 = 20.0;
/// Silero marks speech a little late; soft onsets ("Scout") need this much
/// of what came before the segment to be transcribed whole.
const PRE_ROLL: u64 = SPEECH_RATE as u64 * 2 / 5;
const RATE: i32 = SPEECH_RATE as i32;
/// As much of what's being said over playback as is transcribed to judge it.
const JUDGED: usize = SPEECH_RATE as usize * 2;
/// How long after a reply what's heard might still be the reply.
const ECHO_MEMORY: Duration = Duration::from_secs(4);

/// What the listener noticed while being fed.
#[derive(Debug, Clone, PartialEq)]
pub enum Heard {
    /// Someone talked over playback: stop speaking.
    BargeIn,
    /// A segment is being transcribed.
    Transcribing,
    Utterance(Utterance),
    /// Push-to-talk was let go with nothing said.
    Nothing,
}

struct Spotter {
    spotter: KeywordSpotter,
    stream: OnlineStream,
    keywords: Keywords,
}

/// What the wake path heard.
#[derive(Debug, Clone, PartialEq)]
pub enum Sound {
    /// A roster name, exactly as given to `set_names`.
    Name(String),
    SpeechStarted,
    /// A finished stretch of speech, with a little audio from before it.
    Segment(Vec<f32>),
}

/// Silero VAD and the keyword spotter over the 16 kHz microphone stream,
/// with the recent audio kept by sample index.
pub struct Wake {
    vad: VoiceActivityDetector,
    tokenizer: SentencePiece,
    vocabulary: HashSet<String>,
    spotter_config: KeywordSpotterConfig,
    spotter: Option<Spotter>,
    window: Vec<f32>,
    recent: Recent,
    in_speech: bool,
    onset: Option<u64>,
}

const MIN_SPEECH_SECONDS: f32 = 0.25;

impl Wake {
    pub fn new(models: &Models) -> Result<Self> {
        let vad = VoiceActivityDetector::create(
            &VadModelConfig {
                silero_vad: SileroVadModelConfig {
                    model: Some(models.file_str(&VAD, "silero_vad.onnx")),
                    threshold: 0.5,
                    min_silence_duration: 0.7,
                    min_speech_duration: MIN_SPEECH_SECONDS,
                    window_size: VAD_WINDOW as i32,
                    max_speech_duration: MAX_SPEECH_SECONDS,
                },
                sample_rate: RATE,
                num_threads: 1,
                ..Default::default()
            },
            30.0,
        )
        .ok_or_else(|| eyre!("couldn't load the voice activity model"))?;
        let tokenizer = SentencePiece::parse(&std::fs::read(models.file(&KWS, "bpe.model"))?)
            .context("reading the wake model")?;
        let vocabulary = vocabulary(&std::fs::read_to_string(models.file(&KWS, "tokens.txt"))?);
        let mut spotter_config = KeywordSpotterConfig::default();
        spotter_config.model_config.transducer = OnlineTransducerModelConfig {
            encoder: Some(
                models.file_str(&KWS, "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
            ),
            decoder: Some(models.file_str(&KWS, "decoder-epoch-12-avg-2-chunk-16-left-64.onnx")),
            joiner: Some(models.file_str(&KWS, "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx")),
        };
        spotter_config.model_config.tokens = Some(models.file_str(&KWS, "tokens.txt"));
        spotter_config.model_config.num_threads = 1;
        spotter_config.keywords_threshold = 0.15;
        Ok(Self {
            vad,
            tokenizer,
            vocabulary,
            spotter_config,
            spotter: None,
            window: Vec::with_capacity(VAD_WINDOW),
            recent: Recent::new((MAX_SPEECH_SECONDS as usize + 2) * SPEECH_RATE as usize),
            in_speech: false,
            onset: None,
        })
    }

    /// Listens for these names from now on. With none, nothing wakes it.
    pub fn set_names(&mut self, names: &[String]) -> Result<()> {
        let keywords = Keywords::build(names, &self.tokenizer, &self.vocabulary);
        if self
            .spotter
            .as_ref()
            .is_some_and(|s| s.keywords == keywords)
        {
            return Ok(());
        }
        self.spotter = None;
        if keywords.is_empty() {
            return Ok(());
        }
        let config = KeywordSpotterConfig {
            keywords_buf: Some(keywords.buffer()),
            ..self.spotter_config.clone()
        };
        let spotter =
            KeywordSpotter::create(&config).ok_or_else(|| eyre!("couldn't load the wake model"))?;
        let stream = spotter.create_stream();
        self.spotter = Some(Spotter {
            spotter,
            stream,
            keywords,
        });
        Ok(())
    }

    pub fn names(&self) -> &[String] {
        self.spotter.as_ref().map_or(&[], |s| s.keywords.names())
    }

    /// 16 kHz mono audio, in any chunk size. Names in a chunk are reported
    /// before its speech edges.
    pub fn feed(&mut self, samples: &[f32], out: &mut dyn FnMut(Sound)) {
        self.recent.push(samples);
        self.spot(samples, out);
        for &s in samples {
            self.window.push(s);
            if self.window.len() == VAD_WINDOW {
                self.vad.accept_waveform(&self.window);
                self.window.clear();
                self.after_window(out);
            }
        }
    }

    /// Ends the input: whatever speech is pending is treated as finished.
    pub fn flush(&mut self, out: &mut dyn FnMut(Sound)) {
        self.vad.flush();
        self.after_window(out);
    }

    fn spot(&mut self, samples: &[f32], out: &mut dyn FnMut(Sound)) {
        let Some(s) = &mut self.spotter else { return };
        s.stream.accept_waveform(RATE, samples);
        while s.spotter.is_ready(&s.stream) {
            s.spotter.decode(&s.stream);
            let Some(hit) = s
                .spotter
                .get_result(&s.stream)
                .filter(|r| !r.keyword.is_empty())
            else {
                continue;
            };
            s.spotter.reset(&s.stream);
            if let Some(name) = s.keywords.name(&hit.keyword) {
                tracing::debug!(name, "heard a name");
                out(Sound::Name(name.to_string()));
            }
        }
    }

    fn after_window(&mut self, out: &mut dyn FnMut(Sound)) {
        let detected = self.vad.detected();
        if detected && !self.in_speech {
            let lead = (MIN_SPEECH_SECONDS * SPEECH_RATE as f32) as u64 + VAD_WINDOW as u64;
            self.onset = Some(self.recent.end.saturating_sub(lead + PRE_ROLL));
            out(Sound::SpeechStarted);
        }
        while let Some(segment) = self.vad.front() {
            let start = u64::try_from(segment.start()).unwrap_or_default();
            let samples = [
                self.recent.slice(start.saturating_sub(PRE_ROLL), start),
                segment.samples().to_vec(),
            ]
            .concat();
            self.vad.pop();
            out(Sound::Segment(samples));
        }
        if !detected {
            self.onset = None;
        }
        self.in_speech = detected;
    }

    /// The audio since the current stretch of speech began (a little before
    /// it, as for segments), but no more than `max` samples: what a cloud
    /// session is allowed to hear of what woke it.
    pub fn since_onset(&self, max: usize) -> Vec<f32> {
        let end = self.recent.end;
        let earliest = end.saturating_sub(max as u64);
        let from = self.onset.map_or(earliest, |o| o.max(earliest));
        self.recent.slice(from, end)
    }

    /// Starts afresh: after push-to-talk, or when our own voice may be in
    /// the spotter's context.
    pub fn reset(&mut self) {
        self.vad.reset();
        self.recent.clear();
        self.window.clear();
        self.in_speech = false;
        self.onset = None;
        self.reset_spotter();
    }

    pub fn reset_spotter(&self) {
        if let Some(s) = &self.spotter {
            s.spotter.reset(&s.stream);
        }
    }
}

/// The listener's models: voice activity, the name spotter, and speech
/// recognition. A trait so a whole pipeline can be tested without them.
pub trait Ears: Send {
    /// 16 kHz mono audio, in any chunk size.
    fn feed(&mut self, samples: &[f32], out: &mut dyn FnMut(Sound));
    /// Ends the input: whatever speech is pending is treated as finished.
    fn flush(&mut self, out: &mut dyn FnMut(Sound));
    fn set_names(&mut self, names: &[String]) -> Result<()>;
    fn names(&self) -> &[String];
    /// The audio since the current speech began, but no more than `max` samples.
    fn since_onset(&self, max: usize) -> Vec<f32>;
    /// Starts afresh.
    fn reset(&mut self);
    fn reset_spotter(&self);
    fn transcribe(&mut self, samples: &[f32]) -> String;
}

/// [`Ears`] on the real models.
struct OnDevice {
    wake: Wake,
    asr: OfflineRecognizer,
}

impl Ears for OnDevice {
    fn feed(&mut self, samples: &[f32], out: &mut dyn FnMut(Sound)) {
        self.wake.feed(samples, out);
    }

    fn flush(&mut self, out: &mut dyn FnMut(Sound)) {
        self.wake.flush(out);
    }

    fn set_names(&mut self, names: &[String]) -> Result<()> {
        self.wake.set_names(names)
    }

    fn names(&self) -> &[String] {
        self.wake.names()
    }

    fn since_onset(&self, max: usize) -> Vec<f32> {
        self.wake.since_onset(max)
    }

    fn reset(&mut self) {
        self.wake.reset();
    }

    fn reset_spotter(&self) {
        self.wake.reset_spotter();
    }

    fn transcribe(&mut self, samples: &[f32]) -> String {
        let stream = self.asr.create_stream();
        stream.accept_waveform(RATE, samples);
        self.asr.decode(&stream);
        stream
            .get_result()
            .map(|r| r.text.trim().to_string())
            .unwrap_or_default()
    }
}

fn recognizer(models: &Models) -> Result<OfflineRecognizer> {
    let mut config = OfflineRecognizerConfig::default();
    config.model_config.transducer = OfflineTransducerModelConfig {
        encoder: Some(models.file_str(&ASR, "encoder.int8.onnx")),
        decoder: Some(models.file_str(&ASR, "decoder.int8.onnx")),
        joiner: Some(models.file_str(&ASR, "joiner.int8.onnx")),
    };
    config.model_config.tokens = Some(models.file_str(&ASR, "tokens.txt"));
    config.model_config.num_threads = 2;
    OfflineRecognizer::create(&config)
        .ok_or_else(|| eyre!("couldn't load the speech recognition model"))
}

/// What Desk has been saying, so its own voice coming back isn't taken for
/// the person.
#[derive(Default)]
struct Said {
    text: String,
    /// Until when it might still come back; `None` while it's being said.
    until: Option<Instant>,
}

impl Said {
    fn speaking(&mut self, text: &str, now: Instant) {
        if self.until.is_some_and(|t| now >= t) {
            self.text.clear();
        }
        self.until = None;
        self.text.push(' ');
        self.text.push_str(&without_directions(text));
    }

    fn over(&mut self, now: Instant) {
        self.until = Some(now + ECHO_MEMORY);
    }

    /// Whether `heard`, now, is our own voice.
    fn echoes(&self, heard: &str, now: Instant) -> bool {
        self.until.is_none_or(|t| now < t) && judge(heard, &self.text) == Verdict::Echo
    }
}

/// The cascade's listener: the wake path, the conversation, and Parakeet for
/// the segments worth hearing.
pub struct Listener {
    ears: Box<dyn Ears>,
    conversation: Conversation,
    push_to_talk: Option<Vec<f32>>,
    transcribing: bool,
    barge: Barge,
    said: Said,
    /// A name heard in what's being judged over playback: it counts if that
    /// turns out to be someone talking.
    named: Option<String>,
}

impl Listener {
    pub fn new(models: &Models, timing: Timing, now: Instant) -> Result<Self> {
        let ears = OnDevice {
            wake: Wake::new(models)?,
            asr: recognizer(models)?,
        };
        Ok(Self::with_ears(Box::new(ears), timing, now))
    }

    /// A listener on `ears`.
    pub fn with_ears(ears: Box<dyn Ears>, timing: Timing, now: Instant) -> Self {
        Self {
            ears,
            conversation: Conversation::new(timing, now),
            push_to_talk: None,
            transcribing: false,
            barge: Barge::default(),
            said: Said::default(),
            named: None,
        }
    }

    /// Listens for these names from now on. With none, only push-to-talk works.
    pub fn set_names(&mut self, names: &[String]) -> Result<()> {
        tracing::info!(?names, "voice: listening for names");
        self.ears.set_names(names)
    }

    pub fn names(&self) -> &[String] {
        self.ears.names()
    }

    /// Listens this way from now on (see [`ListenMode`]).
    pub fn set_mode(&mut self, mode: ListenMode, now: Instant) {
        tracing::info!(?mode, "voice: listening");
        self.conversation.set_mode(mode, now);
        self.ears.reset_spotter();
    }

    pub fn state(&self) -> VoiceState {
        if self.transcribing {
            return VoiceState::Transcribing;
        }
        if self.conversation.is_speaking() {
            return VoiceState::Speaking;
        }
        match self.conversation.phase() {
            Phase::Idle => VoiceState::Listening { conversation: None },
            Phase::Named { agent, .. } => VoiceState::HeardName {
                agent: agent.clone(),
            },
            Phase::Engaged(agent) => VoiceState::Listening {
                conversation: Some(agent.clone()),
            },
        }
    }

    /// 16 kHz mono microphone audio, in any chunk size.
    pub fn feed(&mut self, samples: &[f32], now: Instant, out: &mut dyn FnMut(Heard)) {
        if let Some(held) = &mut self.push_to_talk {
            held.extend_from_slice(samples);
            return;
        }
        let mut sounds = Vec::new();
        self.ears.feed(samples, &mut |s| sounds.push(s));
        self.barge.hear(samples);
        self.hear(sounds, now, out);
        self.weigh(now, out);
    }

    /// Ends the input: whatever speech is pending is treated as finished.
    pub fn flush(&mut self, now: Instant, out: &mut dyn FnMut(Heard)) {
        let mut sounds = Vec::new();
        self.ears.flush(&mut |s| sounds.push(s));
        self.hear(sounds, now, out);
    }

    fn hear(&mut self, sounds: Vec<Sound>, now: Instant, out: &mut dyn FnMut(Heard)) {
        for sound in sounds {
            match sound {
                Sound::Name(name) => {
                    if self.conversation.is_speaking() {
                        self.named = Some(name);
                        continue;
                    }
                    let accepted = self.conversation.keyword(&name, now);
                    tracing::info!(name, accepted, "voice: heard a name");
                }
                Sound::SpeechStarted => {
                    tracing::info!("voice: speech started");
                    self.conversation.speech_started(now);
                    if self.conversation.is_speaking() {
                        self.barge.begin();
                    }
                }
                Sound::Segment(samples) => {
                    self.conversation.speech_ended(now);
                    self.barge.end();
                    tracing::info!(
                        seconds = samples.len() as f32 / RATE as f32,
                        transcribe = self.conversation.wants_transcript(),
                        "voice: speech ended"
                    );
                    self.segment(&samples, now, out);
                }
            }
        }
    }

    /// A finished stretch of speech. Over playback it's judged first, whether
    /// or not anything would be done with its words: until now, it hasn't
    /// been shown to be anyone.
    fn segment(&mut self, samples: &[f32], now: Instant, out: &mut dyn FnMut(Heard)) {
        if self.conversation.is_speaking() {
            let text = self.ears.transcribe(samples);
            tracing::info!(text, "voice: transcribed over playback");
            let verdict = judge(&text, &self.said.text);
            if verdict != Verdict::Person {
                tracing::info!(why = verdict.name(), "voice: not a barge-in");
                self.named = None;
                return;
            }
            self.barged(now, out);
            if let Some(u) = self.conversation.transcript(&text, now) {
                out(Heard::Utterance(u));
            }
            return;
        }
        if !self.conversation.wants_transcript() {
            return;
        }
        let text = self.transcribe(samples, out);
        if self.said.echoes(&text, now) {
            tracing::info!("voice: heard our own reply; not sent");
            return;
        }
        if let Some(u) = self.conversation.transcript(&text, now) {
            out(Heard::Utterance(u));
        }
    }

    /// Whether the speech going on over playback is someone talking, once
    /// there's enough of it to tell. Stops playback without waiting for them
    /// to finish. A fraction of a second of its own voice can transcribe as
    /// anything ("the nightly build" came out "the night we did"), so it takes
    /// two looks at it in a row.
    fn weigh(&mut self, now: Instant, out: &mut dyn FnMut(Heard)) {
        if !self.conversation.is_speaking() || !self.barge.due() {
            return;
        }
        let audio = self.ears.since_onset(JUDGED);
        let text = self.ears.transcribe(&audio);
        let verdict = judge(&text, &self.said.text);
        if verdict != Verdict::Person {
            tracing::debug!(why = verdict.name(), "voice: not a barge-in yet");
            self.barge.rejected(verdict);
        } else if self.barge.convinced() {
            self.barged(now, out);
        }
    }

    fn barged(&mut self, now: Instant, out: &mut dyn FnMut(Heard)) {
        if self.conversation.interrupted() {
            self.said.over(now);
            out(Heard::BargeIn);
            if let Some(name) = self.named.take() {
                let accepted = self.conversation.keyword(&name, now);
                tracing::info!(name, accepted, "voice: heard a name");
            }
        }
    }

    fn transcribe(&mut self, samples: &[f32], out: &mut dyn FnMut(Heard)) -> String {
        self.transcribing = true;
        out(Heard::Transcribing);
        let text = self.ears.transcribe(samples);
        self.transcribing = false;
        tracing::info!(text, "voice: transcribed");
        text
    }

    /// Held: audio goes to push-to-talk instead of the wake path. Returns
    /// true when that interrupts playback.
    pub fn start_push_to_talk(&mut self, now: Instant) -> bool {
        if self.push_to_talk.is_some() {
            return false;
        }
        self.push_to_talk = Some(Vec::new());
        self.conversation.speech_started(now);
        let interrupted = self.conversation.interrupted();
        if interrupted {
            self.said.over(now);
        }
        interrupted
    }

    /// Released: transcribe what was held and send it.
    pub fn finish_push_to_talk(&mut self, now: Instant, out: &mut dyn FnMut(Heard)) {
        let Some(held) = self.push_to_talk.take() else {
            return;
        };
        self.conversation.speech_ended(now);
        self.ears.reset();
        if held.len() < SPEECH_RATE as usize / 4 {
            out(Heard::Nothing);
            return;
        }
        let text = self.transcribe(&held, out);
        let names = self.names().to_vec();
        match self.conversation.push_to_talk(&text, &names, now) {
            Some(u) => out(Heard::Utterance(u)),
            None => out(Heard::Nothing),
        }
    }

    /// `text` is about to be said (empty for audio already made).
    pub fn speaking(&mut self, text: &str, now: Instant) {
        if !self.conversation.is_speaking() {
            self.barge.reset();
            self.named = None;
        }
        self.said.speaking(text, now);
        self.conversation.speaking();
    }

    /// Playback ended; our own voice is still in the spotter's context, so
    /// it starts afresh.
    pub fn spoken(&mut self, now: Instant) {
        self.conversation.spoken(now);
        self.said.over(now);
        self.ears.reset_spotter();
    }

    /// True when the conversation just ended for silence.
    pub fn tick(&mut self, now: Instant) -> bool {
        self.conversation.tick(now)
    }
}

/// The last stretch of microphone audio, by absolute sample index.
struct Recent {
    samples: std::collections::VecDeque<f32>,
    end: u64,
    capacity: usize,
}

impl Recent {
    fn new(capacity: usize) -> Self {
        Self {
            samples: std::collections::VecDeque::with_capacity(capacity),
            end: 0,
            capacity,
        }
    }

    fn push(&mut self, samples: &[f32]) {
        self.samples.extend(samples);
        self.end += samples.len() as u64;
        let excess = self.samples.len().saturating_sub(self.capacity);
        self.samples.drain(..excess);
    }

    /// Samples `[from, to)`, or nothing when that range is no longer held.
    fn slice(&self, from: u64, to: u64) -> Vec<f32> {
        let start = self.end - self.samples.len() as u64;
        if from < start || to > self.end || from >= to {
            return Vec::new();
        }
        self.samples
            .range((from - start) as usize..(to - start) as usize)
            .copied()
            .collect()
    }

    fn clear(&mut self) {
        self.samples.clear();
        self.end = 0;
    }
}

/// Speech made on this computer.
pub trait LocalSpeech: Send + Sync {
    /// `text` in the voice `voice` (an id; the default for none or an unknown
    /// one), or `None` when it can't be said.
    fn synthesize(&self, text: &str, voice: Option<&str>) -> Option<Audio>;
}

impl LocalSpeech for Speaker {
    fn synthesize(&self, text: &str, voice: Option<&str>) -> Option<Audio> {
        Speaker::synthesize(self, text, voice)
    }
}

/// Kokoro v1.0 on this computer, in any of its English voices.
pub struct Speaker {
    tts: std::sync::Mutex<OfflineTts>,
    rate: u32,
}

impl Speaker {
    pub fn new(models: &Models) -> Result<Self> {
        let config = OfflineTtsConfig {
            model: OfflineTtsModelConfig {
                kokoro: OfflineTtsKokoroModelConfig {
                    model: Some(models.file_str(&TTS, "model.int8.onnx")),
                    voices: Some(models.file_str(&TTS, "voices.bin")),
                    tokens: Some(models.file_str(&TTS, "tokens.txt")),
                    lexicon: Some(models.file_str(&TTS, "lexicon-en-us.txt")),
                    length_scale: 1.0,
                    ..Default::default()
                },
                num_threads: 2,
                ..Default::default()
            },
            ..Default::default()
        };
        let tts =
            OfflineTts::create(&config).ok_or_else(|| eyre!("couldn't load the speech model"))?;
        let rate = tts.sample_rate().max(0) as u32;
        Ok(Self {
            tts: std::sync::Mutex::new(tts),
            rate,
        })
    }

    pub fn sample_rate(&self) -> u32 {
        self.rate
    }

    /// `text` in the Kokoro voice `voice` (an id like `af_heart`; the
    /// default for none or an unknown one).
    pub fn synthesize(&self, text: &str, voice: Option<&str>) -> Option<Audio> {
        let config = GenerationConfig {
            sid: kokoro_speaker(voice),
            ..Default::default()
        };
        let tts = self.tts.lock().ok()?;
        let audio = tts.generate_with_config(text, &config, None::<fn(&[f32], f32) -> bool>)?;
        Some(Audio {
            samples: audio.samples().to_vec(),
            rate: self.rate,
        })
    }
}

/// Text cut at sentence ends, so the first sentence plays while the rest is
/// synthesised. Short fragments ride along with the next sentence.
pub fn sentences(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let chars: Vec<char> = text.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        cur.push(c);
        let at_end = matches!(c, '.' | '!' | '?' | ';' | '\n')
            && chars.get(i + 1).is_none_or(|n| n.is_whitespace());
        if at_end && cur.split_whitespace().count() >= 3 {
            out.push(cur.trim().to_string());
            cur.clear();
        }
    }
    let rest = cur.trim();
    if !rest.is_empty() {
        match out.last_mut() {
            Some(last) if rest.split_whitespace().count() < 3 => {
                last.push(' ');
                last.push_str(rest);
            }
            _ => out.push(rest.to_string()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_audio_is_cut_by_absolute_index() {
        let mut r = Recent::new(4);
        r.push(&[0.0, 1.0, 2.0]);
        r.push(&[3.0, 4.0, 5.0]);
        assert_eq!(r.slice(3, 5), [3.0, 4.0]);
        assert_eq!(r.slice(2, 6), [2.0, 3.0, 4.0, 5.0]);
        assert!(r.slice(1, 3).is_empty());
        assert!(r.slice(5, 7).is_empty());
        r.clear();
        r.push(&[9.0]);
        assert_eq!(r.slice(0, 1), [9.0]);
    }

    #[test]
    fn splits_at_sentence_ends() {
        assert_eq!(
            sentences(
                "The build failed at three today. Two tests timed out! Want me to rerun them?"
            ),
            [
                "The build failed at three today.",
                "Two tests timed out!",
                "Want me to rerun them?"
            ]
        );
    }

    #[test]
    fn keeps_short_fragments_together() {
        assert_eq!(sentences("On it."), ["On it."]);
        assert_eq!(
            sentences("Okay. Done. The suite passed again."),
            ["Okay. Done. The suite passed again."]
        );
        assert_eq!(
            sentences("All green across the board. Yes."),
            ["All green across the board. Yes."]
        );
        assert_eq!(sentences("  "), Vec::<String>::new());
        assert_eq!(
            sentences("version 1.2.3 is out now"),
            ["version 1.2.3 is out now"]
        );
    }
}
