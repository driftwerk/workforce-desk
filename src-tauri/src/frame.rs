//! Where a window was, per monitor arrangement: kept under
//! `window.<label>.<arrangement>` and put back when the window is made, so
//! Desk opens where it was — on the monitor it was on, at its size, maximized
//! or full screen as it was.
//!
//! An arrangement is the set of monitors connected (each by name, size and
//! scale), so docking at a desk and undocking each restore their own frame.
//! A frame is kept relative to its monitor's work area, in points (what macOS
//! measures windows in), so it survives that monitor moving in the
//! arrangement. An arrangement never seen before takes the frame of the
//! closest one Desk knows (the most monitors in common), else a default;
//! either way the window is never placed off screen.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{LogicalPosition, LogicalSize, Monitor, Runtime, WebviewWindow};

use crate::state::{Entry, StateStore};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }
}

/// A connected monitor, in points.
#[derive(Debug, Clone, PartialEq)]
pub struct Screen {
    /// `name:WxH@scale`, the physical size and scale it reports.
    pub id: String,
    pub frame: Rect,
    /// Less the menu bar and Dock.
    pub work: Rect,
    pub primary: bool,
}

/// A window's frame as kept.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFrame {
    /// The arrangement it was kept in, by monitor id: what "closest" compares.
    pub monitors: Vec<String>,
    /// The monitor it was on.
    pub monitor: String,
    /// That monitor's work area's origin then, which tells identical
    /// monitors apart.
    pub origin: [f64; 2],
    /// Relative to that work area's origin.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
    pub fullscreen: bool,
    /// Milliseconds since the epoch: the latest wins between equally close
    /// arrangements.
    pub saved_at: u64,
}

/// Where a window goes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    pub rect: Rect,
    pub maximized: bool,
    pub fullscreen: bool,
}

/// How much of a window's top edge must be on some monitor to reach it.
const GRIP_WIDTH: f64 = 120.0;
const GRIP_HEIGHT: f64 = 40.0;
/// Room left around a default-sized window.
const MARGIN: f64 = 24.0;

/// The arrangement: every monitor's id, sorted.
pub fn arrangement(screens: &[Screen]) -> Vec<String> {
    let mut ids: Vec<String> = screens.iter().map(|s| s.id.clone()).collect();
    ids.sort();
    ids
}

/// FNV-1a, so the key is short and safe in a URL whatever monitors are
/// called.
fn hash(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// `window.<label>.<arrangement>`.
pub fn key(label: &str, screens: &[Screen]) -> String {
    format!(
        "window.{label}.{:016x}",
        hash(&arrangement(screens).join("\n"))
    )
}

fn in_common(a: &[String], b: &[String]) -> usize {
    let mut rest = b.to_vec();
    a.iter()
        .filter(|id| {
            rest.iter()
                .position(|r| r == *id)
                .map(|i| rest.swap_remove(i))
                .is_some()
        })
        .count()
}

/// The frame kept for this arrangement, else for the closest one known.
pub fn choose(
    label: &str,
    entries: &BTreeMap<String, Entry>,
    screens: &[Screen],
) -> Option<SavedFrame> {
    let parse = |e: &Entry| serde_json::from_value::<SavedFrame>(e.value.clone()).ok();
    if let Some(exact) = entries.get(&key(label, screens)).and_then(parse) {
        return Some(exact);
    }
    let now = arrangement(screens);
    let prefix = format!("window.{label}.");
    entries
        .iter()
        .filter(|(k, _)| k.starts_with(&prefix))
        .filter_map(|(_, e)| parse(e))
        .map(|f| (in_common(&f.monitors, &now), f))
        .filter(|(n, _)| *n > 0)
        .max_by_key(|(n, f)| (*n, f.saved_at))
        .map(|(_, f)| f)
}

pub(crate) fn primary(screens: &[Screen]) -> Option<&Screen> {
    screens.iter().find(|s| s.primary).or(screens.first())
}

/// The monitor a frame was on, if it's connected (the nearest of identical
/// ones), else the primary one.
fn home<'a>(saved: &SavedFrame, screens: &'a [Screen]) -> Option<&'a Screen> {
    let distance = |s: &Screen| (s.work.x - saved.origin[0]).hypot(s.work.y - saved.origin[1]);
    screens
        .iter()
        .filter(|s| s.id == saved.monitor)
        .min_by(|a, b| distance(a).total_cmp(&distance(b)))
        .or_else(|| primary(screens))
}

/// True when enough of the window's top edge is on a monitor to drag it.
pub fn reachable(rect: &Rect, screens: &[Screen]) -> bool {
    screens.iter().any(|s| {
        let w = &s.work;
        let left = rect.x.max(w.x);
        let right = (rect.x + rect.width).min(w.x + w.width);
        let top_ok = rect.y >= w.y - 1.0 && rect.y <= w.y + w.height - GRIP_HEIGHT;
        top_ok && right - left >= GRIP_WIDTH.min(rect.width)
    })
}

pub(crate) fn centred(on: &Rect, width: f64, height: f64) -> Rect {
    Rect {
        x: on.x + ((on.width - width) / 2.0).max(0.0),
        y: on.y + ((on.height - height) / 2.0).max(0.0),
        width,
        height,
    }
}

/// Where the window goes: its kept frame on its monitor (no bigger than
/// that monitor's work area), else `default` centred on the primary
/// monitor; re-centred whenever that would leave it out of reach.
pub fn place(
    saved: Option<&SavedFrame>,
    screens: &[Screen],
    default: (f64, f64),
    min: (f64, f64),
) -> Option<Placement> {
    let fit = |w: f64, h: f64, area: &Rect| {
        (
            w.min(area.width).max(min.0.min(area.width)),
            h.min(area.height).max(min.1.min(area.height)),
        )
    };
    let Some(saved) = saved else {
        let area = primary(screens)?.work;
        let (w, h) = fit(
            default.0.min(area.width - 2.0 * MARGIN),
            default.1.min(area.height - 2.0 * MARGIN),
            &area,
        );
        return Some(Placement {
            rect: centred(&area, w, h),
            maximized: false,
            fullscreen: false,
        });
    };
    let screen = home(saved, screens)?;
    let (width, height) = fit(saved.width, saved.height, &screen.work);
    let mut rect = Rect {
        x: screen.work.x + saved.x,
        y: screen.work.y + saved.y,
        width,
        height,
    };
    if !reachable(&rect, screens) {
        rect = centred(&screen.work, width, height);
    }
    Some(Placement {
        rect,
        maximized: saved.maximized,
        fullscreen: saved.fullscreen,
    })
}

/// The window's frame as kept: its normal frame (`rect`) relative to the
/// monitor it's on — except while maximized or full screen, when the normal
/// frame kept before stays, so leaving those goes back to it.
pub fn capture(
    rect: Rect,
    screens: &[Screen],
    before: Option<&SavedFrame>,
    maximized: bool,
    fullscreen: bool,
    now: u64,
) -> Option<SavedFrame> {
    let monitors = arrangement(screens);
    if (maximized || fullscreen)
        && let Some(before) = before
    {
        return Some(SavedFrame {
            monitors,
            maximized,
            fullscreen,
            saved_at: now,
            ..before.clone()
        });
    }
    let (cx, cy) = (rect.x + rect.width / 2.0, rect.y + rect.height / 2.0);
    let screen = screens
        .iter()
        .find(|s| s.frame.contains(cx, cy))
        .or_else(|| screens.iter().find(|s| s.frame.contains(rect.x, rect.y)))
        .or_else(|| primary(screens))?;
    Some(SavedFrame {
        monitors,
        monitor: screen.id.clone(),
        origin: [screen.work.x, screen.work.y],
        x: rect.x - screen.work.x,
        y: rect.y - screen.work.y,
        width: rect.width,
        height: rect.height,
        maximized,
        fullscreen,
        saved_at: now,
    })
}

// ── The app's windows ───────────────────────────────────────────────────────

fn screen_of(m: &Monitor, primary: Option<&Monitor>) -> Screen {
    let scale = m.scale_factor();
    let points = |x: i32, y: i32, w: u32, h: u32| Rect {
        x: f64::from(x) / scale,
        y: f64::from(y) / scale,
        width: f64::from(w) / scale,
        height: f64::from(h) / scale,
    };
    let (pos, size, work) = (m.position(), m.size(), m.work_area());
    Screen {
        id: format!(
            "{}:{}x{}@{}",
            m.name().map_or("Display", String::as_str),
            size.width,
            size.height,
            scale
        ),
        frame: points(pos.x, pos.y, size.width, size.height),
        work: points(
            work.position.x,
            work.position.y,
            work.size.width,
            work.size.height,
        ),
        primary: primary.is_some_and(|p| p.position() == pos && p.size() == size),
    }
}

/// The monitors connected now, as Tauri lists them.
pub fn screens(
    monitors: tauri::Result<Vec<Monitor>>,
    primary: tauri::Result<Option<Monitor>>,
) -> Vec<Screen> {
    let primary = primary.ok().flatten();
    monitors
        .unwrap_or_default()
        .iter()
        .map(|s| screen_of(s, primary.as_ref()))
        .collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Keeps one window's frame, and puts it back when the monitors change to
/// an arrangement it has a frame for.
pub struct Tracker {
    label: String,
    store: Arc<StateStore>,
    /// The arrangement's key the window is being kept under.
    current: Mutex<String>,
    shown: AtomicBool,
    /// Full screen waits until the window is shown.
    fullscreen_on_show: AtomicBool,
    closed: AtomicBool,
    /// Off while a grid's window fills its monitor: that frame isn't the one
    /// to go back to.
    keeping: AtomicBool,
}

/// How often the monitors are looked at for one being plugged in (unplugging
/// one also moves the window, which says so at once).
const ARRANGEMENT_POLL: Duration = Duration::from_secs(2);
/// A window still hidden this long after it was made is shown anyway, so a
/// page that fails to load never leaves Desk invisible.
const SHOW_ANYWAY: Duration = Duration::from_secs(3);

impl Tracker {
    /// Makes the window `label` from its config, hidden and placed where it
    /// was, and keeps its frame from then on. The page shows it once it has
    /// put back what was open (see [`Tracker::show`]).
    pub fn build<R: Runtime>(
        app: &tauri::App<R>,
        label: &str,
        store: Arc<StateStore>,
    ) -> tauri::Result<Arc<Self>> {
        let config = app
            .config()
            .app
            .windows
            .iter()
            .find(|w| w.label == label)
            .cloned()
            .ok_or_else(|| tauri::Error::WindowNotFound)?;
        let screens = screens(app.available_monitors(), app.primary_monitor());
        let saved = choose(label, &store.all(), &screens);
        let placement = place(
            saved.as_ref(),
            &screens,
            (config.width, config.height),
            (
                config.min_width.unwrap_or(0.0),
                config.min_height.unwrap_or(0.0),
            ),
        );
        let mut builder = crate::navigation::guard(
            tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?,
            crate::navigation::dev_url(app.handle()),
        )
        .visible(false);
        if let Some(p) = placement {
            builder = builder
                .position(p.rect.x, p.rect.y)
                .inner_size(p.rect.width, p.rect.height)
                .maximized(p.maximized);
        }
        let window = builder.build()?;
        tracing::info!(label, restored = saved.is_some(), "window placed");
        Ok(Self::keep(
            &window,
            store,
            &screens,
            placement.is_some_and(|p| p.fullscreen),
        ))
    }

    /// Keeps the frame of a window made hidden elsewhere (a grid's own
    /// window) from now on, and shows it when its page is ready.
    pub fn keep<R: Runtime>(
        window: &WebviewWindow<R>,
        store: Arc<StateStore>,
        screens: &[Screen],
        fullscreen_on_show: bool,
    ) -> Arc<Self> {
        let label = window.label();
        let tracker = Arc::new(Self {
            label: label.into(),
            store,
            current: Mutex::new(key(label, screens)),
            shown: AtomicBool::new(false),
            fullscreen_on_show: AtomicBool::new(fullscreen_on_show),
            closed: AtomicBool::new(false),
            keeping: AtomicBool::new(true),
        });

        let t = tracker.clone();
        let w = window.clone();
        window.on_window_event(move |event| match event {
            tauri::WindowEvent::Moved(_)
            | tauri::WindowEvent::Resized(_)
            | tauri::WindowEvent::ScaleFactorChanged { .. } => t.observe(&w),
            tauri::WindowEvent::Focused(false) => t.flush(),
            tauri::WindowEvent::CloseRequested { .. } => {
                t.observe(&w);
                t.flush();
            }
            tauri::WindowEvent::Destroyed => {
                t.closed.store(true, Ordering::SeqCst);
                t.flush();
            }
            _ => {}
        });

        let (t, w) = (tracker.clone(), window.clone());
        std::thread::spawn(move || {
            std::thread::sleep(SHOW_ANYWAY);
            if !t.shown.load(Ordering::SeqCst) {
                tracing::warn!(label = %t.label, "page didn't say it was ready; showing the window");
                t.show(&w, "timeout");
            }
            while !t.closed.load(Ordering::SeqCst) {
                std::thread::sleep(ARRANGEMENT_POLL);
                t.observe(&w);
            }
        });
        tracker
    }

    /// Whether the window's frame is kept (and put back on a monitor change).
    pub fn set_keeping(&self, keeping: bool) {
        self.keeping.store(keeping, Ordering::SeqCst);
    }

    /// Shows the window (once), full screen if it was.
    pub fn show<R: Runtime>(&self, window: &WebviewWindow<R>, why: &str) {
        if self.shown.swap(true, Ordering::SeqCst) {
            return;
        }
        tracing::info!(label = %self.label, why, "window shown");
        let _ = window.show();
        if self.fullscreen_on_show.swap(false, Ordering::SeqCst) {
            let _ = window.set_fullscreen(true);
        }
        let _ = window.set_focus();
    }

    fn flush(&self) {
        if let Err(e) = self.store.flush() {
            tracing::warn!(error = %e, "couldn't save desk state");
        }
    }

    /// Keeps the window's frame — or, when the monitors are now an
    /// arrangement it has a frame for, puts it there instead.
    fn observe<R: Runtime>(&self, window: &WebviewWindow<R>) {
        if !self.shown.load(Ordering::SeqCst)
            || !self.keeping.load(Ordering::SeqCst)
            || window.is_minimized().unwrap_or(true)
        {
            return;
        }
        let screens = screens(window.available_monitors(), window.primary_monitor());
        if screens.is_empty() {
            return;
        }
        let now_key = key(&self.label, &screens);
        let changed = {
            let mut current = self.current.lock().expect("current");
            let changed = *current != now_key;
            *current = now_key.clone();
            changed
        };
        if changed {
            let kept = self
                .store
                .get(&now_key)
                .and_then(|e| serde_json::from_value::<SavedFrame>(e.value).ok());
            tracing::info!(label = %self.label, known = kept.is_some(), "monitors changed");
            if let Some(kept) = kept {
                self.put(window, &kept, &screens);
                return;
            }
        }
        let (Ok(pos), Ok(size), Ok(scale)) = (
            window.outer_position(),
            window.inner_size(),
            window.scale_factor(),
        ) else {
            return;
        };
        let rect = Rect {
            x: f64::from(pos.x) / scale,
            y: f64::from(pos.y) / scale,
            width: f64::from(size.width) / scale,
            height: f64::from(size.height) / scale,
        };
        let before = self
            .store
            .get(&now_key)
            .and_then(|e| serde_json::from_value::<SavedFrame>(e.value).ok());
        let frame = capture(
            rect,
            &screens,
            before.as_ref(),
            window.is_maximized().unwrap_or(false),
            window.is_fullscreen().unwrap_or(false),
            now_ms(),
        );
        let Some(frame) = frame else { return };
        // Only the frame itself is a change worth keeping.
        if before.as_ref().is_some_and(|b| {
            SavedFrame {
                saved_at: b.saved_at,
                ..frame.clone()
            } == *b
        }) {
            return;
        }
        if let Ok(value) = serde_json::to_value(&frame) {
            self.store.put_native(&now_key, value);
        }
    }

    fn put<R: Runtime>(&self, window: &WebviewWindow<R>, frame: &SavedFrame, screens: &[Screen]) {
        let Some(p) = place(
            Some(frame),
            screens,
            (frame.width, frame.height),
            (0.0, 0.0),
        ) else {
            return;
        };
        if window.is_fullscreen().unwrap_or(false) && !p.fullscreen {
            let _ = window.set_fullscreen(false);
        }
        if window.is_maximized().unwrap_or(false) && !p.maximized {
            let _ = window.unmaximize();
        }
        let _ = window.set_position(LogicalPosition::new(p.rect.x, p.rect.y));
        let _ = window.set_size(LogicalSize::new(p.rect.width, p.rect.height));
        if p.maximized {
            let _ = window.maximize();
        }
        if p.fullscreen {
            let _ = window.set_fullscreen(true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn screen(id: &str, x: f64, y: f64, w: f64, h: f64, primary: bool) -> Screen {
        Screen {
            id: id.into(),
            frame: Rect {
                x,
                y,
                width: w,
                height: h,
            },
            // A menu bar on top.
            work: Rect {
                x,
                y: y + 25.0,
                width: w,
                height: h - 25.0,
            },
            primary,
        }
    }

    fn laptop() -> Screen {
        screen("Built-in:3024x1964@2", 0.0, 0.0, 1512.0, 982.0, true)
    }
    fn monitor_right() -> Screen {
        screen(
            "Monitor A:3840x2160@2",
            1512.0,
            -400.0,
            1920.0,
            1080.0,
            false,
        )
    }
    fn monitor_left() -> Screen {
        screen("Monitor A:3840x2160@2", -1920.0, 0.0, 1920.0, 1080.0, false)
    }

    fn entries(frames: &[(&str, &[Screen], SavedFrame)]) -> BTreeMap<String, Entry> {
        frames
            .iter()
            .map(|(label, screens, f)| {
                (
                    key(label, screens),
                    Entry {
                        value: serde_json::to_value(f).unwrap(),
                        updated_at: None,
                        dirty: false,
                    },
                )
            })
            .collect()
    }

    fn frame_on(screens: &[Screen], rect: Rect, at: u64) -> SavedFrame {
        capture(rect, screens, None, false, false, at).unwrap()
    }

    #[test]
    fn the_arrangement_is_the_same_whatever_order_monitors_are_listed_in() {
        let a = [laptop(), monitor_right()];
        let b = [monitor_right(), laptop()];
        assert_eq!(key("main", &a), key("main", &b));
        assert_ne!(key("main", &a), key("main", &[laptop()]));
        assert!(key("main", &a).starts_with("window.main."));
        assert_eq!(key("main", &a).len(), "window.main.".len() + 16);
    }

    #[test]
    fn a_frame_comes_back_on_the_monitor_it_was_on() {
        let docked = [laptop(), monitor_right()];
        let rect = Rect {
            x: 1612.0,
            y: -300.0,
            width: 1200.0,
            height: 800.0,
        };
        let saved = frame_on(&docked, rect, 1);
        assert_eq!(saved.monitor, "Monitor A:3840x2160@2");
        assert_eq!((saved.x, saved.y), (100.0, 75.0));
        let p = place(Some(&saved), &docked, (1440.0, 900.0), (960.0, 600.0)).unwrap();
        assert_eq!(p.rect, rect);
    }

    #[test]
    fn a_frame_follows_its_monitor_when_the_monitor_moves() {
        let saved = frame_on(
            &[laptop(), monitor_right()],
            Rect {
                x: 1612.0,
                y: -300.0,
                width: 1200.0,
                height: 800.0,
            },
            1,
        );
        let moved = [laptop(), monitor_left()];
        let p = place(Some(&saved), &moved, (1440.0, 900.0), (960.0, 600.0)).unwrap();
        assert_eq!((p.rect.x, p.rect.y), (-1820.0, 100.0));
    }

    #[test]
    fn each_arrangement_keeps_its_own_frame_and_an_unknown_one_takes_the_closest() {
        let docked = [laptop(), monitor_right()];
        let alone = [laptop()];
        let on_monitor = frame_on(
            &docked,
            Rect {
                x: 1600.0,
                y: 0.0,
                width: 1500.0,
                height: 900.0,
            },
            1,
        );
        let on_laptop = frame_on(
            &alone,
            Rect {
                x: 10.0,
                y: 30.0,
                width: 1000.0,
                height: 700.0,
            },
            2,
        );
        let kept = entries(&[
            ("main", &docked, on_monitor.clone()),
            ("main", &alone, on_laptop.clone()),
        ]);
        assert_eq!(choose("main", &kept, &docked), Some(on_monitor.clone()));
        assert_eq!(choose("main", &kept, &alone), Some(on_laptop.clone()));
        // A second monitor never seen: the docked arrangement shares two.
        let other = screen("Monitor B:2560x1440@1", 3432.0, 0.0, 2560.0, 1440.0, false);
        let three = [laptop(), monitor_right(), other];
        assert_eq!(choose("main", &kept, &three), Some(on_monitor));
        // Another window's frames are its own.
        assert_eq!(choose("other", &kept, &docked), None);
        // Nothing in common: no frame, so the default.
        let elsewhere = [screen(
            "Projector:1920x1080@1",
            0.0,
            0.0,
            1920.0,
            1080.0,
            true,
        )];
        assert_eq!(choose("main", &kept, &elsewhere), None);
    }

    #[test]
    fn equally_close_arrangements_give_the_latest_frame() {
        let a = [laptop(), monitor_right()];
        let b = [
            laptop(),
            screen("Monitor C:2560x1440@1", 1512.0, 0.0, 2560.0, 1440.0, false),
        ];
        let older = frame_on(
            &a,
            Rect {
                x: 0.0,
                y: 25.0,
                width: 1000.0,
                height: 700.0,
            },
            1,
        );
        let newer = frame_on(
            &b,
            Rect {
                x: 50.0,
                y: 25.0,
                width: 1000.0,
                height: 700.0,
            },
            2,
        );
        let kept = entries(&[("main", &a, older), ("main", &b, newer.clone())]);
        assert_eq!(choose("main", &kept, &[laptop()]), Some(newer));
    }

    #[test]
    fn a_frame_whose_monitor_is_gone_goes_on_the_primary_one_within_reach() {
        let saved = frame_on(
            &[laptop(), monitor_right()],
            Rect {
                x: 1612.0,
                y: -300.0,
                width: 1900.0,
                height: 1050.0,
            },
            1,
        );
        let p = place(Some(&saved), &[laptop()], (1440.0, 900.0), (960.0, 600.0)).unwrap();
        let work = laptop().work;
        assert!(p.rect.width <= work.width && p.rect.height <= work.height);
        assert!(reachable(&p.rect, &[laptop()]));
    }

    #[test]
    fn a_window_is_never_placed_out_of_reach() {
        let screens = [laptop()];
        let off = Rect {
            x: 5000.0,
            y: 3000.0,
            width: 1000.0,
            height: 700.0,
        };
        assert!(!reachable(&off, &screens));
        // Above the menu bar: its title strip can't be grabbed.
        assert!(!reachable(&Rect { y: -200.0, ..off }, &screens));
        // Only a sliver on screen.
        assert!(!reachable(
            &Rect {
                x: 1500.0,
                y: 100.0,
                ..off
            },
            &screens
        ));
        assert!(reachable(
            &Rect {
                x: 1300.0,
                y: 100.0,
                ..off
            },
            &screens
        ));
        let saved = SavedFrame {
            monitors: arrangement(&screens),
            monitor: laptop().id,
            origin: [0.0, 25.0],
            x: 5000.0,
            y: 3000.0,
            width: 1000.0,
            height: 700.0,
            maximized: false,
            fullscreen: false,
            saved_at: 1,
        };
        let p = place(Some(&saved), &screens, (1440.0, 900.0), (960.0, 600.0)).unwrap();
        assert!(reachable(&p.rect, &screens));
        assert_eq!(p.rect.width, 1000.0);
    }

    #[test]
    fn with_nothing_kept_the_window_is_its_default_size_centred_and_no_bigger_than_the_screen() {
        let p = place(
            None,
            &[monitor_right(), laptop()],
            (1440.0, 900.0),
            (960.0, 600.0),
        )
        .unwrap();
        let work = laptop().work;
        assert!(p.rect.width <= work.width - 2.0 * MARGIN);
        assert!(p.rect.height <= work.height - 2.0 * MARGIN);
        assert!(reachable(&p.rect, &[laptop()]));
        assert!(!p.maximized && !p.fullscreen);
        assert_eq!(place(None, &[], (1440.0, 900.0), (960.0, 600.0)), None);
    }

    #[test]
    fn maximized_and_full_screen_keep_the_normal_frame_to_go_back_to() {
        let screens = [laptop()];
        let normal = frame_on(
            &screens,
            Rect {
                x: 100.0,
                y: 100.0,
                width: 1000.0,
                height: 700.0,
            },
            1,
        );
        let whole = Rect {
            x: 0.0,
            y: 25.0,
            width: 1512.0,
            height: 957.0,
        };
        let max = capture(whole, &screens, Some(&normal), true, false, 2).unwrap();
        assert!(max.maximized);
        assert_eq!(
            (max.x, max.y, max.width),
            (normal.x, normal.y, normal.width)
        );
        let full = capture(whole, &screens, Some(&normal), false, true, 3).unwrap();
        assert!(full.fullscreen && !full.maximized);
        assert_eq!(full.width, normal.width);
        let p = place(Some(&full), &screens, (1440.0, 900.0), (960.0, 600.0)).unwrap();
        assert!(p.fullscreen);
    }

    #[test]
    fn identical_monitors_are_told_apart_by_where_they_were() {
        let twin_left = screen("Monitor A:3840x2160@2", -1920.0, 0.0, 1920.0, 1080.0, false);
        let twin_right = monitor_right();
        let screens = [twin_left, laptop(), twin_right.clone()];
        let saved = frame_on(
            &screens,
            Rect {
                x: 1600.0,
                y: -300.0,
                width: 1000.0,
                height: 700.0,
            },
            1,
        );
        assert_eq!(saved.origin, [twin_right.work.x, twin_right.work.y]);
        let p = place(Some(&saved), &screens, (1440.0, 900.0), (960.0, 600.0)).unwrap();
        assert_eq!(p.rect.x, 1600.0);
    }

    #[test]
    fn a_kept_frame_round_trips_as_json() {
        let f = frame_on(
            &[laptop()],
            Rect {
                x: 1.0,
                y: 30.0,
                width: 1000.0,
                height: 700.0,
            },
            7,
        );
        let v = serde_json::to_value(&f).unwrap();
        assert_eq!(v["savedAt"], json!(7));
        assert_eq!(v["monitor"], json!("Built-in:3024x1964@2"));
        assert_eq!(serde_json::from_value::<SavedFrame>(v).unwrap(), f);
    }
}
