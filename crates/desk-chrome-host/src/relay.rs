//! The relay: Chrome's native messages on stdin and stdout (each a 32-bit
//! length in this machine's byte order, then that much UTF-8 JSON), the
//! hub's WebSocket on the other side. When the hub isn't there it waits and
//! tries again rather than exit: an exit closes the extension's port, and
//! its reconnecting would start a host each time.

use std::io::{Read, Write};
use std::time::Duration;

use eyre::{Result, WrapErr, eyre};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

use crate::{HUB_PATH, called_by, extension_ids, parent};

/// The local hub as the host reaches it.
pub struct Hub {
    /// `http://127.0.0.1:<port>`.
    pub gateway_url: String,
    /// Desk's device token for it.
    pub token: String,
}

impl std::fmt::Debug for Hub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Hub")
            .field("gateway_url", &self.gateway_url)
            .finish_non_exhaustive()
    }
}

/// The most a message to Chrome may be.
pub const MAX_TO_CHROME: usize = 1024 * 1024;
/// The most Desk takes from Chrome in one message (Chrome allows 64 MiB;
/// a screenshot is the largest Desk asks for).
pub const MAX_FROM_CHROME: usize = 32 * 1024 * 1024;

/// Reads one native message; `None` when Chrome closed stdin.
pub fn read_frame(input: &mut impl Read) -> Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match input.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let n = u32::from_ne_bytes(len) as usize;
    if n > MAX_FROM_CHROME {
        return Err(eyre!(
            "a message from Chrome of {n} bytes is more than Desk takes"
        ));
    }
    let mut body = vec![0u8; n];
    input.read_exact(&mut body)?;
    Ok(Some(body))
}

/// Writes one native message.
pub fn write_frame(output: &mut impl Write, body: &[u8]) -> Result<()> {
    if body.len() > MAX_TO_CHROME {
        return Err(eyre!(
            "a message of {} bytes is more than Chrome takes",
            body.len()
        ));
    }
    output.write_all(&(body.len() as u32).to_ne_bytes())?;
    output.write_all(body)?;
    output.flush()?;
    Ok(())
}

/// What the host tells the extension when it won't relay: the extension
/// shows it in its popup.
fn refusal(why: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "type": "refused", "why": why })).unwrap_or_default()
}

/// Whether `frame` is the extension's hello: it is said again to the hub
/// on every new connection.
fn is_hello(frame: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(frame).is_ok_and(|v| v["type"] == "hello")
}

/// The hub's `/ws/desk/chrome` for `gateway_url`, and nothing else.
pub fn socket_url(gateway_url: &str) -> Result<String> {
    let rest = gateway_url
        .strip_prefix("http://")
        .ok_or_else(|| eyre!("the local hub isn't on plain http on this computer"))?;
    let host = rest.trim_end_matches('/');
    if !(host.starts_with("127.0.0.1:")
        || host.starts_with("localhost:")
        || host.starts_with("[::1]:"))
    {
        return Err(eyre!("the local hub isn't on this computer"));
    }
    Ok(format!("ws://{host}{HUB_PATH}"))
}

/// Runs the host for Chrome: `args` as Chrome gave them (the caller's
/// origin first), `hub` reading the local hub. The process's exit code.
pub fn run(args: &[String], hub: impl Fn() -> Result<Option<Hub>> + Send + Sync + 'static) -> i32 {
    let mut stdout = std::io::stdout();
    let origin = args.first().map(String::as_str).unwrap_or_default();
    if !called_by(origin, &extension_ids()) {
        let _ = write_frame(&mut stdout, &refusal("Desk serves its own extension only."));
        return 2;
    }
    if !parent::started_by_chrome() {
        let _ = write_frame(
            &mut stdout,
            &refusal("Desk Helper was started by something other than Google Chrome."),
        );
        return 2;
    }
    let Ok(rt) = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    else {
        return 1;
    };
    rt.block_on(relay(hub))
}

async fn relay(hub: impl Fn() -> Result<Option<Hub>> + Send + Sync + 'static) -> i32 {
    // Chrome's messages, read on a thread of their own.
    let (from_chrome, mut chrome_rx) = mpsc::channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        while let Ok(Some(frame)) = read_frame(&mut stdin) {
            if from_chrome.blocking_send(frame).is_err() {
                break;
            }
        }
    });
    let hub = std::sync::Arc::new(hub);
    let mut hello: Option<Vec<u8>> = None;
    let mut wait = Duration::from_secs(1);
    loop {
        let reach = {
            let hub = hub.clone();
            tokio::task::spawn_blocking(move || hub()).await
        };
        let connected = match reach {
            Ok(Ok(Some(h))) => connect(&h).await,
            Ok(Ok(None)) => Err(eyre!("Desk's hub isn't set up yet")),
            Ok(Err(e)) => Err(e),
            Err(e) => Err(eyre!("{e}")),
        };
        let ws = match connected {
            Ok(ws) => ws,
            Err(_) => {
                // Hold on to what Chrome says meanwhile; only its hello
                // matters once the hub is back.
                let deadline = tokio::time::sleep(wait);
                tokio::pin!(deadline);
                loop {
                    tokio::select! {
                        _ = &mut deadline => break,
                        frame = chrome_rx.recv() => match frame {
                            Some(f) if is_hello(&f) => hello = Some(f),
                            Some(_) => {}
                            None => return 0,
                        },
                    }
                }
                wait = (wait * 2).min(Duration::from_secs(30));
                continue;
            }
        };
        wait = Duration::from_secs(1);
        let (mut to_hub, mut from_hub) = ws.split();
        if let Some(h) = &hello
            && to_hub
                .send(Message::text(String::from_utf8_lossy(h).into_owned()))
                .await
                .is_err()
        {
            continue;
        }
        loop {
            tokio::select! {
                frame = chrome_rx.recv() => match frame {
                    Some(f) => {
                        if is_hello(&f) {
                            hello = Some(f.clone());
                        }
                        if to_hub.send(Message::text(String::from_utf8_lossy(&f).into_owned())).await.is_err() {
                            break;
                        }
                    }
                    None => {
                        let _ = to_hub.send(Message::Close(None)).await;
                        return 0;
                    }
                },
                m = from_hub.next() => match m {
                    Some(Ok(Message::Text(t))) => {
                        if write_frame(&mut std::io::stdout(), t.as_bytes()).is_err() {
                            return 0;
                        }
                    }
                    Some(Ok(Message::Ping(p))) => {
                        let _ = to_hub.send(Message::Pong(p)).await;
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => {}
                },
            }
        }
    }
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(hub: &Hub) -> Result<Socket> {
    let mut req = socket_url(&hub.gateway_url)?.into_client_request()?;
    let bearer = HeaderValue::from_str(&format!("Bearer {}", hub.token))
        .map_err(|_| eyre!("Desk's token for its hub isn't usable"))?;
    req.headers_mut().insert("authorization", bearer);
    let (ws, _) = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async(req),
    )
    .await
    .map_err(|_| eyre!("the local hub didn't answer"))?
    .wrap_err("reaching the local hub")?;
    Ok(ws)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_are_a_length_then_json() {
        let mut out = Vec::new();
        write_frame(&mut out, br#"{"type":"ready"}"#).unwrap();
        assert_eq!(&out[..4], &16u32.to_ne_bytes());
        let mut input = std::io::Cursor::new(out);
        assert_eq!(
            read_frame(&mut input).unwrap().unwrap(),
            br#"{"type":"ready"}"#
        );
        assert_eq!(read_frame(&mut input).unwrap(), None, "Chrome closed stdin");
    }

    #[test]
    fn nothing_too_big_goes_either_way() {
        assert!(write_frame(&mut Vec::new(), &vec![b' '; MAX_TO_CHROME + 1]).is_err());
        let mut huge = ((MAX_FROM_CHROME + 1) as u32).to_ne_bytes().to_vec();
        huge.extend_from_slice(b"{}");
        assert!(read_frame(&mut std::io::Cursor::new(huge)).is_err());
    }

    #[test]
    fn it_opens_only_the_local_hubs_one_path() {
        assert_eq!(
            socket_url("http://127.0.0.1:50148").unwrap(),
            "ws://127.0.0.1:50148/ws/desk/chrome"
        );
        assert_eq!(
            socket_url("http://127.0.0.1:50148/").unwrap(),
            "ws://127.0.0.1:50148/ws/desk/chrome"
        );
        for bad in [
            "https://hub.example",
            "http://hub.example:80",
            "http://10.0.0.2:50148",
            "ws://127.0.0.1:1",
        ] {
            assert!(socket_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_token_never_shows() {
        let h = Hub {
            gateway_url: "http://127.0.0.1:1".into(),
            token: "s3cret-token".into(),
        };
        assert!(!format!("{h:?}").contains("s3cret"));
    }

    #[test]
    fn only_the_hello_is_said_again() {
        assert!(is_hello(br#"{"type":"hello","key":"k"}"#));
        assert!(!is_hello(br#"{"type":"result","id":1}"#));
        assert!(!is_hello(b"not json"));
    }

    /// A hub that answers on the one path, with the token in a header,
    /// hears the extension's hello and relays back what it says.
    #[tokio::test]
    #[allow(clippy::result_large_err)]
    async fn a_hello_reaches_the_hub_with_the_token_in_a_header_and_never_the_url() {
        use tokio::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(None::<(String, String)>));
        let keep = seen.clone();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let cb = move |req: &tokio_tungstenite::tungstenite::handshake::server::Request,
                           res: tokio_tungstenite::tungstenite::handshake::server::Response| {
                *keep.lock().unwrap() = Some((
                    req.uri().to_string(),
                    req.headers().get("authorization").map(|v| v.to_str().unwrap().to_string()).unwrap_or_default(),
                ));
                Ok(res)
            };
            let mut ws = tokio_tungstenite::accept_hdr_async(tcp, cb).await.unwrap();
            let hello = ws.next().await.unwrap().unwrap();
            ws.send(Message::text(
                r#"{"type":"challenge","nonce":"n","state":"pending"}"#,
            ))
            .await
            .unwrap();
            hello.into_text().unwrap().to_string()
        });
        let hub = Hub {
            gateway_url: format!("http://127.0.0.1:{port}"),
            token: "tok".into(),
        };
        let ws = connect(&hub).await.unwrap();
        let (mut tx, mut rx) = ws.split();
        tx.send(Message::text(r#"{"type":"hello"}"#)).await.unwrap();
        let back = rx.next().await.unwrap().unwrap();
        assert!(back.to_text().unwrap().contains("challenge"));
        assert_eq!(server.await.unwrap(), r#"{"type":"hello"}"#);
        let (uri, auth) = seen.lock().unwrap().clone().unwrap();
        assert_eq!(uri, "/ws/desk/chrome");
        assert!(!uri.contains("tok"));
        assert_eq!(auth, "Bearer tok");
    }
}
