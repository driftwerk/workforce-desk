//! Whether what the microphone hears over playback is someone talking.
//!
//! The voice activity model fires on more than speech: at one Mac in everyday
//! use, a third of its segments held no words (a 2 s one among them), and the
//! echo canceller lets some of the agent's own voice through, most of all
//! while it adapts at the start of a reply. Stopping on the model's word alone
//! dropped whole replies nobody interrupted. So a reply stops only on evidence:
//!
//! 1. **Sustained, above the playback.** [`SUSTAINED`] of frames louder than
//!    what the microphone hears of the playback itself: [`MARGIN`] times
//!    `echo`, the level measured while no speech is detected. That's the level
//!    that matters: a digital reference can't know the speaker's volume, the
//!    room, or what the canceller already removed.
//! 2. **Words.** That audio has to transcribe to words ([`judge`]) that aren't
//!    filler, and aren't what's being said, twice running.
//!
//! A stretch that ends before 1 is met (a short "wait") goes straight to 2.
//! Pure: fed levels and transcripts, so every rule is tested without audio.

use std::collections::VecDeque;

const FRAME: usize = 512;
/// Frames in `SUSTAINED`, about 320 ms at 16 kHz. Silero has already taken
/// 250 ms to report speech, so a real interruption stops playback about a
/// second in: 0.7 s to the first look at it, 0.3 s more to the second.
const SUSTAINED: usize = 10;
/// How much louder than the playback the microphone must be: 6 dB.
const MARGIN: f32 = 2.0;
/// Under this it isn't anyone at the computer, whatever the echo: a normal
/// voice measures 0.02-0.1, and the microphone 0.0001 during processed playback.
const FLOOR: f32 = 0.002;
/// `echo` falls this much a frame, so a loud moment is forgotten in seconds.
const DECAY: f32 = 0.995;
/// Frames held back from `echo`: the model reports speech 250 ms after it
/// starts at best, plus its own latency and however the audio was chunked, and
/// the speech mustn't count as the level to beat. About 640 ms.
const LAG: usize = 20;
/// Frames of a rejected stretch after which its level counts as echo, if what
/// it held wasn't words: too little audio may merely be too short to transcribe.
const LONG_ENOUGH: usize = 31;

/// What was heard over playback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Person,
    /// Our own reply, coming back.
    Echo,
    /// No words, or only "um".
    Noise,
}

impl Verdict {
    pub fn name(self) -> &'static str {
        match self {
            Verdict::Person => "person",
            Verdict::Echo => "echo",
            Verdict::Noise => "noise",
        }
    }
}

const FILLER: &[&str] = &[
    "ah", "eh", "er", "erm", "hm", "hmm", "huh", "mhm", "mm", "mmm", "oh", "uh", "um", "umm",
];
/// Short things that mean stop, even when the reply has the same word in it.
const STOPS: &[&str] = &["stop", "wait"];
/// Of what was heard, this much in the reply's own word order is the reply.
const ECHO_SHARE: f32 = 0.7;

fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !(c.is_alphanumeric() || c == '\''))
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// What transcribing it gave, against what's being said.
pub fn judge(heard: &str, said: &str) -> Verdict {
    let heard = words(heard);
    if heard.iter().all(|w| FILLER.contains(&w.as_str())) {
        return Verdict::Noise;
    }
    if heard.len() <= 3 && heard.iter().any(|w| STOPS.contains(&w.as_str())) {
        return Verdict::Person;
    }
    let said = words(said);
    if in_order(&heard, &said) as f32 / heard.len() as f32 >= ECHO_SHARE {
        Verdict::Echo
    } else {
        Verdict::Person
    }
}

/// The same word, to a recogniser hearing it through a room or cut off mid-way:
/// "builds" for "build", "night" for "nightly".
fn same_word(a: &str, b: &str) -> bool {
    let (short, long) = if a.len() < b.len() { (a, b) } else { (b, a) };
    short == long || (short.len() >= 4 && long.starts_with(short))
}

/// How many of `heard` appear in `said`, in the same order.
fn in_order(heard: &[String], said: &[String]) -> usize {
    let mut best = vec![0; said.len() + 1];
    for word in heard {
        let mut diagonal = 0;
        for (i, other) in said.iter().enumerate() {
            let above = best[i + 1];
            best[i + 1] = if same_word(word, other) {
                diagonal + 1
            } else {
                above.max(best[i])
            };
            diagonal = above;
        }
    }
    best[said.len()]
}

/// One reply's worth of listening over playback.
#[derive(Debug)]
pub struct Barge {
    partial: Vec<f32>,
    /// Recent frames' levels, not yet taken as echo.
    recent: VecDeque<f32>,
    echo: f32,
    in_stretch: bool,
    /// Frames of the stretch above the level to beat, and their total level.
    loud: usize,
    loud_level: f32,
    /// Frames of it at which to transcribe next.
    next_check: usize,
    /// The last look at it took it for a person.
    person_so_far: bool,
}

impl Default for Barge {
    fn default() -> Self {
        Self {
            partial: Vec::with_capacity(FRAME),
            recent: VecDeque::with_capacity(LAG + 1),
            echo: 0.0,
            in_stretch: false,
            loud: 0,
            loud_level: 0.0,
            next_check: SUSTAINED,
            person_so_far: false,
        }
    }
}

impl Barge {
    /// A new reply: nothing is known of how it comes back yet.
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// Microphone audio, at the speech rate, in any chunk size.
    pub fn hear(&mut self, samples: &[f32]) {
        for &sample in samples {
            self.partial.push(sample);
            if self.partial.len() == FRAME {
                let level = rms(&self.partial);
                self.partial.clear();
                self.frame(level);
            }
        }
    }

    fn frame(&mut self, level: f32) {
        self.echo *= DECAY;
        if self.in_stretch {
            self.count(level);
            return;
        }
        self.recent.push_back(level);
        if self.recent.len() > LAG
            && let Some(old) = self.recent.pop_front()
        {
            self.echo = self.echo.max(old);
        }
    }

    fn count(&mut self, level: f32) {
        if level > FLOOR.max(self.echo * MARGIN) {
            self.loud += 1;
            self.loud_level += level;
        }
    }

    /// Speech started. What came just before it is probably its start.
    pub fn begin(&mut self) {
        self.in_stretch = true;
        self.loud = 0;
        self.loud_level = 0.0;
        self.next_check = SUSTAINED;
        self.person_so_far = false;
        let onset: Vec<f32> = self.recent.drain(..).collect();
        onset.into_iter().for_each(|level| self.count(level));
    }

    /// The stretch of speech ended.
    pub fn end(&mut self) {
        self.in_stretch = false;
    }

    /// Whether what's been heard is due to be transcribed: sustained and above
    /// the playback, and more of it than last time.
    pub fn due(&mut self) -> bool {
        if !self.in_stretch || self.loud < self.next_check {
            return false;
        }
        self.next_check = self.loud + SUSTAINED;
        true
    }

    /// What was due took words someone else said. True on the second look in a
    /// row: too little audio can transcribe as anything.
    pub fn convinced(&mut self) -> bool {
        std::mem::replace(&mut self.person_so_far, true)
    }

    /// What was due wasn't anyone: from here on it's the level to beat.
    pub fn rejected(&mut self, verdict: Verdict) {
        self.person_so_far = false;
        if verdict == Verdict::Echo || self.loud >= LONG_ENOUGH {
            self.echo = self.echo.max(self.loud_level / self.loud.max(1) as f32);
            self.loud = 0;
            self.loud_level = 0.0;
            self.next_check = SUSTAINED;
        }
    }
}

fn rms(samples: &[f32]) -> f32 {
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len().max(1) as f32).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPLY: &str =
        "The build failed at three today. Two tests timed out, want me to rerun them?";

    fn frames(barge: &mut Barge, level: f32, n: usize) {
        barge.hear(&vec![level; FRAME * n]);
    }

    #[test]
    fn nothing_but_words_that_arent_the_reply_is_a_person() {
        assert_eq!(judge("", REPLY), Verdict::Noise);
        assert_eq!(judge(" . ", REPLY), Verdict::Noise);
        assert_eq!(judge("Um. Hmm.", REPLY), Verdict::Noise);
        assert_eq!(judge("the build failed at three", REPLY), Verdict::Echo);
        assert_eq!(judge("tests timed out, want me", REPLY), Verdict::Echo);
        assert_eq!(judge("today", REPLY), Verdict::Echo);
        assert_eq!(judge("hold on a second", REPLY), Verdict::Person);
        assert_eq!(judge("no", REPLY), Verdict::Person);
        assert_eq!(judge("what about the tests though", REPLY), Verdict::Person);
        assert_eq!(judge("no the tests", REPLY), Verdict::Person);
        // As the recogniser really hears a reply come back: words cut off, or
        // run together, part of the way through it.
        assert_eq!(judge("the build failing at three", REPLY), Verdict::Echo);
        assert_eq!(
            judge(
                "The nightly builds",
                "The nightly build failed in the suite."
            ),
            Verdict::Echo
        );
    }

    #[test]
    fn stop_means_stop_even_if_the_reply_says_it() {
        assert_eq!(judge("Stop.", "They stop and wait."), Verdict::Person);
        assert_eq!(judge("wait wait", "They stop and wait."), Verdict::Person);
        assert_eq!(
            judge("they stop and wait", "They stop and wait."),
            Verdict::Echo
        );
    }

    #[test]
    fn with_nothing_being_said_nothing_is_an_echo() {
        assert_eq!(judge("hello there", ""), Verdict::Person);
        assert_eq!(judge("hello", ""), Verdict::Person);
    }

    #[test]
    fn a_blip_is_not_sustained() {
        let mut barge = Barge::default();
        barge.begin();
        frames(&mut barge, 0.1, SUSTAINED - 1);
        assert!(!barge.due());
        frames(&mut barge, 0.0, 30);
        assert!(!barge.due());
        frames(&mut barge, 0.1, 1);
        assert!(barge.due());
    }

    #[test]
    fn it_is_due_only_during_a_stretch_and_again_as_it_goes_on() {
        let mut barge = Barge::default();
        frames(&mut barge, 0.1, 40);
        assert!(!barge.due(), "no stretch");
        barge.begin();
        frames(&mut barge, 0.5, SUSTAINED);
        assert!(barge.due());
        assert!(!barge.due());
        frames(&mut barge, 0.5, SUSTAINED);
        assert!(barge.due());
        barge.end();
        frames(&mut barge, 0.5, SUSTAINED);
        assert!(!barge.due());
    }

    /// The level to beat is what the microphone hears of the playback.
    #[test]
    fn speech_must_be_above_the_playback() {
        let mut barge = Barge::default();
        frames(&mut barge, 0.05, 40);
        barge.begin();
        // The onset the model reported late: playback level, so it's no help.
        frames(&mut barge, 0.06, SUSTAINED * 2);
        assert!(!barge.due(), "about as loud as the playback");
        frames(&mut barge, 0.2, SUSTAINED);
        assert!(barge.due(), "well above it");
    }

    /// Silence below the floor never counts, however quiet the playback is.
    #[test]
    fn under_the_floor_is_nobody() {
        let mut barge = Barge::default();
        barge.begin();
        frames(&mut barge, FLOOR / 2.0, SUSTAINED * 3);
        assert!(!barge.due());
    }

    /// The model's late report means the start of real speech is in `recent`:
    /// it counts toward the stretch, and doesn't raise the level to beat.
    #[test]
    fn the_onset_counts_as_the_stretch_not_the_echo() {
        let mut barge = Barge::default();
        frames(&mut barge, 0.0, 40);
        frames(&mut barge, 0.2, LAG - 1);
        barge.begin();
        assert!(barge.due(), "what came before the report counts");
        frames(&mut barge, 0.2, SUSTAINED);
        assert!(barge.due(), "and isn't the level to beat");
    }

    /// Steady residual that keeps the model firing is checked, found not to be
    /// anyone, and becomes the level to beat: it doesn't keep costing a
    /// transcription, and someone talking over it still gets through.
    #[test]
    fn what_was_rejected_becomes_the_level_to_beat() {
        let mut barge = Barge::default();
        barge.begin();
        frames(&mut barge, 0.05, SUSTAINED);
        assert!(barge.due());
        barge.rejected(Verdict::Echo);
        frames(&mut barge, 0.05, SUSTAINED * 3);
        assert!(!barge.due());
        frames(&mut barge, 0.3, SUSTAINED);
        assert!(barge.due());
    }

    /// Half a second of a real person may transcribe to nothing yet. That says
    /// nothing about them, so their own voice doesn't become the bar.
    #[test]
    fn too_little_to_transcribe_doesnt_raise_the_bar() {
        let mut barge = Barge::default();
        barge.begin();
        frames(&mut barge, 0.2, SUSTAINED);
        assert!(barge.due());
        barge.rejected(Verdict::Noise);
        frames(&mut barge, 0.2, SUSTAINED);
        assert!(barge.due(), "still heard");
        barge.rejected(Verdict::Noise);
        frames(&mut barge, 0.2, LONG_ENOUGH);
        assert!(barge.due());
        barge.rejected(Verdict::Noise);
        frames(&mut barge, 0.2, SUSTAINED * 3);
        assert!(!barge.due(), "a second of it with no words wasn't anyone");
    }

    #[test]
    fn it_takes_two_looks_in_a_row_to_be_convinced() {
        let mut barge = Barge::default();
        barge.begin();
        assert!(!barge.convinced());
        barge.rejected(Verdict::Echo);
        assert!(!barge.convinced());
        assert!(barge.convinced());
        barge.end();
        barge.begin();
        assert!(!barge.convinced(), "another stretch starts again");
    }

    #[test]
    fn a_reset_forgets_the_last_reply() {
        let mut barge = Barge::default();
        frames(&mut barge, 0.5, 40);
        barge.reset();
        barge.begin();
        frames(&mut barge, 0.1, SUSTAINED);
        assert!(barge.due());
    }

    #[test]
    fn levels_are_frame_sized_however_the_audio_arrives() {
        let mut barge = Barge::default();
        barge.begin();
        for _ in 0..=SUSTAINED * FRAME / 100 {
            barge.hear(&[0.1; 100]);
        }
        assert!(barge.due());
    }
}
