//! The sherpa-onnx models wired together: Silero VAD cuts speech into
//! segments, the keyword spotter listens for roster names, Parakeet
//! transcribes the segments worth hearing, and Kokoro speaks.

use std::collections::HashSet;
use std::time::Instant;

use eyre::{Context, Result, eyre};
use sherpa_onnx::{
    GenerationConfig, KeywordSpotter, KeywordSpotterConfig, OfflineRecognizer,
    OfflineRecognizerConfig, OfflineTransducerModelConfig, OfflineTts, OfflineTtsConfig,
    OfflineTtsKokoroModelConfig, OfflineTtsModelConfig, OnlineStream, OnlineTransducerModelConfig,
    SileroVadModelConfig, VadModelConfig, VoiceActivityDetector,
};

use crate::conversation::{Conversation, Phase, Timing};
use crate::keywords::{Keywords, SentencePiece, vocabulary};
use crate::models::{ASR, KWS, Models, TTS, VAD};
use crate::resample::SPEECH_RATE;
use crate::{Utterance, VoiceState};

const VAD_WINDOW: usize = 512;
const MAX_SPEECH_SECONDS: f32 = 20.0;
/// Silero marks speech a little late; soft onsets ("Scout") need this much
/// of what came before the segment to be transcribed whole.
const PRE_ROLL: u64 = SPEECH_RATE as u64 * 2 / 5;
const RATE: i32 = SPEECH_RATE as i32;

/// What the listener noticed while being fed.
#[derive(Debug, Clone, PartialEq)]
pub enum Heard {
    /// Speech started over playback: stop speaking.
    BargeIn,
    /// A segment is being transcribed.
    Transcribing,
    Utterance(Utterance),
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

/// The cascade's listener: the wake path, the conversation, and Parakeet for
/// the segments worth hearing.
pub struct Listener {
    wake: Wake,
    asr: OfflineRecognizer,
    conversation: Conversation,
    push_to_talk: Option<Vec<f32>>,
    transcribing: bool,
}

impl Listener {
    pub fn new(models: &Models, timing: Timing, now: Instant) -> Result<Self> {
        Ok(Self {
            wake: Wake::new(models)?,
            asr: recognizer(models)?,
            conversation: Conversation::new(timing, now),
            push_to_talk: None,
            transcribing: false,
        })
    }

    /// Listens for these names from now on. With none, only push-to-talk works.
    pub fn set_names(&mut self, names: &[String]) -> Result<()> {
        self.wake.set_names(names)
    }

    pub fn names(&self) -> &[String] {
        self.wake.names()
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
        self.wake.feed(samples, &mut |s| sounds.push(s));
        self.hear(sounds, now, out);
    }

    /// Ends the input: whatever speech is pending is treated as finished.
    pub fn flush(&mut self, now: Instant, out: &mut dyn FnMut(Heard)) {
        let mut sounds = Vec::new();
        self.wake.flush(&mut |s| sounds.push(s));
        self.hear(sounds, now, out);
    }

    fn hear(&mut self, sounds: Vec<Sound>, now: Instant, out: &mut dyn FnMut(Heard)) {
        for sound in sounds {
            match sound {
                Sound::Name(name) => {
                    let accepted = self.conversation.keyword(&name, now);
                    tracing::debug!(name, accepted, "wake");
                }
                Sound::SpeechStarted => {
                    if self.conversation.speech_started(now) {
                        out(Heard::BargeIn);
                    }
                }
                Sound::Segment(samples) => {
                    self.conversation.speech_ended(now);
                    if self.conversation.wants_transcript() {
                        let text = self.transcribe(&samples, out);
                        if let Some(u) = self.conversation.transcript(&text, now) {
                            out(Heard::Utterance(u));
                        }
                    }
                }
            }
        }
    }

    fn transcribe(&mut self, samples: &[f32], out: &mut dyn FnMut(Heard)) -> String {
        self.transcribing = true;
        out(Heard::Transcribing);
        let stream = self.asr.create_stream();
        stream.accept_waveform(RATE, samples);
        self.asr.decode(&stream);
        self.transcribing = false;
        let text = stream
            .get_result()
            .map(|r| r.text.trim().to_string())
            .unwrap_or_default();
        tracing::debug!(text, "transcribed");
        text
    }

    /// Held: audio goes to push-to-talk instead of the wake path. Returns
    /// true when that interrupts playback.
    pub fn start_push_to_talk(&mut self, now: Instant) -> bool {
        if self.push_to_talk.is_some() {
            return false;
        }
        self.push_to_talk = Some(Vec::new());
        self.conversation.speech_started(now)
    }

    /// Released: transcribe what was held and send it.
    pub fn finish_push_to_talk(&mut self, now: Instant, out: &mut dyn FnMut(Heard)) {
        let Some(held) = self.push_to_talk.take() else {
            return;
        };
        self.conversation.speech_ended(now);
        self.wake.reset();
        if held.len() < SPEECH_RATE as usize / 4 {
            return;
        }
        let text = self.transcribe(&held, out);
        let names = self.names().to_vec();
        if let Some(u) = self.conversation.push_to_talk(&text, &names, now) {
            out(Heard::Utterance(u));
        }
    }

    pub fn speaking(&mut self) {
        self.conversation.speaking();
    }

    /// Playback ended; our own voice is still in the spotter's context, so
    /// it starts afresh.
    pub fn spoken(&mut self, now: Instant, more: bool) {
        self.conversation.spoken(now, more);
        self.wake.reset_spotter();
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

/// Kokoro's American English voice "af_bella".
const VOICE: i32 = 1;

pub struct Speaker {
    tts: OfflineTts,
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
        Ok(Self { tts })
    }

    pub fn sample_rate(&self) -> u32 {
        self.tts.sample_rate().max(0) as u32
    }

    pub fn synthesize(&self, text: &str) -> Option<Vec<f32>> {
        let config = GenerationConfig {
            sid: VOICE,
            ..Default::default()
        };
        let audio =
            self.tts
                .generate_with_config(text, &config, None::<fn(&[f32], f32) -> bool>)?;
        Some(audio.samples().to_vec())
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
