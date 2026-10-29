//! Voice lives in the app process, because the microphone permission belongs
//! to the app bundle. Rust does audio only: what it hears goes to the
//! frontend as `voice-utterance` events, and the frontend asks it to speak
//! (the cascade, in the agent's voice) or hands the agent's answer back
//! (`voice_tool_result`, the cloud engines). Cloud voices are spoken by the
//! local hub, which holds the keys; the gateway token never reaches JS.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use desk_core::{Paths, Secret, SecretStore, Secrets};
use desk_voice::cascade::Voices;
use desk_voice::hub::{CloudSpeech, Grant, Hub, Sessions, SpeechError};
use desk_voice::lookup::{self, Endpoints, Lookup};
use desk_voice::models::{Progress, TTS, default_dir};
use desk_voice::realtime::gemini_live::GeminiLive;
use desk_voice::realtime::gpt_live::GptLive;
use desk_voice::speech::Speaker;
use desk_voice::voices::{Provider, VoiceInfo, engine_voices, kokoro_voices};
use desk_voice::{
    Audio, Cascade, EngineKind, Member, Models, Realtime, SharedAudioOut, Utterance, VoiceEngine,
    VoiceEvents, VoiceSpec, VoiceState,
};
use eyre::eyre;
use tauri::{AppHandle, Emitter, State};

type CommandResult<T> = Result<T, String>;

type Running = (EngineKind, Box<dyn VoiceEngine>);

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
    /// Whether voice is wanted off; a download or start in flight checks it.
    off: Arc<AtomicBool>,
    enabling: AtomicBool,
}

impl Voice {
    pub fn new(paths: &Paths) -> Self {
        Self {
            models: Models::new(default_dir(paths)),
            engine: Mutex::new(None),
            wanted: Mutex::new(EngineKind::default()),
            roster: Mutex::new(Vec::new()),
            state: Arc::new(Mutex::new(VoiceState::Off)),
            hub: Arc::new(LocalHub {
                paths: paths.clone(),
                hub: Mutex::new(None),
            }),
            kokoro: Arc::new(Mutex::new(None)),
            trial: Mutex::new(None),
            off: Arc::new(AtomicBool::new(true)),
            enabling: AtomicBool::new(false),
        }
    }

    fn with_engine(&self, f: impl FnOnce(&dyn VoiceEngine)) {
        if let Some((_, engine)) = lock(&self.engine).as_ref() {
            f(engine.as_ref());
        }
    }

    fn wanted(&self) -> EngineKind {
        *lock(&self.wanted)
    }

    fn shared(&self) -> Shared {
        Shared {
            hub: self.hub.clone(),
            kokoro: self.kokoro.clone(),
        }
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
    paths: Paths,
    hub: Mutex<Option<Arc<Hub>>>,
}

impl LocalHub {
    fn get(&self) -> eyre::Result<Arc<Hub>> {
        let mut hub = lock(&self.hub);
        if let Some(h) = hub.as_ref() {
            return Ok(h.clone());
        }
        let ports = desk_core::read_ports(&self.paths.hub_state())?
            .ok_or_else(|| eyre!("Desk is still starting"))?;
        let token = Secrets::for_paths(&self.paths)
            .get(Secret::GatewayToken)?
            .ok_or_else(|| eyre!("Desk is still starting"))?;
        Ok(hub
            .insert(Arc::new(Hub::new(ports.gateway_url(), token)))
            .clone())
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
) -> eyre::Result<Option<Box<dyn VoiceEngine>>> {
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
    let open = desk_voice::mac::open;
    Ok(Some(match kind {
        EngineKind::Cascade => {
            let voices = Voices {
                kokoro: kokoro(&shared.kokoro, models)?,
                cloud: Some(shared.hub.clone()),
            };
            Box::new(Cascade::start(models, voices, events, open)?)
        }
        EngineKind::GptLive => Box::new(Realtime::start(
            models,
            Arc::new(GptLive),
            shared.hub.clone(),
            events,
            open,
        )?),
        EngineKind::GeminiLive => Box::new(Realtime::start(
            models,
            Arc::new(GeminiLive),
            shared.hub.clone(),
            events,
            open,
        )?),
    }))
}

/// Turns voice on with `engine` ("cascade", "gpt-live", "gemini-live"; an
/// unknown name is the cascade): fetches its models the first time
/// (reporting progress as `voice-state` events), then starts listening.
/// Asking for another engine replaces the running one. Turning voice off
/// meanwhile cancels; turning it back on before that has wound down starts
/// again.
#[tauri::command]
pub async fn voice_enable(
    app: AppHandle,
    voice: State<'_, Voice>,
    engine: Option<String>,
) -> CommandResult<()> {
    let kind = engine.as_deref().map(EngineKind::parse).unwrap_or_default();
    *lock(&voice.wanted) = kind;
    voice.off.store(false, Ordering::SeqCst);
    let replaced = {
        let mut running = lock(&voice.engine);
        match running.as_ref() {
            Some((k, _)) if *k == kind => return Ok(()),
            Some(_) => running.take(),
            None => None,
        }
    };
    let trial = lock(&voice.trial).take();
    tauri::async_runtime::spawn_blocking(move || drop((replaced, trial)))
        .await
        .map_err(|e| e.to_string())?;
    if voice.enabling.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let events = Arc::new(Events {
        app,
        state: voice.state.clone(),
    });
    let started = loop {
        let kind = voice.wanted();
        let (models, shared, events, off) = (
            voice.models.clone(),
            voice.shared(),
            events.clone(),
            voice.off.clone(),
        );
        let attempt = tauri::async_runtime::spawn_blocking(move || {
            start(kind, &models, &shared, events, &off)
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r.map_err(|e| format!("{e:#}")));
        match attempt {
            _ if voice.off.load(Ordering::SeqCst) => break Ok(None),
            Ok(None) => continue,
            Ok(Some(_)) if voice.wanted() != kind => continue,
            Ok(Some(engine)) => break Ok(Some((kind, engine))),
            Err(e) => break Err(e),
        }
    };
    voice.enabling.store(false, Ordering::SeqCst);
    match started {
        Ok(Some((kind, engine))) => {
            engine.set_roster(lock(&voice.roster).clone());
            *lock(&voice.engine) = Some((kind, engine));
            Ok(())
        }
        Ok(None) => {
            events.state(&VoiceState::Off);
            Ok(())
        }
        Err(e) => {
            events.state(&VoiceState::Off);
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn voice_disable(app: AppHandle, voice: State<'_, Voice>) -> CommandResult<()> {
    voice.off.store(true, Ordering::SeqCst);
    let engine = lock(&voice.engine).take();
    tauri::async_runtime::spawn_blocking(move || drop(engine))
        .await
        .map_err(|e| e.to_string())?;
    Events {
        app,
        state: voice.state.clone(),
    }
    .state(&VoiceState::Off);
    Ok(())
}

/// The roster: the names to wake on (plain text) and each agent's voice,
/// which the live engines open their sessions with.
#[tauri::command]
pub fn voice_set_roster(voice: State<'_, Voice>, roster: Vec<Member>) {
    *lock(&voice.roster) = roster.clone();
    voice.with_engine(|e| e.set_roster(roster));
}

#[tauri::command]
pub fn voice_push_to_talk(voice: State<'_, Voice>, pressed: bool) {
    voice.with_engine(|e| e.push_to_talk(pressed));
}

/// Speaks `text` in `voice` (the agent's; the engine's default when
/// absent). `more` marks an acknowledgement with the answer still to come,
/// which keeps the conversation open while the agent works.
#[tauri::command]
pub fn voice_speak(
    desk: State<'_, Voice>,
    text: String,
    more: Option<bool>,
    voice: Option<VoiceSpec>,
) {
    desk.with_engine(|e| e.speak(text, more.unwrap_or(false), voice));
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
    if let Some((_, engine)) = lock(&desk.engine).as_ref() {
        engine.play(audio);
        return Ok(());
    }
    let mut trial = lock(&desk.trial);
    let out = match trial.as_ref() {
        Some(out) => out.clone(),
        None => trial
            .insert(desk_voice::mac::output().map_err(|e| format!("{e:#}"))?)
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
        Some((_, engine)) => engine.state(),
        None => lock(&voice.state).clone(),
    }
}
