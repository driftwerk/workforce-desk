//! Reading the local hub's address again when nothing answered at it (Desk
//! Helper may have given the hub new ports): one read however many
//! requests failed together, and at most one every [`GAP`]. On Windows a
//! read asks WSL, so a hub that is down must not have every retry read.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// The least time between two reads.
pub const GAP: Duration = Duration::from_secs(2);

pub struct Reread {
    gap: Duration,
    /// When it last read; held while a read runs, so those that ask then
    /// wait for it rather than read too.
    last: tokio::sync::Mutex<Option<Instant>>,
    /// A socket couldn't reach the hub: the next socket reads first.
    stale: AtomicBool,
}

impl Default for Reread {
    fn default() -> Self {
        Self::every(GAP)
    }
}

impl Reread {
    pub fn every(gap: Duration) -> Self {
        Self {
            gap,
            last: tokio::sync::Mutex::new(None),
            stale: AtomicBool::new(false),
        }
    }

    /// Runs `read` unless one ran less than the gap ago (or ran while this
    /// waited for it); whether it did.
    pub async fn run<F: std::future::Future<Output = ()>>(&self, read: impl FnOnce() -> F) -> bool {
        let mut last = self.last.lock().await;
        if last.is_some_and(|t| t.elapsed() < self.gap) {
            return false;
        }
        self.stale.store(false, Ordering::SeqCst);
        read().await;
        *last = Some(Instant::now());
        true
    }

    /// Said from a socket's handshake that couldn't connect.
    pub fn mark_stale(&self) {
        self.stale.store(true, Ordering::SeqCst);
    }

    pub fn is_stale(&self) -> bool {
        self.stale.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::AtomicUsize;

    #[tokio::test]
    async fn many_asking_together_read_once_and_not_again_within_the_gap() {
        let r = Arc::new(Reread::every(Duration::from_millis(300)));
        let reads = Arc::new(AtomicUsize::new(0));
        let ask = || {
            let (r, reads) = (Arc::clone(&r), Arc::clone(&reads));
            tokio::spawn(async move {
                r.run(|| async {
                    reads.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(50)).await;
                })
                .await
            })
        };
        let all: Vec<_> = (0..8).map(|_| ask()).collect();
        for t in all {
            t.await.unwrap();
        }
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        ask().await.unwrap();
        assert_eq!(reads.load(Ordering::SeqCst), 1, "within the gap");
        tokio::time::sleep(Duration::from_millis(350)).await;
        ask().await.unwrap();
        assert_eq!(reads.load(Ordering::SeqCst), 2);
    }
}
