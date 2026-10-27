//! Voice lives in the app process, because the microphone permission belongs
//! to the app bundle. Rust does audio only: what it hears goes to the
//! frontend as `voice-utterance` events, and the frontend asks it to speak
//! (the cascade) or hands the agent's answer back (`voice_tool_result`, the
//! cloud engines).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use desk_core::{Keychain, Paths, Secret, SecretStore};
use desk_voice::models::{Progress, default_dir};
use desk_voice::realtime::gemini_live::GeminiLive;
use desk_voice::realtime::gpt_live::GptLive;
use desk_voice::realtime::hub::{HubSessions, Sessions};
use desk_voice::{
    Cascade, EngineKind, Models, Realtime, Utterance, VoiceEngine, VoiceEvents, VoiceState,
};
use eyre::eyre;
use tauri::{AppHandle, Emitter, State};

type CommandResult<T> = Result<T, String>;

type Running = (EngineKind, Box<dyn VoiceEngine>);

pub struct Voice {
    paths: Paths,
    models: Models,
    engine: Mutex<Option<Running>>,
    wanted: Mutex<EngineKind>,
    names: Mutex<Vec<String>>,
    state: Arc<Mutex<VoiceState>>,
    /// Whether voice is wanted off; a download or start in flight checks it.
    off: Arc<AtomicBool>,
    enabling: AtomicBool,
}

impl Voice {
    pub fn new(paths: &Paths) -> Self {
        Self {
            paths: paths.clone(),
            models: Models::new(default_dir(paths)),
            engine: Mutex::new(None),
            wanted: Mutex::new(EngineKind::default()),
            names: Mutex::new(Vec::new()),
            state: Arc::new(Mutex::new(VoiceState::Off)),
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

/// The local hub, which holds the provider keys for the cloud engines.
fn hub(paths: &Paths) -> eyre::Result<Arc<dyn Sessions>> {
    let ports = desk_core::read_ports(&paths.hub_state())?
        .ok_or_else(|| eyre!("the local hub hasn't started"))?;
    let token = Keychain
        .get(Secret::GatewayToken)?
        .ok_or_else(|| eyre!("the local hub has no token yet"))?;
    Ok(Arc::new(HubSessions::new(ports.gateway_url(), token)))
}

/// Fetches what `kind` runs on and starts it; `None` when voice was turned
/// off on the way.
fn start(
    kind: EngineKind,
    models: &Models,
    paths: &Paths,
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
        EngineKind::Cascade => Box::new(Cascade::start(models, events, open)?),
        EngineKind::GptLive => Box::new(Realtime::start(
            models,
            Arc::new(GptLive),
            hub(paths)?,
            events,
            open,
        )?),
        EngineKind::GeminiLive => Box::new(Realtime::start(
            models,
            Arc::new(GeminiLive),
            hub(paths)?,
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
    tauri::async_runtime::spawn_blocking(move || drop(replaced))
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
        let (models, paths, events, off) = (
            voice.models.clone(),
            voice.paths.clone(),
            events.clone(),
            voice.off.clone(),
        );
        let attempt = tauri::async_runtime::spawn_blocking(move || {
            start(kind, &models, &paths, events, &off)
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
            engine.set_names(lock(&voice.names).clone());
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

/// The roster names to wake on, as plain text.
#[tauri::command]
pub fn voice_set_names(voice: State<'_, Voice>, names: Vec<String>) {
    *lock(&voice.names) = names.clone();
    voice.with_engine(|e| e.set_names(names));
}

#[tauri::command]
pub fn voice_push_to_talk(voice: State<'_, Voice>, pressed: bool) {
    voice.with_engine(|e| e.push_to_talk(pressed));
}

/// Speaks `text`. `more` marks an acknowledgement with the answer still to
/// come, which keeps the conversation open while the agent works.
#[tauri::command]
pub fn voice_speak(voice: State<'_, Voice>, text: String, more: Option<bool>) {
    voice.with_engine(|e| e.speak(text, more.unwrap_or(false)));
}

#[tauri::command]
pub fn voice_stop_speaking(voice: State<'_, Voice>) {
    voice.with_engine(|e| e.stop_speaking());
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
