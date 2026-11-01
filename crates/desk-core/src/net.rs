//! The HTTP clients that carry Desk's credentials, and the addresses they
//! may carry them to.
//!
//! Every client here refuses to follow a redirect: a hub never needs one
//! to answer Desk, and a redirect would take a request (and, for a client
//! that kept it, its token) somewhere the hub's address didn't say. Every
//! one gives up on a hub that stops answering. One for the hub on this
//! computer never goes through a proxy: a proxy set in the environment
//! would see its admin token.

use std::net::IpAddr;
use std::time::Duration;

use reqwest::Url;

/// How long a hub has to take a connection.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a hub may take to start answering, or go without sending
/// anything while it answers. reqwest counts it from the send, so it bounds
/// the whole request too: generous, so no route a hub is slow to answer
/// (making a session, posting to a room) is cut off. An upload, which may
/// take longer than this to send, goes by [`uploading`] instead.
pub const READ_TIMEOUT: Duration = Duration::from_secs(300);
/// The slowest an upload is let go: well under any uplink people use.
const UPLOAD_FLOOR: u64 = 32 * 1024;

/// What every client here is: no redirects, and a connection taken in time.
fn client(on_this_computer: bool, read_timeout: Option<Duration>) -> reqwest::Client {
    let builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT);
    // No proxy for this computer's hub; for others the system's, if any
    // (a corporate network may need it), and https only.
    let builder = if on_this_computer {
        builder.no_proxy()
    } else {
        builder.https_only(true)
    };
    match read_timeout {
        Some(t) => builder.read_timeout(t),
        None => builder,
    }
    .build()
    .expect("an HTTP client")
}

/// A client for the hub on this computer: no proxy, no redirects.
pub fn loopback() -> reqwest::Client {
    client(true, Some(READ_TIMEOUT))
}

/// [`loopback`], blocking.
pub fn loopback_blocking() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(READ_TIMEOUT)
        .build()
        .expect("an HTTP client")
}

/// A client for hubs elsewhere: through the system's proxy when it has one
/// (a corporate network may need it), over https only, no redirects.
pub fn remote() -> reqwest::Client {
    client(false, Some(READ_TIMEOUT))
}

/// [`loopback`] or [`remote`], as `on_this_computer` says, for uploads: no
/// read timeout, which reqwest counts from the send and so would cut a slow
/// upload off. Each upload is bounded by [`upload_timeout`] instead.
pub fn uploading(on_this_computer: bool) -> reqwest::Client {
    client(on_this_computer, UPLOAD_READ_TIMEOUT)
}

/// None: see [`uploading`].
const UPLOAD_READ_TIMEOUT: Option<Duration> = None;

/// How long an upload of `bytes` may take, its answer included: what any
/// request may, and the time to send it at [`UPLOAD_FLOOR`] bytes a second.
pub fn upload_timeout(bytes: usize) -> Duration {
    READ_TIMEOUT + Duration::from_secs(bytes as u64 / UPLOAD_FLOOR)
}

/// Whether `url` names this computer by address. An address, not a name:
/// nothing a resolver answers decides where a token goes.
pub fn is_loopback(url: &Url) -> bool {
    url.host_str()
        .unwrap_or_default()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
        .is_ok_and(|ip| ip.is_loopback())
}

/// `url` with nothing in it but where a hub is: no credentials, path,
/// query or fragment.
fn bare(url: &Url) -> bool {
    url.username().is_empty()
        && url.password().is_none()
        && matches!(url.path(), "" | "/")
        && url.query().is_none()
        && url.fragment().is_none()
}

/// The address of the hub on this computer: plain `http` to a loopback
/// address, with nothing else in it.
pub fn loopback_url(raw: &str) -> Result<Url, String> {
    let refuse = || "This computer's hub isn't at an address on this computer.".to_string();
    let url = Url::parse(raw).map_err(|_| refuse())?;
    if url.scheme() != "http" || !is_loopback(&url) || !bare(&url) {
        return Err(refuse());
    }
    Ok(url)
}

/// A hub's address as Desk will send its token to it: `https` anywhere, or
/// [`loopback_url`]; nothing else in it.
pub fn hub_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim_end_matches('/'))
        .map_err(|_| format!("{raw} isn't a workspace's address."))?;
    match url.scheme() {
        "https" if url.host_str().is_some_and(|h| !h.is_empty()) && bare(&url) => Ok(url),
        "http" => loopback_url(raw)
            .map_err(|_| "A workspace elsewhere must be reached over https.".to_string()),
        _ => Err(format!("{raw} isn't a workspace's address.")),
    }
}

/// `base` at `path` and `query`, exactly as given: a URL the parser would
/// normalise into another path, or onto another host, isn't made.
pub fn at(base: &Url, path: &str, query: Option<&str>) -> Result<Url, String> {
    let refuse = || format!("Desk doesn't send {path} to a workspace.");
    if !path.starts_with('/') || path.starts_with("//") || path.contains('\\') {
        return Err(refuse());
    }
    let mut url = base.clone();
    url.set_path(path);
    url.set_query(query);
    if url.path() != path
        || url.query() != query
        || url.scheme() != base.scheme()
        || url.host() != base.host()
        || url.port() != base.port()
    {
        return Err(refuse());
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    /// A listener on a loopback port that answers each connection with
    /// `answer`, and says what each request's head was.
    fn listener(answer: String) -> (String, mpsc::Receiver<String>) {
        // What the app installs before it makes a client.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", l.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for stream in l.incoming() {
                let mut s = stream.unwrap();
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = s.read(&mut chunk).unwrap();
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let _ = tx.send(String::from_utf8_lossy(&buf).to_ascii_lowercase());
                let _ = s.write_all(answer.as_bytes());
            }
        });
        (url, rx)
    }

    #[test]
    fn a_redirect_is_answered_and_never_followed_with_the_token() {
        let (elsewhere, followed) = listener("HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n".into());
        let (hub, asked) = listener(format!(
            "HTTP/1.1 307 Temporary Redirect\r\nlocation: {elsewhere}/steal\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
        ));
        let answer = loopback_blocking()
            .post(format!("{hub}/api/vault/x"))
            .bearer_auth("SENTINEL-TOKEN")
            .body("{}")
            .send()
            .unwrap();
        assert_eq!(answer.status().as_u16(), 307);
        assert!(asked.recv().unwrap().contains("bearer sentinel-token"));
        assert!(
            followed.recv_timeout(Duration::from_millis(300)).is_err(),
            "the redirect's target got a request"
        );
    }

    #[tokio::test]
    async fn the_async_clients_follow_no_redirect_either() {
        let (elsewhere, followed) = listener("HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n".into());
        let (hub, _asked) = listener(format!(
            "HTTP/1.1 302 Found\r\nlocation: {elsewhere}/steal\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
        ));
        let answer = loopback()
            .get(format!("{hub}/api/me"))
            .bearer_auth("SENTINEL-TOKEN")
            .send()
            .await
            .unwrap();
        assert_eq!(answer.status().as_u16(), 302);
        assert!(followed.recv_timeout(Duration::from_millis(300)).is_err());
    }

    #[tokio::test]
    async fn the_remote_client_refuses_plain_http() {
        let (hub, asked) = listener("HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n".into());
        assert!(remote().get(format!("{hub}/api/me")).send().await.is_err());
        assert!(asked.recv_timeout(Duration::from_millis(200)).is_err());
    }

    /// A hub that takes `wait` to answer, after
    /// reading the whole request (a hub that answered before reading it all
    /// would have its connection reset under the upload, on Windows).
    async fn slow_hub(wait: Duration) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", l.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((mut s, _)) = l.accept().await {
                tokio::spawn(async move {
                    let mut got = Vec::new();
                    let mut chunk = [0u8; 64 * 1024];
                    let whole = loop {
                        let Ok(n) = s.read(&mut chunk).await else {
                            return;
                        };
                        if n == 0 {
                            return;
                        }
                        got.extend_from_slice(&chunk[..n]);
                        let Some(end) = got.windows(4).position(|w| w == b"\r\n\r\n") else {
                            continue;
                        };
                        let length = String::from_utf8_lossy(&got[..end])
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if got.len() >= end + 4 + length {
                            break true;
                        }
                    };
                    if whole {
                        tokio::time::sleep(wait).await;
                        let _ = s
                            .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                            .await;
                    }
                });
            }
        });
        url
    }

    #[tokio::test]
    async fn an_upload_is_bounded_by_its_size_not_the_read_timeout() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        // reqwest counts a read timeout from the send: a hub slower to answer
        // than it (an upload still arriving, say) is cut off however much is
        // still coming.
        let hub = slow_hub(Duration::from_millis(800)).await;
        let body = vec![0u8; 1024 * 1024];
        let cut = client(true, Some(Duration::from_millis(300)))
            .post(format!("{hub}/up"))
            .body(body.clone())
            .send()
            .await;
        assert!(cut.unwrap_err().is_timeout());
        // So an upload has none, and is bounded by its size instead.
        assert_eq!(UPLOAD_READ_TIMEOUT, None);
        let up = client(true, UPLOAD_READ_TIMEOUT)
            .post(format!("{hub}/up"))
            .timeout(Duration::from_secs(5))
            .body(body)
            .send()
            .await
            .unwrap();
        assert_eq!(up.status().as_u16(), 200);
        assert!(upload_timeout(0) >= READ_TIMEOUT);
        assert!(
            upload_timeout(100 * 1024 * 1024) > READ_TIMEOUT + Duration::from_secs(3000),
            "100 MB at the slowest uplink allowed"
        );
        // Still bounded: a hub that never answers is given up on.
        let never = slow_hub(Duration::from_secs(3600)).await;
        let late = uploading(true)
            .post(format!("{never}/up"))
            .timeout(Duration::from_millis(300))
            .body("abc")
            .send()
            .await;
        assert!(late.unwrap_err().is_timeout());
    }

    #[test]
    fn a_hub_is_https_or_this_computer_and_nothing_else() {
        for ok in [
            "https://hub.example.com",
            "https://hub.example.com/",
            "https://hub.example.com:8443",
            "http://127.0.0.1:3",
            "http://[::1]:3",
        ] {
            assert!(hub_url(ok).is_ok(), "{ok}");
        }
        for refused in [
            "http://hub.example.com",
            "http://localhost:3",
            "http://10.0.0.1:3",
            "https://user:pw@hub.example.com",
            "https://hub.example.com/prefix",
            "https://hub.example.com/?x=1",
            "https://hub.example.com/#f",
            "ftp://hub.example.com",
            "not a url",
        ] {
            assert!(hub_url(refused).is_err(), "{refused}");
        }
        for refused in [
            "https://127.0.0.1:3",
            "http://localhost:3",
            "http://0.0.0.0:3",
        ] {
            assert!(loopback_url(refused).is_err(), "{refused}");
        }
    }

    #[test]
    fn a_path_never_leaves_the_hub() {
        let base = Url::parse("https://hub.example.com").unwrap();
        assert_eq!(
            at(&base, "/api/me", Some("a=1")).unwrap().as_str(),
            "https://hub.example.com/api/me?a=1"
        );
        for path in [
            "//evil.example.com/x",
            "https://evil.example.com/",
            "api/me",
            "/api/../vault",
            "/api/%2e%2e/vault",
            "/a\\b",
            "",
        ] {
            assert!(at(&base, path, None).is_err(), "{path}");
        }
        assert!(at(&base, "/a", Some("x#y")).is_err());
    }
}
