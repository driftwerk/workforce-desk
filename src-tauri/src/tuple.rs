//! Desk's side of the Tuple bridge: runs the follower while enabled, hands
//! requests to the frontend (which routes them to agents), and posts answers
//! back over the call.

use std::path::PathBuf;
use std::sync::Mutex;

use desk_tuple::Status;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, watch};

#[derive(Default)]
pub struct Tuple {
    names: Mutex<Option<watch::Sender<Vec<String>>>>,
}

/// The Tuple CLI the app installs (`/usr/local/bin/tuple`), else `PATH`.
pub fn binary() -> PathBuf {
    let installed = PathBuf::from("/usr/local/bin/tuple");
    if installed.is_file() {
        installed
    } else {
        "tuple".into()
    }
}

impl Tuple {
    pub fn enable(&self, app: AppHandle, names: Vec<String>) {
        let mut slot = self.names.lock().expect("tuple state");
        if let Some(tx) = slot.as_ref() {
            let _ = tx.send(names);
            return;
        }
        let (names_tx, names_rx) = watch::channel(names);
        let (req_tx, mut req_rx) = mpsc::channel(32);
        let (status_tx, mut status_rx) = watch::channel(Status::Off);
        tauri::async_runtime::spawn(desk_tuple::run(binary(), names_rx, req_tx, status_tx));
        let requests = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(r) = req_rx.recv().await {
                let _ = requests.emit("tuple-request", r);
            }
        });
        tauri::async_runtime::spawn(async move {
            while status_rx.changed().await.is_ok() {
                let s = status_rx.borrow_and_update().clone();
                let _ = app.emit("tuple-state", s);
            }
        });
        *slot = Some(names_tx);
    }

    /// Dropping the names sender ends the follower.
    pub fn disable(&self) {
        self.names.lock().expect("tuple state").take();
    }
}
