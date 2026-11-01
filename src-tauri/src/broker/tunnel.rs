//! A socket to a hub elsewhere goes through the proxy this computer is set
//! to use for https, as Desk's requests to hubs do (and as the webview's
//! sockets did): an HTTP proxy's `CONNECT` tunnel, then TLS to the hub
//! through it. The proxy is found as reqwest finds it: `HTTPS_PROXY`,
//! `ALL_PROXY` and `NO_PROXY`, else the system's settings.
//!
//! The local hub is never reached through a proxy: its sockets are plain
//! `ws` to a loopback address, which no proxy is asked for.

use std::sync::OnceLock;

use hyper_util::client::proxy::matcher::{Intercept, Matcher};
use reqwest::Url;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::http::{HeaderValue, Uri};

/// The most of a proxy's answer to `CONNECT` read before it is refused.
const MAX_ANSWER: usize = 16 * 1024;

/// This computer's proxy settings, read once.
fn system() -> &'static Matcher {
    static MATCHER: OnceLock<Matcher> = OnceLock::new();
    MATCHER.get_or_init(Matcher::from_system)
}

/// The proxy, with its credentials if any, that `wss` socket `url` goes
/// through according to `matcher`; none for any other socket, or a host
/// the settings exempt.
pub fn proxy_for(url: &Url, matcher: &Matcher) -> Option<Intercept> {
    if url.scheme() != "wss" {
        return None;
    }
    let host = url.host_str()?;
    let port = url.port_or_known_default()?;
    let target: Uri = format!("https://{host}:{port}/").parse().ok()?;
    matcher.intercept(&target)
}

/// The proxy that socket `url` goes through on this computer.
pub fn system_proxy_for(url: &Url) -> Option<Intercept> {
    proxy_for(url, system())
}

/// Why a tunnel couldn't be made, as the page is told it (never the
/// proxy's credentials).
#[derive(Debug, PartialEq)]
pub enum Refused {
    /// A proxy Desk can't tunnel through (only `http://` proxies can be).
    Unsupported(String),
    Unreachable,
    /// The proxy answered `CONNECT` with this status.
    Status(u16),
    Garbled,
}

/// A TCP stream to `host:port` through HTTP proxy `proxy`.
pub async fn connect(proxy: &Intercept, host: &str, port: u16) -> Result<TcpStream, Refused> {
    let uri = proxy.uri();
    if uri.scheme_str() != Some("http") {
        return Err(Refused::Unsupported(
            uri.scheme_str().unwrap_or("unknown").to_string(),
        ));
    }
    let proxy_host = uri.host().ok_or(Refused::Unreachable)?;
    let proxy_port = uri.port_u16().unwrap_or(80);
    let mut stream = TcpStream::connect((proxy_host.trim_matches(['[', ']']), proxy_port))
        .await
        .map_err(|_| Refused::Unreachable)?;
    let authority = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let mut head = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if let Some(auth) = proxy
        .basic_auth()
        .and_then(|v: &HeaderValue| v.to_str().ok())
    {
        head.push_str(&format!("Proxy-Authorization: {auth}\r\n"));
    }
    head.push_str("\r\n");
    stream
        .write_all(head.as_bytes())
        .await
        .map_err(|_| Refused::Unreachable)?;
    // The answer's head, a byte at a time: nothing after it is read, so the
    // tunnel's first bytes (the hub's) are left for TLS.
    let mut answer = Vec::new();
    while !answer.ends_with(b"\r\n\r\n") {
        if answer.len() >= MAX_ANSWER {
            return Err(Refused::Garbled);
        }
        let mut byte = [0u8; 1];
        match stream.read(&mut byte).await {
            Ok(1) => answer.push(byte[0]),
            _ => return Err(Refused::Unreachable),
        }
    }
    let status = std::str::from_utf8(&answer)
        .ok()
        .and_then(|a| a.lines().next())
        .filter(|line| line.starts_with("HTTP/1."))
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or(Refused::Garbled)?;
    if status != 200 {
        return Err(Refused::Status(status));
    }
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    fn url(s: &str) -> Url {
        s.parse().unwrap()
    }

    #[test]
    fn only_a_socket_elsewhere_goes_through_the_proxy_and_not_one_exempted() {
        let m = Matcher::builder()
            .https("http://user:pw@proxy.example.com:3128")
            .no("exempt.example.com")
            .build();
        let p = proxy_for(&url("wss://hub.example.com/ws/desk"), &m).unwrap();
        assert_eq!(p.uri().host(), Some("proxy.example.com"));
        assert!(p.basic_auth().is_some());
        assert!(proxy_for(&url("wss://exempt.example.com/ws"), &m).is_none());
        // The local hub's sockets are plain ws to a loopback address.
        assert!(proxy_for(&url("ws://127.0.0.1:4100/ws"), &m).is_none());
        let none = Matcher::builder().build();
        assert!(proxy_for(&url("wss://hub.example.com/ws"), &none).is_none());
    }

    /// An HTTP proxy that takes one `CONNECT`, answers `status`, and on 200
    /// pipes the tunnel to whatever it names; it tells what it was asked.
    async fn proxy(status: u16) -> (String, tokio::sync::mpsc::UnboundedReceiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            let (mut client, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                let mut b = [0u8; 1];
                client.read_exact(&mut b).await.unwrap();
                head.push(b[0]);
            }
            let head = String::from_utf8(head).unwrap();
            let target = head.split_whitespace().nth(1).unwrap().to_string();
            let _ = tx.send(head);
            client
                .write_all(format!("HTTP/1.1 {status} X\r\n\r\n").as_bytes())
                .await
                .unwrap();
            if status == 200 {
                let mut upstream = TcpStream::connect(target).await.unwrap();
                let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
            }
        });
        (format!("http://user:pw@{addr}"), rx)
    }

    #[tokio::test]
    async fn a_socket_goes_through_the_proxys_tunnel() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        // A hub that echoes.
        let hub = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = hub.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (s, _) = hub.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
            while let Some(Ok(m)) = ws.next().await {
                if m.is_text() {
                    ws.send(m).await.unwrap();
                }
            }
        });
        let (at, mut asked) = proxy(200).await;
        let m = Matcher::builder().https(at).build();
        let p = m
            .intercept(&"https://hub.example.com/".parse().unwrap())
            .unwrap();
        let stream = connect(&p, "127.0.0.1", port).await.unwrap();
        let head = asked.recv().await.unwrap();
        assert!(head.starts_with(&format!("CONNECT 127.0.0.1:{port} HTTP/1.1\r\n")));
        assert!(head.contains("Proxy-Authorization: Basic "));
        let (mut ws, _) =
            tokio_tungstenite::client_async(format!("ws://127.0.0.1:{port}/ws"), stream)
                .await
                .unwrap();
        ws.send(Message::Text("hi".into())).await.unwrap();
        assert_eq!(ws.next().await.unwrap().unwrap().to_text().unwrap(), "hi");
    }

    #[tokio::test]
    async fn a_proxy_that_refuses_says_so() {
        let (at, _asked) = proxy(407).await;
        let m = Matcher::builder().https(at).build();
        let p = m
            .intercept(&"https://hub.example.com/".parse().unwrap())
            .unwrap();
        assert_eq!(
            connect(&p, "hub.example.com", 443).await.unwrap_err(),
            Refused::Status(407)
        );
        let socks = Matcher::builder().https("socks5://127.0.0.1:1080").build();
        let p = socks
            .intercept(&"https://hub.example.com/".parse().unwrap())
            .unwrap();
        assert!(matches!(
            connect(&p, "hub.example.com", 443).await,
            Err(Refused::Unsupported(_))
        ));
    }
}
