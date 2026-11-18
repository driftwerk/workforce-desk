//! Audio that keeps going: the platform's microphone and speaker, built on
//! the devices the person chose (or the system's), and built again whenever
//! that stops being right — a device unplugged or plugged back in, the
//! system's default changing, the system stopping the audio after a
//! configuration change, or the person choosing differently. What's
//! listening keeps the same [`AudioOut`] throughout, so a conversation goes
//! on over the change rather than going silent.
//!
//! Everything the microphone hears passes through one place ([`Hearing`]),
//! which measures it for the level meter, quiets it while Desk speaks when
//! there's no echo canceller, holds it back unless push to talk is held when
//! that's how the person listens, and records it for Test.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use eyre::{Result, eyre};
use serde::Serialize;

use super::devices::{self, Device, Devices, Resolved};
use super::gate::Speaking;
use super::prefs::{self, AudioPrefs};
use super::{SharedIn, platform};
use crate::{AudioIn, AudioOut, SharedAudioOut};

pub(crate) type Done = Box<dyn FnOnce() + Send>;

/// One way of opening the audio, tried in turn ([`attempts`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Attempt {
    /// The microphone's device id; `None` is the system's. Unused unless
    /// `listen`.
    pub input: Option<String>,
    pub output: Option<String>,
    pub listen: bool,
    /// The platform's echo canceller (macOS voice processing).
    pub cancel_echo: bool,
}

/// A microphone and speaker as the platform opened them.
pub(crate) trait Backend: Send + Sync {
    fn play(&self, samples: &[f32], rate: u32, done: Done);
    fn stop(&self);
    fn lag(&self) -> Duration {
        Duration::ZERO
    }
    /// False once the system stopped it or its device went away.
    fn healthy(&self) -> bool;
}

/// The ways to try, best first, for what's wanted: the chosen devices with
/// the echo canceller, then without it (quiet while Desk speaks), then the
/// system's speaker, then the system's microphone.
pub(crate) fn attempts(
    input: Option<&str>,
    output: Option<&str>,
    listen: bool,
    echo_cancel: bool,
    has_canceller: bool,
) -> Vec<Attempt> {
    let at = |input: Option<&str>, output: Option<&str>, cancel_echo| Attempt {
        input: input.filter(|_| listen).map(str::to_string),
        output: output.map(str::to_string),
        listen,
        cancel_echo: cancel_echo && listen,
    };
    let canceller = listen && echo_cancel && has_canceller;
    let mut all = Vec::new();
    if canceller {
        all.push(at(input, output, true));
    }
    all.push(at(input, output, false));
    all.push(at(input, None, false));
    if canceller {
        all.push(at(None, None, true));
    }
    all.push(at(None, None, false));
    let mut tried = Vec::new();
    for a in all {
        if !tried.contains(&a) {
            tried.push(a);
        }
    }
    tried
}

/// What the person sees of the audio in use.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStatus {
    /// A microphone is open.
    pub listening: bool,
    pub input: Option<Device>,
    pub output: Option<Device>,
    /// The echo canceller is removing Desk's voice from the microphone.
    pub echo_cancelled: bool,
    /// The microphone goes quiet while Desk speaks (no echo canceller).
    pub quiet_while_speaking: bool,
    /// What isn't as chosen, in the person's words.
    pub notes: Vec<String>,
}

/// The status of audio opened with `attempt` for what was wanted.
fn describe(
    attempt: &Attempt,
    wanted: &AudioPrefs,
    devices: &Devices,
    input: &Resolved,
    output: &Resolved,
) -> AudioStatus {
    let find = |list: &[Device], id: Option<&str>| match id {
        Some(id) => list.iter().find(|d| d.id == id).cloned(),
        None => list.iter().find(|d| d.is_default).cloned(),
    };
    let mut notes = Vec::new();
    let mic_in_use = find(&devices.inputs, attempt.input.as_deref());
    let speaker_in_use = find(&devices.outputs, attempt.output.as_deref());
    let system = |d: &Option<Device>| {
        d.as_ref()
            .map_or("the system’s".to_string(), |d| d.name.clone())
    };
    if attempt.listen {
        if let Some(c) = &wanted.input {
            if input.missing(Some(c)) {
                notes.push(format!(
                    "{} isn’t connected, so Desk is using {} until it’s back.",
                    c.name,
                    system(&mic_in_use)
                ));
            } else if attempt.input.is_none() {
                notes.push(format!(
                    "{} wouldn’t open, so Desk is using {}.",
                    c.name,
                    system(&mic_in_use)
                ));
            }
        }
        if wanted.echo_cancel && platform::HAS_ECHO_CANCELLER && !attempt.cancel_echo {
            let mic = mic_in_use
                .as_ref()
                .map_or("this microphone".to_string(), |d| d.name.clone());
            notes.push(format!(
                "Echo cancelling won’t work with {mic}, so Desk quiets the microphone while it speaks."
            ));
        }
    }
    if let Some(c) = &wanted.output {
        if output.missing(Some(c)) {
            notes.push(format!(
                "{} isn’t connected, so Desk is playing on {} until it’s back.",
                c.name,
                system(&speaker_in_use)
            ));
        } else if attempt.output.is_none() {
            notes.push(format!(
                "{} wouldn’t open, so Desk is playing on {}.",
                c.name,
                system(&speaker_in_use)
            ));
        }
    }
    AudioStatus {
        listening: attempt.listen,
        input: mic_in_use.filter(|_| attempt.listen),
        output: speaker_in_use,
        echo_cancelled: attempt.cancel_echo,
        quiet_while_speaking: quiet_while_speaking(attempt, wanted),
        notes,
    }
}

/// Without an echo canceller, the microphone goes quiet while Desk speaks:
/// if the person wants echo kept out, and the microphone is open.
fn quiet_while_speaking(attempt: &Attempt, wanted: &AudioPrefs) -> bool {
    attempt.listen && wanted.echo_cancel && !attempt.cancel_echo
}

/// What the devices and choices come to: the ids to open (`None`, the
/// system's) and the devices they are now. Audio is built again when this
/// changes.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Target {
    input: Option<String>,
    input_is: Option<String>,
    output: Option<String>,
    output_is: Option<String>,
}

impl Target {
    fn of(input: &Resolved, output: &Resolved) -> Self {
        Self {
            input: input.id().map(str::to_string),
            input_is: input.device().map(|d| d.id.clone()),
            output: output.id().map(str::to_string),
            output_is: output.device().map(|d| d.id.clone()),
        }
    }
}

// ── The level meter ──────────────────────────────────────────────────────

static LEVEL: AtomicU32 = AtomicU32::new(0);
static LEVEL_AT: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn measure(samples: &[f32]) {
    if samples.is_empty() {
        return;
    }
    let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt();
    LEVEL.store(rms.to_bits(), Ordering::Relaxed);
    LEVEL_AT.store(now_ms(), Ordering::Relaxed);
}

/// How loud the open microphone is now (root mean square, 0 to 1), before
/// anything quiets it; 0 when no microphone is open.
pub fn level() -> f32 {
    if now_ms().saturating_sub(LEVEL_AT.load(Ordering::Relaxed)) > 500 {
        return 0.0;
    }
    f32::from_bits(LEVEL.load(Ordering::Relaxed))
}

// ── What the microphone hears ────────────────────────────────────────────

struct Recording {
    samples: Vec<f32>,
    rate: u32,
    seconds: f32,
}

impl Recording {
    fn full(&self) -> bool {
        self.rate > 0 && self.samples.len() as f32 >= self.seconds * self.rate as f32
    }
}

/// Where the platform's microphone samples go.
struct Hearing {
    to: Option<SharedIn>,
    speaking: Arc<Speaking>,
    /// No echo canceller: quiet while Desk speaks.
    gated: AtomicBool,
    /// Test is recording or playing back: what's heard isn't for anyone.
    testing: AtomicBool,
    recording: Mutex<Option<Recording>>,
}

impl Hearing {
    fn hear(&self, samples: &[f32], rate: u32) {
        measure(samples);
        if self.testing.load(Ordering::SeqCst)
            && let Some(r) = lock(&self.recording).as_mut().filter(|r| !r.full())
        {
            if r.rate != rate {
                r.samples.clear();
                r.rate = rate;
            }
            r.samples.extend_from_slice(samples);
        }
        let Some(to) = &self.to else { return };
        let quiet = self.testing.load(Ordering::SeqCst)
            || (self.gated.load(Ordering::SeqCst) && self.speaking.now())
            || !prefs::hearing();
        if quiet {
            SILENCE.with(|s| {
                let mut s = s.borrow_mut();
                s.clear();
                s.resize(samples.len(), 0.0);
                to(&s, rate);
            });
        } else {
            to(samples, rate);
        }
    }
}

thread_local! {
    static SILENCE: std::cell::RefCell<Vec<f32>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ── The audio that keeps going ───────────────────────────────────────────

struct Current {
    backend: Box<dyn Backend>,
    target: Target,
    prefs: AudioPrefs,
}

struct Inner {
    listen: bool,
    hearing: Arc<Hearing>,
    speaking: Arc<Speaking>,
    current: Mutex<Option<Current>>,
    status: Mutex<AudioStatus>,
    /// Held while building, so dropping waits for a build under way.
    building: Mutex<()>,
    alive: AtomicBool,
}

/// The microphone (when listening) and speaker, kept on the right devices.
pub struct Live {
    inner: Arc<Inner>,
}

/// The audio with the microphone open, if any: what the meter and Test use
/// rather than opening the microphone a second time.
static MIC: Mutex<Option<Weak<Inner>>> = Mutex::new(None);
/// The microphone opened only for the meter, while nothing else has it.
static METER: Mutex<Option<Live>> = Mutex::new(None);

/// How often the supervisor checks the audio is still running.
const TICK: Duration = Duration::from_millis(250);
/// The longest it waits between attempts while nothing will open.
const MOST_BACKOFF: Duration = Duration::from_secs(10);
const STOPPED: &str = "the audio device stopped";
/// More stops than this within the window, and it waits a while.
const STOPS_ALLOWED: usize = 3;
const STOPS_WINDOW: Duration = Duration::from_secs(10);

impl Live {
    /// Opens audio: the microphone too when `listen`, its samples to `to`.
    fn open(listen: bool, to: Option<SharedIn>) -> Result<Self> {
        let speaking = Arc::new(Speaking::default());
        let inner = Arc::new(Inner {
            listen,
            hearing: Arc::new(Hearing {
                to,
                speaking: speaking.clone(),
                gated: AtomicBool::new(false),
                testing: AtomicBool::new(false),
                recording: Mutex::new(None),
            }),
            speaking,
            current: Mutex::new(None),
            status: Mutex::new(AudioStatus::default()),
            building: Mutex::new(()),
            alive: AtomicBool::new(true),
        });
        inner.build("opening")?;
        if listen {
            *lock(&MIC) = Some(Arc::downgrade(&inner));
        }
        let watched = inner.clone();
        std::thread::Builder::new()
            .name("voice-audio-watch".into())
            .spawn(move || watched.watch())?;
        Ok(Self { inner })
    }
}

impl Inner {
    /// Builds the audio for the devices and choices as they are now. The
    /// one before it, if any, is stopped first: speech it was playing is
    /// answered as stopped, so nothing waits on it.
    fn build(&self, why: &str) -> Result<()> {
        let _building = lock(&self.building);
        if !self.alive.load(Ordering::SeqCst) {
            return Ok(());
        }
        let old = lock(&self.current).take();
        if let Some(old) = old {
            let lost = self.speaking.pending();
            old.backend.stop();
            drop(old);
            self.speaking.stopped();
            if lost > 0 {
                tracing::warn!(
                    lost,
                    why,
                    "voice: speech stopped: the audio changed mid-reply"
                );
            }
            // A voice-processing unit winds down in the background; the
            // next one won't start until it has.
            std::thread::sleep(platform::SETTLE);
        }
        let wanted = prefs::get();
        let devices = devices::list();
        let input = devices.input(wanted.input.as_ref());
        let output = devices.output(wanted.output.as_ref());
        let target = Target::of(&input, &output);
        let tries = attempts(
            input.id(),
            output.id(),
            self.listen,
            wanted.echo_cancel,
            platform::HAS_ECHO_CANCELLER && platform::can_cancel_echo(input.device()),
        );
        let mut errors: Vec<(Attempt, eyre::Report)> = Vec::new();
        // A voice-processing unit that failed winds down in the background:
        // the plain microphone tried next starts only once it has, so that
        // one attempt is given a few tries, `SETTLE` apart.
        let mut winding_down = false;
        for attempt in &tries {
            let rounds = if winding_down && !attempt.cancel_echo {
                winding_down = false;
                platform::RETRIES_AFTER_VP
            } else {
                1
            };
            // Without an echo canceller, quiet while Desk speaks from the
            // first buffer the new tap hears.
            self.hearing
                .gated
                .store(quiet_while_speaking(attempt, &wanted), Ordering::SeqCst);
            for round in 0..rounds {
                if rounds > 1 {
                    std::thread::sleep(platform::SETTLE);
                }
                let to = self.listen.then(|| {
                    let hearing = self.hearing.clone();
                    Arc::new(move |s: &[f32], r: u32| hearing.hear(s, r)) as SharedIn
                });
                match objc_pool(|| platform::build(attempt, to)) {
                    Ok(backend) => {
                        let status = describe(attempt, &wanted, &devices, &input, &output);
                        tracing::info!(
                            why,
                            input = status.input.as_ref().map(|d| d.name.as_str()),
                            output = status.output.as_ref().map(|d| d.name.as_str()),
                            echo_cancelled = status.echo_cancelled,
                            quiet_while_speaking = status.quiet_while_speaking,
                            "voice: audio open"
                        );
                        for note in &status.notes {
                            tracing::info!("voice: {note}");
                        }
                        *lock(&self.status) = status;
                        *lock(&self.current) = Some(Current {
                            backend,
                            target,
                            prefs: wanted,
                        });
                        return Ok(());
                    }
                    Err(e) => {
                        tracing::warn!(?attempt, "voice: audio won’t open that way: {e:#}");
                        if round + 1 == rounds {
                            winding_down |= attempt.cancel_echo;
                            errors.push((attempt.clone(), e));
                        }
                    }
                }
            }
        }
        *lock(&self.status) = AudioStatus::default();
        Err(errors
            .pop()
            .map(|(_, e)| e)
            .unwrap_or_else(|| eyre!("the audio won’t start")))
    }

    /// Why the audio needs building again, if it does.
    fn stale(&self, devices: Option<&Devices>) -> Option<&'static str> {
        let current = lock(&self.current);
        let Some(c) = current.as_ref() else {
            return Some("the audio wasn’t open");
        };
        if !c.backend.healthy() {
            return Some(STOPPED);
        }
        let wanted = prefs::get();
        if wanted.rebuilds(&c.prefs) {
            return Some("the audio settings changed");
        }
        let devices = devices?;
        let target = Target::of(
            &devices.input(wanted.input.as_ref()),
            &devices.output(wanted.output.as_ref()),
        );
        let target = Target {
            input_is: target.input_is.filter(|_| self.listen),
            input: target.input.filter(|_| self.listen),
            ..target
        };
        let built = Target {
            input_is: c.target.input_is.clone().filter(|_| self.listen),
            input: c.target.input.clone().filter(|_| self.listen),
            ..c.target.clone()
        };
        (target != built).then_some("the audio devices changed")
    }

    /// Until dropped: builds the audio again whenever it's stale.
    fn watch(self: Arc<Self>) {
        let mut last_poll = Instant::now();
        let mut generation = prefs::generation();
        let mut backoff = TICK;
        let mut retry_at: Option<Instant> = None;
        // When the audio stopped by itself: a device that stops whatever is
        // built on it is given time rather than rebuilt over and over.
        let mut stops: Vec<Instant> = Vec::new();
        while self.alive.load(Ordering::SeqCst) {
            std::thread::sleep(TICK);
            if !self.alive.load(Ordering::SeqCst) {
                break;
            }
            if retry_at.is_some_and(|at| Instant::now() < at) {
                continue;
            }
            let poll = last_poll.elapsed() >= platform::POLL || prefs::generation() != generation;
            let devices = poll.then(|| {
                last_poll = Instant::now();
                generation = prefs::generation();
                devices::list()
            });
            let Some(why) = self.stale(devices.as_ref()) else {
                continue;
            };
            if why == STOPPED {
                stops.retain(|t| t.elapsed() < STOPS_WINDOW);
                stops.push(Instant::now());
                if stops.len() > STOPS_ALLOWED {
                    tracing::warn!(
                        "voice: the audio keeps stopping; waiting before opening it again"
                    );
                    stops.clear();
                    retry_at = Some(Instant::now() + MOST_BACKOFF / 5);
                    continue;
                }
            }
            match self.build(why) {
                Ok(()) => {
                    backoff = TICK;
                    retry_at = None;
                }
                Err(e) => {
                    if backoff == TICK {
                        tracing::warn!("voice: the audio stopped and won’t open again yet: {e:#}");
                    }
                    retry_at = Some(Instant::now() + backoff);
                    backoff = (backoff * 2).min(MOST_BACKOFF);
                }
            }
        }
    }

    fn play(&self, samples: &[f32], rate: u32, done: Done) {
        let speaking = self.speaking.clone();
        speaking.started();
        let done: Done = Box::new(move || {
            speaking.finished();
            done();
        });
        match lock(&self.current).as_ref() {
            Some(c) => c.backend.play(samples, rate, done),
            None => done(),
        }
    }
}

/// Runs `f` in an autorelease pool of its own on macOS, so a failed
/// attempt's objects are gone before the next.
fn objc_pool<T>(f: impl FnOnce() -> T) -> T {
    #[cfg(target_os = "macos")]
    {
        objc2::rc::autoreleasepool(|_| f())
    }
    #[cfg(not(target_os = "macos"))]
    {
        f()
    }
}

impl AudioOut for Live {
    fn play(&self, samples: &[f32], rate: u32, done: Box<dyn FnOnce() + Send>) {
        self.inner.play(samples, rate, done);
    }

    fn stop(&self) {
        if let Some(c) = lock(&self.inner.current).as_ref() {
            c.backend.stop();
        }
        self.inner.speaking.stopped();
    }

    fn lag(&self) -> Duration {
        lock(&self.inner.current)
            .as_ref()
            .map_or(Duration::ZERO, |c| c.backend.lag())
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        let _building = lock(&self.inner.building);
        self.inner.alive.store(false, Ordering::SeqCst);
        if let Some(c) = lock(&self.inner.current).take() {
            c.backend.stop();
        }
        self.inner.speaking.stopped();
        let mut mic = lock(&MIC);
        if mic
            .as_ref()
            .is_some_and(|w| std::ptr::eq(w.as_ptr(), Arc::as_ptr(&self.inner)))
        {
            *mic = None;
        }
    }
}

// ── What the rest of Desk opens ──────────────────────────────────────────

/// The microphone, its samples to `input`, and the speaker. The meter's
/// microphone, if it has one open, is closed first: only one may have it.
pub(crate) fn open(input: AudioIn) -> Result<SharedAudioOut> {
    VOICE_OPENING.fetch_add(1, Ordering::SeqCst);
    drop(lock(&METER).take());
    let opened = Live::open(true, Some(Arc::from(input)));
    VOICE_OPENING.fetch_sub(1, Ordering::SeqCst);
    Ok(Arc::new(opened?))
}

/// Voice is opening the microphone: the meter mustn't open a second one.
static VOICE_OPENING: AtomicUsize = AtomicUsize::new(0);

/// Just the speaker.
pub(crate) fn output() -> Result<SharedAudioOut> {
    Ok(Arc::new(Live::open(false, None)?))
}

/// The audio with the microphone open, if any.
fn mic() -> Option<Arc<Inner>> {
    lock(&MIC)
        .as_ref()
        .and_then(Weak::upgrade)
        .filter(|i| i.alive.load(Ordering::SeqCst))
}

/// What's in use now: the microphone and speaker, whether echo is
/// cancelled, and what isn't as chosen. Nothing listening, nothing in use.
pub fn status() -> AudioStatus {
    mic().map(|m| lock(&m.status).clone()).unwrap_or_default()
}

/// Keeps a microphone open for the level meter while `on`, if nothing else
/// has one open. Voice opening the microphone closes the meter's.
pub fn meter(on: bool) -> Result<()> {
    let mut meter = lock(&METER);
    if !on {
        drop(meter.take());
        return Ok(());
    }
    if super::mic_access() == super::MicAccess::Denied {
        return Err(eyre!(super::MIC_NOT_ALLOWED));
    }
    if meter.is_none() && mic().is_none() && VOICE_OPENING.load(Ordering::SeqCst) == 0 {
        *meter = Some(Live::open(true, None)?);
    }
    Ok(())
}

/// Records `seconds` from the microphone in use and plays them back on the
/// speaker in use. A conversation listening meanwhile hears silence rather
/// than the test. Opens the microphone and speaker for it when nothing has.
pub fn test(seconds: f32) -> Result<()> {
    static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());
    let Ok(_one) = ONE_AT_A_TIME.try_lock() else {
        return Err(eyre!("a test is already running"));
    };
    if super::mic_access() == super::MicAccess::Denied {
        return Err(eyre!(super::MIC_NOT_ALLOWED));
    }
    let seconds = if seconds.is_finite() {
        seconds.clamp(0.5, 10.0)
    } else {
        3.0
    };
    let (inner, _opened) = match mic() {
        Some(inner) => (inner, None),
        None => {
            let live = Live::open(true, None)?;
            (live.inner.clone(), Some(live))
        }
    };
    struct Testing<'a>(&'a Hearing);
    impl Drop for Testing<'_> {
        fn drop(&mut self) {
            *lock(&self.0.recording) = None;
            self.0.testing.store(false, Ordering::SeqCst);
        }
    }
    let hearing = &inner.hearing;
    *lock(&hearing.recording) = Some(Recording {
        samples: Vec::new(),
        rate: 0,
        seconds,
    });
    hearing.testing.store(true, Ordering::SeqCst);
    let _testing = Testing(hearing);
    let until = Instant::now() + Duration::from_secs_f32(seconds + 2.0);
    while !lock(&hearing.recording)
        .as_ref()
        .is_some_and(Recording::full)
    {
        if Instant::now() > until {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let Some(recorded) = lock(&hearing.recording).take() else {
        return Err(eyre!("nothing came from the microphone"));
    };
    if recorded.samples.is_empty() || recorded.rate == 0 {
        return Err(eyre!("nothing came from the microphone"));
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let length = Duration::from_secs_f32(recorded.samples.len() as f32 / recorded.rate as f32);
    inner.play(
        &recorded.samples,
        recorded.rate,
        Box::new(move || {
            let _ = tx.send(());
        }),
    );
    rx.recv_timeout(length + Duration::from_secs(3))
        .map_err(|_| eyre!("the recording didn’t finish playing"))?;
    // What's still on its way from the speaker into the microphone.
    std::thread::sleep(Duration::from_millis(300));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::prefs::DeviceChoice;

    fn names(tries: &[Attempt]) -> Vec<String> {
        tries
            .iter()
            .map(|a| {
                format!(
                    "{}/{}{}",
                    a.input.as_deref().unwrap_or("-"),
                    a.output.as_deref().unwrap_or("-"),
                    if a.cancel_echo { " vp" } else { "" }
                )
            })
            .collect()
    }

    #[test]
    fn the_chosen_devices_are_tried_with_echo_cancelling_first() {
        assert_eq!(
            names(&attempts(Some("yeti"), Some("speakers"), true, true, true)),
            [
                "yeti/speakers vp",
                "yeti/speakers",
                "yeti/-",
                "-/- vp",
                "-/-"
            ]
        );
    }

    #[test]
    fn the_system_devices_need_fewer_tries() {
        assert_eq!(
            names(&attempts(None, None, true, true, true)),
            ["-/- vp", "-/-"]
        );
        // Echo cancelling off, or no canceller: never voice processing.
        assert_eq!(names(&attempts(None, None, true, false, true)), ["-/-"]);
        assert_eq!(
            names(&attempts(Some("usb"), None, true, true, false)),
            ["usb/-", "-/-"]
        );
    }

    #[test]
    fn the_speaker_alone_never_asks_for_the_microphone() {
        let tries = attempts(Some("yeti"), Some("speakers"), false, true, true);
        assert_eq!(names(&tries), ["-/speakers", "-/-"]);
        assert!(tries.iter().all(|a| !a.listen && !a.cancel_echo));
    }

    fn device(id: &str, name: &str, is_default: bool) -> Device {
        Device {
            id: id.into(),
            name: name.into(),
            is_default,
        }
    }

    fn devices() -> Devices {
        Devices {
            inputs: vec![
                device("display", "LG UltraFine Display Audio", true),
                device("yeti", "Yeti Stereo Microphone", false),
            ],
            outputs: vec![device("speakers", "MacBook Pro Speakers", true)],
        }
    }

    fn attempt(input: Option<&str>, cancel_echo: bool) -> Attempt {
        Attempt {
            input: input.map(str::to_string),
            output: None,
            listen: true,
            cancel_echo,
        }
    }

    #[test]
    fn the_status_says_what_isnt_as_chosen() {
        let d = devices();
        let yeti = DeviceChoice {
            id: "yeti".into(),
            name: "Yeti Stereo Microphone".into(),
        };
        let wanted = AudioPrefs {
            input: Some(yeti.clone()),
            ..Default::default()
        };
        let input = d.input(Some(&yeti));
        let output = d.output(None);

        let s = describe(&attempt(Some("yeti"), true), &wanted, &d, &input, &output);
        assert_eq!(s.input.unwrap().name, "Yeti Stereo Microphone");
        assert_eq!(s.output.unwrap().name, "MacBook Pro Speakers");
        assert!(s.echo_cancelled && !s.quiet_while_speaking);
        assert!(s.notes.is_empty(), "{:?}", s.notes);

        // Voice processing refused the Yeti: the gate stands in, and says so
        // (only where there is an echo canceller to be refused).
        let s = describe(&attempt(Some("yeti"), false), &wanted, &d, &input, &output);
        assert!(!s.echo_cancelled && s.quiet_while_speaking);
        assert_eq!(
            s.notes.len(),
            usize::from(platform::HAS_ECHO_CANCELLER),
            "{:?}",
            s.notes
        );

        // The Yeti wouldn't open at all: the system's microphone, said.
        let s = describe(&attempt(None, true), &wanted, &d, &input, &output);
        assert_eq!(s.input.unwrap().name, "LG UltraFine Display Audio");
        assert_eq!(
            s.notes,
            ["Yeti Stereo Microphone wouldn’t open, so Desk is using LG UltraFine Display Audio."]
        );

        // Unplugged: the system's until it's back.
        let away = DeviceChoice {
            id: "airpods".into(),
            name: "AirPods Pro".into(),
        };
        let wanted = AudioPrefs {
            input: Some(away.clone()),
            ..Default::default()
        };
        let input = d.input(Some(&away));
        let s = describe(&attempt(None, true), &wanted, &d, &input, &output);
        assert_eq!(
            s.notes,
            [
                "AirPods Pro isn’t connected, so Desk is using LG UltraFine Display Audio until it’s back."
            ]
        );
    }

    #[test]
    fn echo_cancelling_off_never_quiets_the_microphone() {
        let d = devices();
        let wanted = AudioPrefs {
            echo_cancel: false,
            ..Default::default()
        };
        let s = describe(
            &attempt(None, false),
            &wanted,
            &d,
            &d.input(None),
            &d.output(None),
        );
        assert!(!s.echo_cancelled && !s.quiet_while_speaking);
        assert!(s.notes.is_empty());
    }

    #[test]
    fn following_the_system_rebuilds_when_its_default_changes() {
        let mut d = devices();
        let before = Target::of(&d.input(None), &d.output(None));
        d.inputs[0].is_default = false;
        d.inputs[1].is_default = true;
        let after = Target::of(&d.input(None), &d.output(None));
        assert_ne!(before, after);
        assert_eq!(after.input, None, "still the system's");
        assert_eq!(after.input_is.as_deref(), Some("yeti"));
    }

    #[test]
    fn a_chosen_device_coming_back_rebuilds_onto_it() {
        let yeti = DeviceChoice {
            id: "yeti".into(),
            name: "Yeti Stereo Microphone".into(),
        };
        let mut d = devices();
        let present = Target::of(&d.input(Some(&yeti)), &d.output(None));
        d.inputs.retain(|m| m.id != "yeti");
        let away = Target::of(&d.input(Some(&yeti)), &d.output(None));
        assert_ne!(present, away);
        assert_eq!(present.input.as_deref(), Some("yeti"));
        assert_eq!(away.input, None);
    }

    fn hearing(to: SharedIn) -> Hearing {
        Hearing {
            to: Some(to),
            speaking: Arc::new(Speaking::default()),
            gated: AtomicBool::new(false),
            testing: AtomicBool::new(false),
            recording: Mutex::new(None),
        }
    }

    #[test]
    fn what_is_heard_is_quieted_while_desk_speaks_only_without_a_canceller() {
        let heard = Arc::new(Mutex::new(Vec::new()));
        let h = {
            let heard = heard.clone();
            hearing(Arc::new(move |s: &[f32], _| {
                heard.lock().unwrap().extend_from_slice(s)
            }))
        };
        h.speaking.started();
        h.hear(&[0.5], 16_000);
        h.gated.store(true, Ordering::SeqCst);
        h.hear(&[0.5], 16_000);
        assert_eq!(*heard.lock().unwrap(), [0.5, 0.0]);
    }

    #[test]
    fn a_test_recording_is_kept_and_kept_from_the_conversation() {
        let heard = Arc::new(Mutex::new(Vec::new()));
        let h = {
            let heard = heard.clone();
            hearing(Arc::new(move |s: &[f32], _| {
                heard.lock().unwrap().extend_from_slice(s)
            }))
        };
        *h.recording.lock().unwrap() = Some(Recording {
            samples: Vec::new(),
            rate: 0,
            seconds: 0.5,
        });
        h.testing.store(true, Ordering::SeqCst);
        h.hear(&[0.25; 3], 4);
        h.hear(&[0.25; 3], 4);
        let r = h.recording.lock().unwrap().take().unwrap();
        assert_eq!(
            (r.rate, r.samples.len()),
            (4, 3),
            "stops once it has enough"
        );
        assert!(heard.lock().unwrap().iter().all(|s| *s == 0.0));
    }
}
