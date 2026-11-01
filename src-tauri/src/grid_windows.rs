//! Grids in windows of their own (`grid-<id>`): made hidden on the monitor
//! the grid was on — recognised as Desk's window frames recognise monitors
//! (`frame::Screen::id`) — and shown once its page is ready. A window that
//! fills its monitor takes the monitor's work area; a free-size one has its
//! frame kept per monitor arrangement under `window.grid-<id>.<arrangement>`
//! by the same `frame::Tracker` the main window uses, and is never put out
//! of reach.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Runtime, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::frame::{self, Rect, Screen, Tracker};
use crate::state::{Entry, StateStore};

/// Desk is quitting: its windows close without that meaning anything.
static QUITTING: AtomicBool = AtomicBool::new(false);

pub fn quitting() {
    QUITTING.store(true, Ordering::SeqCst);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Fills its monitor's work area.
    Fill,
    /// Wherever and however big it's made.
    Free,
    /// Native full screen, in a Space of its own.
    Fullscreen,
}

/// The monitor a grid was on.
#[derive(Debug, Clone, Deserialize)]
pub struct Wanted {
    pub id: String,
    pub origin: [f64; 2],
}

/// A monitor as the page knows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MonitorInfo {
    /// `name:WxH@scale`, as window frames key monitors.
    pub id: String,
    pub name: String,
    /// Its work area's origin, in points: tells identical monitors apart.
    pub origin: [f64; 2],
    pub primary: bool,
}

pub fn label(grid: &str) -> String {
    format!("grid-{grid}")
}

pub fn info(s: &Screen) -> MonitorInfo {
    MonitorInfo {
        id: s.id.clone(),
        name: s
            .id
            .rsplit_once(':')
            .map_or(s.id.as_str(), |(n, _)| n)
            .to_string(),
        origin: [s.work.x, s.work.y],
        primary: s.primary,
    }
}

fn distance(s: &Screen, origin: [f64; 2]) -> f64 {
    (s.work.x - origin[0]).hypot(s.work.y - origin[1])
}

fn contains(r: &Rect, x: f64, y: f64) -> bool {
    x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height
}

/// Where a grid's window goes: the monitor it was on (the nearest of
/// identical ones); with none asked for, a monitor Desk's main window isn't
/// on, else the main window's, else the primary one. None when the monitor
/// asked for isn't connected.
pub fn target<'a>(
    wanted: Option<&Wanted>,
    screens: &'a [Screen],
    main_at: Option<(f64, f64)>,
) -> Option<&'a Screen> {
    if let Some(w) = wanted {
        return screens
            .iter()
            .filter(|s| s.id == w.id)
            .min_by(|a, b| distance(a, w.origin).total_cmp(&distance(b, w.origin)));
    }
    let main = main_at.and_then(|(x, y)| screens.iter().find(|s| contains(&s.frame, x, y)));
    screens
        .iter()
        .find(|s| main.is_some_and(|m| m.id != s.id || m.work != s.work))
        .or(main)
        .or_else(|| frame::primary(screens))
}

/// A free-size window's default: most of its monitor, centred.
const FREE_DEFAULT: (f64, f64) = (1280.0, 820.0);
const MIN: (f64, f64) = (480.0, 320.0);
const MARGIN: f64 = 48.0;

/// The window's frame on `screen` for `mode`.
pub fn rect_for(
    mode: Mode,
    grid_label: &str,
    screen: &Screen,
    screens: &[Screen],
    kept: &std::collections::BTreeMap<String, Entry>,
) -> Rect {
    if mode != Mode::Free {
        return screen.work;
    }
    let saved = frame::choose(grid_label, kept, screens).filter(|f| f.monitor == screen.id);
    if let Some(p) = saved
        .as_ref()
        .and_then(|f| frame::place(Some(f), screens, FREE_DEFAULT, MIN))
    {
        return p.rect;
    }
    let w = &screen.work;
    frame::centred(
        w,
        FREE_DEFAULT.0.min(w.width - MARGIN).max(MIN.0.min(w.width)),
        FREE_DEFAULT
            .1
            .min(w.height - MARGIN)
            .max(MIN.1.min(w.height)),
    )
}

fn main_centre<R: Runtime>(app: &AppHandle<R>) -> Option<(f64, f64)> {
    use tauri::Manager;
    let main = app.get_webview_window("main")?;
    let (pos, size, scale) = (
        main.outer_position().ok()?,
        main.outer_size().ok()?,
        main.scale_factor().ok()?,
    );
    Some((
        (f64::from(pos.x) + f64::from(size.width) / 2.0) / scale,
        (f64::from(pos.y) + f64::from(size.height) / 2.0) / scale,
    ))
}

/// The monitors connected now.
pub fn monitors<R: Runtime>(app: &AppHandle<R>) -> Vec<MonitorInfo> {
    frame::screens(app.available_monitors(), app.primary_monitor())
        .iter()
        .map(info)
        .collect()
}

/// The monitor most of `window` is on.
pub fn monitor_of<R: Runtime>(window: &WebviewWindow<R>) -> Option<MonitorInfo> {
    let screens = frame::screens(window.available_monitors(), window.primary_monitor());
    let (pos, size, scale) = (
        window.outer_position().ok()?,
        window.outer_size().ok()?,
        window.scale_factor().ok()?,
    );
    let (cx, cy) = (
        (f64::from(pos.x) + f64::from(size.width) / 2.0) / scale,
        (f64::from(pos.y) + f64::from(size.height) / 2.0) / scale,
    );
    screens
        .iter()
        .find(|s| contains(&s.frame, cx, cy))
        .or_else(|| frame::primary(&screens))
        .map(info)
}

/// Makes grid `grid`'s window, hidden, on its monitor; None when that
/// monitor isn't connected. The page shows it (`desk_ready`).
pub fn open<R: Runtime>(
    app: &AppHandle<R>,
    store: Arc<StateStore>,
    grid: &str,
    title: &str,
    mode: Mode,
    wanted: Option<&Wanted>,
) -> tauri::Result<Option<(Arc<Tracker>, MonitorInfo)>> {
    let label = label(grid);
    let screens = frame::screens(app.available_monitors(), app.primary_monitor());
    let Some(screen) = target(wanted, &screens, main_centre(app)) else {
        return Ok(None);
    };
    let rect = rect_for(mode, &label, screen, &screens, &store.all());
    // The page tells a grid's window by its label.
    let builder = crate::navigation::guard(
        WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into())),
        crate::navigation::dev_url(app),
    )
    .title(title)
    .visible(false)
    .position(rect.x, rect.y)
    .inner_size(rect.width, rect.height)
    .min_inner_size(MIN.0, MIN.1)
    .disable_drag_drop_handler();
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    let window = builder.build()?;
    let tracker = Tracker::keep(&window, store, &screens, mode == Mode::Fullscreen);
    tracker.set_keeping(mode == Mode::Free);
    let w = window.clone();
    window.on_window_event(move |event| {
        // Closed by its own close button: the page moves the grid back to
        // the main window, then closes it. Quitting just closes it.
        if let tauri::WindowEvent::CloseRequested { api, .. } = event
            && !QUITTING.load(Ordering::SeqCst)
        {
            api.prevent_close();
            let _ = w.emit_to(w.label(), "grid-close", ());
        }
    });
    tracing::info!(label, monitor = %screen.id, ?mode, "grid window made");
    Ok(Some((tracker, info(screen))))
}

/// Puts a grid's window in `mode` on the monitor it's on.
pub fn set_mode<R: Runtime>(
    window: &WebviewWindow<R>,
    tracker: Option<Arc<Tracker>>,
    store: Arc<StateStore>,
    mode: Mode,
) {
    let window = window.clone();
    // Leaving full screen animates; the frame is set once it has.
    std::thread::spawn(move || {
        if let Some(t) = &tracker {
            t.set_keeping(false);
        }
        if mode == Mode::Fullscreen {
            let _ = window.set_fullscreen(true);
            return;
        }
        if window.is_fullscreen().unwrap_or(false) {
            let _ = window.set_fullscreen(false);
            std::thread::sleep(Duration::from_millis(800));
        }
        let screens = frame::screens(window.available_monitors(), window.primary_monitor());
        let Some(here) = monitor_of(&window) else {
            return;
        };
        let Some(screen) = screens
            .iter()
            .find(|s| s.id == here.id && s.work.x == here.origin[0] && s.work.y == here.origin[1])
        else {
            return;
        };
        let rect = rect_for(mode, window.label(), screen, &screens, &store.all());
        let _ = window.set_position(LogicalPosition::new(rect.x, rect.y));
        let _ = window.set_size(LogicalSize::new(rect.width, rect.height));
        if let Some(t) = &tracker {
            t.set_keeping(mode == Mode::Free);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn screen(id: &str, x: f64, w: f64, primary: bool) -> Screen {
        let frame = Rect {
            x,
            y: 0.0,
            width: w,
            height: 900.0,
        };
        Screen {
            id: id.into(),
            frame,
            work: Rect {
                y: 25.0,
                height: 875.0,
                ..frame
            },
            primary,
        }
    }

    fn desk() -> Vec<Screen> {
        vec![
            screen("Built-in Retina Display:3024x1964@2", 0.0, 1512.0, true),
            screen("Studio Display:5120x2880@2", 1512.0, 2560.0, false),
            screen("Studio Display:5120x2880@2", 4072.0, 2560.0, false),
        ]
    }

    #[test]
    fn a_grid_goes_back_on_its_monitor_and_waits_while_it_is_away() {
        let screens = desk();
        let right = Wanted {
            id: "Studio Display:5120x2880@2".into(),
            origin: [4072.0, 25.0],
        };
        assert_eq!(target(Some(&right), &screens, None).unwrap().work.x, 4072.0);
        let gone = Wanted {
            id: "Projector:1920x1080@1".into(),
            origin: [0.0, 0.0],
        };
        assert!(target(Some(&gone), &screens, None).is_none());
    }

    #[test]
    fn a_new_grid_window_goes_where_the_main_window_isnt() {
        let screens = desk();
        let t = target(None, &screens, Some((700.0, 400.0))).unwrap();
        assert_eq!(t.work.x, 1512.0);
        let alone = vec![screen(
            "Built-in Retina Display:3024x1964@2",
            0.0,
            1512.0,
            true,
        )];
        assert_eq!(
            target(None, &alone, Some((700.0, 400.0))).unwrap().work.x,
            0.0
        );
    }

    #[test]
    fn filling_takes_the_work_area_and_a_free_window_starts_centred_within_it() {
        let screens = desk();
        let s = &screens[1];
        assert_eq!(
            rect_for(Mode::Fill, "grid-a", s, &screens, &BTreeMap::new()),
            s.work
        );
        let free = rect_for(Mode::Free, "grid-a", s, &screens, &BTreeMap::new());
        assert_eq!((free.width, free.height), (1280.0, 820.0));
        assert!(free.x > s.work.x && free.x + free.width < s.work.x + s.work.width);
    }

    #[test]
    fn a_monitor_is_named_as_it_says() {
        assert_eq!(info(&desk()[1]).name, "Studio Display");
    }
}
