//! Voice lives in the app process, because the microphone permission belongs
//! to the app bundle. Rust does audio only: what it hears goes to the
//! frontend as `voice-utterance` events, and the frontend asks it to speak
//! (the cascade, in the agent's voice) or hands the agent's answer back
//! (`voice_tool_result`, the cloud engines). Cloud voices are spoken by the
//! local hub, which holds the keys; the gateway token never reaches JS.
//!
//! One engine has the microphone at a time, chosen by what's wanted: while a
//! conversation holds it (`voice_claim`, a DM's talk or hold) the on-device
//! cascade listens for that conversation alone; otherwise voice by name runs
//! on the engine Settings name, if it's on.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use desk_core::Paths;
use desk_core::backend::Backend;
use desk_voice::cascade::Voices;
use desk_voice::hub::{CloudSpeech, Grant, Hub, Sessions, SpeechError};
use desk_voice::lookup::{self, Endpoints, Lookup};
use desk_voice::models::{Progress, TTS, default_dir};
use desk_voice::realtime::gemini_live::GeminiLive;
use desk_voice::realtime::gpt_live::GptLive;
use desk_voice::speech::Speaker;
use desk_voice::voices::{Provider, VoiceInfo, engine_voices, kokoro_voices};
use desk_voice::{
    Audio, Cascade, EngineKind, ListenMode, Member, Models, Realtime, SharedAudioOut, Utterance,
    VoiceEngine, VoiceEvents, VoiceSpec, VoiceState,
};
use eyre::eyre;
use tauri::{AppHandle, Emitter, State};

type CommandResult<T> = Result<T, String>;

/// The engine with the microphone: the cascade, which can listen for one
/// conversation, or a live engine, which listens by name.
enum Running {
    Cascade(Cascade),
    Live(EngineKind, Box<dyn VoiceEngine>),
}

impl Running {
    fn kind(&self) -> EngineKind {
        match self {
            Running::Cascade(_) => EngineKind::Cascade,
            Running::Live(kind, _) => *kind,
        }
    }

    fn engine(&self) -> &dyn VoiceEngine {
        match self {
            Running::Cascade(cascade) => cascade,
            Running::Live(_, engine) => engine.as_ref(),
        }
    }

    /// Listens `mode`'s way. Only the cascade is ever asked for anything
    /// but names (see [`Voice::desired`]).
    fn listen(&self, mode: ListenMode) {
        match self {
            Running::Cascade(cascade) => cascade.set_mode(mode),
            Running::Live(..) => debug_assert_eq!(mode, ListenMode::Names),
        }
    }
}

pub struct Voice {
    models: Models,
    engine: Mutex<Option<Running>>,
    wanted: Mutex<EngineKind>,
    roster: Mutex<Vec<Member>>,
    state: Arc<Mutex<VoiceState>>,
    hub: Arc<LocalHub>,
    kokoro: Arc<Mutex<Option<Arc<Speaker>>>>,
    /// The speaker-only output samples play through while voice is off.
    trial: Mutex<Option<SharedAudioOut>>,
    /// Whether voice by name is wanted off.
    off: AtomicBool,
    /// How the conversation holding the microphone listens; `None` while
    /// none does.
    claim: Mutex<Option<ListenMode>>,
    /// Whether nothing at all is wanted; a download or start in flight
    /// checks it.
    idle: Arc<AtomicBool>,
    /// Push-to-talk is held: an engine that starts meanwhile takes it.
    held: AtomicBool,
    enabling: AtomicBool,
}

impl Voice {
    pub fn new(paths: &Paths, backend: Option<Backend>) -> Self {
        Self {
            models: Models::new(default_dir(paths)),
            engine: Mutex::new(None),
            wanted: Mutex::new(EngineKind::default()),
            roster: Mutex::new(Vec::new()),
            state: Arc::new(Mutex::new(VoiceState::Off)),
            hub: Arc::new(LocalHub {
                backend,
                hub: Mutex::new(None),
            }),
            kokoro: Arc::new(Mutex::new(None)),
            trial: Mutex::new(None),
            off: AtomicBool::new(true),
            claim: Mutex::new(None),
            idle: Arc::new(AtomicBool::new(true)),
            held: AtomicBool::new(false),
            enabling: AtomicBool::new(false),
        }
    }

    /// Runs `f` on the engine; false when none is running.
    fn with_engine(&self, f: impl FnOnce(&dyn VoiceEngine)) -> bool {
        match lock(&self.engine).as_ref() {
            Some(running) => {
                f(running.engine());
                true
            }
            None => false,
        }
    }

    fn wanted(&self) -> EngineKind {
        *lock(&self.wanted)
    }

    /// The engine that should have the microphone, and how it listens: the
    /// cascade for the conversation holding it, else voice by name on the
    /// engine Settings name, else none.
    fn desired(&self) -> Option<(EngineKind, ListenMode)> {
        desired(
            *lock(&self.claim),
            !self.off.load(Ordering::SeqCst),
            self.wanted(),
        )
    }

    fn shared(&self) -> Shared {
        Shared {
            hub: self.hub.clone(),
            kokoro: self.kokoro.clone(),
        }
    }
}

/// What has the microphone, from who claims it: a conversation's claim beats
/// voice by name, which runs only while it's on.
fn desired(
    claim: Option<ListenMode>,
    by_name: bool,
    engine: EngineKind,
) -> Option<(EngineKind, ListenMode)> {
    match claim {
        Some(mode) => Some((EngineKind::Cascade, mode)),
        None if by_name => Some((engine, ListenMode::Names)),
        None => None,
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

struct Events {
    app: AppHandle,
    state: Arc<Mutex<VoiceState>>,
}

impl VoiceEvents for Events {
    fn state(&self, state: &VoiceState) {
        *lock(&self.state) = state.clone();
        let _ = self.app.emit("voice-state", state);
    }

    fn utterance(&self, utterance: &Utterance) {
        let _ = self.app.emit("voice-utterance", utterance);
    }

    fn unheard(&self) {
        let _ = self.app.emit("voice-unheard", ());
    }

    fn error(&self, message: &str) {
        let _ = self.app.emit("voice-error", message);
    }
}

/// Download progress, at most every half percent.
fn downloading(events: &Events) -> impl FnMut(Progress) + '_ {
    let mut shown = -1.0;
    move |p| {
        let progress = p.fraction();
        if progress - shown >= 0.005 || progress >= 1.0 {
            shown = progress;
            events.state(&VoiceState::Downloading {
                model: p.model.to_string(),
                progress,
            });
        }
    }
}

/// The local hub, which holds the provider keys: found when first needed,
/// since it may start after Desk.
struct LocalHub {
    backend: Option<Backend>,
    hub: Mutex<Option<Arc<Hub>>>,
}

impl LocalHub {
    fn get(&self) -> eyre::Result<Arc<Hub>> {
        let mut hub = lock(&self.hub);
        if let Some(h) = hub.as_ref() {
            return Ok(h.clone());
        }
        let c = self
            .backend
            .as_ref()
            .ok_or_else(|| eyre!("Desk isn't set up on this computer yet"))?
            .connection()?
            .ok_or_else(|| eyre!("Desk is still starting"))?;
        // Its admin token goes only to an address on this computer.
        let base = desk_core::net::loopback_url(&c.gateway_url).map_err(|e| eyre!(e))?;
        let base = base.as_str().trim_end_matches('/').to_string();
        Ok(hub.insert(Arc::new(Hub::new(base, c.admin_token))).clone())
    }
}

impl Sessions for LocalHub {
    fn grant(&self, engine: &str) -> eyre::Result<Grant> {
        self.get()?.grant(engine)
    }
}

impl CloudSpeech for LocalHub {
    fn speak(&self, voice: &VoiceSpec, text: &str) -> Result<Audio, SpeechError> {
        self.get()
            .map_err(|e| SpeechError::Hub(e.to_string()))?
            .speak(voice, text)
    }
}

/// Kokoro, loaded once and shared by the cascade and voice samples.
fn kokoro(slot: &Mutex<Option<Arc<Speaker>>>, models: &Models) -> eyre::Result<Arc<Speaker>> {
    let mut slot = lock(slot);
    if let Some(s) = slot.as_ref() {
        return Ok(s.clone());
    }
    Ok(slot.insert(Arc::new(Speaker::new(models)?)).clone())
}

struct Shared {
    hub: Arc<LocalHub>,
    kokoro: Arc<Mutex<Option<Arc<Speaker>>>>,
}

/// Fetches what `kind` runs on and starts it; `None` when voice was turned
/// off on the way.
fn start(
    kind: EngineKind,
    models: &Models,
    shared: &Shared,
    events: Arc<Events>,
    off: &AtomicBool,
) -> eyre::Result<Option<Running>> {
    if let Err(e) = models.ensure(kind.models(), off, &mut downloading(&events)) {
        return if off.load(Ordering::SeqCst) {
            Ok(None)
        } else {
            Err(e)
        };
    }
    if off.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let open = desk_voice::audio::open;
    Ok(Some(match kind {
        EngineKind::Cascade => {
            let voices = Voices {
                kokoro: kokoro(&shared.kokoro, models)?,
                cloud: Some(shared.hub.clone()),
            };
            Running::Cascade(Cascade::start(models, voices, events, open)?)
        }
        EngineKind::GptLive => Running::Live(
            kind,
            Box::new(Realtime::start(
                models,
                Arc::new(GptLive),
                shared.hub.clone(),
                events,
                open,
            )?),
        ),
        EngineKind::GeminiLive => Running::Live(
            kind,
            Box::new(Realtime::start(
                models,
                Arc::new(GeminiLive),
                shared.hub.clone(),
                events,
                open,
            )?),
        ),
    }))
}

/// Brings the engine in line with what's wanted ([`Voice::desired`]): the
/// running one changes how it listens, or is replaced, or stops. Fetches an
/// engine's models the first time (reporting progress as `voice-state`
/// events). A change while an engine starts is picked up when it's up.
async fn reconcile(app: AppHandle, voice: &Voice) -> CommandResult<()> {
    let events = Arc::new(Events {
        app,
        state: voice.state.clone(),
    });
    loop {
        let want = voice.desired();
        voice.idle.store(want.is_none(), Ordering::SeqCst);
        let replaced = {
            let mut running = lock(&voice.engine);
            match (running.as_ref(), want) {
                (Some(r), Some((kind, mode))) if r.kind() == kind => {
                    r.listen(mode);
                    return Ok(());
                }
                (None, None) => {
                    if !voice.enabling.load(Ordering::SeqCst) {
                        events.state(&VoiceState::Off);
                    }
                    return Ok(());
                }
                _ => running.take(),
            }
        };
        let trial = lock(&voice.trial).take();
        tauri::async_runtime::spawn_blocking(move || drop((replaced, trial)))
            .await
            .map_err(|e| e.to_string())?;
        if want.is_none() {
            events.state(&VoiceState::Off);
            return Ok(());
        }
        if voice.enabling.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let started = loop {
            let Some((kind, _)) = voice.desired() else {
                break Ok(None);
            };
            let (models, shared, events, idle) = (
                voice.models.clone(),
                voice.shared(),
                events.clone(),
                voice.idle.clone(),
            );
            let attempt = tauri::async_runtime::spawn_blocking(move || {
                start(kind, &models, &shared, events, &idle)
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r.map_err(|e| format!("{e:#}")));
            match attempt {
                _ if voice.desired().is_none() => break Ok(None),
                Ok(None) => continue,
                Ok(Some(_)) if voice.desired().map(|(k, _)| k) != Some(kind) => continue,
                Ok(Some(running)) => break Ok(Some(running)),
                Err(e) => break Err(e),
            }
        };
        voice.enabling.store(false, Ordering::SeqCst);
        match started {
            Ok(Some(running)) => {
                running.engine().set_roster(lock(&voice.roster).clone());
                if voice.held.load(Ordering::SeqCst) {
                    running.engine().push_to_talk(true);
                }
                *lock(&voice.engine) = Some(running);
            }
            Ok(None) => events.state(&VoiceState::Off),
            Err(e) => {
                events.state(&VoiceState::Off);
                return Err(e);
            }
        }
    }
}

/// Turns voice by name on with `engine` ("cascade", "gpt-live",
/// "gemini-live"; an unknown name is the cascade). Asking for another engine
/// replaces the running one; turning voice off meanwhile cancels. While a
/// conversation holds the microphone, this is what it goes back to.
#[tauri::command]
pub async fn voice_enable(
    app: AppHandle,
    voice: State<'_, Voice>,
    engine: Option<String>,
) -> CommandResult<()> {
    *lock(&voice.wanted) = engine.as_deref().map(EngineKind::parse).unwrap_or_default();
    voice.off.store(false, Ordering::SeqCst);
    reconcile(app, &voice).await
}

/// Turns voice by name off. A conversation holding the microphone keeps it.
#[tauri::command]
pub async fn voice_disable(app: AppHandle, voice: State<'_, Voice>) -> CommandResult<()> {
    voice.off.store(true, Ordering::SeqCst);
    reconcile(app, &voice).await
}

/// A conversation takes the microphone (`"open"`: everything said is for
/// it; `"held"`: only push-to-talk), or gives it back (`null`) to voice by
/// name. It runs on the on-device cascade, which hears every word as said;
/// a live engine running by name is set aside until it's given back.
#[tauri::command]
pub async fn voice_claim(
    app: AppHandle,
    voice: State<'_, Voice>,
    mode: Option<ListenMode>,
) -> CommandResult<()> {
    *lock(&voice.claim) = mode;
    reconcile(app, &voice).await
}

/// The roster: the names to wake on (plain text) and each agent's voice,
/// which the live engines open their sessions with.
#[tauri::command]
pub fn voice_set_roster(voice: State<'_, Voice>, roster: Vec<Member>) {
    *lock(&voice.roster) = roster.clone();
    voice.with_engine(|e| e.set_roster(roster));
}

/// Push-to-talk pressed or let go. Pressed while an engine is starting, it
/// is taken once the engine is up; let go before then, nothing was heard.
#[tauri::command]
pub fn voice_push_to_talk(app: AppHandle, voice: State<'_, Voice>, pressed: bool) {
    voice.held.store(pressed, Ordering::SeqCst);
    if !voice.with_engine(|e| e.push_to_talk(pressed)) && !pressed {
        let _ = app.emit("voice-unheard", ());
    }
}

/// Speaks `text` in `voice` (the agent's; the engine's default when
/// absent).
#[tauri::command]
pub fn voice_speak(desk: State<'_, Voice>, text: String, voice: Option<VoiceSpec>) {
    desk.with_engine(|e| e.speak(text, voice));
}

#[tauri::command]
pub fn voice_stop_speaking(voice: State<'_, Voice>) {
    voice.with_engine(|e| e.stop_speaking());
    if let Some(out) = lock(&voice.trial).as_ref() {
        out.stop();
    }
}

/// `text` in `voice`, made here (Kokoro) or by the hub (cloud voices).
fn sample(
    spec: &VoiceSpec,
    text: &str,
    models: &Models,
    shared: &Shared,
    events: &Events,
) -> Result<Audio, String> {
    match spec.provider {
        Provider::Kokoro => {
            let before = lock(&events.state).clone();
            let fetched = models.ensure(&[&TTS], &AtomicBool::new(false), &mut downloading(events));
            events.state(&before);
            fetched.map_err(|e| format!("couldn't fetch Kokoro: {e:#}"))?;
            kokoro(&shared.kokoro, models)
                .map_err(|e| format!("{e:#}"))?
                .synthesize(text, spec.voice.as_deref())
                .ok_or_else(|| "Kokoro couldn't say that".to_string())
        }
        p if p.is_cloud_speech() => shared.hub.speak(spec, text).map_err(|e| e.to_string()),
        _ => Err(
            "GPT-Live and Gemini Live voices are heard in a live conversation: turn \
                  voice on with that engine to hear one."
                .into(),
        ),
    }
}

/// Plays `text` in `voice`, even with voice off; `voice_stop_speaking`
/// stops it. The error is worded for the person (a missing key, say).
#[tauri::command]
pub async fn voice_try(
    app: AppHandle,
    desk: State<'_, Voice>,
    voice: VoiceSpec,
    text: String,
) -> CommandResult<()> {
    let (models, shared) = (desk.models.clone(), desk.shared());
    let events = Events {
        app,
        state: desk.state.clone(),
    };
    let audio = tauri::async_runtime::spawn_blocking(move || {
        sample(&voice, &text, &models, &shared, &events)
    })
    .await
    .map_err(|e| e.to_string())??;
    if let Some(running) = lock(&desk.engine).as_ref() {
        running.engine().play(audio);
        return Ok(());
    }
    let mut trial = lock(&desk.trial);
    let out = match trial.as_ref() {
        Some(out) => out.clone(),
        None => trial
            .insert(desk_voice::audio::output().map_err(|e| format!("{e:#}"))?)
            .clone(),
    };
    out.play(&audio.samples, audio.rate, Box::new(|| {}));
    Ok(())
}

/// Looks up a voice someone entered by id (Fish Audio, ElevenLabs) with the
/// provider, using the key Desk keeps for it in the local hub's vault. The
/// key stays here; the page only hears what the provider said.
#[tauri::command]
pub async fn voice_lookup(
    desk: State<'_, Voice>,
    provider: Provider,
    voice: String,
) -> CommandResult<Lookup> {
    let hub = desk.hub.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(name) = lookup::key_name(provider).filter(|_| lookup::takes_custom_ids(provider))
        else {
            return Ok(Lookup::Failed {
                message: "this provider's voices can't be added by id".into(),
            });
        };
        let key = hub
            .get()
            .and_then(|h| h.speech_key(name))
            .map_err(|e| format!("{e:#}"))?;
        Ok(match key {
            None => Lookup::NoKey,
            Some(key) => lookup::lookup(&Endpoints::default(), provider, &voice, &key),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Kokoro's voices, as `{id, name, description}`.
#[tauri::command]
pub fn voice_kokoro_voices() -> Vec<VoiceInfo> {
    kokoro_voices()
}

/// The voices a live engine ("gpt-live", "gemini-live") or Kokoro offers.
#[tauri::command]
pub fn voice_engine_voices(engine: Provider) -> Vec<VoiceInfo> {
    engine_voices(engine)
}

/// An agent's answer to a request a cloud voice model made (an utterance
/// with a `callId`).
#[tauri::command]
pub fn voice_tool_result(voice: State<'_, Voice>, call_id: String, text: String) {
    voice.with_engine(|e| e.tool_result(call_id, text));
}

#[tauri::command]
pub fn voice_status(voice: State<'_, Voice>) -> VoiceState {
    match lock(&voice.engine).as_ref() {
        Some(running) => running.engine().state(),
        None => lock(&voice.state).clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_conversation_holding_the_microphone_runs_the_cascade() {
        for engine in [
            EngineKind::Cascade,
            EngineKind::GptLive,
            EngineKind::GeminiLive,
        ] {
            for by_name in [true, false] {
                for mode in [ListenMode::Open, ListenMode::Held] {
                    assert_eq!(
                        desired(Some(mode), by_name, engine),
                        Some((EngineKind::Cascade, mode))
                    );
                }
            }
        }
    }

    #[test]
    fn voice_by_name_has_it_otherwise_while_on() {
        assert_eq!(
            desired(None, true, EngineKind::GptLive),
            Some((EngineKind::GptLive, ListenMode::Names))
        );
        assert_eq!(desired(None, false, EngineKind::GptLive), None);
    }
}
