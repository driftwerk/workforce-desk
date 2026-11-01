//! The local hub's sockets, held on this side: the page sees their frames
//! through a `Channel` and sends its own one at a time, and the hub's token
//! goes in the handshake's header, never in a URL the page sees.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use reqwest::Url;
use tauri::ipc::InvokeResponseBody;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderValue, header::AUTHORIZATION};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

/// The most sockets the page may hold open at once: a few per open pane.
pub const MAX_SOCKETS: usize = 64;
/// Frames the page has sent that the hub hasn't taken yet.
const OUTBOX: usize = 1024;
/// How long a socket the page closed waits for the hub to close too.
const CLOSE_WAIT: Duration = Duration::from_secs(2);

/// Where a socket's frames go: the page's `Channel` in the app.
pub type Events = Arc<dyn Fn(InvokeResponseBody) + Send + Sync>;

/// What the page sends down a socket.
#[derive(Debug)]
pub enum Out {
    Text(String),
    Binary(Vec<u8>),
}

enum Said {
    Frame(Out),
    Close,
}

struct Handle {
    /// The webview that opened it; only it may use or close it.
    owner: String,
    out: mpsc::Sender<Said>,
    task: tauri::async_runtime::JoinHandle<()>,
}

/// The sockets the page has open.
#[derive(Default)]
pub struct Sockets {
    open: Arc<Mutex<HashMap<u32, Handle>>>,
    next: AtomicU32,
}

impl Sockets {
    /// Opens `url` with `bearer` in its handshake for webview `owner`; its
    /// frames, and then its close, go to `events`.
    pub fn open(&self, owner: &str, url: Url, bearer: &str, events: Events) -> Result<u32, String> {
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|_| "That isn't a socket Desk can open.".to_string())?;
        let mut auth = HeaderValue::from_str(&format!("Bearer {bearer}"))
            .map_err(|_| "This computer's hub has a token Desk can't send.".to_string())?;
        auth.set_sensitive(true);
        request.headers_mut().insert(AUTHORIZATION, auth);
        let (tx, rx) = mpsc::channel(OUTBOX);
        let mut open = self.open.lock().expect("sockets");
        if open.len() >= MAX_SOCKETS {
            return Err("Desk has too many connections to this computer's hub open.".into());
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        // Held while spawning: the task's removal of itself waits for this
        // insert, however soon it ends.
        let registry = Arc::clone(&self.open);
        let task = tauri::async_runtime::spawn(async move {
            relay(request, rx, events).await;
            registry.lock().expect("sockets").remove(&id);
        });
        open.insert(
            id,
            Handle {
                owner: owner.to_string(),
                out: tx,
                task,
            },
        );
        Ok(id)
    }

    /// Sends `frame` down socket `id`, after whatever was sent before it.
    pub fn send(&self, owner: &str, id: u32, frame: Out) -> Result<(), String> {
        let open = self.open.lock().expect("sockets");
        let handle = open
            .get(&id)
            .filter(|h| h.owner == owner)
            .ok_or_else(|| "That connection is closed.".to_string())?;
        handle
            .out
            .try_send(Said::Frame(frame))
            .map_err(|e| match e {
                mpsc::error::TrySendError::Full(_) => {
                    "This computer's hub isn't keeping up.".to_string()
                }
                mpsc::error::TrySendError::Closed(_) => "That connection is closed.".to_string(),
            })
    }

    /// Closes socket `id` once what was sent before has gone; its close
    /// reaches the page as the hub's would.
    pub fn close(&self, owner: &str, id: u32) {
        let open = self.open.lock().expect("sockets");
        if let Some(h) = open.get(&id).filter(|h| h.owner == owner)
            && h.out.try_send(Said::Close).is_err()
        {
            h.task.abort();
        }
    }

    /// Drops every socket webview `owner` holds at once: it is loading a
    /// page again, or gone, and nothing would hear them.
    pub fn close_owned(&self, owner: &str) {
        self.open.lock().expect("sockets").retain(|_, h| {
            let keep = h.owner != owner;
            if !keep {
                h.task.abort();
            }
            keep
        });
    }

    #[cfg(test)]
    pub fn count(&self) -> usize {
        self.open.lock().expect("sockets").len()
    }
}

fn event(value: serde_json::Value) -> InvokeResponseBody {
    InvokeResponseBody::Json(value.to_string())
}

fn closed(code: u16, reason: &str) -> InvokeResponseBody {
    event(
        serde_json::json!({ "type": "close", "code": code, "reason": reason, "clean": code != 1006 }),
    )
}

/// What a failed handshake says to the page: the status the hub answered,
/// never the request.
fn unreachable(e: &WsError) -> String {
    match e {
        WsError::Http(response) => format!(
            "This computer's hub refused the connection ({}).",
            response.status()
        ),
        _ => "Desk couldn't reach this computer's hub.".into(),
    }
}

async fn relay(
    request: tokio_tungstenite::tungstenite::handshake::client::Request,
    mut said: mpsc::Receiver<Said>,
    events: Events,
) {
    let mut ws = match tokio_tungstenite::connect_async(request).await {
        Ok((ws, _)) => ws,
        Err(e) => {
            events(event(serde_json::json!({ "type": "error" })));
            events(closed(1006, &unreachable(&e)));
            return;
        }
    };
    events(event(serde_json::json!({ "type": "open" })));
    let (code, reason) = loop {
        tokio::select! {
            heard = ws.next() => match heard {
                Some(Ok(Message::Text(t))) => events(event(serde_json::json!({ "type": "text", "data": t.as_str() }))),
                Some(Ok(Message::Binary(b))) => events(InvokeResponseBody::Raw(b.to_vec())),
                // Its pong is queued; flushing sends it.
                Some(Ok(Message::Ping(_))) => { let _ = ws.flush().await; }
                Some(Ok(Message::Close(frame))) => {
                    let _ = ws.flush().await;
                    break frame.map_or((1005, String::new()), |f| (u16::from(f.code), f.reason.to_string()));
                }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => break (1006, String::new()),
            },
            out = said.recv() => match out {
                Some(Said::Frame(Out::Text(t))) => {
                    if ws.send(Message::Text(t.into())).await.is_err() { break (1006, String::new()); }
                }
                Some(Said::Frame(Out::Binary(b))) => {
                    if ws.send(Message::Binary(b.into())).await.is_err() { break (1006, String::new()); }
                }
                Some(Said::Close) | None => {
                    let _ = ws.close(None).await;
                    let _ = tokio::time::timeout(CLOSE_WAIT, async { while ws.next().await.is_some() {} }).await;
                    break (1000, String::new());
                }
            },
        }
    };
    events(closed(code, &reason));
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

    /// What a socket told the page.
    #[derive(Debug, Clone, PartialEq)]
    enum Heard {
        Json(serde_json::Value),
        Bytes(Vec<u8>),
    }

    fn recorder() -> (Events, tokio::sync::mpsc::UnboundedReceiver<Heard>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let events: Events = Arc::new(move |body| {
            let _ = tx.send(match body {
                InvokeResponseBody::Json(s) => Heard::Json(serde_json::from_str(&s).unwrap()),
                InvokeResponseBody::Raw(b) => Heard::Bytes(b),
            });
        });
        (events, rx)
    }

    async fn next(rx: &mut tokio::sync::mpsc::UnboundedReceiver<Heard>) -> Heard {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("in time")
            .expect("a frame")
    }

    /// A hub that echoes, after saying what Authorization and URI the
    /// handshake carried.
    // The handshake callback's error type is tungstenite's own.
    #[allow(clippy::result_large_err)]
    async fn echo_hub() -> Url {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!(
            "ws://{}/api/desk/sessions/s1/pty",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut seen = (String::new(), String::new());
            let mut ws =
                tokio_tungstenite::accept_hdr_async(stream, |req: &Request, res: Response| {
                    seen = (
                        req.headers()
                            .get(AUTHORIZATION)
                            .map(|v| v.to_str().unwrap().to_string())
                            .unwrap_or_default(),
                        req.uri().to_string(),
                    );
                    Ok(res)
                })
                .await
                .unwrap();
            ws.send(Message::Text(format!("{}|{}", seen.0, seen.1).into()))
                .await
                .unwrap();
            while let Some(Ok(m)) = ws.next().await {
                if m.is_close() {
                    break;
                }
                if m.is_binary() || m.is_text() {
                    ws.send(m).await.unwrap();
                }
            }
        });
        url
    }

    #[tokio::test]
    async fn frames_go_both_ways_in_order_with_the_token_only_in_the_header() {
        let url = echo_hub().await;
        let sockets = Sockets::default();
        let (events, mut rx) = recorder();
        let id = sockets.open("main", url, "SENTINEL-ADMIN", events).unwrap();
        assert_eq!(
            next(&mut rx).await,
            Heard::Json(serde_json::json!({ "type": "open" }))
        );
        let Heard::Json(hello) = next(&mut rx).await else {
            panic!("text")
        };
        assert_eq!(
            hello["data"],
            "Bearer SENTINEL-ADMIN|/api/desk/sessions/s1/pty"
        );
        for i in 0..50u8 {
            sockets.send("main", id, Out::Binary(vec![i, i])).unwrap();
        }
        sockets
            .send("main", id, Out::Text("{\"type\":\"ping\"}".into()))
            .unwrap();
        for i in 0..50u8 {
            assert_eq!(next(&mut rx).await, Heard::Bytes(vec![i, i]));
        }
        assert_eq!(
            next(&mut rx).await,
            Heard::Json(serde_json::json!({ "type": "text", "data": "{\"type\":\"ping\"}" }))
        );
        // Another window can neither use nor close it.
        assert!(sockets.send("grid-1", id, Out::Text("x".into())).is_err());
        sockets.close("grid-1", id);
        sockets.close("main", id);
        let Heard::Json(close) = next(&mut rx).await else {
            panic!("close")
        };
        assert_eq!(close["type"], "close");
        assert_eq!(close["clean"], true);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(sockets.count(), 0, "a closed socket is forgotten");
        assert!(sockets.send("main", id, Out::Text("x".into())).is_err());
    }

    #[tokio::test]
    async fn a_refused_handshake_says_why_and_closes() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 2048];
            let _ = tokio::io::AsyncReadExt::read(&mut s, &mut buf).await;
            s.write_all(b"HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n")
                .await
                .unwrap();
        });
        let sockets = Sockets::default();
        let (events, mut rx) = recorder();
        sockets
            .open(
                "main",
                Url::parse(&format!("ws://{addr}/api/desk/events")).unwrap(),
                "SENTINEL-ADMIN",
                events,
            )
            .unwrap();
        assert_eq!(
            next(&mut rx).await,
            Heard::Json(serde_json::json!({ "type": "error" }))
        );
        let Heard::Json(close) = next(&mut rx).await else {
            panic!("close")
        };
        assert_eq!(close["code"], 1006);
        let reason = close["reason"].as_str().unwrap();
        assert!(reason.contains("403"), "{reason}");
        assert!(!reason.contains("SENTINEL"));
    }

    #[tokio::test]
    async fn a_reloaded_page_drops_its_sockets_and_only_its_own() {
        let sockets = Sockets::default();
        let mut ids = vec![];
        for owner in ["main", "main", "grid-1"] {
            let url = echo_hub().await;
            let (events, _rx) = recorder();
            ids.push(sockets.open(owner, url, "t", events).unwrap());
        }
        sockets.close_owned("main");
        assert_eq!(sockets.count(), 1);
        assert!(
            sockets
                .send("grid-1", ids[2], Out::Text("x".into()))
                .is_ok()
        );
    }

    #[tokio::test]
    async fn there_is_a_limit_to_how_many() {
        let sockets = Sockets::default();
        // A hub that never answers a handshake: each waits, and counts meanwhile.
        let silent = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!(
            "ws://{}/api/desk/events",
            silent.local_addr().unwrap()
        ))
        .unwrap();
        for _ in 0..MAX_SOCKETS {
            let (events, _rx) = recorder();
            sockets.open("main", url.clone(), "t", events).unwrap();
        }
        let (events, _rx) = recorder();
        assert!(sockets.open("main", url, "t", events).is_err());
        sockets.close_owned("main");
    }
}
