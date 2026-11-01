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
/// How long a hub may go without sending anything while it answers.
pub const READ_TIMEOUT: Duration = Duration::from_secs(60);

/// A client for the hub on this computer: no proxy, no redirects.
pub fn loopback() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .build()
        .expect("an HTTP client")
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
    reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .build()
        .expect("an HTTP client")
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
