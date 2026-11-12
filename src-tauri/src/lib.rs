mod attachments;
mod badge;
mod broker;
mod chrome;
#[cfg(test)]
mod commands;
mod drops;
mod files;
mod fonts;
mod frame;
mod grid_windows;
mod helper;
mod hub_io;
mod hubs;
mod links;
mod logins;
mod machine_accounts;
mod machine_secret;
mod machine_setup;
mod machines;
mod navigation;
mod pair_gate;
mod paired;
mod privacy;
mod remote_images;
mod repos;
mod reread;
mod state;
mod support;
mod terminals;
mod tuple;
mod updates;
mod voice;
mod wsl;

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
    /// Where the hub and its helper run, and their folder; none on Windows
    /// until Desk is set up inside WSL.
    backend: Option<Backend>,
    helper: Mutex<helper::Status>,
    _themes: Mutex<Option<notify::RecommendedWatcher>>,
}

/// What a command that needs the backend says when Windows has none yet.
const NOT_SET_UP: &str =
    "Desk runs this computer's agents inside Linux, with WSL: finish setting it up first.";

impl App {
    fn backend(&self) -> CommandResult<Backend> {
        self.backend.clone().ok_or_else(|| NOT_SET_UP.to_string())
    }
}

/// The backend on this computer: in the app's own folder on macOS and
/// Linux; on Windows, inside the WSL distro setup chose, once it has.
fn backend_of(paths: &Paths) -> eyre::Result<Option<Backend>> {
    if !cfg!(windows) {
        return Ok(Some(Backend::native(paths.clone())));
    }
    Ok(match desk_core::backend::read_host(paths)? {
        Some(Host::Wsl(w)) => Some(Backend::wsl(w)),
        // A machine is never this computer's backend.
        Some(Host::Native | Host::Ssh(_)) | None => None,
    })
}

/// Where the local hub is, as the page learns it. Never its token: the page
/// reaches the hub's admin surface only through [`broker`], which holds it.
#[derive(Debug, Serialize)]
struct HubConnection {
    url: String,
}

impl From<desk_core::backend::Connection> for HubConnection {
    fn from(c: desk_core::backend::Connection) -> Self {
        Self { url: c.gateway_url }
    }
}

type CommandResult<T> = Result<T, String>;

fn text<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// The local hub's address, once it has one and its token. On first launch
/// `desk-hubd` is still creating them, so this waits for both.
#[tauri::command]
async fn hub_connection(app: State<'_, App>) -> CommandResult<HubConnection> {
    let backend = app.backend()?;
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            if let Some(c) = backend.connection().map_err(text)? {
                return Ok(HubConnection::from(c));
            }
            // Say at once when Desk Helper can't start, rather than wait.
            if let Some(why) = helper::login(&backend).status().blocked() {
                return Err(why);
            }
            // The page shows how far it has got meanwhile, and asks again.
            if Instant::now() > deadline {
                return Err("Desk isn’t ready yet.".into());
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
    /// Where the backend runs; none on Windows until Desk is set up in WSL.
    host: Option<Host>,
    computer_name: Option<String>,
    /// Where the backend keeps its secrets, as Help names it.
    keys: &'static str,
}

#[tauri::command]
async fn host_info(app: State<'_, App>) -> CommandResult<HostInfo> {
    let (paths, backend) = (app.paths.clone(), app.backend.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let keys = match &backend {
            Some(b) => desk_core::Secrets::for_host(&b.paths, &b.host),
            None => desk_core::Secrets::for_host(&paths, &Host::Native),
        };
        Ok(HostInfo {
            platform: std::env::consts::OS,
            keys: keys.map_err(text)?.store().name(),
            host: backend.map(|b| b.host),
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

/// Shows Desk's own log on this computer in the system's file manager.
#[tauri::command]
fn machine_reveal_log(app: State<'_, App>) -> CommandResult<()> {
    let log = app.paths.logs().join("desk.log");
    if !log.exists() {
        return Err("Desk hasn't written its log on this computer yet.".into());
    }
    tauri_plugin_opener::reveal_item_in_dir(&log).map_err(text)
}

/// Opens the person's Chrome, or brings it forward, for "Connect my
/// Chrome" (see `chrome.rs`).
#[tauri::command]
async fn open_chrome() -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(chrome::open)
        .await
        .map_err(text)?
}

#[tauri::command]
async fn hubs_list(
    app: State<'_, App>,
    machines: State<'_, machines::MachineIo>,
) -> CommandResult<Vec<hubs::HubAccount>> {
    let (paths, backend) = (app.paths.clone(), app.backend.clone());
    let mut all =
        tauri::async_runtime::spawn_blocking(move || hubs::accounts(&paths, backend.as_ref()))
            .await
            .map_err(text)?
            .map_err(text)?;
    // Each machine's, once Desk has reached it.
    all.extend(machines.accounts());
    Ok(all)
}

/// Forgets a paired hub and its token. (A hub is paired, and its token
/// kept, by `hub_io::pair_collect`: the page never holds one to hand over.)
#[tauri::command]
fn hubs_remove(app: State<'_, App>, io: State<'_, hub_io::HubIo>, id: String) -> CommandResult<()> {
    if hubs::machine_of(&id).is_some() {
        return Err("A machine is removed from Settings → Machines.".into());
    }
    let removed = hubs::remove(&app.paths, &id).map_err(text);
    io.forget();
    removed
}

/// Names a paired workspace as it names itself (`/api/me`'s `workspace`).
#[tauri::command]
fn hubs_rename(
    app: State<'_, App>,
    io: State<'_, hub_io::HubIo>,
    id: String,
    label: String,
) -> CommandResult<()> {
    if hubs::machine_of(&id).is_some() || id == desk_core::LOCAL_HUB_ID {
        return Err("Only a workspace is renamed here.".into());
    }
    hubs::rename(&app.paths, &id, &label).map_err(text)?;
    io.forget();
    Ok(())
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
async fn login_start(
    app: tauri::AppHandle,
    plan: logins::Plan,
    to: Option<logins::ClaudeUse>,
) -> CommandResult<()> {
    let backend = app.state::<App>().backend()?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<logins::Logins>()
            .start(&app, backend, plan, to.unwrap_or_default())
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

/// Off the main thread: inside WSL, ending a sign-in runs `wsl.exe`.
#[tauri::command]
async fn login_cancel(app: tauri::AppHandle, plan: logins::Plan) -> CommandResult<()> {
    let backend = app.state::<App>().backend().ok();
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<logins::Logins>().cancel(plan, backend.as_ref())
    })
    .await
    .map_err(text)
}

/// Where Desk Helper stands, as Settings → Help shows it. Registers it
/// again first if it was found unregistered (the person may have removed it).
#[tauri::command]
async fn helper_status(app: State<'_, App>) -> CommandResult<helper::Status> {
    let backend = app.backend.clone();
    let status = tauri::async_runtime::spawn_blocking(move || {
        let Some(backend) = backend else {
            return helper::Status::NotRegistered;
        };
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

/// Starts Desk Helper now, the way the system starts it at login (the
/// installed app: its login item; a development run starts nothing — the
/// supervisor is started by hand), and says where it stands.
#[tauri::command]
async fn helper_start(app: State<'_, App>) -> CommandResult<helper::Status> {
    let backend = app.backend.clone();
    let status = tauri::async_runtime::spawn_blocking(move || match backend {
        Some(backend) => helper::login(&backend).start(),
        None => helper::Status::NotRegistered,
    })
    .await
    .map_err(text)?;
    *app.helper.lock().expect("helper") = status.clone();
    Ok(status)
}

/// What `desk-hubd.log` last said about Desk Helper stopping, if readable.
#[tauri::command]
fn helper_last_reason(app: State<'_, App>) -> Option<String> {
    let paths = app.backend.as_ref().map_or(&app.paths, |b| &b.paths);
    helper::last_reason_in(&paths.logs().join("desk-hubd.log"))
}

/// How far Desk Helper has got since it last started, from its log; none
/// when it hasn't logged a start.
#[tauri::command]
fn helper_progress(app: State<'_, App>) -> Option<helper::Stage> {
    let paths = app.backend.as_ref().map_or(&app.paths, |b| &b.paths);
    helper::stage_in(&paths.logs().join("desk-hubd.log"))
}

/// Copies Desk into the Applications folder, then quits and opens the copy
/// (macOS, when it runs from its disk image or Downloads). Answers only
/// when it couldn't, with why.
#[tauri::command]
async fn helper_move_to_applications(
    handle: tauri::AppHandle,
    app: State<'_, App>,
) -> CommandResult<()> {
    #[cfg(target_os = "macos")]
    {
        // Only a Desk that can't keep running where it is moves itself.
        let backend = app.backend()?;
        let status = tauri::async_runtime::spawn_blocking(move || helper::login(&backend).status())
            .await
            .map_err(text)?;
        if status != helper::Status::MoveToApplications {
            return Err("Desk is already where it can keep running, so it moves nothing.".into());
        }
        let exe = std::env::current_exe().map_err(text)?;
        let moved = tauri::async_runtime::spawn_blocking(move || {
            helper::moving::copy_to_applications(&exe)
        })
        .await
        .map_err(text)?
        .map_err(text)?;
        tracing::info!(to = %moved.display(), "Desk copied itself to Applications; reopening there");
        helper::moving::reopen_after_exit(&moved).map_err(text)?;
        handle.exit(0);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (handle, app);
        Err("Only Desk on a Mac is moved to the Applications folder.".into())
    }
}

#[tauri::command]
fn helper_open_login_items(app: State<'_, App>) {
    if let Some(backend) = &app.backend {
        helper::login(backend).open_settings();
    }
}

/// Off the main thread: finding the CLI reads the login shell's PATH.
#[tauri::command]
async fn cli_installed(app: State<'_, App>, plan: logins::Plan) -> CommandResult<bool> {
    let backend = app.backend()?;
    tauri::async_runtime::spawn_blocking(move || logins::install::installed(&backend, plan))
        .await
        .map_err(text)
}

#[tauri::command]
async fn cli_install(app: tauri::AppHandle, plan: logins::Plan) -> CommandResult<()> {
    let backend = app.state::<App>().backend()?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<logins::install::Installs>()
            .start(&app, backend, plan)
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
        let about = format!(
            "{about}\n{}\nDesk Helper: {helper}\n",
            os_version(backend.as_ref())
        );
        let known = support::known_secrets(&paths, backend.as_ref());
        support::write_report(
            &paths,
            backend.as_ref().map(|b| &b.paths),
            &known,
            &about,
            &path,
        )
    })
    .await
    .map_err(text)?
    .map_err(text)
}

/// The system and its version, as a report says it ("macOS 15.1"), and
/// with WSL the distro and its kernel.
fn os_version(backend: Option<&Backend>) -> String {
    let system = match tauri_plugin_os::platform() {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        other => other,
    };
    let os = format!("{system} {}", tauri_plugin_os::version());
    match backend.map(|b| &b.host) {
        Some(host @ Host::Wsl(w)) => {
            let kernel = host
                .invocation("uname", &["-r"])
                .command()
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default();
            format!("{os}\nWSL: {} (kernel {kernel})", w.distro)
        }
        Some(Host::Native | Host::Ssh(_)) | None => os,
    }
}

/// Stops Desk Helper and takes it out of what starts at login; with
/// `everything`, deletes Desk's folders and secrets too.
#[tauri::command]
async fn data_remove(app: State<'_, App>, everything: bool) -> CommandResult<()> {
    let (paths, backend) = (app.paths.clone(), app.backend.clone());
    tauri::async_runtime::spawn_blocking(move || {
        support::remove(&paths, backend.as_ref(), everything)
    })
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

/// The page has put back what was open and painted its theme: the window
/// takes the theme's background (`#RRGGBB`), seen at its edges while it
/// resizes, and can be seen.
#[tauri::command]
fn desk_ready(window: tauri::WebviewWindow, frames: State<'_, Frames>, background: Option<String>) {
    tracing::info!(label = window.label(), "page ready");
    if let Some(bg) = background {
        window_background(window.clone(), bg);
    }
    if let Some(t) = frames.0.lock().expect("frames").get(window.label()) {
        t.show(&window, "page ready");
    } else {
        let _ = window.show();
    }
}

/// Keeps a window's own background on its theme's (`#RRGGBB`); a colour that
/// isn't one is left out.
#[tauri::command]
fn window_background(window: tauri::WebviewWindow, background: String) {
    match theme_colour(&background) {
        Some(c) => {
            if let Err(e) = window.set_background_color(Some(c)) {
                tracing::warn!(label = window.label(), error = %e, "couldn't set the window's background");
            }
        }
        None => {
            // What the page sent, cut short: it may be anything.
            let shown: String = background.chars().take(16).collect();
            tracing::warn!(
                label = window.label(),
                background = %shown,
                "not a background colour"
            )
        }
    }
}

/// `#RRGGBB` as an opaque colour.
fn theme_colour(hex: &str) -> Option<tauri::window::Color> {
    let h = hex.strip_prefix('#')?;
    if h.len() != 6 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let at = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
    Some(tauri::window::Color(at(0)?, at(2)?, at(4)?, 255))
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

/// Brings Desk's main window forward: shown, out of the Dock and focused
/// (for the Ask shortcut, and for a thread or a ticket a grid's own window
/// opened there).
#[tauri::command]
fn main_window_focus(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
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

/// The person's home folder where the backend runs, as it names it: where
/// a terminal opens when it has no folder of its own.
#[tauri::command]
fn backend_home(handle: tauri::AppHandle, app: State<'_, App>) -> CommandResult<String> {
    match app.backend()?.host {
        Host::Wsl(w) => Ok(w.home),
        Host::Ssh(m) => Err(format!("{} names its own home", m.name)),
        Host::Native => Ok(handle
            .path()
            .home_dir()
            .map_err(text)?
            .to_string_lossy()
            .into_owned()),
    }
}

/// A folder the person picks for the backend to work in (a session's), as
/// the backend names it: on Windows one in the distro or on a Windows
/// drive, which WSL reaches; none when they cancel.
#[tauri::command]
async fn pick_folder(
    handle: tauri::AppHandle,
    app: State<'_, App>,
) -> CommandResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let host = app.backend()?.host;
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = handle.dialog().file();
        let dialog = match &host {
            Host::Wsl(w) => dialog.set_directory(host.host_path(&w.home)),
            Host::Ssh(m) => return Err(format!("A folder on {} is typed, not picked.", m.name)),
            Host::Native => dialog,
        };
        let Some(picked) = dialog.blocking_pick_folder() else {
            return Ok(None);
        };
        let picked = picked.into_path().map_err(text)?;
        match (host.backend_path(&picked), &host) {
            (Some(path), _) => Ok(Some(path)),
            (None, Host::Wsl(w)) => Err(format!(
                "Pick a folder in {} or on a Windows drive.",
                w.distro
            )),
            (None, Host::Native | Host::Ssh(_)) => {
                Err(format!("Desk can't use {}", picked.display()))
            }
        }
    })
    .await
    .map_err(text)?
}

/// Desk's Claude Code plugin folder, for the shells of grid terminals, as
/// the backend names it; none when this build doesn't have it.
#[tauri::command]
async fn claude_plugin_dir(
    handle: tauri::AppHandle,
    app: State<'_, App>,
    machines: State<'_, machines::MachineIo>,
    machine: Option<String>,
) -> CommandResult<Option<String>> {
    match machine {
        // On a machine: beside its backend, named from its home there
        // (read over SSH once).
        Some(id) => {
            let link = machines.link(&id)?;
            tauri::async_runtime::spawn_blocking(move || link.plugin_dir().map(Some))
                .await
                .map_err(text)?
        }
        None => Ok(terminals::plugin_dir(&handle, &app.backend()?.host)),
    }
}

/// A machine's home folder, as it says it over SSH (read once): where `~`
/// is there, whether or not its hub answers.
#[tauri::command]
async fn machine_home(
    machines: State<'_, machines::MachineIo>,
    machine: String,
) -> CommandResult<String> {
    let link = machines.link(&machine)?;
    tauri::async_runtime::spawn_blocking(move || link.home())
        .await
        .map_err(text)?
}

/// The repositories of the folders Desk's sessions run in, with their
/// remotes and workflows: what Act fully's setup suggests.
#[tauri::command]
async fn repo_facts(
    app: State<'_, App>,
    folders: Vec<String>,
) -> CommandResult<Vec<repos::RepoFacts>> {
    let backend = app.backend()?;
    tauri::async_runtime::spawn_blocking(move || repos::repo_facts(&backend.host, &folders))
        .await
        .map_err(text)
}

/// What's running in a terminal whose shell is `pid`, shell first.
#[tauri::command]
async fn programs_under(app: State<'_, App>, pid: u32) -> CommandResult<Vec<String>> {
    let backend = app.backend()?;
    tauri::async_runtime::spawn_blocking(move || terminals::programs_under(&backend.host, pid))
        .await
        .map_err(text)?
        .map_err(text)
}

/// How this install of Desk updates, from its running program.
fn how_here(app: &App) -> updates::How {
    let Ok(exe) = std::env::current_exe() else {
        return updates::How::Never("Desk couldn't tell where its program is");
    };
    let exe = exe.canonicalize().unwrap_or(exe);
    let env = std::env::vars().collect();
    let install = desk_core::install::Install::of(&exe, &env, &app.paths);
    updates::how(&exe, &install, cfg!(debug_assertions), std::env::consts::OS)
}

/// Whether this computer's sessions are in the PTY holder, which keeps
/// them running while Desk restarts.
fn sessions_kept(app: &App) -> bool {
    #[cfg(unix)]
    if let Some(b) = &app.backend
        && matches!(b.host, Host::Native)
    {
        return desk_core::holder::answers(&b.paths.pty_socket());
    }
    let _ = app;
    false
}

/// How this install of Desk gets a new version.
#[tauri::command]
fn updating(handle: tauri::AppHandle, app: State<'_, App>) -> CommandResult<updates::Updating> {
    let endpoint = handle
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u["endpoints"][0].as_str().map(str::to_string));
    Ok(updates::updating(
        how_here(&app),
        endpoint.as_deref(),
        sessions_kept(&app),
    ))
}

/// The update found by the last check, and its download once made. The
/// page never holds the updater itself: every step is gated here.
#[derive(Default)]
struct PendingUpdate(Mutex<updates::Held<tauri_plugin_updater::Update>>);

/// Looks for a new version: its version, or none. A development build, or
/// one whose program an update couldn't replace, never looks. A newer
/// version than the one held replaces it, and its download.
#[tauri::command]
async fn update_check(
    handle: tauri::AppHandle,
    app: State<'_, App>,
    pending: State<'_, PendingUpdate>,
) -> CommandResult<Option<String>> {
    use tauri_plugin_updater::UpdaterExt;
    if let updates::How::Never(why) = how_here(&app) {
        tracing::info!("not checking for updates: {why}");
        return Ok(None);
    }
    let found = handle
        .updater()
        .map_err(text)?
        .check()
        .await
        .map_err(text)?;
    let version = found.as_ref().map(|u| u.version.clone());
    pending.0.lock().map_err(text)?.found(found.map(|u| {
        let v = u.version.clone();
        (u, v)
    }));
    Ok(version)
}

/// Downloads the version the last check found (its signature is checked
/// as it installs), for an install that updates itself.
#[tauri::command]
async fn update_download(
    app: State<'_, App>,
    pending: State<'_, PendingUpdate>,
) -> CommandResult<()> {
    let how = how_here(&app);
    if how != updates::How::Itself {
        return Err(refuse_update(how));
    }
    let (update, version) = {
        let held = pending.0.lock().map_err(text)?;
        match held.to_download() {
            Some(found) => found,
            None if held.has() => return Ok(()),
            None => return Err("Desk hasn't found an update to download".into()),
        }
    };
    let bytes = update.download(|_, _| {}, || {}).await.map_err(text)?;
    pending.0.lock().map_err(text)?.downloaded(&version, bytes);
    Ok(())
}

/// Installs the downloaded `version`, the one the page offered, and
/// restarts into it: refused unless it is the newest found. Refused too,
/// and the reason logged, unless this install updates itself: on macOS,
/// only a program inside a `.app` bundle, since the updater replaces
/// whatever folder it takes for the bundle.
#[tauri::command]
async fn update_install(
    handle: tauri::AppHandle,
    app: State<'_, App>,
    pending: State<'_, PendingUpdate>,
    version: String,
) -> CommandResult<()> {
    let how = how_here(&app);
    if how != updates::How::Itself {
        return Err(refuse_update(how));
    }
    let Some((update, bytes)) = pending.0.lock().map_err(text)?.to_install(&version) else {
        return Err(format!(
            "Desk {version} isn't the newest version downloaded: check for updates again"
        ));
    };
    tracing::info!(version = %update.version, "installing the update, then restarting");
    tauri::async_runtime::spawn_blocking(move || update.install(bytes.as_slice()))
        .await
        .map_err(text)?
        .map_err(text)?;
    handle.restart()
}

/// Why an update isn't installed here, logged.
fn refuse_update(how: updates::How) -> String {
    let why = match how {
        updates::How::Never(why) => why,
        updates::How::Package => "the system's package manager updates this install",
        updates::How::Itself => "",
    };
    tracing::warn!("refusing to install an update: {why}");
    format!("Desk doesn't install updates here: {why}.")
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
    // The hubs' sockets are held in this process, not the webview's.
    #[cfg(unix)]
    if let Err(e) = desk_core::process::raise_open_files(4096) {
        eprintln!("Couldn't raise the open-files limit: {e}");
    }
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
            let unregistered = match backend_of(&paths) {
                Ok(Some(backend)) => helper::login(&backend).unregister(),
                Ok(None) => Ok(()),
                Err(e) => Err(e),
            };
            let code = match unregistered {
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(tuple::Tuple::default())
        .manage(PendingUpdate::default())
        .manage(logins::Logins::default())
        .manage(logins::install::Installs::default())
        .manage(Frames::default())
        .manage(drops::Drops::default())
        .manage(drops::Copies::default())
        .manage(drops::Pastes::default())
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
            let backend = backend_of(&paths)?;
            tracing::info!(host = ?backend.as_ref().map(|b| &b.host), version = %app.package_info().version, "Desk starting");
            let watcher = files::watch_themes(app.handle().clone(), &paths.themes())?;
            app.manage(voice::Voice::new(&paths, backend.clone()));
            // Every hub socket the page holds, the local hub's admin ones
            // and every paired hub's, and the hubs it reaches by id.
            let sockets = Arc::new(broker::socket::Sockets::default());
            // The person's own machines, reached over SSH (none until one
            // is added).
            // One ssh for every machine, which knows Desk's own key and
            // the machines it was put on.
            let ssh = desk_machine::SshExe::system()
                .with_own_key(paths.root.join("machines").join("ssh").join("id_ed25519"));
            let machines = Arc::new(desk_machine::Machines::new(
                ssh.clone(),
                &paths.root.join("machines"),
            ));
            app.manage(Arc::new(machine_secret::SecretField::default()));
            let paired = Arc::new(paired::Paired::new(
                paths.clone(),
                backend.clone(),
                Arc::clone(&machines),
            ));
            app.manage(machines::MachineIo::new(
                Arc::clone(&machines),
                Arc::clone(&sockets),
            ));
            // The machines added (machines.json), each connected to, and
            // upgraded when it is on an older Desk.
            let home = std::env::var_os("HOME")
                .map(std::path::PathBuf::from)
                .unwrap_or_default();
            let fleet = desk_machine::fleet::Fleet::new(
                ssh,
                machines,
                paths.root.join("machines.json"),
                home.clone(),
                Arc::new(machine_setup::AppHost {
                    app: app.handle().clone(),
                    version: app.package_info().version.to_string(),
                    cache: paths.root.join("machines").join("backend"),
                    home,
                }),
                Arc::new(pair_gate::NativeConfirm(app.handle().clone())),
                Arc::new(pair_gate::NativeConfirm(app.handle().clone())),
                desk_machine::fleet::Timing::default(),
            );
            app.manage(Arc::clone(&fleet));
            std::thread::spawn(move || fleet.load());
            app.manage(attachments::Files::new(Arc::clone(&paired)));
            app.manage(broker::Broker::new(backend.clone(), Arc::clone(&sockets)));
            app.manage(hub_io::HubIo::new(paired, Arc::clone(&sockets)));
            app.manage(pair_gate::PairGate::new(
                paths.clone(),
                Arc::new(pair_gate::NativeConfirm(app.handle().clone())),
            ));
            app.manage(sockets);
            app.manage(App {
                paths,
                backend,
                helper: Mutex::new(helper::Status::Starting),
                _themes: Mutex::new(Some(watcher)),
            });
            // The installed app makes Desk Helper start at login (on Windows
            // it also installs the backend it carries into WSL, which takes
            // a while): off the main thread. A development run talks to a
            // supervisor started by hand.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let app = handle.state::<App>();
                let status = match &app.backend {
                    Some(backend) => helper::login(backend).ensure(),
                    None => helper::Status::NotRegistered,
                };
                tracing::info!(?status, "Desk Helper");
                *app.helper.lock().expect("helper") = status;
            });
            Ok(())
        })
        // A page loading again, or a window gone, holds none of its hub
        // sockets any more.
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started
                && let Some(sockets) = webview.try_state::<Arc<broker::socket::Sockets>>()
            {
                sockets.close_owned(webview.label());
            }
        })
        .on_window_event(|window, event| {
            // Files dropped on a window: the page may ask about these
            // paths, and only these (see drops.rs).
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event
                && let Some(drops) = window.try_state::<drops::Drops>()
            {
                drops.saw(window.label(), paths);
            }
            if let tauri::WindowEvent::Destroyed = event
                && let Some(sockets) = window.try_state::<Arc<broker::socket::Sockets>>()
            {
                sockets.close_owned(window.label());
            }
        })
        .invoke_handler(tauri::generate_handler![
            hub_connection,
            broker::local_hub_fetch,
            broker::local_hub_socket_open,
            machines::machine_fetch,
            machines::machine_sign_in_forward,
            machines::machine_sign_in_forward_stop,
            machines::machine_open_sign_in_page,
            machines::machine_socket_open,
            machine_setup::machines_list,
            machine_setup::machine_probe,
            machine_setup::machine_trust,
            machine_setup::machine_install_key,
            machine_setup::machine_unlock_key,
            machine_setup::machine_forget_key,
            machine_setup::machine_linger_with_password,
            machine_secret::machine_secret_request,
            machine_secret::machine_secret_submit,
            machine_secret::machine_secret_cancel,
            machine_setup::machine_public_key,
            machine_setup::machine_add,
            machine_setup::machine_reconnect,
            machine_setup::machine_remove,
            machine_accounts::machine_share_accounts,
            links::open_terminal_link,
            machine_setup::machine_log,
            machine_setup::machine_remote_log,
            machine_setup::machine_ssh_hosts,
            machine_setup::machine_edit,
            machine_setup::machine_check_reach,
            machine_setup::machine_cancel_add,
            machine_setup::machine_retry_engines,
            machine_setup::machine_cancel_update,
            machine_setup::machine_uninstall,
            machine_setup::machine_cancel_uninstall,
            machine_reveal_log,
            open_chrome,
            broker::socket_send,
            broker::socket_ack,
            broker::socket_close,
            hub_io::hub_fetch,
            hub_io::board_sync_mint,
            hub_io::hub_socket_open,
            hub_io::pair_request,
            hub_io::pair_collect,
            fonts::fonts_list,
            host_info,
            badge::set_unread_badge,
            settings_load,
            settings_save,
            themes_list,
            themes_write,
            themes_reveal,
            hubs_list,
            hubs_remove,
            hubs_rename,
            tuple_enable,
            tuple_disable,
            tuple_reply,
            tuple_available,
            login_start,
            login_code,
            login_cancel,
            helper_status,
            helper_open_login_items,
            helper_start,
            helper_last_reason,
            helper_progress,
            helper_move_to_applications,
            cli_installed,
            cli_install,
            report_save,
            data_remove,
            updating,
            update_check,
            update_download,
            update_install,
            resume_later,
            resume_take,
            desk_state_load,
            desk_state_put,
            desk_state_remove,
            desk_state_synced,
            desk_state_adopt,
            desk_state_flush,
            desk_ready,
            window_background,
            claude_plugin_dir,
            machine_home,
            backend_home,
            pick_folder,
            programs_under,
            repo_facts,
            grid_window_open,
            grid_window_close,
            grid_windows_open,
            main_window_focus,
            grid_window_mode,
            grid_window_monitor,
            grid_monitors,
            attachments::attachment_open,
            attachments::attachment_save,
            attachments::attachment_upload,
            drops::dropped_files,
            privacy::privacy_open,
            privacy::privacy_check,
            drops::dropped_file_read,
            drops::terminal_drop,
            drops::terminal_drop_cancel,
            drops::terminal_paste_image,
            remote_images::remote_image_fetch,
            voice::voice_enable,
            voice::voice_disable,
            voice::voice_claim,
            voice::voice_set_roster,
            voice::voice_push_to_talk,
            voice::voice_speak,
            voice::voice_stop_speaking,
            voice::voice_tool_result,
            voice::voice_try,
            voice::voice_kokoro_voices,
            voice::voice_engine_voices,
            voice::voice_lookup,
            voice::voice_status,
            wsl::wsl_detect,
            wsl::wsl_install,
            wsl::wsl_forget_resume,
            wsl::wsl_convert,
            wsl::wsl_create_user,
            wsl::wsl_install_alongside,
            wsl::wsl_setup,
            wsl::wsl_fix_forwarding,
            wsl::wsl_installed
        ])
        .build(tauri::generate_context!())
        .expect("Desk failed to start")
        .run(|app, event| {
            // Quitting, however it happens, writes what's pending first.
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                grid_windows::quitting();
            }
            // Machines' forwards end with Desk, not after it.
            if let tauri::RunEvent::Exit = event
                && let Some(fleet) = app.try_state::<Arc<desk_machine::fleet::Fleet>>()
            {
                fleet.shutdown();
            }
            if let tauri::RunEvent::Exit = event
                && let Some(io) = app.try_state::<machines::MachineIo>()
            {
                io.end_callbacks();
            }
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event
                && let Some(store) = app.try_state::<Arc<state::StateStore>>()
                && let Err(e) = store.flush()
            {
                tracing::warn!(error = %e, "couldn't save desk state");
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// A theme's background reaches the window as the same opaque colour; a
    /// colour that isn't `#RRGGBB` is refused.
    #[test]
    fn a_theme_background_is_read_as_its_colour() {
        let c = theme_colour("#FBFAF7").unwrap();
        assert_eq!((c.0, c.1, c.2, c.3), (0xFB, 0xFA, 0xF7, 255));
        let c = theme_colour("#111210").unwrap();
        assert_eq!((c.0, c.1, c.2, c.3), (0x11, 0x12, 0x10, 255));
        for bad in ["111210", "#11121", "#1112100", "#GG1210", "", "#ééé"] {
            assert!(theme_colour(bad).is_none(), "{bad}");
        }
    }

    /// Every command `generate_handler!` registers is declared to the ACL
    /// (`commands.rs`, read by build.rs), and nothing else: one left out
    /// would be refused in every window.
    #[test]
    fn every_command_is_declared_to_the_acl() {
        let src = include_str!("lib.rs");
        let list = &src[src.find("generate_handler![").unwrap() + "generate_handler![".len()..];
        let list = &list[..list.find(']').unwrap()];
        let registered: BTreeSet<&str> = list
            .split(',')
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .map(|c| c.rsplit("::").next().unwrap())
            .collect();
        let declared: BTreeSet<&str> = commands::COMMANDS.iter().copied().collect();
        assert_eq!(registered, declared);
        assert_eq!(
            declared.len(),
            commands::COMMANDS.len(),
            "declared once each"
        );
    }

    /// The capabilities as the build resolved them: a grid's window is
    /// refused what only the main window may do, which the main window
    /// gets past the ACL for.
    ///
    /// Not on Windows: building an app links in its menus, which need the
    /// Common Controls v6 that only the app's manifest asks for, and a test
    /// binary has none (it fails to load, `STATUS_ENTRYPOINT_NOT_FOUND`).
    /// The capabilities are the same files on every system.
    #[cfg(not(windows))]
    #[test]
    fn a_grid_window_is_refused_what_only_the_main_window_may_do() {
        use tauri::ipc::{CallbackFn, InvokeBody};
        use tauri::test::{INVOKE_KEY, get_ipc_response, mock_builder};
        use tauri::webview::InvokeRequest;
        let app = mock_builder()
            .build(tauri::generate_context!("tauri.conf.json", test = true))
            .unwrap();
        let ask = |label: &str, cmd: &str| {
            let webview = app.get_webview_window(label).unwrap_or_else(|| {
                tauri::WebviewWindowBuilder::new(&app, label, Default::default())
                    .build()
                    .unwrap()
            });
            let answer = get_ipc_response(
                &webview,
                InvokeRequest {
                    cmd: cmd.into(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: "tauri://localhost".parse().unwrap(),
                    body: InvokeBody::default(),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.to_string(),
                },
            );
            match answer {
                Ok(_) => String::new(),
                Err(e) => e.to_string(),
            }
        };
        for cmd in [
            "data_remove",
            "pair_request",
            "pair_collect",
            "hubs_remove",
            "hubs_rename",
            "wsl_install",
            "report_save",
        ] {
            let refused = ask("grid-a", cmd);
            assert!(
                refused.contains("not allowed"),
                "{cmd} in a grid: {refused}"
            );
            let main = ask("main", cmd);
            assert!(!main.contains("not allowed"), "{cmd} in main: {main}");
        }
        // What a grid's panes use, it gets past the ACL for.
        for cmd in [
            "hub_fetch",
            "hub_socket_open",
            "desk_state_put",
            "attachment_upload",
        ] {
            let grid = ask("grid-b", cmd);
            assert!(!grid.contains("not allowed"), "{cmd} in a grid: {grid}");
        }
        // And a window that is neither gets nothing.
        let other = ask("elsewhere", "hub_fetch");
        assert!(other.contains("not allowed"), "{other}");
        // Desk's own password field alone asks for and answers a password;
        // it can do nothing with machines, pairing or the hub.
        for cmd in [
            "machine_secret_request",
            "machine_secret_submit",
            "machine_secret_cancel",
        ] {
            for label in ["main", "grid-c"] {
                let refused = ask(label, cmd);
                assert!(
                    refused.contains("not allowed"),
                    "{cmd} in {label}: {refused}"
                );
            }
            let own = ask(machine_secret::LABEL, cmd);
            assert!(!own.contains("not allowed"), "{cmd} in its window: {own}");
        }
        for cmd in [
            "machine_install_key",
            "machine_add",
            "hub_fetch",
            "pair_request",
        ] {
            let refused = ask(machine_secret::LABEL, cmd);
            assert!(
                refused.contains("not allowed"),
                "{cmd} in the field: {refused}"
            );
        }
    }

    /// What `hub_connection` hands the page, serialized as the IPC sends it.
    #[test]
    fn hub_connection_never_carries_the_admin_token() {
        const SENTINEL: &str = "SENTINEL-ADMIN-93ab";
        let c = desk_core::backend::Connection {
            gateway_url: "http://127.0.0.1:3".into(),
            admin_token: SENTINEL.into(),
            device_token: Some("device".into()),
            version: None,
        };
        let json = serde_json::to_value(HubConnection::from(c)).unwrap();
        assert_eq!(json, serde_json::json!({ "url": "http://127.0.0.1:3" }));
        assert!(!json.to_string().contains(SENTINEL));
    }
}
