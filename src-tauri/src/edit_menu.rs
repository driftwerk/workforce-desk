//! The Edit menu's Select All, sent to the page instead of left to the web
//! view: what has focus there decides what it selects (the sidebar its rows,
//! a field or a terminal its text; see `src/shell/selectAll.ts`). Every other
//! Edit item stays native. Only macOS has these menus.

use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Builder, Emitter, EventTarget, Manager, Runtime};

/// The menu item's id, and the event the page hears.
const SELECT_ALL: &str = "select-all";

/// The default menus, with Select All the page's.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &MenuItem::with_id(app, SELECT_ALL, "Select All", true, Some("CmdOrCtrl+A"))?,
        ],
    )?;
    let at = menu.items()?.iter().position(
        |item| matches!(item, MenuItemKind::Submenu(s) if s.text().is_ok_and(|t| t == "Edit")),
    );
    if let Some(at) = at {
        menu.remove_at(at)?;
        menu.insert(&edit, at)?;
    }
    Ok(menu)
}

/// Tells the focused window's page to select all.
fn select_all_in_focus<R: Runtime>(app: &AppHandle<R>) {
    let focused = app
        .webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false));
    if let Some(w) = focused
        && let Err(e) = app.emit_to(EventTarget::webview_window(w.label()), SELECT_ALL, ())
    {
        tracing::warn!(error = %e, "couldn't send Select All to the page");
    }
}

/// `builder` with Desk's menus, where the system has them.
pub fn with_menu<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu);
    builder.on_menu_event(|app, event| {
        if event.id() == SELECT_ALL {
            select_all_in_focus(app);
        }
    })
}
