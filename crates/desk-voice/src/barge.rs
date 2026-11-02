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
//!    filler, and aren't a run of what's playing, twice running.
//!
//! A stretch that ends before 1 is met (a short "wait") goes straight to 2.
//! Losing what someone said is the worst this can do, and cutting a reply short
//! the next: where the evidence runs out, it's a person.
//! Pure: fed levels and transcripts, so every rule is tested without audio.

use std::collections::VecDeque;

mod spoken;

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
/// Frames of a stretch above the playback that make a word or two a person's.
const AUDIBLE: usize = 3;
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
    /// A word or two, all of them in what's playing. Too few to tell by the words,
    /// so how loud they were decides: [`Barge::above_playback`].
    Fragment,
}

impl Verdict {
    pub fn name(self) -> &'static str {
        match self {
            Verdict::Person => "person",
            Verdict::Echo => "echo",
            Verdict::Noise => "noise",
            Verdict::Fragment => "fragment",
        }
    }
}

const FILLER: &[&str] = &[
    "ah", "eh", "er", "erm", "hm", "hmm", "huh", "mhm", "mm", "mmm", "oh", "uh", "um", "umm",
];
/// Short things that mean stop, even when the reply has the same word in it.
const STOPS: &[&str] = &["stop", "wait"];
/// The fewest words that can be called the reply on words alone.
const MIN_ECHO_WORDS: usize = 3;
/// A recogniser hearing a reply through a room gets words wrong: one for every
/// this many it gets right.
const MATCHED_PER_MISHEARD: usize = 4;
/// And cuts words off at the ends of what it was given. A word at the edge that
/// isn't in the reply could as well be a person, "yes open the pull request",
/// so it's only let go when this many words either side of it say otherwise...
const MATCHED_PER_STRAY: usize = 5;
/// ...or when it's at an edge the audio was cut at, where the recogniser makes a
/// word of whatever it heard of the one cut ("it" for "-ild"), from this many
/// words of the run.
const MATCHED_FOR_A_CUT_STRAY: usize = 3;
/// Words someone answering what they heard puts beside it: "yes open the pull
/// request", "the second one why". Never let go as the recogniser's.
const ANSWERS: &[&str] = &[
    "yes", "yeah", "yep", "no", "nope", "not", "don't", "okay", "ok", "please", "but", "sure",
    "right", "actually", "instead", "thanks", "what", "why", "how", "which", "who", "when",
    "where",
];

/// How what's judged was cut from the audio.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cut {
    /// A look at speech still going on: its last word may be cut off too.
    Look,
    /// A whole stretch, which ended where the speech paused. Its start may
    /// still be cut: the voice model reports speech late, and some of what came
    /// before is taken with it.
    Whole,
}

fn words(text: &str) -> Vec<String> {
    let words = spoken::said(text)
        .split(|c: char| !(c.is_alphanumeric() || c == '\''))
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect();
    spoken::without_joining_and(words)
}

/// What transcribing it gave, against what was playing while it was heard: not
/// the whole reply, since a long one has any short phrase somewhere in it.
/// Numbers and symbols are compared as they're said, "3" as "three".
pub fn judge(heard: &str, playing: &str, cut: Cut) -> Verdict {
    let heard = words(heard);
    if heard.iter().all(|w| FILLER.contains(&w.as_str())) {
        return Verdict::Noise;
    }
    if heard.len() <= 3 && heard.iter().any(|w| STOPS.contains(&w.as_str())) {
        return Verdict::Person;
    }
    let said = words(playing);
    let run = best_run(&heard, &said);
    let edges = Edges::of(&heard, &said, run, cut);
    let matched = run.matched + edges.cut_words;
    if heard.len() < MIN_ECHO_WORDS {
        return if matched == heard.len() {
            Verdict::Fragment
        } else {
            Verdict::Person
        };
    }
    let let_go = edges.strays == 0
        || (!edges.answers
            && (edges.strays <= matched / MATCHED_PER_STRAY
                || (edges.strays == 1 && edges.at_a_cut && matched >= MATCHED_FOR_A_CUT_STRAY)));
    if matched >= MIN_ECHO_WORDS && run.misheard <= matched / MATCHED_PER_MISHEARD && let_go {
        Verdict::Echo
    } else {
        Verdict::Person
    }
}

/// The words of `heard` either side of its run along what's playing.
#[derive(Debug, Default)]
struct Edges {
    /// What's left of a word of the reply where the audio was cut: "thr" just
    /// after "at" for "three", "he" just before "build" for "the".
    cut_words: usize,
    /// The rest.
    strays: usize,
    /// Every stray is at an edge the audio may have been cut at.
    at_a_cut: bool,
    /// A stray is a word someone answers with.
    answers: bool,
}

impl Edges {
    fn of(heard: &[String], said: &[String], run: Run, cut: Cut) -> Self {
        if run.matched == 0 {
            return Self {
                strays: heard.len(),
                ..Self::default()
            };
        }
        let before = &heard[..run.heard_from];
        let after = &heard[run.heard_to..];
        // Only the word beside the run can be a piece of the one playing beside it.
        let start_cut = matches!(before, [word] if run.said_from > 0
            && said[run.said_from - 1].ends_with(word.as_str()));
        let end_cut = matches!(after, [word] if cut == Cut::Look
            && said.get(run.said_to).is_some_and(|next| next.starts_with(word.as_str())));
        let strays: Vec<&String> = before
            .iter()
            .filter(|_| !start_cut)
            .chain(after.iter().filter(|_| !end_cut))
            .collect();
        Self {
            cut_words: usize::from(start_cut) + usize::from(end_cut),
            strays: strays.len(),
            at_a_cut: end_cut || after.is_empty() || cut == Cut::Look,
            answers: strays.iter().any(|w| ANSWERS.contains(&w.as_str())),
        }
    }
}

/// The same word, to a recogniser hearing it through a room or cut off mid-way:
/// "builds" for "build", "night" for "nightly".
fn same_word(a: &str, b: &str) -> bool {
    let (short, long) = if a.len() < b.len() { (a, b) } else { (b, a) };
    short == long || (short.len() >= 4 && long.starts_with(short))
}

/// The part of `heard` that runs along `said`, word after word.
#[derive(Debug, Clone, Copy, Default)]
struct Run {
    /// Worth: its matches less its misheard words. Nothing starts a run but a
    /// match, so a run only goes on while it's worth more than starting over.
    score: i32,
    matched: usize,
    /// Words wrong, extra or missed along the way.
    misheard: usize,
    /// The words of `heard` from its first match to its last, `heard_from..heard_to`.
    heard_from: usize,
    heard_to: usize,
    /// And of what was said.
    said_from: usize,
    said_to: usize,
}

impl Run {
    /// `heard[h]` is `said[s]`.
    fn matched(self, h: usize, s: usize) -> Self {
        let (heard_from, said_from) = if self.matched == 0 {
            (h, s)
        } else {
            (self.heard_from, self.said_from)
        };
        Self {
            score: self.score + 1,
            matched: self.matched + 1,
            heard_from,
            heard_to: h + 1,
            said_from,
            said_to: s + 1,
            ..self
        }
    }

    /// A word gone wrong along the way. `None` where there's no run to go on with.
    fn misheard(self) -> Option<Self> {
        (self.score > 1).then_some(Self {
            score: self.score - 1,
            misheard: self.misheard + 1,
            ..self
        })
    }
}

/// The best run of `heard` along `said`: a contiguous stretch of each, allowing
/// for what a recogniser gets wrong.
fn best_run(heard: &[String], said: &[String]) -> Run {
    let mut best = Run::default();
    let mut above = vec![Run::default(); said.len() + 1];
    for (h, word) in heard.iter().enumerate() {
        let mut row = vec![Run::default(); said.len() + 1];
        for (i, other) in said.iter().enumerate() {
            let diagonal = above[i];
            let found = if same_word(word, other) {
                Some(diagonal.matched(h, i))
            } else {
                diagonal.misheard()
            };
            // The recogniser here leaves numbers out of what it writes, as often
            // as not: one it didn't write isn't a word it got wrong.
            let skipped = if row[i].matched > 0 && spoken::of_a_number(other) {
                Some(row[i])
            } else {
                row[i].misheard()
            };
            let options = [found, above[i + 1].misheard(), skipped];
            let cell = options
                .into_iter()
                .flatten()
                .max_by_key(|r| r.score)
                .unwrap_or_default();
            if cell.score > best.score {
                best = cell;
            }
            row[i + 1] = cell;
        }
        above = row;
    }
    best
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

    /// Whether this stretch stood out from the playback, as its echo wouldn't.
    pub fn above_playback(&self) -> bool {
        self.loud >= AUDIBLE
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

    use crate::cascade::tests::LONG_REPLY;

    const REPLY: &str =
        "The build failed at three today. Two tests timed out, want me to rerun them?";

    fn frames(barge: &mut Barge, level: f32, n: usize) {
        barge.hear(&vec![level; FRAME * n]);
    }

    #[test]
    fn nothing_but_words_that_arent_the_reply_is_a_person() {
        assert_eq!(judge("", REPLY, Cut::Whole), Verdict::Noise);
        assert_eq!(judge(" . ", REPLY, Cut::Whole), Verdict::Noise);
        assert_eq!(judge("Um. Hmm.", REPLY, Cut::Whole), Verdict::Noise);
        assert_eq!(
            judge("the build failed at three", REPLY, Cut::Whole),
            Verdict::Echo
        );
        assert_eq!(
            judge("tests timed out, want me", REPLY, Cut::Whole),
            Verdict::Echo
        );
        assert_eq!(judge("today", REPLY, Cut::Whole), Verdict::Fragment);
        assert_eq!(judge("two tests", REPLY, Cut::Whole), Verdict::Fragment);
        assert_eq!(judge("two tasks", REPLY, Cut::Whole), Verdict::Person);
        assert_eq!(
            judge("hold on a second", REPLY, Cut::Whole),
            Verdict::Person
        );
        assert_eq!(judge("no", REPLY, Cut::Whole), Verdict::Person);
        assert_eq!(
            judge("what about the tests though", REPLY, Cut::Whole),
            Verdict::Person
        );
        assert_eq!(judge("no the tests", REPLY, Cut::Whole), Verdict::Person);
        // As the recogniser really hears a reply come back: words cut off, or
        // run together, part of the way through it.
        assert_eq!(
            judge("the build failing at three", REPLY, Cut::Whole),
            Verdict::Echo
        );
        assert_eq!(
            judge(
                "The nightly builds",
                "The nightly build failed in the suite.",
                Cut::Whole
            ),
            Verdict::Echo
        );
    }

    /// At the first looks a reply comes back as two to four of its words, cut at
    /// either end, and as it's said: "three" for "3".
    #[test]
    fn its_own_voice_cut_short_is_still_echo() {
        let playing = "The build failed at 3 today. Two tests timed out.";
        for (echo, cut) in [
            ("build failed at thr", Cut::Look),
            ("he build failed at three", Cut::Look),
            ("he build failed at three", Cut::Whole),
            ("build failed at three to", Cut::Look),
            ("it failed at three today", Cut::Look),
            ("it failed at three today", Cut::Whole),
            ("failed at 3 today", Cut::Whole),
            ("ild failed at", Cut::Look),
        ] {
            assert_eq!(judge(echo, playing, cut), Verdict::Echo, "{echo} {cut:?}");
        }
        assert_eq!(judge("at thr", playing, Cut::Look), Verdict::Fragment);
    }

    /// Numbers and amounts, written in the reply and said back as words, or
    /// heard as digits: the same either way, and nothing else.
    #[test]
    fn numbers_match_as_they_are_said() {
        let playing = "It costs $2.50 a run, about 10% more, since version 2.1 on the 3rd.";
        for echo in [
            "it costs two dollars fifty cents a run",
            "two dollars and fifty cents a run about",
            "about ten percent more since",
            "since version two point one on the third",
            "version 2.1 on the 3rd",
            // As the recogniser here often has it: the numbers left out.
            "about more since version on the",
        ] {
            assert_eq!(judge(echo, playing, Cut::Whole), Verdict::Echo, "{echo}");
        }
        for person in [
            "it costs five dollars a run",
            "about twenty percent more though",
            "since version three point four",
        ] {
            assert_eq!(
                judge(person, playing, Cut::Whole),
                Verdict::Person,
                "{person}"
            );
        }
    }

    /// A stray word at an edge is let go only where the audio was cut, and never
    /// one someone answering would say.
    #[test]
    fn a_stray_word_is_let_go_only_where_the_audio_was_cut() {
        let playing = "Do you want me to open the pull request with that change now?";
        assert_eq!(judge("do you want that", playing, Cut::Look), Verdict::Echo);
        assert_eq!(
            judge("do you want that", playing, Cut::Whole),
            Verdict::Person
        );
        for person in [
            "yes open the pull request",
            "no the pull request",
            "open the pull request please",
            "the pull request with that why",
        ] {
            for cut in [Cut::Look, Cut::Whole] {
                assert_eq!(
                    judge(person, playing, cut),
                    Verdict::Person,
                    "{person} {cut:?}"
                );
            }
        }
    }

    /// With a long reply, nearly any short phrase can be found scattered through
    /// it, word by word. That isn't the reply coming back.
    #[test]
    fn a_short_phrase_is_not_an_echo_of_a_long_reply() {
        for phrase in [
            "yes please do that",
            "no let me look at it first",
            "what about the timeout",
            "can you open it now",
            "yes open the pull request",
        ] {
            assert_eq!(
                judge(phrase, LONG_REPLY, Cut::Whole),
                Verdict::Person,
                "{phrase}"
            );
        }
    }

    /// Echo is a run of what's playing with nothing else in it. These all have
    /// words of it, in order, as someone answering it would.
    #[test]
    fn a_run_of_what_is_playing_is_echo_and_little_else_is() {
        let playing = "Do you want me to open the pull request with that change now?";
        for echo in [
            "open the pull request",
            "you want me to open the",
            "want me to open a pull request with",
            "the pull request with that change now",
            "uh want me to open the pull",
        ] {
            assert_eq!(judge(echo, playing, Cut::Whole), Verdict::Echo, "{echo}");
        }
        for person in [
            "yes open the pull request",
            "no the pull request",
            "open the request",
            "me open that",
            "do you want that",
            "change the pull request now",
        ] {
            assert_eq!(
                judge(person, playing, Cut::Whole),
                Verdict::Person,
                "{person}"
            );
        }
    }

    #[test]
    fn stop_means_stop_even_if_the_reply_says_it() {
        assert_eq!(
            judge("Stop.", "They stop and wait.", Cut::Whole),
            Verdict::Person
        );
        assert_eq!(
            judge("wait wait", "They stop and wait.", Cut::Whole),
            Verdict::Person
        );
        assert_eq!(
            judge("they stop and wait", "They stop and wait.", Cut::Whole),
            Verdict::Echo
        );
    }

    #[test]
    fn with_nothing_being_said_nothing_is_an_echo() {
        assert_eq!(judge("hello there", "", Cut::Whole), Verdict::Person);
        assert_eq!(judge("hello", "", Cut::Whole), Verdict::Person);
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

    /// A word or two come back at the level of the playback isn't someone; the
    /// same word above it is.
    #[test]
    fn standing_out_from_the_playback_settles_a_fragment() {
        let mut barge = Barge::default();
        frames(&mut barge, 0.05, 40);
        barge.begin();
        frames(&mut barge, 0.06, SUSTAINED);
        assert!(!barge.above_playback());
        frames(&mut barge, 0.3, AUDIBLE);
        assert!(barge.above_playback());
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
