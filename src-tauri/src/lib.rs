mod attachments;
mod files;
mod fonts;
mod frame;
mod grid_windows;
mod helper;
mod hubs;
mod logins;
mod state;
mod support;
mod terminals;
mod tuple;
mod updates;
mod voice;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use desk_core::Paths;
use desk_core::backend::Backend;
use desk_core::host::Host;
use helper::Login;
use serde::Serialize;
use tauri::{Emitter, Manager, State};

struct App {
    /// The app's own folder: settings, hubs, themes, its log.
    paths: Paths,
    /// Where the hub and its helper run, and their folder.
    backend: Backend,
    helper: Mutex<helper::Status>,
    _themes: Mutex<Option<notify::RecommendedWatcher>>,
}

#[derive(Serialize)]
struct HubConnection {
    url: String,
    token: String,
}

type CommandResult<T> = Result<T, String>;

fn text<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// The local hub's address and token. On first launch `desk-hubd` is still
/// creating them, so this waits for both.
#[tauri::command]
async fn hub_connection(app: State<'_, App>) -> CommandResult<HubConnection> {
    let backend = app.backend.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            if let Some(c) = backend.connection().map_err(text)? {
                return Ok(HubConnection {
                    url: c.gateway_url,
                    token: c.admin_token,
                });
            }
            // Say at once when Desk Helper can't start, rather than wait.
            if let Some(why) = helper::login(&backend).status().blocked() {
                return Err(why);
            }
            if Instant::now() > deadline {
                return Err(
                    "Desk Helper hasn’t started. Settings → Help says why, and can save a report."
                        .into(),
                );
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    })
    .await
    .map_err(text)?
}

/// What the page needs to know about this computer, read once at start.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostInfo {
    /// `macos`, `linux` or `windows`.
    platform: &'static str,
    /// Where the backend runs.
    host: Host,
    computer_name: Option<String>,
    /// Where the backend keeps its secrets, as Help names it.
    keys: &'static str,
}

#[tauri::command]
async fn host_info(app: State<'_, App>) -> CommandResult<HostInfo> {
    let backend = app.backend.clone();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(HostInfo {
            platform: std::env::consts::OS,
            keys: desk_core::Secrets::for_host(&backend.paths, &backend.host)
                .map_err(text)?
                .store()
                .name(),
            host: backend.host,
            computer_name: desk_core::computer_name(),
        })
    })
    .await
    .map_err(text)?
}

#[tauri::command]
fn settings_load(app: State<'_, App>) -> CommandResult<files::Settings> {
    files::load_settings(&app.paths).map_err(text)
}

#[tauri::command]
fn settings_save(app: State<'_, App>, settings: files::Settings) -> CommandResult<()> {
    files::save_settings(&app.paths, &settings).map_err(text)
}

#[tauri::command]
fn themes_list(app: State<'_, App>) -> CommandResult<Vec<files::ThemeFile>> {
    files::list_themes(&app.paths.themes()).map_err(text)
}

#[tauri::command]
fn themes_write(app: State<'_, App>, id: String, source: String) -> CommandResult<()> {
    files::write_theme(&app.paths.themes(), &id, &source).map_err(text)
}

/// Opens the themes folder in the system's file manager.
#[tauri::command]
fn themes_reveal(handle: tauri::AppHandle, app: State<'_, App>) -> CommandResult<()> {
    use tauri_plugin_opener::OpenerExt;
    let dir = app.paths.themes();
    std::fs::create_dir_all(&dir).map_err(text)?;
    handle
        .opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(text)
}

#[tauri::command]
async fn hubs_list(app: State<'_, App>) -> CommandResult<Vec<hubs::HubAccount>> {
    let (paths, backend) = (app.paths.clone(), app.backend.clone());
    tauri::async_runtime::spawn_blocking(move || hubs::accounts(&paths, &backend))
        .await
        .map_err(text)?
        .map_err(text)
}

#[tauri::command]
fn hubs_save(
    app: State<'_, App>,
    files: State<'_, attachments::Files>,
    label: String,
    url: String,
    token: String,
) -> CommandResult<hubs::HubRecord> {
    let saved = hubs::save(&app.paths, &label, &url, &token).map_err(text);
    files.forget();
    saved
}

#[tauri::command]
fn hubs_remove(
    app: State<'_, App>,
    files: State<'_, attachments::Files>,
    id: String,
) -> CommandResult<()> {
    let removed = hubs::remove(&app.paths, &id).map_err(text);
    files.forget();
    removed
}

#[tauri::command]
fn tuple_enable(app: tauri::AppHandle, tuple: State<'_, tuple::Tuple>, names: Vec<String>) {
    tuple.enable(app, names);
}

#[tauri::command]
fn tuple_disable(tuple: State<'_, tuple::Tuple>) {
    tuple.disable();
}

#[tauri::command]
async fn tuple_reply(agent: String, answer: String) -> CommandResult<()> {
    let tuple = desk_tuple::binary().ok_or("Tuple isn't installed on this computer")?;
    desk_tuple::notify(&tuple, &agent, &answer)
        .await
        .map_err(text)
}

/// Whether this computer has Tuple: Settings offers it only then.
#[tauri::command]
fn tuple_available() -> bool {
    desk_tuple::binary().is_some()
}

#[tauri::command]
async fn login_start(app: tauri::AppHandle, plan: logins::Plan) -> CommandResult<()> {
    let backend = app.state::<App>().backend.clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<logins::Logins>().start(&app, backend, plan)
    })
    .await
    .map_err(text)?
}

#[tauri::command]
fn login_code(
    logins: State<'_, logins::Logins>,
    plan: logins::Plan,
    code: String,
) -> CommandResult<()> {
    logins.code(plan, &code)
}

#[tauri::command]
fn login_cancel(logins: State<'_, logins::Logins>, plan: logins::Plan) {
    logins.cancel(plan);
}

/// Where Desk Helper stands, as Settings → Help shows it. Registers it
/// again first if it was found unregistered (the person may have removed it).
#[tauri::command]
async fn helper_status(app: State<'_, App>) -> CommandResult<helper::Status> {
    let backend = app.backend.clone();
    let status = tauri::async_runtime::spawn_blocking(move || {
        let login = helper::login(&backend);
        match login.status() {
            helper::Status::NotRegistered => login.ensure(),
            status => status,
        }
    })
    .await
    .map_err(text)?;
    *app.helper.lock().expect("helper") = status.clone();
    Ok(status)
}

#[tauri::command]
fn helper_open_login_items(app: State<'_, App>) {
    helper::login(&app.backend).open_settings();
}

/// Off the main thread: finding the CLI reads the login shell's PATH.
#[tauri::command]
async fn cli_installed(plan: logins::Plan) -> CommandResult<bool> {
    tauri::async_runtime::spawn_blocking(move || logins::install::installed(plan))
        .await
        .map_err(text)
}

#[tauri::command]
async fn cli_install(app: tauri::AppHandle, plan: logins::Plan) -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<logins::install::Installs>().start(&app, plan)
    })
    .await
    .map_err(text)?
}

/// Saves a zip of recent logs, every secret taken out, at `path`.
#[tauri::command]
async fn report_save(app: State<'_, App>, path: PathBuf, about: String) -> CommandResult<()> {
    let (paths, backend) = (app.paths.clone(), app.backend.clone());
    let helper = format!("{:?}", *app.helper.lock().expect("helper"));
    tauri::async_runtime::spawn_blocking(move || {
        let about = format!("{about}\n{}\nDesk Helper: {helper}\n", os_version());
        let known = support::known_secrets(&paths, &backend);
        support::write_report(&paths, &backend.paths, &known, &about, &path)
    })
    .await
    .map_err(text)?
    .map_err(text)
}

/// The system and its version, as a report says it ("macOS 15.1").
fn os_version() -> String {
    let system = match tauri_plugin_os::platform() {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    };
    format!("{system} {}", tauri_plugin_os::version())
}

/// Stops Desk Helper and takes it out of what starts at login; with
/// `everything`, deletes Desk's folders and secrets too.
#[tauri::command]
async fn data_remove(app: State<'_, App>, everything: bool) -> CommandResult<()> {
    let (paths, backend) = (app.paths.clone(), app.backend.clone());
    tauri::async_runtime::spawn_blocking(move || support::remove(&paths, &backend, everything))
        .await
        .map_err(text)?
        .map_err(text)
}

/// Everything Desk keeps to restore (its own copy; the hub has the same).
#[tauri::command]
fn desk_state_load(store: State<'_, Arc<state::StateStore>>) -> BTreeMap<String, state::Entry> {
    store.all()
}

/// A change the page made, kept at once and written within the debounce.
#[tauri::command]
fn desk_state_put(store: State<'_, Arc<state::StateStore>>, key: String, value: serde_json::Value) {
    store.put(&key, value);
}

#[tauri::command]
fn desk_state_remove(store: State<'_, Arc<state::StateStore>>, key: String) {
    store.remove(&key);
}

/// The hub has stored `value` under `key`.
#[tauri::command]
fn desk_state_synced(
    store: State<'_, Arc<state::StateStore>>,
    key: String,
    value: serde_json::Value,
    updated_at: Option<String>,
) {
    store.synced(&key, &value, updated_at);
}

/// The hub's value for `key` (none: it has none), taken unless this one
/// hasn't reached the hub yet. True when taken.
#[tauri::command]
fn desk_state_adopt(
    store: State<'_, Arc<state::StateStore>>,
    key: String,
    value: Option<serde_json::Value>,
    updated_at: Option<String>,
) -> bool {
    store.adopt(&key, value.map(|v| (v, updated_at)))
}

#[tauri::command]
fn desk_state_flush(store: State<'_, Arc<state::StateStore>>) -> CommandResult<()> {
    store.flush().map_err(text)
}

/// The page has put back what was open: the window can be seen.
#[tauri::command]
fn desk_ready(window: tauri::WebviewWindow, frames: State<'_, Frames>) {
    tracing::info!(label = window.label(), "page ready");
    if let Some(t) = frames.0.lock().expect("frames").get(window.label()) {
        t.show(&window, "page ready");
    } else {
        let _ = window.show();
    }
}

/// Each window's frame keeper, by label.
#[derive(Default)]
struct Frames(Mutex<BTreeMap<String, Arc<frame::Tracker>>>);

/// Opens grid `grid`'s own window on its monitor (or brings it forward if
/// it's open); answers the monitor it's on, or none when that monitor isn't
/// connected (the grid waits for it).
#[tauri::command]
fn grid_window_open(
    app: tauri::AppHandle,
    frames: State<'_, Frames>,
    store: State<'_, Arc<state::StateStore>>,
    grid: String,
    title: String,
    mode: grid_windows::Mode,
    monitor: Option<grid_windows::Wanted>,
) -> CommandResult<Option<grid_windows::MonitorInfo>> {
    let label = grid_windows::label(&grid);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_focus();
        return Ok(grid_windows::monitor_of(&w));
    }
    let made = grid_windows::open(
        &app,
        store.inner().clone(),
        &grid,
        &title,
        mode,
        monitor.as_ref(),
    )
    .map_err(text)?;
    Ok(made.map(|(tracker, monitor)| {
        frames.0.lock().expect("frames").insert(label, tracker);
        monitor
    }))
}

/// Closes grid `grid`'s window, if it has one (its monitor went away, or
/// the grid moved back to the main window).
#[tauri::command]
fn grid_window_close(app: tauri::AppHandle, frames: State<'_, Frames>, grid: String) {
    let label = grid_windows::label(&grid);
    frames.0.lock().expect("frames").remove(&label);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.destroy();
    }
}

/// The grids that have a window of their own now.
#[tauri::command]
fn grid_windows_open(app: tauri::AppHandle) -> Vec<String> {
    app.webview_windows()
        .keys()
        .filter_map(|l| l.strip_prefix("grid-").map(str::to_string))
        .collect()
}

/// Puts this grid window in a window mode.
#[tauri::command]
fn grid_window_mode(
    window: tauri::WebviewWindow,
    frames: State<'_, Frames>,
    store: State<'_, Arc<state::StateStore>>,
    mode: grid_windows::Mode,
) {
    let tracker = frames
        .0
        .lock()
        .expect("frames")
        .get(window.label())
        .cloned();
    grid_windows::set_mode(&window, tracker, store.inner().clone(), mode);
}

/// The monitor this window is on.
#[tauri::command]
fn grid_window_monitor(window: tauri::WebviewWindow) -> Option<grid_windows::MonitorInfo> {
    grid_windows::monitor_of(&window)
}

/// The monitors connected now.
#[tauri::command]
fn grid_monitors(app: tauri::AppHandle) -> Vec<grid_windows::MonitorInfo> {
    grid_windows::monitors(&app)
}

/// Desk's Claude Code plugin folder, for the shells of grid terminals; none
/// when this build doesn't have it.
#[tauri::command]
fn claude_plugin_dir(app: tauri::AppHandle) -> Option<String> {
    terminals::plugin_dir(&app).map(|p| p.to_string_lossy().into_owned())
}

/// What's running in a terminal whose shell is `pid`, shell first.
#[tauri::command]
async fn programs_under(pid: u32) -> CommandResult<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || terminals::programs_under(pid))
        .await
        .map_err(text)?
        .map_err(text)
}

/// How this install of Desk gets a new version.
#[tauri::command]
fn updating(handle: tauri::AppHandle, app: State<'_, App>) -> CommandResult<updates::Updating> {
    let exe = std::env::current_exe().map_err(text)?;
    let env = std::env::vars().collect();
    let install = desk_core::install::Install::of(&exe, &env, &app.backend.paths);
    let endpoint = handle
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u["endpoints"][0].as_str().map(str::to_string));
    Ok(updates::updating(&install, endpoint.as_deref()))
}

#[tauri::command]
fn resume_later(app: State<'_, App>, ids: Vec<String>) -> CommandResult<()> {
    updates::resume_later(&app.paths, &ids).map_err(text)
}

#[tauri::command]
fn resume_take(app: State<'_, App>) -> CommandResult<Vec<String>> {
    updates::resume_take(&app.paths).map_err(text)
}

/// Logs to `logs/desk.log` when Finder or launchd started Desk (nothing
/// reads its terminal), to the terminal in development.
fn init_logging(paths: &Paths) {
    use std::io::IsTerminal;
    let filter =
        tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into());
    let log = paths.logs().join("desk.log");
    let file = (!std::io::stderr().is_terminal())
        .then(|| {
            std::fs::create_dir_all(paths.logs()).ok()?;
            if std::fs::metadata(&log).is_ok_and(|m| m.len() > 20 * 1024 * 1024) {
                let _ = std::fs::rename(&log, log.with_extension("log.1"));
            }
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log)
                .ok()
        })
        .flatten();
    match file {
        Some(f) => tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_ansi(false)
            .with_writer(Mutex::new(f))
            .init(),
        None => tracing_subscriber::fmt().with_env_filter(filter).init(),
    }
}

pub fn run() {
    // A workspace build can give reqwest rustls without a crypto provider
    // (postgresql_embedded asks for that); every client shares this one.
    let _ = rustls::crypto::ring::default_provider().install_default();
    // `Desk.AppImage --helper`: what the AppImage's login service runs.
    #[cfg(target_os = "linux")]
    if std::env::args().any(|a| a == "--helper") {
        std::process::exit(helper::run_bundled());
    }
    if let Ok(paths) = Paths::new() {
        init_logging(&paths);
        // `Desk --unregister-helper`: takes Desk Helper out of what starts
        // at login and stops it, for uninstall scripts and for testing a
        // build.
        if std::env::args().any(|a| a == "--unregister-helper") {
            let code = match helper::login(&Backend::native(paths.clone())).unregister() {
                Ok(()) => 0,
                Err(e) => {
                    eprintln!("Couldn't remove Desk Helper: {e}");
                    1
                }
            };
            std::process::exit(code);
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(tuple::Tuple::default())
        .manage(logins::Logins::default())
        .manage(logins::install::Installs::default())
        .manage(Frames::default())
        .register_asynchronous_uri_scheme_protocol(attachments::SCHEME, attachments::protocol)
        .setup(|app| {
            let paths = Paths::new()?;
            // What was open, and where the window was, before anything shows.
            let store = state::StateStore::open(paths.desk_state());
            let handle = app.handle().clone();
            store.on_native_change(move |changed| {
                let _ = handle.emit("desk-state", changed);
            });
            let main = frame::Tracker::build(app, "main", store.clone())?;
            app.state::<Frames>()
                .0
                .lock()
                .expect("frames")
                .insert("main".into(), main);
            app.manage(store);
            // The installed app makes Desk Helper start at login; a
            // development run talks to a supervisor started by hand.
            let backend = Backend::native(paths.clone());
            let helper = helper::login(&backend).ensure();
            tracing::info!(?helper, version = %app.package_info().version, "Desk starting");
            let watcher = files::watch_themes(app.handle().clone(), &paths.themes())?;
            app.manage(voice::Voice::new(&paths, backend.clone()));
            app.manage(attachments::Files::new(paths.clone(), backend.clone()));
            app.manage(App {
                paths,
                backend,
                helper: Mutex::new(helper),
                _themes: Mutex::new(Some(watcher)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hub_connection,
            fonts::fonts_list,
            host_info,
            settings_load,
            settings_save,
            themes_list,
            themes_write,
            themes_reveal,
            hubs_list,
            hubs_save,
            hubs_remove,
            tuple_enable,
            tuple_disable,
            tuple_reply,
            tuple_available,
            login_start,
            login_code,
            login_cancel,
            helper_status,
            helper_open_login_items,
            cli_installed,
            cli_install,
            report_save,
            data_remove,
            updating,
            resume_later,
            resume_take,
            desk_state_load,
            desk_state_put,
            desk_state_remove,
            desk_state_synced,
            desk_state_adopt,
            desk_state_flush,
            desk_ready,
            claude_plugin_dir,
            programs_under,
            grid_window_open,
            grid_window_close,
            grid_windows_open,
            grid_window_mode,
            grid_window_monitor,
            grid_monitors,
            attachments::attachment_open,
            attachments::attachment_save,
            attachments::attachment_upload,
            voice::voice_enable,
            voice::voice_disable,
            voice::voice_set_roster,
            voice::voice_push_to_talk,
            voice::voice_speak,
            voice::voice_stop_speaking,
            voice::voice_tool_result,
            voice::voice_try,
            voice::voice_kokoro_voices,
            voice::voice_engine_voices,
            voice::voice_lookup,
            voice::voice_status
        ])
        .build(tauri::generate_context!())
        .expect("Desk failed to start")
        .run(|app, event| {
            // Quitting, however it happens, writes what's pending first.
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                grid_windows::quitting();
            }
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event
                && let Some(store) = app.try_state::<Arc<state::StateStore>>()
                && let Err(e) = store.flush()
            {
                tracing::warn!(error = %e, "couldn't save desk state");
            }
        });
}
