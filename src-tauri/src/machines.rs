//! The page's requests and sockets to machines' hubs: the machines Desk
//! reaches over SSH (`desk_machine`), each by id, each through a broker of
//! its own with the same allowlist as this computer's hub (and its
//! folders, and a terminal's programs), and its sockets in a pool of its
//! own. The page names a machine only by id: nothing it sends becomes part
//! of an `ssh` command line, and no machine's token reaches it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use desk_machine::{Link, Machines};
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::CommandResult;
use crate::broker::{self, Answer, Broker, header, socket};

/// A machine's broker, and the link it was made for.
type Brokered = (Arc<Link>, Arc<Broker>);

pub struct MachineIo {
    machines: Arc<Machines>,
    sockets: Arc<socket::Sockets>,
    /// Each machine's broker, for the link it was made for.
    brokers: Mutex<HashMap<String, Brokered>>,
    /// The number the next broker's socket pool takes.
    next_pool: AtomicU32,
}

impl MachineIo {
    pub fn new(machines: Arc<Machines>, sockets: Arc<socket::Sockets>) -> Self {
        Self {
            machines,
            sockets,
            brokers: Mutex::default(),
            next_pool: AtomicU32::new(1),
        }
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
    let broker = io.broker(&machine)?;
    broker.fetch(&method, &path, body).await
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
