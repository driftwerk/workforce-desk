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

/// Sign-ins' callback listeners, by sign-in: at most one per machine. Each
/// start takes a number first; stopping one (or starting another on that
/// machine) drops its number, so a listener that finishes opening after
/// its sign-in was stopped is ended at once rather than kept.
pub struct Forwards<T> {
    inner: Mutex<ForwardsInner<T>>,
}

struct ForwardsInner<T> {
    next: u64,
    /// The number each sign-in's start took, and its machine.
    wanted: HashMap<String, (u64, String)>,
    open: HashMap<String, T>,
}

impl<T> Default for Forwards<T> {
    fn default() -> Self {
        Self {
            inner: Mutex::new(ForwardsInner {
                next: 1,
                wanted: HashMap::new(),
                open: HashMap::new(),
            }),
        }
    }
}

impl<T> Forwards<T> {
    fn lock(&self) -> std::sync::MutexGuard<'_, ForwardsInner<T>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Sign-in `sign_in` on `machine` is to have a listener: its number.
    /// Any other on that machine ends.
    pub fn begin(&self, machine: &str, sign_in: &str) -> u64 {
        let ended: Vec<T>;
        let n = {
            let mut st = self.lock();
            let others: Vec<String> = st
                .wanted
                .iter()
                .filter(|(_, (_, m))| m == machine)
                .map(|(k, _)| k.clone())
                .collect();
            ended = others
                .iter()
                .filter_map(|k| {
                    st.wanted.remove(k);
                    st.open.remove(k)
                })
                .collect();
            let n = st.next;
            st.next += 1;
            st.wanted
                .insert(sign_in.to_string(), (n, machine.to_string()));
            n
        };
        drop(ended);
        n
    }

    /// Keeps `forward` for start `n` of `sign_in`, if that start is still
    /// wanted; else gives it back, to be ended.
    pub fn settle(&self, sign_in: &str, n: u64, forward: T) -> Result<(), T> {
        let mut st = self.lock();
        if st.wanted.get(sign_in).is_some_and(|(w, _)| *w == n) {
            st.open.insert(sign_in.to_string(), forward);
            Ok(())
        } else {
            Err(forward)
        }
    }

    /// Ends `sign_in`'s listener, or its start under way.
    pub fn stop(&self, sign_in: &str) {
        let ended = {
            let mut st = self.lock();
            st.wanted.remove(sign_in);
            st.open.remove(sign_in)
        };
        drop(ended);
    }

    /// Ends start `n` of `sign_in`, if it is still the one: its time is up.
    pub fn expire(&self, sign_in: &str, n: u64) {
        let ended = {
            let mut st = self.lock();
            if !st.wanted.get(sign_in).is_some_and(|(w, _)| *w == n) {
                return;
            }
            st.wanted.remove(sign_in);
            st.open.remove(sign_in)
        };
        drop(ended);
    }

    /// Ends every listener on `machine`.
    pub fn stop_machine(&self, machine: &str) {
        let ended: Vec<T> = {
            let mut st = self.lock();
            let ids: Vec<String> = st
                .wanted
                .iter()
                .filter(|(_, (_, m))| m == machine)
                .map(|(k, _)| k.clone())
                .collect();
            ids.iter()
                .filter_map(|k| {
                    st.wanted.remove(k);
                    st.open.remove(k)
                })
                .collect()
        };
        drop(ended);
    }

    /// Ends them all: Desk is quitting.
    pub fn stop_all(&self) {
        let ended: Vec<T> = {
            let mut st = self.lock();
            st.wanted.clear();
            st.open.drain().map(|(_, f)| f).collect()
        };
        drop(ended);
    }
}

pub struct MachineIo {
    machines: Arc<Machines>,
    sockets: Arc<socket::Sockets>,
    /// Each machine's broker, for the link it was made for.
    brokers: Mutex<HashMap<String, Brokered>>,
    /// The number the next broker's socket pool takes.
    next_pool: AtomicU32,
    /// Sign-ins' callback listeners, at most one per machine.
    callbacks: Arc<Forwards<CallbackForward>>,
}

impl MachineIo {
    pub fn new(machines: Arc<Machines>, sockets: Arc<socket::Sockets>) -> Self {
        Self {
            machines,
            sockets,
            brokers: Mutex::default(),
            next_pool: AtomicU32::new(1),
            callbacks: Arc::default(),
        }
    }

    /// Ends every sign-in's callback listener: Desk is quitting.
    pub fn end_callbacks(&self) {
        self.callbacks.stop_all();
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
        self.callbacks.stop_machine(id);
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
    if broker::routes::native_only(&method, &path) {
        return Err("Desk doesn't send that from the page.".into());
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
/// `sign_in`, as its hub gives it now (never one the page names), checked:
/// the page, and the port it comes back to.
async fn direct_page(
    io: &MachineIo,
    machine: &str,
    sign_in: &str,
) -> Result<(url::Url, u16), String> {
    let refused = || {
        "That sign-in can't finish here by itself: paste the code from the page instead."
            .to_string()
    };
    let id = uuid_like(sign_in).ok_or_else(refused)?;
    let answer = io
        .broker(machine)?
        .fetch(
            "GET",
            &format!("/api/desk/accounts/sign-ins/{id}/direct"),
            None,
        )
        .await?;
    if answer.status == 404 {
        return Err("That sign-in has ended.".into());
    }
    if answer.status != 200 {
        return Err(refused());
    }
    let said: serde_json::Value = serde_json::from_str(&answer.body).map_err(|_| refused())?;
    let url = said["url"].as_str().ok_or_else(refused)?;
    let port = callback::direct_port(url)
        .filter(|p| said["port"].as_u64() == Some(u64::from(*p)))
        .ok_or_else(refused)?;
    let page = callback::sign_in_page(url, callback::CLAUDE_HOSTS).ok_or_else(refused)?;
    Ok((page, port))
}

/// A sign-in's id as the hub gives them (a UUID), and nothing else.
fn uuid_like(id: &str) -> Option<&str> {
    (id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')).then_some(id)
}

/// Opens `page` in the person's browser.
fn open_page(app: &tauri::AppHandle, page: &url::Url) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(page.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// For machine `machine`'s Claude sign-in `sign_in`: listens on the one
/// port its page comes back to, on this computer's loopback alone, and
/// carries each connection to that port on the machine's, for the length
/// of the sign-in (ended by `machine_sign_in_forward_stop`, another sign-in
/// there, Desk quitting, or after `CALLBACK_FOR_SECS`); then opens the page
/// in the browser. The page names neither the port nor the page.
#[tauri::command]
pub async fn machine_sign_in_forward(
    app: tauri::AppHandle,
    io: tauri::State<'_, MachineIo>,
    machine: String,
    sign_in: String,
) -> CommandResult<()> {
    let (page, port) = direct_page(&io, &machine, &sign_in).await?;
    let n = io.callbacks.begin(&machine, &sign_in);
    let link = io.link(&machine)?;
    let opened = tauri::async_runtime::spawn_blocking(move || {
        CallbackForward::open(link.ssh(), link.machine(), port)
    })
    .await
    .map_err(|e| e.to_string())?;
    let forward = match opened {
        Ok(f) => f,
        Err(e) => {
            io.callbacks.expire(&sign_in, n);
            return Err(e);
        }
    };
    if let Err(late) = io.callbacks.settle(&sign_in, n, forward) {
        drop(late);
        return Err("That sign-in has ended.".into());
    }
    let callbacks = Arc::clone(&io.callbacks);
    let ending = sign_in.clone();
    tauri::async_runtime::spawn(async move {
        let secs = u64::from(desk_core::machine::CALLBACK_FOR_SECS);
        tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
        callbacks.expire(&ending, n);
    });
    open_page(&app, &page)?;
    Ok(())
}

/// Ends the callback listener of machine `machine`'s sign-in `sign_in`, or
/// its start under way: the sign-in is over.
#[tauri::command]
pub fn machine_sign_in_forward_stop(
    io: tauri::State<'_, MachineIo>,
    machine: String,
    sign_in: String,
) {
    let _ = machine;
    io.callbacks.stop(&sign_in);
}

/// Opens a page a machine's engine gave for signing in (Claude's page with a
/// code, Codex's device page) in the browser, once it is checked to be that
/// engine's own: https on its hosts, read as a browser reads it. The page
/// never opens a machine's page itself.
#[tauri::command]
pub fn machine_open_sign_in_page(
    app: tauri::AppHandle,
    engine: String,
    url: String,
) -> CommandResult<()> {
    let hosts = match engine.as_str() {
        "claude" => callback::CLAUDE_HOSTS,
        "codex" => callback::CODEX_HOSTS,
        _ => return Err("Desk doesn't sign that in.".into()),
    };
    let page = callback::sign_in_page(&url, hosts)
        .ok_or("That page isn't the sign-in's own, so Desk won't open it.")?;
    open_page(&app, &page)?;
    Ok(())
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

    /// Stands for a listener: says when it ends.
    struct Probe(Arc<Mutex<Vec<&'static str>>>, &'static str);
    impl Drop for Probe {
        fn drop(&mut self) {
            self.0.lock().unwrap().push(self.1);
        }
    }

    #[test]
    fn a_listener_that_opens_after_its_sign_in_was_stopped_is_ended_at_once() {
        let ended = Arc::new(Mutex::new(Vec::new()));
        let f: Forwards<Probe> = Forwards::default();
        let n = f.begin("devbox", "s1");
        f.stop("s1"); // Cancel, while it opens.
        let late = f
            .settle("s1", n, Probe(Arc::clone(&ended), "s1"))
            .err()
            .unwrap();
        drop(late);
        assert_eq!(*ended.lock().unwrap(), ["s1"]);

        // A newer sign-in on that machine ends the older one's, and the
        // older one's late start is never kept.
        let a = f.begin("devbox", "s2");
        assert!(f.settle("s2", a, Probe(Arc::clone(&ended), "s2")).is_ok());
        let b = f.begin("devbox", "s3");
        assert_eq!(*ended.lock().unwrap(), ["s1", "s2"]);
        assert!(
            f.settle("s2", a, Probe(Arc::clone(&ended), "s2-late"))
                .is_err()
        );
        assert!(f.settle("s3", b, Probe(Arc::clone(&ended), "s3")).is_ok());
        // Another machine's is its own; a timer ends only its own start.
        let c = f.begin("gpu", "s4");
        assert!(f.settle("s4", c, Probe(Arc::clone(&ended), "s4")).is_ok());
        f.expire("s3", a);
        assert!(!ended.lock().unwrap().contains(&"s3"));
        f.expire("s3", b);
        assert!(ended.lock().unwrap().contains(&"s3"));
        f.stop_machine("gpu");
        assert!(ended.lock().unwrap().contains(&"s4"));
    }

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
