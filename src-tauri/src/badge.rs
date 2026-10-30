//! The app's unread mark: what's for you as a count on its icon, or a dot
//! when only something new is unread, and the window's title saying the
//! same. macOS badges the dock icon, Linux the launcher entry (where the
//! desktop supports it), Windows draws Desk's overlay on the taskbar icon.

use tauri::WebviewWindow;

/// The overlay's side, in pixels: Desk draws it as RGBA.
#[cfg(target_os = "windows")]
const OVERLAY: u32 = 32;

/// "Desk (3)", "Desk •", or "Desk".
pub fn title(count: u32, dot: bool) -> String {
    match (count, dot) {
        (0, true) => "Desk •".into(),
        (0, false) => "Desk".into(),
        (n, _) if n > 99 => "Desk (99+)".into(),
        (n, _) => format!("Desk ({n})"),
    }
}

#[tauri::command]
#[cfg_attr(not(target_os = "windows"), allow(unused_variables))]
pub fn set_unread_badge(window: WebviewWindow, count: u32, dot: bool, overlay: Option<Vec<u8>>) -> Result<(), String> {
    let fail = |e: tauri::Error| e.to_string();
    window.set_title(&title(count, dot)).map_err(fail)?;
    #[cfg(target_os = "macos")]
    if count > 0 {
        window.set_badge_count(Some(count.into())).map_err(fail)?;
    } else {
        window.set_badge_label(dot.then(|| "•".to_string())).map_err(fail)?;
    }
    #[cfg(target_os = "linux")]
    window.set_badge_count((count > 0).then_some(count.into())).map_err(fail)?;
    #[cfg(target_os = "windows")]
    window
        .set_overlay_icon(
            overlay
                .filter(|rgba| rgba.len() == (OVERLAY * OVERLAY * 4) as usize && (count > 0 || dot))
                .map(|rgba| tauri::image::Image::new_owned(rgba, OVERLAY, OVERLAY)),
        )
        .map_err(fail)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_title_carries_the_count_or_the_dot() {
        assert_eq!(title(0, false), "Desk");
        assert_eq!(title(0, true), "Desk •");
        assert_eq!(title(3, true), "Desk (3)");
        assert_eq!(title(120, false), "Desk (99+)");
    }
}
