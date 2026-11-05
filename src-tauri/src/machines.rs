//! The page's requests and sockets to machines' hubs: the machines Desk
//! reaches over SSH (`desk_machine`), each by id, each through a broker of
//! its own with the same allowlist as this computer's hub (and its
//! folders, and a terminal's programs), and its sockets in a pool of its
//! own. The page names a machine only by id: nothing it sends becomes part
//! of an `ssh` command line, and no machine's token reaches it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use desk_machine::callback::{self, CallbackForward};
use desk_machine::{Link, Machines};
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::CommandResult;
use crate::broker::{self, Answer, Broker, header, socket};

/// A machine's broker, and the link it was made for.
type Brokered = (Arc<Link>, Arc<Broker>);

/// Each machine's sign-in callback forward while one runs, by machine: the
/// number it was started as, so a timer ends only its own.
type Callbacks = Arc<Mutex<HashMap<String, (u64, CallbackForward)>>>;

pub struct MachineIo {
    machines: Arc<Machines>,
    sockets: Arc<socket::Sockets>,
    /// Each machine's broker, for the link it was made for.
    brokers: Mutex<HashMap<String, Brokered>>,
    /// The number the next broker's socket pool takes.
    next_pool: AtomicU32,
    /// Sign-ins' callback forwards, at most one per machine.
    callbacks: Callbacks,
    next_callback: std::sync::atomic::AtomicU64,
}

impl MachineIo {
    pub fn new(machines: Arc<Machines>, sockets: Arc<socket::Sockets>) -> Self {
        Self {
            machines,
            sockets,
            brokers: Mutex::default(),
            next_pool: AtomicU32::new(1),
            callbacks: Arc::default(),
            next_callback: std::sync::atomic::AtomicU64::new(1),
        }
    }

    /// Ends machine `id`'s sign-in callback forward, if one runs.
    pub fn end_callback(&self, id: &str) {
        let ended = self.callbacks.lock().expect("callbacks").remove(id);
        drop(ended);
    }

    /// Ends every sign-in's callback forward: Desk is quitting.
    pub fn end_callbacks(&self) {
        let ended: Vec<_> = self.callbacks.lock().expect("callbacks").drain().collect();
        drop(ended);
    }

    /// Machine `id`'s broker: the one made for its link, or a new one when
    /// it was added again since (and so has a new link).
    fn broker(&self, id: &str) -> Result<Arc<Broker>, String> {
        let link = self.link(id)?;
        let mut brokers = self.brokers.lock().expect("brokers");
        brokers.retain(|k, _| self.machines.get(k).is_some());
        if let Some((kept, broker)) = brokers.get(id)
            && Arc::ptr_eq(kept, &link)
        {
            return Ok(Arc::clone(broker));
        }
        let pool = self.next_pool.fetch_add(1, Ordering::Relaxed);
        let broker = Arc::new(Broker::machine(
            Arc::clone(&link),
            Arc::clone(&self.sockets),
            pool,
        )?);
        brokers.insert(id.to_string(), (link, Arc::clone(&broker)));
        Ok(broker)
    }

    /// Drops machine `id`'s broker now (it was removed, or is on a newer
    /// Desk), so its old link and forward end with it.
    pub fn forget(&self, id: &str) {
        self.brokers.lock().expect("brokers").remove(id);
        self.end_callback(id);
    }

    /// Every machine's hub Desk can reach now, for the hubs the page reads.
    pub fn accounts(&self) -> Vec<crate::hubs::HubAccount> {
        crate::hubs::machine_accounts(&self.machines)
    }

    /// Machine `id`, as Desk reaches it.
    pub fn link(&self, id: &str) -> Result<Arc<Link>, String> {
        self.machines
            .get(id)
            .ok_or_else(|| "That machine isn't in Desk any more.".to_string())
    }
}

/// One of `DeskHub`'s requests to a machine's hub: as `local_hub_fetch`,
/// with the machine's id in `x-desk-machine`.
#[tauri::command]
pub async fn machine_fetch(
    io: tauri::State<'_, MachineIo>,
    request: tauri::ipc::Request<'_>,
) -> CommandResult<Answer> {
    let machine =
        header(request.headers(), "x-desk-machine").ok_or("The request didn't say its machine.")?;
    let (method, path, body) = broker::brokered(&request)?;
    if chatgpt_sign_in(&method, &path, body.as_ref().map(|(_, b)| b.as_slice())) {
        let name = io
            .link(&machine)
            .map(|l| l.machine().name.clone())
            .unwrap_or_else(|_| "the machine".into());
        return Ok(Answer {
            status: 409,
            content_type: Some("application/json".into()),
            body: serde_json::json!({"error": crate::machine_setup::chatgpt_refusal(&name)})
                .to_string(),
        });
    }
    let broker = io.broker(&machine)?;
    broker.fetch(&method, &path, body).await
}

/// Whether a request is signing in to ChatGPT on a machine, which Desk
/// doesn't do yet: ChatGPT's sign-in comes back to an address on the machine
/// itself, which this computer's browser doesn't reach.
fn chatgpt_sign_in(method: &str, path: &str, body: Option<&[u8]>) -> bool {
    let path = path.split('?').next().unwrap_or(path);
    method.eq_ignore_ascii_case("POST")
        && path.trim_end_matches('/') == "/api/desk/accounts"
        && body
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(b).ok())
            .is_some_and(|v| v["engine"] == "codex")
}

/// The page that comes back by itself for machine `machine`'s sign-in
/// `sign_in`, as its hub gives it now: never one the page names.
async fn direct_page(
    io: &MachineIo,
    machine: &str,
    sign_in: &str,
) -> Result<(String, u16), String> {
    let refused = || {
        "That sign-in can't finish here by itself: paste the code from the page instead."
            .to_string()
    };
    let answer = io
        .broker(machine)?
        .fetch("GET", "/api/desk/accounts", None)
        .await?;
    if answer.status != 200 {
        return Err(refused());
    }
    let said: serde_json::Value = serde_json::from_str(&answer.body).map_err(|_| refused())?;
    let run = said["signIns"]
        .as_array()
        .and_then(|runs| runs.iter().find(|r| r["id"].as_str() == Some(sign_in)))
        .ok_or_else(|| "That sign-in has ended.".to_string())?;
    if matches!(run["state"].as_str(), Some("done" | "failed")) {
        return Err("That sign-in has ended.".into());
    }
    let url = run["direct"]["url"].as_str().ok_or_else(refused)?;
    let port = callback::direct_port(url)
        .filter(|p| run["direct"]["port"].as_u64() == Some(u64::from(*p)))
        .ok_or_else(refused)?;
    Ok((url.to_string(), port))
}

/// Starts the forward machine `machine`'s Claude sign-in `sign_in` comes
/// back through: its page's port on this computer's loopback alone, to the
/// same port on the machine's, for the length of that sign-in (ended by
/// `machine_sign_in_forward_stop`, another sign-in there, Desk quitting, or
/// by itself after `CALLBACK_FOR_SECS`). The page to open in the browser.
#[tauri::command]
pub async fn machine_sign_in_forward(
    io: tauri::State<'_, MachineIo>,
    machine: String,
    sign_in: String,
) -> CommandResult<String> {
    let (url, port) = direct_page(&io, &machine, &sign_in).await?;
    io.end_callback(&machine);
    let link = io.link(&machine)?;
    let forward = tauri::async_runtime::spawn_blocking(move || {
        CallbackForward::open(link.ssh(), link.machine(), port, callback::READY_WITHIN)
    })
    .await
    .map_err(|e| e.to_string())??;
    let n = io.next_callback.fetch_add(1, Ordering::Relaxed);
    io.callbacks
        .lock()
        .expect("callbacks")
        .insert(machine.clone(), (n, forward));
    let callbacks = Arc::clone(&io.callbacks);
    tauri::async_runtime::spawn(async move {
        let secs = u64::from(desk_core::machine::CALLBACK_FOR_SECS);
        tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
        let mut held = callbacks.lock().expect("callbacks");
        if held.get(&machine).is_some_and(|(m, _)| *m == n) {
            let ended = held.remove(&machine);
            drop(held);
            drop(ended);
        }
    });
    Ok(url)
}

/// Ends machine `machine`'s sign-in callback forward: the sign-in is over.
#[tauri::command]
pub fn machine_sign_in_forward_stop(io: tauri::State<'_, MachineIo>, machine: String) {
    io.end_callback(&machine);
}

/// Opens one of the page's sockets to machine `machine`'s hub; its frames,
/// and then its close, arrive on `events`, and it is used and closed with
/// `socket_send`, `socket_ack` and `socket_close` as any other.
#[tauri::command]
pub async fn machine_socket_open(
    webview: tauri::Webview,
    io: tauri::State<'_, MachineIo>,
    machine: String,
    path: String,
    events: Channel<InvokeResponseBody>,
) -> CommandResult<u32> {
    let events: socket::Events = Arc::new(move |body| {
        let _ = events.send(body);
    });
    let broker = io.broker(&machine)?;
    broker.open_socket(webview.label(), &path, events).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signing_in_to_chatgpt_on_a_machine_is_found() {
        let codex = br#"{"engine":"codex","name":"ChatGPT","makeDefault":true}"#;
        assert!(chatgpt_sign_in("POST", "/api/desk/accounts", Some(codex)));
        assert!(chatgpt_sign_in("post", "/api/desk/accounts/", Some(codex)));
        let claude = br#"{"engine":"claude","name":"Claude"}"#;
        assert!(!chatgpt_sign_in("POST", "/api/desk/accounts", Some(claude)));
        assert!(!chatgpt_sign_in("GET", "/api/desk/accounts", None));
        assert!(!chatgpt_sign_in(
            "POST",
            "/api/desk/accounts/sign-ins/x/code",
            Some(codex)
        ));
    }
}
