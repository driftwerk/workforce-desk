mod files;
mod hubs;
mod launch_agent;
mod logins;
mod tuple;
mod voice;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use desk_core::{Paths, Secret, SecretStore, Secrets};
use serde::Serialize;
use tauri::{Manager, State};

struct App {
    paths: Paths,
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
                    "Desk’s background service hasn’t started — see ~/Library/Application Support/Desk/logs"
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

/// Binaries shipped beside the app executable (Tauri sidecars).
fn sidecar(name: &str) -> eyre::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let path = exe
        .parent()
        .ok_or_else(|| eyre::eyre!("app has no folder"))?
        .join(name);
    if path.is_file() {
        Ok(path)
    } else {
        Err(eyre::eyre!("{} is missing", path.display()))
    }
}

pub fn run() {
    // A workspace build can give reqwest rustls without a crypto provider
    // (postgresql_embedded asks for that); every client shares this one.
    let _ = rustls::crypto::ring::default_provider().install_default();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(tuple::Tuple::default())
        .manage(logins::Logins::default())
        .setup(|app| {
            let paths = Paths::new()?;
            // A development run (`DESK_HOME`) talks to a supervisor started by
            // hand; only the real app installs the LaunchAgent.
            if std::env::var_os("DESK_HOME").is_none() {
                launch_agent::ensure(&sidecar("desk-hubd")?, &sidecar("workforce")?, &paths)?;
            }
            let watcher = files::watch_themes(app.handle().clone(), &paths.themes())?;
            app.manage(voice::Voice::new(&paths));
            app.manage(App {
                paths,
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
            voice::voice_enable,
            voice::voice_disable,
            voice::voice_set_names,
            voice::voice_push_to_talk,
            voice::voice_speak,
            voice::voice_stop_speaking,
            voice::voice_tool_result,
            voice::voice_status
        ])
        .run(tauri::generate_context!())
        .expect("Desk failed to start");
}
