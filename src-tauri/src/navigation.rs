//! Where Desk's windows may go: only their own page. Script that got into
//! a page can't take it (or anything it holds) to another site by
//! navigating, nor open a window of its own; links open in the browser,
//! through the opener.

use tauri::Url;

/// Whether a window may navigate to `url`: Desk's own pages, as each
/// system serves them (`tauri://localhost` on macOS and Linux,
/// `http(s)://tauri.localhost` on Windows), or in a development build the
/// dev server `dev` it was started with.
pub fn allowed(url: &Url, dev: Option<&Url>) -> bool {
    let own = match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    };
    own || dev.is_some_and(|d| d.origin() == url.origin())
}

/// The dev server this build loads from, when it is a development build.
pub fn dev_url<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<Url> {
    if cfg!(dev) {
        app.config().build.dev_url.clone()
    } else {
        None
    }
}

/// `builder` kept to Desk's own pages, and opening no windows.
pub fn guard<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: tauri::WebviewWindowBuilder<'a, R, M>,
    dev: Option<Url>,
) -> tauri::WebviewWindowBuilder<'a, R, M> {
    builder
        .on_navigation(move |url| {
            let ok = allowed(url, dev.as_ref());
            if !ok {
                tracing::warn!(scheme = url.scheme(), host = ?url.host_str(), "a window was kept from leaving Desk");
            }
            ok
        })
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        s.parse().unwrap()
    }

    #[test]
    fn a_window_stays_on_desks_own_pages() {
        for ok in [
            "tauri://localhost/index.html",
            "tauri://localhost/",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/",
        ] {
            assert!(allowed(&url(ok), None), "{ok}");
        }
        for refused in [
            "https://evil.example.com/?t=x",
            "http://localhost:5183/",
            "tauri://evil/",
            "https://tauri.localhost.evil.example.com/",
            "deskfile://localhost/hub/agent/file",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "about:blank",
        ] {
            assert!(!allowed(&url(refused), None), "{refused}");
        }
        let dev = url("http://localhost:5183");
        assert!(allowed(&url("http://localhost:5183/?x=1"), Some(&dev)));
        assert!(!allowed(&url("http://localhost:5184/"), Some(&dev)));
    }
}
