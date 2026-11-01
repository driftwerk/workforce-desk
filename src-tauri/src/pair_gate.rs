//! Who may be paired with. A page can ask Desk to pair with any https or
//! loopback address it names, so script that got into the page could add a
//! hub the person never chose: a visible new entry, and a device token kept
//! for it. Adding a hub Desk isn't paired with is therefore the person's
//! decision, asked natively (outside the page, where script can't click it),
//! once, before anything leaves this computer. A hub Desk is already paired
//! with is paired again without asking: nothing new is added.
//!
//! Both steps of a pairing go through the gate: `pair_request` asks, and
//! `pair_collect` is held to the same rule, so script can't skip the request
//! and collect into a hub of its own choosing. The answer is kept for as long
//! as a pairing code lives, so one pairing is asked about once; a pairing
//! that outlived the app (its code is kept, to collect after a restart) is
//! asked about again at its collect, which is also the first the gate hears
//! of it.
//!
//! The question can't be used to wear the person down: one is open at a time
//! (a second pairing while it is open is refused, not queued), and after a
//! Cancel no new one is asked for a while, the wait doubling with each Cancel
//! in a row, so script calling in a loop gets refusals, not a stream of
//! dialogs until someone clicks Pair to make them stop.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use desk_core::Paths;

/// How long a confirmation stands: a pairing code's life.
const CONFIRMATION_TTL: Duration = Duration::from_secs(15 * 60);

/// How long after a Cancel no new question is asked; doubled for each Cancel
/// in a row, up to [`MAX_QUIET`].
const QUIET_AFTER_CANCEL: Duration = Duration::from_secs(10);

/// The longest wait between questions after Cancels in a row.
const MAX_QUIET: Duration = Duration::from_secs(15 * 60);

/// The person's answer to "Pair Desk with <host>?". The real one is the
/// operating system's own dialog; tests answer for themselves.
pub trait Confirm: Send + Sync + 'static {
    /// Asks, and waits: true only when they chose to pair.
    fn pair_with(&self, host: &str) -> bool;
}

/// The question as the native dialog asks it.
pub struct NativeConfirm<R: tauri::Runtime = tauri::Wry>(pub tauri::AppHandle<R>);

impl<R: tauri::Runtime> Confirm for NativeConfirm<R> {
    fn pair_with(&self, host: &str) -> bool {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        self.0
            .dialog()
            .message(format!(
                "Pair Desk with {host}?\n\nOnly pair with a workspace you meant to add. \
                 Once paired, Desk sends it your conversations."
            ))
            .title("Pair with a new workspace")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Pair".into(),
                "Cancel".into(),
            ))
            .blocking_show()
    }
}

pub struct PairGate {
    paths: Paths,
    confirm: Arc<dyn Confirm>,
    ttl: Duration,
    quiet: Duration,
    /// The addresses confirmed and not yet paired, and when.
    confirmed: Mutex<HashMap<String, Instant>>,
    asking: Arc<Mutex<Asking>>,
}

/// Whether a question is open, and how soon after Cancels another may be.
#[derive(Default)]
struct Asking {
    open: bool,
    /// Cancels in a row since the last Pair.
    cancels: u32,
    /// No question before this.
    quiet_until: Option<Instant>,
}

/// Marks the question closed however asking it ends, a panic included.
struct Open(Arc<Mutex<Asking>>);

impl Drop for Open {
    fn drop(&mut self) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).open = false;
    }
}

/// The address as pairing keeps it, and the host the person is shown.
fn place(url: &str) -> Result<(String, String), String> {
    let base = desk_core::net::hub_url(url)?;
    let host = match (base.host_str(), base.port()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_string(),
        (None, _) => return Err(format!("{url} isn't a workspace's address.")),
    };
    Ok((base.as_str().trim_end_matches('/').to_string(), host))
}

impl PairGate {
    pub fn new(paths: Paths, confirm: Arc<dyn Confirm>) -> Self {
        Self::with_timing(paths, confirm, CONFIRMATION_TTL, QUIET_AFTER_CANCEL)
    }

    fn with_timing(
        paths: Paths,
        confirm: Arc<dyn Confirm>,
        ttl: Duration,
        quiet: Duration,
    ) -> Self {
        Self {
            paths,
            confirm,
            ttl,
            quiet,
            confirmed: Mutex::default(),
            asking: Arc::default(),
        }
    }

    /// The question may be asked now: none is open, and none was cancelled a
    /// moment ago. It is open until the returned guard drops.
    fn open_question(&self) -> Result<Open, String> {
        let mut asking = self.asking.lock().unwrap_or_else(|e| e.into_inner());
        if asking.open {
            return Err("Desk is already asking about pairing with a workspace.".to_string());
        }
        if let Some(left) = asking
            .quiet_until
            .and_then(|until| until.checked_duration_since(Instant::now()))
            .filter(|left| !left.is_zero())
        {
            return Err(format!(
                "Pairing was cancelled. Try again in {} seconds.",
                left.as_secs().max(1)
            ));
        }
        asking.open = true;
        Ok(Open(Arc::clone(&self.asking)))
    }

    /// The person answered: a Pair clears the wait, a Cancel lengthens it.
    fn answered(&self, agreed: bool) {
        let mut asking = self.asking.lock().unwrap_or_else(|e| e.into_inner());
        if agreed {
            asking.cancels = 0;
            asking.quiet_until = None;
        } else {
            asking.cancels = asking.cancels.saturating_add(1);
            let wait = self
                .quiet
                .saturating_mul(1 << (asking.cancels - 1).min(16))
                .min(MAX_QUIET);
            asking.quiet_until = Some(Instant::now() + wait);
        }
    }

    /// Whether Desk is paired with the hub at `key` already.
    fn is_paired(&self, key: &str) -> Result<bool, String> {
        let records = crate::hubs::read_records(&self.paths).map_err(|e| e.to_string())?;
        Ok(records.iter().any(|r| crate::hubs::same_place(&r.url, key)))
    }

    fn is_confirmed(&self, key: &str) -> bool {
        let mut confirmed = self.confirmed.lock().unwrap_or_else(|e| e.into_inner());
        confirmed.retain(|_, at| at.elapsed() < self.ttl);
        confirmed.contains_key(key)
    }

    /// A step of a pairing at `url`: a hub Desk is paired with, or one the
    /// person confirmed a moment ago, goes through; any other is asked about,
    /// and refused unless the person confirms. Nothing is sent to it before
    /// this returns.
    pub async fn allow(&self, url: &str) -> Result<(), String> {
        let (key, host) = place(url)?;
        if self.is_paired(&key)? || self.is_confirmed(&key) {
            return Ok(());
        }
        let open = self.open_question()?;
        let confirm = Arc::clone(&self.confirm);
        let agreed = tauri::async_runtime::spawn_blocking(move || confirm.pair_with(&host))
            .await
            .map_err(|e| e.to_string())?;
        self.answered(agreed);
        drop(open);
        if !agreed {
            return Err("Pairing was cancelled.".to_string());
        }
        self.confirmed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, Instant::now());
        Ok(())
    }

    /// `url` is paired: its confirmation is spent.
    pub fn spent(&self, url: &str) {
        if let Ok((key, _)) = place(url) {
            self.confirmed
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&key);
        }
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A dialog that answers `agree` and keeps what it was asked.
    pub struct Mock {
        agree: bool,
        pub asked: Mutex<Vec<String>>,
        pub count: AtomicUsize,
    }

    impl Mock {
        pub fn new(agree: bool) -> Arc<Self> {
            Arc::new(Self {
                agree,
                asked: Mutex::default(),
                count: AtomicUsize::new(0),
            })
        }
    }

    impl Confirm for Mock {
        fn pair_with(&self, host: &str) -> bool {
            self.count.fetch_add(1, Ordering::SeqCst);
            self.asked.lock().unwrap().push(host.to_string());
            self.agree
        }
    }

    pub fn gate(agree: bool) -> (PairGate, Arc<Mock>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let mock = Mock::new(agree);
        let gate = PairGate::new(Paths::at(dir.path()), mock.clone());
        (gate, mock, dir)
    }

    /// Desk paired with `url` already.
    pub fn pair(dir: &tempfile::TempDir, url: &str) {
        let paths = Paths::at(dir.path());
        let secrets = desk_core::Secrets::of(&paths, desk_core::KeyStore::File);
        crate::hubs::save_with(&secrets, &paths, "Acme", url, "token").unwrap();
    }

    #[tokio::test]
    async fn a_new_hub_is_asked_about_by_host_and_refused_on_cancel() {
        let (gate, mock, _dir) = gate(false);
        let err = gate.allow("https://hub.example.com/").await.unwrap_err();
        assert_eq!(err, "Pairing was cancelled.");
        assert_eq!(*mock.asked.lock().unwrap(), ["hub.example.com"]);
    }

    #[tokio::test]
    async fn a_confirmed_hub_goes_through_and_is_asked_once() {
        let (gate, mock, _dir) = gate(true);
        gate.allow("https://hub.example.com").await.unwrap();
        gate.allow("https://hub.example.com/").await.unwrap();
        assert_eq!(mock.count.load(Ordering::SeqCst), 1);
        gate.spent("https://hub.example.com");
        gate.allow("https://hub.example.com").await.unwrap();
        assert_eq!(
            mock.count.load(Ordering::SeqCst),
            2,
            "a spent one asks again"
        );
    }

    #[tokio::test]
    async fn the_port_is_shown_and_loopback_is_asked_too() {
        let (gate, mock, _dir) = gate(true);
        gate.allow("http://127.0.0.1:8123").await.unwrap();
        assert_eq!(*mock.asked.lock().unwrap(), ["127.0.0.1:8123"]);
    }

    #[tokio::test]
    async fn collecting_without_a_confirmation_asks_and_is_refused_on_cancel() {
        let (gate, mock, _dir) = gate(false);
        assert!(gate.allow("https://evil.example.com").await.is_err());
        assert_eq!(*mock.asked.lock().unwrap(), ["evil.example.com"]);
    }

    #[tokio::test]
    async fn pairing_a_hub_again_asks_nothing() {
        let (gate, mock, dir) = gate(false);
        pair(&dir, "https://a.example.com");
        gate.allow("https://a.example.com/").await.unwrap();
        assert_eq!(mock.count.load(Ordering::SeqCst), 0);
        // Another hub still asks.
        assert!(gate.allow("https://b.example.com").await.is_err());
    }

    #[tokio::test]
    async fn a_confirmation_lapses() {
        let dir = tempfile::tempdir().unwrap();
        let mock = Mock::new(true);
        let gate = PairGate::with_timing(
            Paths::at(dir.path()),
            mock.clone(),
            Duration::ZERO,
            Duration::ZERO,
        );
        gate.allow("https://hub.example.com").await.unwrap();
        gate.allow("https://hub.example.com").await.unwrap();
        assert_eq!(mock.count.load(Ordering::SeqCst), 2, "it asks again");
    }

    #[tokio::test]
    async fn the_host_is_shown_as_its_ascii_name_never_as_lookalike_letters() {
        let (gate, mock, _dir) = gate(false);
        // Cyrillic "а" in place of Latin "a".
        let _ = gate.allow("https://\u{430}pple.example.com").await;
        let asked = mock.asked.lock().unwrap().clone();
        assert_eq!(asked, ["xn--pple-43d.example.com"]);
        assert!(asked[0].is_ascii());
    }

    /// A dialog that stays open until the test lets it answer.
    struct Held {
        asked: std::sync::mpsc::Sender<()>,
        answer: Mutex<std::sync::mpsc::Receiver<bool>>,
    }

    impl Confirm for Held {
        fn pair_with(&self, _host: &str) -> bool {
            self.asked.send(()).unwrap();
            self.answer.lock().unwrap().recv().unwrap()
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn one_question_is_open_at_a_time() {
        let dir = tempfile::tempdir().unwrap();
        let (asked_tx, asked) = std::sync::mpsc::channel();
        let (answer, answer_rx) = std::sync::mpsc::channel();
        let gate = Arc::new(PairGate::new(
            Paths::at(dir.path()),
            Arc::new(Held {
                asked: asked_tx,
                answer: Mutex::new(answer_rx),
            }),
        ));
        let first = tokio::spawn({
            let gate = Arc::clone(&gate);
            async move { gate.allow("https://a.example.com").await }
        });
        tokio::task::spawn_blocking(move || asked.recv().unwrap())
            .await
            .unwrap();
        // While it is open, neither the same hub nor another asks again.
        for url in ["https://a.example.com", "https://b.example.com"] {
            let err = gate.allow(url).await.unwrap_err();
            assert!(err.contains("already asking"), "{url}: {err}");
        }
        answer.send(true).unwrap();
        first.await.unwrap().unwrap();
        // Answered, the confirmed hub goes through without a dialog.
        gate.allow("https://a.example.com").await.unwrap();
    }

    #[tokio::test]
    async fn after_a_cancel_no_question_is_asked_for_a_while_and_longer_each_time() {
        let dir = tempfile::tempdir().unwrap();
        let mock = Mock::new(false);
        let gate = PairGate::with_timing(
            Paths::at(dir.path()),
            mock.clone(),
            CONFIRMATION_TTL,
            Duration::from_secs(60),
        );
        assert_eq!(
            gate.allow("https://a.example.com").await.unwrap_err(),
            "Pairing was cancelled."
        );
        // Script asking again in a loop, for any hub, gets refusals, not dialogs.
        for url in [
            "https://a.example.com",
            "https://b.example.com",
            "https://c.example.com",
        ] {
            let err = gate.allow(url).await.unwrap_err();
            assert!(err.contains("Try again in"), "{err}");
        }
        assert_eq!(mock.count.load(Ordering::SeqCst), 1);
        // The wait doubles with each Cancel in a row, up to a bound.
        gate.answered(false);
        let until =
            |gate: &PairGate| gate.asking.lock().unwrap().quiet_until.unwrap() - Instant::now();
        assert!(
            until(&gate) > Duration::from_secs(110),
            "{:?}",
            until(&gate)
        );
        for _ in 0..40 {
            gate.answered(false);
        }
        assert!(until(&gate) <= MAX_QUIET);
        // A Pair clears it.
        gate.answered(true);
        assert!(gate.asking.lock().unwrap().quiet_until.is_none());
    }

    #[tokio::test]
    async fn a_paired_hub_goes_through_even_while_quiet() {
        let (gate, _mock, dir) = gate(false);
        assert!(gate.allow("https://new.example.com").await.is_err());
        pair(&dir, "https://a.example.com");
        gate.allow("https://a.example.com").await.unwrap();
    }

    #[tokio::test]
    async fn an_address_desk_would_not_pair_with_is_refused_unasked() {
        let (gate, mock, _dir) = gate(true);
        for url in ["http://evil.example.com", "ftp://x.example.com", "nonsense"] {
            assert!(gate.allow(url).await.is_err(), "{url}");
        }
        assert_eq!(mock.count.load(Ordering::SeqCst), 0);
    }
}
