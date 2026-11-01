//! Whether Desk is speaking, for a microphone with no echo canceller: what
//! it hears is replaced with silence while Desk speaks, and for a moment
//! after, so Desk never hears itself.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// How long the microphone stays quiet after Desk stops speaking: the tail
/// of the speech still in the room.
const ECHO_TAIL_MS: u64 = 400;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[derive(Default)]
pub struct Speaking {
    queued: AtomicUsize,
    quiet_after: AtomicU64,
}

impl Speaking {
    /// A buffer of speech was queued to play.
    pub fn started(&self) {
        self.queued.fetch_add(1, Ordering::SeqCst);
    }

    /// A queued buffer finished playing.
    pub fn finished(&self) {
        let _ = self
            .queued
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1));
        self.quiet_after
            .store(now_ms() + ECHO_TAIL_MS, Ordering::SeqCst);
    }

    /// Playback was stopped, dropping whatever was queued.
    pub fn stopped(&self) {
        self.queued.store(0, Ordering::SeqCst);
        self.quiet_after
            .store(now_ms() + ECHO_TAIL_MS, Ordering::SeqCst);
    }

    /// Whether anything queued is still to play.
    pub fn pending(&self) -> usize {
        self.queued.load(Ordering::SeqCst)
    }

    /// Whether the microphone should be quiet now.
    pub fn now(&self) -> bool {
        self.queued.load(Ordering::SeqCst) > 0 || now_ms() < self.quiet_after.load(Ordering::SeqCst)
    }

    /// `heard`, or silence of its length while Desk speaks.
    pub fn gated<'a>(&self, heard: &'a [f32], silence: &'a mut Vec<f32>) -> &'a [f32] {
        if self.now() {
            silence.clear();
            silence.resize(heard.len(), 0.0);
            silence
        } else {
            heard
        }
    }

    #[cfg(test)]
    fn tail_over(&self) {
        self.quiet_after.store(0, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_microphone_is_quiet_while_desk_speaks_and_just_after() {
        let s = Speaking::default();
        assert!(!s.now());
        s.started();
        s.started();
        assert!(s.now());
        s.finished();
        assert!(s.now(), "one buffer still playing");
        s.finished();
        assert!(s.now(), "the tail of the speech is still in the room");
        s.tail_over();
        assert!(!s.now());
        s.started();
        s.stopped();
        s.tail_over();
        assert!(!s.now(), "stopping clears what was queued");
        s.finished();
        s.tail_over();
        assert!(!s.now(), "a late completion after stop never goes negative");
    }

    #[test]
    fn what_is_heard_while_speaking_becomes_silence() {
        let s = Speaking::default();
        let mut silence = Vec::new();
        assert_eq!(s.gated(&[0.5, -0.5], &mut silence), [0.5, -0.5]);
        s.started();
        assert_eq!(s.gated(&[0.5, -0.5], &mut silence), [0.0, 0.0]);
    }
}
