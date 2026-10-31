//! Who the user is talking to, and when they've stopped: wake by name, then
//! follow-ups without it until a farewell or a stretch of silence. Or, while
//! one conversation holds the microphone, everything said (or only what's
//! held) is for it. Pure, with time passed in, so every rule is tested
//! without audio.

use std::time::{Duration, Instant};

use crate::Utterance;
use crate::address::{addressed, is_farewell, strip_name};

#[derive(Debug, Clone, Copy)]
pub struct Timing {
    /// Silence (no one speaking, nothing being said back) that ends a conversation.
    pub follow_up: Duration,
    /// After playback stops, keyword hits are still taken as our own echo.
    pub echo_tail: Duration,
    /// The longest a sent request holds the conversation open waiting for a reply.
    pub reply_wait: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            follow_up: Duration::from_secs(8),
            echo_tail: Duration::from_millis(600),
            reply_wait: Duration::from_secs(90),
        }
    }
}

/// How the microphone is listened to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ListenMode {
    /// Wake on a roster name, then follow-ups until a farewell or silence.
    #[default]
    Names,
    /// Every utterance is for the conversation holding the microphone: no
    /// name, no silence that ends it, no farewell. It lasts until the app
    /// lets the microphone go.
    Open,
    /// Only push-to-talk is heard.
    Held,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Phase {
    Idle,
    /// A name was heard; the request is in this speech segment or the next.
    Named {
        agent: String,
        this_segment: bool,
        resume: Option<String>,
    },
    /// Talking with `agent`: speech is a follow-up.
    Engaged(String),
}

pub struct Conversation {
    timing: Timing,
    mode: ListenMode,
    phase: Phase,
    last: Instant,
    in_speech: bool,
    speaking: bool,
    quiet_until: Option<Instant>,
    awaiting: Option<Instant>,
}

impl Conversation {
    pub fn new(timing: Timing, now: Instant) -> Self {
        Self {
            timing,
            mode: ListenMode::Names,
            phase: Phase::Idle,
            last: now,
            in_speech: false,
            speaking: false,
            quiet_until: None,
            awaiting: None,
        }
    }

    pub fn phase(&self) -> &Phase {
        &self.phase
    }

    pub fn mode(&self) -> ListenMode {
        self.mode
    }

    /// Listens this way from now on. Whatever conversation was going on by
    /// name is over: the microphone has a new owner, or is given back.
    pub fn set_mode(&mut self, mode: ListenMode, now: Instant) {
        if self.mode == mode {
            return;
        }
        self.mode = mode;
        self.end();
        self.last = now;
    }

    pub fn is_speaking(&self) -> bool {
        self.speaking
    }

    fn engaged_agent(&self) -> Option<String> {
        match &self.phase {
            Phase::Engaged(a) => Some(a.clone()),
            Phase::Named { resume, .. } => resume.clone(),
            Phase::Idle => None,
        }
    }

    /// The spotter heard `agent`. False when it's taken as our own voice:
    /// during playback and just after it, and when names don't wake us.
    pub fn keyword(&mut self, agent: &str, now: Instant) -> bool {
        if self.mode != ListenMode::Names
            || self.speaking
            || self.quiet_until.is_some_and(|t| now < t)
        {
            return false;
        }
        self.phase = Phase::Named {
            agent: agent.to_string(),
            this_segment: true,
            resume: self.engaged_agent(),
        };
        self.last = now;
        true
    }

    /// Speech began. True means barge in: stop what's playing.
    pub fn speech_started(&mut self, now: Instant) -> bool {
        self.in_speech = true;
        self.last = now;
        let barge = self.speaking;
        if barge {
            self.speaking = false;
            self.quiet_until = None;
        }
        barge
    }

    pub fn speech_ended(&mut self, now: Instant) {
        self.in_speech = false;
        self.last = now;
    }

    /// Whether a finished speech segment is worth transcribing.
    pub fn wants_transcript(&self) -> bool {
        match self.mode {
            ListenMode::Names => self.phase != Phase::Idle,
            ListenMode::Open => true,
            ListenMode::Held => false,
        }
    }

    /// A speech segment's transcript; what to send, if anything.
    pub fn transcript(&mut self, text: &str, now: Instant) -> Option<Utterance> {
        self.last = now;
        match self.mode {
            ListenMode::Names => {}
            ListenMode::Open => {
                let text = text.trim();
                return (!text.is_empty()).then(|| Utterance::new(None, text));
            }
            ListenMode::Held => return None,
        }
        match std::mem::replace(&mut self.phase, Phase::Idle) {
            Phase::Idle => None,
            Phase::Named {
                agent,
                this_segment,
                resume,
            } => {
                let request = match strip_name(text, &agent) {
                    Some(rest) => rest,
                    None if this_segment => {
                        self.phase = resume.map_or(Phase::Idle, Phase::Engaged);
                        return None;
                    }
                    None => text.trim(),
                };
                if request.is_empty() {
                    self.phase = Phase::Named {
                        agent,
                        this_segment: false,
                        resume,
                    };
                    return None;
                }
                self.request(agent.clone(), Some(agent), request, now)
            }
            Phase::Engaged(agent) => self.request(agent, None, text.trim(), now),
        }
    }

    fn request(
        &mut self,
        agent: String,
        named: Option<String>,
        text: &str,
        now: Instant,
    ) -> Option<Utterance> {
        if is_farewell(text) {
            self.end();
            return None;
        }
        self.phase = Phase::Engaged(agent);
        self.awaiting = Some(now);
        Some(Utterance::new(named, text))
    }

    /// Push-to-talk: always sent. Listening by name, a leading roster name
    /// addresses it; otherwise it is the microphone owner's whatever it
    /// opens with.
    pub fn push_to_talk(
        &mut self,
        text: &str,
        names: &[String],
        now: Instant,
    ) -> Option<Utterance> {
        self.last = now;
        let (agent, text) = match addressed(text, names).filter(|_| self.mode == ListenMode::Names)
        {
            Some((name, rest)) => (Some(name.to_string()), rest),
            None => (None, text.trim()),
        };
        if text.is_empty() {
            return None;
        }
        if matches!(self.phase, Phase::Engaged(_)) {
            if is_farewell(text) {
                self.end();
                return None;
            }
            self.awaiting = Some(now);
        }
        Some(Utterance::new(agent, text))
    }

    pub fn speaking(&mut self) {
        self.speaking = true;
    }

    /// Playback finished: the reply has been said.
    pub fn spoken(&mut self, now: Instant) {
        self.speaking = false;
        self.quiet_until = Some(now + self.timing.echo_tail);
        self.last = now;
        self.awaiting = None;
    }

    /// Ends the conversation after the silence; true when it did.
    pub fn tick(&mut self, now: Instant) -> bool {
        if self.mode != ListenMode::Names
            || self.phase == Phase::Idle
            || self.in_speech
            || self.speaking
        {
            return false;
        }
        if self
            .awaiting
            .is_some_and(|t| now.duration_since(t) < self.timing.reply_wait)
        {
            return false;
        }
        if now.duration_since(self.last) < self.timing.follow_up {
            return false;
        }
        self.end();
        true
    }

    fn end(&mut self) {
        self.phase = Phase::Idle;
        self.awaiting = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Clock(Instant);

    impl Clock {
        fn at(&self, ms: u64) -> Instant {
            self.0 + Duration::from_millis(ms)
        }
    }

    fn start() -> (Conversation, Clock) {
        let clock = Clock(Instant::now());
        (Conversation::new(Timing::default(), clock.at(0)), clock)
    }

    fn said(
        c: &mut Conversation,
        clock: &Clock,
        from: u64,
        to: u64,
        text: &str,
    ) -> Option<Utterance> {
        c.speech_started(clock.at(from));
        c.speech_ended(clock.at(to));
        c.transcript(text, clock.at(to))
    }

    fn u(agent: Option<&str>, text: &str) -> Option<Utterance> {
        Some(Utterance::new(agent.map(String::from), text))
    }

    #[test]
    fn a_name_starts_a_conversation_and_follow_ups_need_no_name() {
        let (mut c, clock) = start();
        c.speech_started(clock.at(0));
        assert!(c.keyword("Atlas", clock.at(500)));
        c.speech_ended(clock.at(2_000));
        assert_eq!(
            c.transcript("Atlas, what failed overnight?", clock.at(2_000)),
            u(Some("Atlas"), "what failed overnight?")
        );
        c.speaking();
        c.spoken(clock.at(6_000));
        assert_eq!(
            said(&mut c, &clock, 7_000, 8_000, "And the night before?"),
            u(None, "And the night before?")
        );
        assert_eq!(c.phase(), &Phase::Engaged("Atlas".into()));
    }

    #[test]
    fn speech_without_a_name_is_ignored_when_idle() {
        let (mut c, clock) = start();
        assert!(!c.wants_transcript());
        assert_eq!(
            said(&mut c, &clock, 0, 1_000, "what failed overnight"),
            None
        );
    }

    #[test]
    fn a_bare_name_waits_for_the_request() {
        let (mut c, clock) = start();
        c.speech_started(clock.at(0));
        c.keyword("Atlas", clock.at(400));
        c.speech_ended(clock.at(700));
        assert_eq!(c.transcript("Atlas.", clock.at(700)), None);
        assert!(c.wants_transcript());
        assert_eq!(
            said(&mut c, &clock, 1_500, 3_000, "What failed overnight?"),
            u(Some("Atlas"), "What failed overnight?")
        );
    }

    #[test]
    fn a_name_the_transcript_does_not_open_with_was_a_false_wake() {
        let (mut c, clock) = start();
        c.speech_started(clock.at(0));
        c.keyword("Atlas", clock.at(900));
        c.speech_ended(clock.at(2_000));
        assert_eq!(
            c.transcript("I asked atlas yesterday", clock.at(2_000)),
            None
        );
        assert_eq!(c.phase(), &Phase::Idle);
    }

    #[test]
    fn a_false_wake_mid_conversation_keeps_the_conversation() {
        let (mut c, clock) = start();
        c.speech_started(clock.at(0));
        c.keyword("Atlas", clock.at(300));
        c.speech_ended(clock.at(1_000));
        c.transcript("Atlas, status?", clock.at(1_000));
        c.speech_started(clock.at(2_000));
        c.keyword("Allan", clock.at(2_500));
        c.speech_ended(clock.at(3_000));
        assert_eq!(c.transcript("ask about it later", clock.at(3_000)), None);
        assert_eq!(c.phase(), &Phase::Engaged("Atlas".into()));
    }

    #[test]
    fn naming_someone_else_switches_agent() {
        let (mut c, clock) = start();
        c.speech_started(clock.at(0));
        c.keyword("Atlas", clock.at(300));
        c.speech_ended(clock.at(1_000));
        c.transcript("Atlas, status?", clock.at(1_000));
        c.speech_started(clock.at(2_000));
        c.keyword("Allan", clock.at(2_300));
        c.speech_ended(clock.at(3_000));
        assert_eq!(
            c.transcript("Allan, and yours?", clock.at(3_000)),
            u(Some("Allan"), "and yours?")
        );
        assert_eq!(c.phase(), &Phase::Engaged("Allan".into()));
    }

    #[test]
    fn eight_seconds_of_silence_ends_it() {
        let (mut c, clock) = start();
        c.speech_started(clock.at(0));
        c.keyword("Atlas", clock.at(300));
        c.speech_ended(clock.at(1_000));
        c.transcript("Atlas, status?", clock.at(1_000));
        c.speaking();
        c.spoken(clock.at(3_000));
        assert!(!c.tick(clock.at(10_900)));
        assert!(c.tick(clock.at(11_000)));
        assert_eq!(c.phase(), &Phase::Idle);
        assert_eq!(said(&mut c, &clock, 12_000, 13_000, "and then?"), None);
    }

    #[test]
    fn a_bare_name_also_times_out() {
        let (mut c, clock) = start();
        c.speech_started(clock.at(0));
        c.keyword("Atlas", clock.at(300));
        c.speech_ended(clock.at(600));
        c.transcript("Atlas", clock.at(600));
        assert!(c.tick(clock.at(8_600)));
    }

    #[test]
    fn waiting_for_a_reply_is_not_silence() {
        let (mut c, clock) = start();
        c.speech_started(clock.at(0));
        c.keyword("Atlas", clock.at(300));
        c.speech_ended(clock.at(1_000));
        c.transcript("Atlas, run the suite", clock.at(1_000));
        assert!(!c.tick(clock.at(30_000)));
        c.speaking();
        c.spoken(clock.at(40_000));
        assert!(!c.tick(clock.at(47_000)));
        assert!(c.tick(clock.at(48_000)));
    }

    #[test]
    fn a_reply_that_never_comes_lets_it_end() {
        let (mut c, clock) = start();
        c.speech_started(clock.at(0));
        c.keyword("Atlas", clock.at(300));
        c.speech_ended(clock.at(1_000));
        c.transcript("Atlas, run the suite", clock.at(1_000));
        assert!(!c.tick(clock.at(60_000)));
        assert!(c.tick(clock.at(91_000)));
    }

    #[test]
    fn long_speech_is_not_silence() {
        let (mut c, clock) = start();
        c.speech_started(clock.at(0));
        c.keyword("Atlas", clock.at(300));
        assert!(!c.tick(clock.at(15_000)));
    }

    #[test]
    fn thanks_ends_it_without_sending() {
        let (mut c, clock) = start();
        c.speech_started(clock.at(0));
        c.keyword("Atlas", clock.at(300));
        c.speech_ended(clock.at(1_000));
        c.transcript("Atlas, status?", clock.at(1_000));
        assert_eq!(
            said(&mut c, &clock, 2_000, 2_600, "Thanks, that's all."),
            None
        );
        assert_eq!(c.phase(), &Phase::Idle);
    }

    #[test]
    fn our_own_voice_does_not_wake_us() {
        let (mut c, clock) = start();
        c.speaking();
        assert!(!c.keyword("Atlas", clock.at(100)));
        c.spoken(clock.at(1_000));
        assert!(!c.keyword("Atlas", clock.at(1_400)));
        assert!(c.keyword("Atlas", clock.at(1_700)));
    }

    #[test]
    fn speaking_over_playback_barges_in() {
        let (mut c, clock) = start();
        c.speaking();
        assert!(c.speech_started(clock.at(200)));
        assert!(!c.is_speaking());
        assert!(c.keyword("Atlas", clock.at(400)));
        c.speech_ended(clock.at(900));
        assert!(!c.speech_started(clock.at(1_500)));
    }

    #[test]
    fn push_to_talk_is_always_sent_and_may_name_someone() {
        let (mut c, clock) = start();
        let names = ["Atlas", "Allan"].map(String::from);
        assert_eq!(
            c.push_to_talk("what failed overnight?", &names, clock.at(0)),
            u(None, "what failed overnight?")
        );
        assert_eq!(
            c.push_to_talk("Allan, what's left?", &names, clock.at(0)),
            u(Some("Allan"), "what's left?")
        );
        assert_eq!(c.push_to_talk("  ", &names, clock.at(0)), None);
        assert_eq!(c.phase(), &Phase::Idle);
    }

    fn open(c: &mut Conversation, clock: &Clock) {
        c.set_mode(ListenMode::Open, clock.at(0));
        assert_eq!(c.mode(), ListenMode::Open);
    }

    #[test]
    fn an_open_microphone_sends_everything_without_a_name() {
        let (mut c, clock) = start();
        open(&mut c, &clock);
        assert!(c.wants_transcript());
        assert_eq!(
            said(&mut c, &clock, 0, 1_000, " what failed overnight? "),
            u(None, "what failed overnight?")
        );
        // A leading name is part of what was said, not who it's for.
        assert_eq!(
            said(&mut c, &clock, 2_000, 3_000, "Allan, and yours?"),
            u(None, "Allan, and yours?")
        );
        assert_eq!(said(&mut c, &clock, 4_000, 4_300, "  "), None);
    }

    #[test]
    fn an_open_microphone_is_not_ended_by_silence_or_thanks() {
        let (mut c, clock) = start();
        open(&mut c, &clock);
        assert!(!c.keyword("Atlas", clock.at(100)), "names don't wake it");
        assert!(!c.tick(clock.at(600_000)));
        assert_eq!(
            said(&mut c, &clock, 600_000, 601_000, "Thanks, that's all."),
            u(None, "Thanks, that's all.")
        );
        assert!(!c.tick(clock.at(700_000)));
    }

    #[test]
    fn a_held_microphone_hears_only_push_to_talk() {
        let (mut c, clock) = start();
        c.set_mode(ListenMode::Held, clock.at(0));
        assert!(!c.wants_transcript());
        assert!(!c.keyword("Atlas", clock.at(100)));
        assert_eq!(said(&mut c, &clock, 0, 1_000, "Atlas, status?"), None);
        let names = ["Atlas", "Allan"].map(String::from);
        assert_eq!(
            c.push_to_talk("Allan, what's left?", &names, clock.at(2_000)),
            u(None, "Allan, what's left?")
        );
    }

    #[test]
    fn handing_the_microphone_over_ends_a_conversation_by_name() {
        let (mut c, clock) = start();
        c.speech_started(clock.at(0));
        c.keyword("Atlas", clock.at(300));
        c.speech_ended(clock.at(1_000));
        c.transcript("Atlas, status?", clock.at(1_000));
        assert_eq!(c.phase(), &Phase::Engaged("Atlas".into()));
        open(&mut c, &clock);
        c.set_mode(ListenMode::Names, clock.at(2_000));
        assert_eq!(c.phase(), &Phase::Idle);
        assert_eq!(said(&mut c, &clock, 3_000, 4_000, "and then?"), None);
    }
}
