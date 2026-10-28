mod files;
mod helper;
mod hubs;
mod logins;
mod support;
mod tuple;
mod updates;
mod voice;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use desk_core::{Paths, Secret, SecretStore, Secrets};
use serde::Serialize;
use tauri::{Manager, State};

struct App {
    paths: Paths,
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
    let paths = app.paths.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let ports = desk_core::read_ports(&paths.hub_state()).map_err(text)?;
            let token = Secrets::for_paths(&paths)
                .get(Secret::GatewayToken)
                .map_err(text)?;
            if let (Some(ports), Some(token)) = (ports, token) {
                return Ok(HubConnection {
                    url: ports.gateway_url(),
                    token,
                });
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

#[tauri::command]
fn themes_reveal(app: State<'_, App>) -> CommandResult<()> {
    let dir = app.paths.themes();
    std::fs::create_dir_all(&dir).map_err(text)?;
    std::process::Command::new("open")
        .arg(&dir)
        .status()
        .map_err(text)?;
    Ok(())
}

#[tauri::command]
fn hubs_list(app: State<'_, App>) -> CommandResult<Vec<hubs::HubAccount>> {
    hubs::accounts(&app.paths).map_err(text)
}

#[tauri::command]
fn hubs_save(
    app: State<'_, App>,
    label: String,
    url: String,
    token: String,
) -> CommandResult<hubs::HubRecord> {
    hubs::save(&app.paths, &label, &url, &token).map_err(text)
}

#[tauri::command]
fn hubs_remove(app: State<'_, App>, id: String) -> CommandResult<()> {
    hubs::remove(&app.paths, &id).map_err(text)
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
    desk_tuple::notify(&tuple::binary(), &agent, &answer)
        .await
        .map_err(text)
}

#[tauri::command]
async fn login_start(app: tauri::AppHandle, plan: logins::Plan) -> CommandResult<()> {
    let paths = app.state::<App>().paths.clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<logins::Logins>().start(&app, paths, plan)
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
fn helper_status(app: State<'_, App>) -> helper::Status {
    let mut status = helper::status();
    if status == helper::Status::NotRegistered {
        status = helper::ensure(&app.paths);
    }
    *app.helper.lock().expect("helper") = status.clone();
    status
}

#[tauri::command]
fn helper_open_login_items() {
    helper::open_login_items();
}

#[tauri::command]
fn cli_installed(plan: logins::Plan) -> bool {
    logins::install::installed(plan)
}

#[tauri::command]
fn cli_install(
    app: tauri::AppHandle,
    installs: State<'_, logins::install::Installs>,
    plan: logins::Plan,
) -> CommandResult<()> {
    installs.start(&app, plan)
}

/// Saves a zip of recent logs, every secret taken out, at `path`.
#[tauri::command]
async fn report_save(app: State<'_, App>, path: PathBuf, about: String) -> CommandResult<()> {
    let paths = app.paths.clone();
    let helper = format!("{:?}", *app.helper.lock().expect("helper"));
    tauri::async_runtime::spawn_blocking(move || {
        let about = format!("{about}\nmacOS {}\nDesk Helper: {helper}\n", os_version());
        let known = support::known_secrets(&paths);
        support::write_report(&paths, &known, &about, &path)
    })
    .await
    .map_err(text)?
    .map_err(text)
}

fn os_version() -> String {
    std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// Stops Desk Helper and removes it from Login Items; with `everything`,
/// deletes Desk's folder and keychain items too.
#[tauri::command]
async fn data_remove(app: State<'_, App>, everything: bool) -> CommandResult<()> {
    let paths = app.paths.clone();
    tauri::async_runtime::spawn_blocking(move || support::remove(&paths, everything))
        .await
        .map_err(text)?
        .map_err(text)
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
    if let Ok(paths) = Paths::new() {
        init_logging(&paths);
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(tuple::Tuple::default())
        .manage(logins::Logins::default())
        .manage(logins::install::Installs::default())
        .setup(|app| {
            let paths = Paths::new()?;
            // The installed app makes Desk Helper its login item; a
            // development run talks to a supervisor started by hand.
            let helper = helper::ensure(&paths);
            tracing::info!(?helper, version = %app.package_info().version, "Desk starting");
            let watcher = files::watch_themes(app.handle().clone(), &paths.themes())?;
            app.manage(voice::Voice::new(&paths));
            app.manage(App {
                paths,
                helper: Mutex::new(helper),
                _themes: Mutex::new(Some(watcher)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hub_connection,
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
            login_start,
            login_code,
            login_cancel,
            helper_status,
            helper_open_login_items,
            cli_installed,
            cli_install,
            report_save,
            data_remove,
            resume_later,
            resume_take,
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
            voice::voice_status
        ])
        .run(tauri::generate_context!())
        .expect("Desk failed to start");
}
