//! When a cloud session closes: the cascade's rules (about eight seconds of
//! silence, or "thanks" / "that's all"), with silence meaning nobody
//! talking, nothing playing and no agent still working. Pure, with time
//! passed in.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::address::is_farewell;
use crate::conversation::Timing;

/// How long the provider's transcript of the user must stay quiet before
/// what they said is judged as a whole.
const SETTLE: Duration = Duration::from_millis(900);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum End {
    Farewell,
    Silence,
}

pub struct Lifetime {
    timing: Timing,
    last: Instant,
    in_speech: bool,
    playing: bool,
    calls: HashMap<String, Instant>,
    said: String,
    said_at: Option<Instant>,
}

impl Lifetime {
    pub fn new(timing: Timing, now: Instant) -> Self {
        Self {
            timing,
            last: now,
            in_speech: false,
            playing: false,
            calls: HashMap::new(),
            said: String::new(),
            said_at: None,
        }
    }

    pub fn in_speech(&self) -> bool {
        self.in_speech
    }

    pub fn speech_started(&mut self, now: Instant) {
        self.in_speech = true;
        self.last = now;
    }

    pub fn speech_ended(&mut self, now: Instant) {
        self.in_speech = false;
        self.last = now;
    }

    pub fn playing(&mut self, playing: bool, now: Instant) {
        self.playing = playing;
        self.last = now;
    }

    pub fn call(&mut self, id: &str, now: Instant) {
        self.calls.insert(id.to_string(), now);
        self.last = now;
    }

    /// The call is answered or withdrawn; false when it wasn't pending.
    pub fn settled(&mut self, id: &str, now: Instant) -> bool {
        self.last = now;
        self.calls.remove(id).is_some()
    }

    /// A piece of the provider's transcript of the user.
    pub fn heard(&mut self, text: &str, now: Instant) {
        self.said.push_str(text);
        self.said_at = Some(now);
        self.last = now;
    }

    pub fn tick(&mut self, now: Instant) -> Option<End> {
        if !self.in_speech
            && self
                .said_at
                .is_some_and(|t| now.duration_since(t) >= SETTLE)
        {
            self.said_at = None;
            if is_farewell(&std::mem::take(&mut self.said)) {
                return Some(End::Farewell);
            }
        }
        let working = self
            .calls
            .values()
            .any(|since| now.duration_since(*since) < self.timing.reply_wait);
        let quiet = !self.in_speech && !self.playing && !working;
        (quiet && now.duration_since(self.last) >= self.timing.follow_up).then_some(End::Silence)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start() -> (Lifetime, impl Fn(u64) -> Instant) {
        let t0 = Instant::now();
        (Lifetime::new(Timing::default(), t0), move |ms| {
            t0 + Duration::from_millis(ms)
        })
    }

    #[test]
    fn ends_after_eight_quiet_seconds() {
        let (mut l, at) = start();
        l.speech_started(at(0));
        l.speech_ended(at(2_000));
        assert_eq!(l.tick(at(9_900)), None);
        assert_eq!(l.tick(at(10_000)), Some(End::Silence));
    }

    #[test]
    fn playback_and_speech_are_not_silence() {
        let (mut l, at) = start();
        l.playing(true, at(0));
        assert_eq!(l.tick(at(20_000)), None);
        l.playing(false, at(20_000));
        l.speech_started(at(25_000));
        assert_eq!(l.tick(at(40_000)), None);
        l.speech_ended(at(40_000));
        assert_eq!(l.tick(at(48_000)), Some(End::Silence));
    }

    #[test]
    fn an_agent_at_work_holds_it_open_up_to_the_reply_wait() {
        let (mut l, at) = start();
        l.call("c1", at(0));
        assert_eq!(l.tick(at(60_000)), None);
        assert_eq!(l.tick(at(91_000)), Some(End::Silence));
        let (mut l, at) = start();
        l.call("c1", at(0));
        assert!(l.settled("c1", at(30_000)));
        assert!(!l.settled("c1", at(30_000)));
        assert_eq!(l.tick(at(37_000)), None);
        assert_eq!(l.tick(at(38_000)), Some(End::Silence));
    }

    #[test]
    fn thanks_ends_it_once_the_transcript_settles() {
        let (mut l, at) = start();
        l.speech_started(at(0));
        l.heard("Thanks,", at(300));
        l.heard(" that's all.", at(600));
        l.speech_ended(at(800));
        assert_eq!(l.tick(at(1_000)), None);
        assert_eq!(l.tick(at(1_600)), Some(End::Farewell));
    }

    #[test]
    fn a_request_that_starts_with_thanks_does_not() {
        let (mut l, at) = start();
        l.speech_started(at(0));
        l.heard("Thanks", at(300));
        assert_eq!(l.tick(at(1_500)), None, "still talking");
        l.heard(", and can you rerun the failing test?", at(1_800));
        l.speech_ended(at(2_000));
        assert_eq!(l.tick(at(3_000)), None);
    }
}
