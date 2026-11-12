//! Desk's own field for a machine's password or an SSH key's passphrase
//! (friction sweep #3): a small window of its own, `machine-secret`, made
//! here when the native side needs one, never by the page. The page that
//! shows machines can't reach it: the window's capability
//! (`capabilities/machine-secret.json`) is the only one that grants the
//! three commands below, each checks it is that window asking, and nothing
//! of the main window's page runs in it. What is typed goes from it
//! straight into a wiped-on-drop [`Secret`] here, to Desk's askpass and the
//! one command that uses it; the page is told only how that went.

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use desk_machine::askpass::Secret;
use desk_machine::fleet::keys::SecretQuestion;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use zeroize::Zeroizing;

use crate::CommandResult;

/// The window's label: its capability names it.
pub const LABEL: &str = "machine-secret";

/// How long the field waits for the person.
const WAIT: Duration = Duration::from_secs(10 * 60);

struct Asking {
    question: SecretQuestion,
    answer: mpsc::Sender<Option<Secret>>,
}

/// The one question open in Desk's own field, if any.
#[derive(Default)]
pub struct SecretField {
    asking: Mutex<Option<Asking>>,
}

impl SecretField {
    /// Opens the field for `question` and waits for the person; none when
    /// they cancelled or closed it, or another question is open. Blocking:
    /// never on the main thread.
    pub fn ask<R: tauri::Runtime>(
        self: &Arc<Self>,
        app: &tauri::AppHandle<R>,
        question: &SecretQuestion,
    ) -> Option<Secret> {
        let (tx, rx) = mpsc::channel();
        {
            let mut asking = self.asking.lock().unwrap_or_else(|e| e.into_inner());
            if asking.is_some() {
                return None;
            }
            *asking = Some(Asking {
                question: question.clone(),
                answer: tx.clone(),
            });
        }
        let title = match question.kind {
            desk_machine::fleet::keys::SecretKind::Passphrase => "Unlock your SSH key",
            _ => "Sign in to a machine",
        };
        let opened = {
            let app2 = app.clone();
            let field = Arc::clone(self);
            let title = title.to_string();
            app.run_on_main_thread(move || {
                if let Err(e) = open(&app2, &title, field) {
                    tracing::warn!(error = %e, "couldn't open Desk's password field");
                    let _ = tx.send(None);
                }
            })
        };
        let answer = match opened {
            Ok(()) => rx.recv_timeout(WAIT).ok().flatten(),
            Err(_) => None,
        };
        *self.asking.lock().unwrap_or_else(|e| e.into_inner()) = None;
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = w.destroy();
        }
        answer
    }

    fn question(&self) -> Option<SecretQuestion> {
        self.asking
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|a| a.question.clone())
    }

    /// Answers the open question: `secret`, or none (Cancel, closed).
    fn answer(&self, secret: Option<Secret>) {
        if let Some(a) = self
            .asking
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            let _ = a.answer.send(secret);
        }
    }
}

/// Makes the field's window, centred over Desk, in front.
fn open<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    title: &str,
    field: Arc<SecretField>,
) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.destroy();
    }
    let builder = crate::navigation::guard(
        WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into())),
        crate::navigation::dev_url(app),
    )
    .title(title)
    .inner_size(460.0, 400.0)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .always_on_top(true)
    .center()
    .visible(false)
    .focused(true);
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    let window = builder.build()?;
    // Closed by its own close button: the same as Cancel.
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed = event {
            field.answer(None);
        }
    });
    Ok(())
}

/// Only the field's own window may ask.
fn own(window: &tauri::WebviewWindow) -> CommandResult<()> {
    if window.label() == LABEL {
        Ok(())
    } else {
        Err("Only Desk's own field asks for that.".into())
    }
}

/// What the field asks for: the machine, its exact address, the account.
#[tauri::command]
pub fn machine_secret_request(
    window: tauri::WebviewWindow,
    field: tauri::State<'_, Arc<SecretField>>,
) -> CommandResult<SecretQuestion> {
    own(&window)?;
    field
        .question()
        .ok_or_else(|| "Nothing is asked for now.".into())
}

/// What the person typed into the field.
#[tauri::command]
pub fn machine_secret_submit(
    window: tauri::WebviewWindow,
    field: tauri::State<'_, Arc<SecretField>>,
    secret: String,
) -> CommandResult<()> {
    own(&window)?;
    let secret = Secret::new(Zeroizing::new(secret))?;
    field.answer(Some(secret));
    Ok(())
}

/// Cancel in the field: nothing is sent.
#[tauri::command]
pub fn machine_secret_cancel(
    window: tauri::WebviewWindow,
    field: tauri::State<'_, Arc<SecretField>>,
) -> CommandResult<()> {
    own(&window)?;
    field.answer(None);
    Ok(())
}
