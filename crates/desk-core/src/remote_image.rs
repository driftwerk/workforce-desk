//! Fetching a picture an agent's markdown points at, once the person asks to
//! see it.
//!
//! The page never fetches a remote image itself (its content-security policy
//! bars them, and an agent's text would choose what it fetched). Desk does it
//! here instead, and only:
//!
//! - over https, to a name or address on the public internet: every address a
//!   name resolves to is checked when the connection is made, so a name that
//!   resolves to this computer or a private network is refused, and every
//!   redirect is followed by hand and checked the same way;
//! - with nothing of the person's: no cookies (reqwest keeps none without its
//!   `cookies` feature), no credentials (an address with a user or password in
//!   it is refused, since reqwest would send them), no referrer, and never
//!   through a proxy (a proxy resolves the name itself, so the check above
//!   would never see where the request went);
//! - up to [`MAX_BYTES`], within [`TOTAL_TIMEOUT`];
//! - for a PNG, JPEG, GIF, WebP or AVIF picture, told by its bytes, whatever
//!   the site says it is. Never SVG, which can carry script.

use std::fmt;
use std::future::Future;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::header::{ACCEPT, LOCATION};
use reqwest::{StatusCode, Url};
use serde::Serialize;

/// The largest picture fetched.
pub const MAX_BYTES: usize = 10 * 1024 * 1024;
/// How long a site has to take the connection.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the whole fetch may take, every redirect and the body included.
pub const TOTAL_TIMEOUT: Duration = Duration::from_secs(30);
/// The most redirects followed.
pub const MAX_REDIRECTS: usize = 5;

/// Why a picture isn't shown, in words the placeholder can say as they are.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "reason", rename_all = "lowercase")]
pub enum FetchError {
    /// Desk won't fetch it: where it is, or what it turned out to be.
    Refused(String),
    /// Desk tried and it didn't come.
    Failed(String),
}

impl fmt::Display for FetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FetchError::Refused(r) | FetchError::Failed(r) => f.write_str(r),
        }
    }
}

const PRIVATE: &str = "It's on this computer or a private network, so Desk won't fetch it.";
const NOT_HTTPS: &str = "Desk only fetches pictures over https.";
const NOT_AN_IMAGE: &str = "It isn't a PNG, JPEG, GIF, WebP or AVIF picture.";

fn refused(reason: &str) -> FetchError {
    FetchError::Refused(reason.to_string())
}
fn failed(reason: impl Into<String>) -> FetchError {
    FetchError::Failed(reason.into())
}

/// A fetched picture: what its bytes say it is, and the bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Image {
    pub mime: &'static str,
    pub bytes: Vec<u8>,
}

/// What a picture's first bytes say it is; none for anything but the raster
/// formats Desk shows.
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && matches!(&bytes[8..12], b"avif" | b"avis")
    {
        Some("image/avif")
    } else {
        None
    }
}

/// Whether `ip` is an address on the public internet. Everything else is
/// refused: this computer, private and shared (CGNAT) networks, link-local,
/// multicast, documentation, benchmarking and reserved ranges, and an IPv6
/// address that carries one of those IPv4 addresses inside it.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_v4(v4),
        IpAddr::V6(v6) => public_v6(v6),
    }
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0 // "this network"
        || a == 10 // private
        || a == 127 // loopback
        || (a == 100 && (64..128).contains(&b)) // shared address space (CGNAT)
        || (a == 169 && b == 254) // link-local, cloud metadata
        || (a == 172 && (16..32).contains(&b)) // private
        || (a == 192 && b == 0 && c == 0) // IETF protocol assignments
        || (a == 192 && b == 0 && c == 2) // documentation
        || (a == 192 && b == 88 && c == 99) // 6to4 relay anycast
        || (a == 192 && b == 168) // private
        || (a == 198 && (18..20).contains(&b)) // benchmarking
        || (a == 198 && b == 51 && c == 100) // documentation
        || (a == 203 && b == 0 && c == 113) // documentation
        || a >= 224) // multicast, reserved, broadcast
}

fn public_v6(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    // An IPv4 address inside: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d),
    // NAT64 (64:ff9b::a.b.c.d) and 6to4 (2002:aabb:ccdd::) reach it.
    let inner =
        |hi: u16, lo: u16| Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
    if s[..5] == [0; 5] && (s[5] == 0xffff || s[5] == 0) {
        // `::` and `::1` land in 0.0.0.0/8, so they're refused too.
        return public_v4(inner(s[6], s[7]));
    }
    // NAT64, the well-known prefix and the local-use one (64:ff9b:1::/48).
    if s[..2] == [0x64, 0xff9b] && (s[2..6] == [0; 4] || s[2] == 1) {
        return public_v4(inner(s[6], s[7]));
    }
    if s[0] == 0x2002 {
        return public_v4(inner(s[1], s[2]));
    }
    !((s[0] & 0xfe00) == 0xfc00 // unique local
        || (s[0] & 0xffc0) == 0xfe80 // link-local
        || (s[0] & 0xffc0) == 0xfec0 // site-local (deprecated)
        || (s[0] & 0xff00) == 0xff00 // multicast
        || (s[0] == 0x2001 && s[1] == 0) // Teredo
        || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
        || (s[0] == 0x3fff && s[1] < 0x1000) // documentation
        || (s[..4] == [0x100, 0, 0, 0])) // discard
}

/// How a name is turned into addresses.
pub type Lookup = Arc<
    dyn Fn(String) -> Pin<Box<dyn Future<Output = io::Result<Vec<IpAddr>>> + Send>> + Send + Sync,
>;

/// The system's resolver.
fn system_lookup() -> Lookup {
    Arc::new(|name| {
        Box::pin(async move {
            Ok(tokio::net::lookup_host((name.as_str(), 0))
                .await?
                .map(|a| a.ip())
                .collect())
        })
    })
}

/// A name that resolved somewhere Desk won't fetch from: found in a failed
/// request's error chain, so the refusal says why.
#[derive(Debug)]
struct NotPublic;

impl fmt::Display for NotPublic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(PRIVATE)
    }
}
impl std::error::Error for NotPublic {}

/// reqwest's resolver for every name the fetch connects to, redirects
/// included: a name with any address that isn't allowed is refused whole, and
/// the addresses it gives are the ones connected to, so nothing can resolve
/// one way when checked and another when used.
struct Guarded {
    lookup: Lookup,
    allow: fn(IpAddr) -> bool,
}

impl Resolve for Guarded {
    fn resolve(&self, name: Name) -> Resolving {
        let lookup = self.lookup.clone();
        let allow = self.allow;
        let name = name.as_str().to_string();
        Box::pin(async move {
            let ips = lookup(name).await?;
            if ips.is_empty() {
                return Err(io::Error::new(io::ErrorKind::NotFound, "no address").into());
            }
            if ips.iter().any(|ip| !allow(*ip)) {
                return Err(NotPublic.into());
            }
            // Port 0: the connector puts the address's own port in.
            let addrs: Addrs = Box::new(ips.into_iter().map(|ip| SocketAddr::new(ip, 0)));
            Ok(addrs)
        })
    }
}

/// What a fetch may reach. [`Policy::PUBLIC`] is the only one Desk uses;
/// tests serve their first hop from this computer over plain http.
#[derive(Clone, Copy)]
pub struct Policy {
    pub https_only: bool,
    pub allow: fn(IpAddr) -> bool,
    pub max_bytes: usize,
}

impl Policy {
    pub const PUBLIC: Policy = Policy {
        https_only: true,
        allow: is_public,
        max_bytes: MAX_BYTES,
    };
}

/// Fetches remote pictures under a [`Policy`].
pub struct Fetcher {
    client: reqwest::Client,
    policy: Policy,
}

impl Default for Fetcher {
    fn default() -> Self {
        Fetcher::new(Policy::PUBLIC, system_lookup())
    }
}

impl Fetcher {
    pub fn new(policy: Policy, lookup: Lookup) -> Fetcher {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .https_only(policy.https_only)
            .referer(false)
            .connect_timeout(CONNECT_TIMEOUT)
            .user_agent("Desk")
            .dns_resolver(Arc::new(Guarded {
                lookup,
                allow: policy.allow,
            }))
            .build()
            .expect("an HTTP client");
        Fetcher { client, policy }
    }

    /// Whether `url` may be asked for at all: before the first request and
    /// again before every redirect. A name is checked when it's resolved; an
    /// address in the URL (which no resolver sees) is checked here.
    fn check(&self, url: &Url) -> Result<(), FetchError> {
        match url.scheme() {
            "https" => {}
            "http" if !self.policy.https_only => {}
            _ => return Err(refused(NOT_HTTPS)),
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(refused(
                "Its address has a user name or password in it, so Desk won't fetch it.",
            ));
        }
        match url.host() {
            None => Err(refused("It has no site in its address.")),
            Some(url::Host::Ipv4(ip)) if !(self.policy.allow)(IpAddr::V4(ip)) => {
                Err(refused(PRIVATE))
            }
            Some(url::Host::Ipv6(ip)) if !(self.policy.allow)(IpAddr::V6(ip)) => {
                Err(refused(PRIVATE))
            }
            Some(_) => Ok(()),
        }
    }

    /// The picture at `raw`, following up to [`MAX_REDIRECTS`] redirects.
    pub async fn fetch(&self, raw: &str) -> Result<Image, FetchError> {
        let deadline = Instant::now() + TOTAL_TIMEOUT;
        let mut url = Url::parse(raw.trim()).map_err(|_| refused("That isn't a web address."))?;
        for _ in 0..=MAX_REDIRECTS {
            self.check(&url)?;
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(failed("The site took too long to answer."));
            }
            let mut answer = self
                .client
                .get(url.clone())
                .header(
                    ACCEPT,
                    "image/avif,image/webp,image/png,image/jpeg,image/gif",
                )
                .timeout(left)
                .send()
                .await
                .map_err(why)?;
            let status = answer.status();
            if status.is_redirection() {
                let next = answer
                    .headers()
                    .get(LOCATION)
                    .and_then(|l| l.to_str().ok())
                    .and_then(|l| url.join(l).ok())
                    .ok_or_else(|| failed("The site sent Desk somewhere it couldn't follow."))?;
                url = next;
                continue;
            }
            if status != StatusCode::OK {
                return Err(failed(format!("The site answered {}.", status.as_u16())));
            }
            let too_big = || {
                failed(format!(
                    "It's larger than {} MB.",
                    self.policy.max_bytes / (1024 * 1024)
                ))
            };
            if answer
                .content_length()
                .is_some_and(|n| n > self.policy.max_bytes as u64)
            {
                return Err(too_big());
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = answer.chunk().await.map_err(why)? {
                if bytes.len() + chunk.len() > self.policy.max_bytes {
                    return Err(too_big());
                }
                bytes.extend_from_slice(&chunk);
            }
            let mime = sniff(&bytes).ok_or_else(|| refused(NOT_AN_IMAGE))?;
            return Ok(Image { mime, bytes });
        }
        Err(failed("The site redirected Desk too many times."))
    }
}

/// A failed request in plain words: a refused name says so.
fn why(e: reqwest::Error) -> FetchError {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(&e);
    while let Some(err) = source {
        if err.is::<NotPublic>() {
            return refused(PRIVATE);
        }
        source = err.source();
    }
    if e.is_timeout() {
        failed("The site took too long to answer.")
    } else if e.is_connect() {
        failed("Desk couldn't reach the site.")
    } else {
        failed("The picture didn't arrive.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    /// A policy that lets the test's own server on this computer answer over
    /// plain http, and nothing else that isn't public.
    fn here_and_public(ip: IpAddr) -> bool {
        ip.is_loopback() || is_public(ip)
    }
    const HERE: Policy = Policy {
        https_only: false,
        allow: here_and_public,
        max_bytes: MAX_BYTES,
    };

    /// A lookup that answers `name` with `ips` and counts what it's asked.
    fn lookup(ips: Vec<IpAddr>, asked: Arc<AtomicUsize>) -> Lookup {
        Arc::new(move |_name| {
            asked.fetch_add(1, Ordering::SeqCst);
            let ips = ips.clone();
            Box::pin(async move { Ok(ips) })
        })
    }

    fn never_resolves() -> Lookup {
        Arc::new(|name| Box::pin(async move { panic!("resolved {name}") }))
    }

    /// A server on this computer answering every request with `head` then
    /// `body`, counting the requests.
    async fn server(head: String, body: Vec<u8>) -> (String, Arc<AtomicUsize>) {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", l.local_addr().unwrap());
        let hits = Arc::new(AtomicUsize::new(0));
        let counted = hits.clone();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = l.accept().await {
                counted.fetch_add(1, Ordering::SeqCst);
                let (head, body) = (head.clone(), body.clone());
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = s.read(&mut buf).await;
                    let _ = s.write_all(head.as_bytes()).await;
                    let _ = s.write_all(&body).await;
                });
            }
        });
        (url, hits)
    }

    fn ok_head(mime: &str, length: Option<usize>) -> String {
        let length = length
            .map(|n| format!("content-length: {n}\r\n"))
            .unwrap_or_default();
        format!("HTTP/1.1 200 OK\r\ncontent-type: {mime}\r\n{length}connection: close\r\n\r\n")
    }

    /// A fetcher, made as the app makes one: after rustls has its provider.
    fn fetcher(policy: Policy, lookup: Lookup) -> Fetcher {
        let _ = rustls::crypto::ring::default_provider().install_default();
        Fetcher::new(policy, lookup)
    }

    fn here() -> Fetcher {
        fetcher(HERE, never_resolves())
    }

    #[test]
    fn only_public_addresses_are_allowed() {
        for private in [
            "0.0.0.0",
            "10.1.2.3",
            "100.64.0.1",
            "100.127.255.254",
            "127.0.0.1",
            "127.8.8.8",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.255",
            "192.0.0.8",
            "192.0.2.1",
            "192.168.1.1",
            "198.18.0.1",
            "224.0.0.1",
            "239.255.255.250",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::ffff:169.254.169.254",
            "::127.0.0.1",
            "64:ff9b::a00:1",
            "2002:7f00:1::",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "fec0::1",
            "ff02::1",
            "2001:db8::1",
            "2001:0:4136:e378::1",
        ] {
            assert!(!is_public(private.parse().unwrap()), "{private}");
        }
        for public in [
            "1.1.1.1",
            "8.8.8.8",
            "100.63.255.255",
            "100.128.0.1",
            "172.15.0.1",
            "172.32.0.1",
            "93.184.216.34",
            "2606:4700:4700::1111",
            "2a00:1450:4009:81f::200e",
            "::ffff:8.8.8.8",
            "64:ff9b::808:808",
            "2002:808:808::",
        ] {
            assert!(is_public(public.parse().unwrap()), "{public}");
        }
    }

    #[tokio::test]
    async fn an_address_in_the_url_is_checked_however_it_is_written() {
        let desk = fetcher(Policy::PUBLIC, system_lookup());
        for raw in [
            "https://127.0.0.1/a.png",
            "https://2130706433/a.png",
            "https://0x7f.1/a.png",
            "https://0177.0.0.1/a.png",
            "https://[::1]/a.png",
            "https://[::ffff:127.0.0.1]/a.png",
            "https://[fd00::1]/a.png",
            "https://[fe80::1]/a.png",
            "https://169.254.169.254/latest/meta-data",
            "https://100.64.0.1/a.png",
            "https://10.0.0.1/a.png",
            "https://0.0.0.0/a.png",
        ] {
            assert_eq!(desk.fetch(raw).await, Err(refused(PRIVATE)), "{raw}");
        }
    }

    #[tokio::test]
    async fn a_name_that_resolves_to_this_computer_is_refused_before_connecting() {
        let asked = Arc::new(AtomicUsize::new(0));
        for ips in [
            vec!["127.0.0.1".parse().unwrap()],
            vec!["10.0.0.5".parse().unwrap()],
            // One bad address among good ones refuses the name whole.
            vec!["8.8.8.8".parse().unwrap(), "::1".parse().unwrap()],
        ] {
            // Plain http, so the test needs no TLS: the name is resolved, and
            // refused, before any connection either way.
            let policy = Policy {
                https_only: false,
                ..Policy::PUBLIC
            };
            let desk = fetcher(policy, lookup(ips, asked.clone()));
            assert_eq!(
                desk.fetch("http://pictures.example/a.png").await,
                Err(refused(PRIVATE))
            );
        }
        assert_eq!(asked.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn only_https_and_no_credentials() {
        let desk = fetcher(Policy::PUBLIC, never_resolves());
        for raw in [
            "http://pictures.example/a.png",
            "ftp://pictures.example/a.png",
            "file:///etc/passwd",
            "data:image/png;base64,AAAA",
        ] {
            assert_eq!(desk.fetch(raw).await, Err(refused(NOT_HTTPS)), "{raw}");
        }
        assert!(matches!(
            desk.fetch("https://me:secret@pictures.example/a.png").await,
            Err(FetchError::Refused(_))
        ));
        assert!(matches!(
            desk.fetch("not a url").await,
            Err(FetchError::Refused(_))
        ));
    }

    #[tokio::test]
    async fn a_picture_comes_back_as_its_bytes_say() {
        let (url, _) = server(ok_head("text/html", Some(PNG.len())), PNG.to_vec()).await;
        let image = here().fetch(&format!("{url}/a")).await.unwrap();
        assert_eq!(
            image,
            Image {
                mime: "image/png",
                bytes: PNG.to_vec()
            }
        );
    }

    #[tokio::test]
    async fn a_redirect_to_a_private_address_is_refused_and_never_requested() {
        let (target, target_hits) =
            server(ok_head("image/png", Some(PNG.len())), PNG.to_vec()).await;
        // The first hop is this computer, which the test policy allows; the
        // redirect goes to a private network, which it doesn't.
        let (start, _) = server(
            "HTTP/1.1 302 Found\r\nlocation: http://10.0.0.1/a.png\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".into(),
            vec![],
        )
        .await;
        assert_eq!(
            here().fetch(&format!("{start}/a")).await,
            Err(refused(PRIVATE))
        );
        // A redirect to a name resolving there is refused the same way.
        let asked = Arc::new(AtomicUsize::new(0));
        let (start, _) = server(
            "HTTP/1.1 301 Moved\r\nlocation: http://inside.example/a.png\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".into(),
            vec![],
        )
        .await;
        let desk = fetcher(
            HERE,
            lookup(vec!["192.168.1.10".parse().unwrap()], asked.clone()),
        );
        assert_eq!(
            desk.fetch(&format!("{start}/a")).await,
            Err(refused(PRIVATE))
        );
        assert_eq!(asked.load(Ordering::SeqCst), 1);
        // And a redirect that's allowed is followed.
        let (start, _) = server(
            format!("HTTP/1.1 307 Temporary\r\nlocation: {target}/b.png\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"),
            vec![],
        )
        .await;
        assert_eq!(
            here().fetch(&format!("{start}/a")).await.unwrap().mime,
            "image/png"
        );
        assert_eq!(target_hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn redirects_end() {
        let (start, hits) = server(
            "HTTP/1.1 302 Found\r\nlocation: /again\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".into(),
            vec![],
        )
        .await;
        assert!(matches!(
            here().fetch(&format!("{start}/a")).await,
            Err(FetchError::Failed(_))
        ));
        assert_eq!(hits.load(Ordering::SeqCst), MAX_REDIRECTS + 1);
    }

    #[tokio::test]
    async fn an_oversized_body_is_refused_whether_or_not_it_says_so() {
        let mut big = PNG.to_vec();
        big.resize(MAX_BYTES + 1, 0);
        let (said, _) = server(ok_head("image/png", Some(big.len())), big.clone()).await;
        let (unsaid, _) = server(ok_head("image/png", None), big).await;
        for url in [said, unsaid] {
            let got = here().fetch(&format!("{url}/a")).await;
            assert_eq!(got, Err(failed("It's larger than 10 MB.")), "{url}");
        }
        // Exactly the limit is fine.
        let mut most = PNG.to_vec();
        most.resize(MAX_BYTES, 0);
        let (url, _) = server(ok_head("image/png", None), most).await;
        assert_eq!(
            here().fetch(&format!("{url}/a")).await.unwrap().bytes.len(),
            MAX_BYTES
        );
    }

    #[tokio::test]
    async fn an_svg_or_page_sent_as_a_png_is_refused() {
        for body in [
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>".to_vec(),
            b"<?xml version=\"1.0\"?><svg/>".to_vec(),
            b"<html><body>hi</body></html>".to_vec(),
            Vec::new(),
        ] {
            let (url, _) = server(ok_head("image/png", Some(body.len())), body).await;
            assert_eq!(
                here().fetch(&format!("{url}/a")).await,
                Err(refused(NOT_AN_IMAGE))
            );
        }
    }

    #[tokio::test]
    async fn no_cookie_or_credential_is_sent() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", l.local_addr().unwrap());
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = s.read(&mut buf).await.unwrap();
            let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase());
            let _ = s
                .write_all(ok_head("image/png", Some(PNG.len())).as_bytes())
                .await;
            let _ = s.write_all(PNG).await;
        });
        here().fetch(&format!("{url}/a")).await.unwrap();
        let head = rx.await.unwrap();
        for header in [
            "cookie:",
            "authorization:",
            "referer:",
            "proxy-authorization:",
        ] {
            assert!(!head.contains(header), "{header} in {head}");
        }
    }

    #[tokio::test]
    async fn a_site_that_says_no_is_a_failure_in_plain_words() {
        let (url, _) = server(
            "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".into(),
            vec![],
        )
        .await;
        assert_eq!(
            here().fetch(&format!("{url}/a")).await,
            Err(failed("The site answered 404."))
        );
    }

    #[test]
    fn the_formats_are_told_by_their_bytes() {
        assert_eq!(sniff(PNG), Some("image/png"));
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff(b"GIF89a...."), Some("image/gif"));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff(b"\0\0\0\x1cftypavif\0\0"), Some("image/avif"));
        for not in [
            &b"<svg"[..],
            b"\xEF\xBB\xBF<svg",
            b"BM....",
            b"\0\0\0\x1cftypheic",
            b"RIFF\0\0\0\0WAVE",
            b"",
        ] {
            assert_eq!(sniff(not), None);
        }
    }

    #[test]
    fn errors_reach_the_page_as_kind_and_reason() {
        assert_eq!(
            serde_json::to_string(&refused(PRIVATE)).unwrap(),
            format!(r#"{{"kind":"refused","reason":"{PRIVATE}"}}"#)
        );
    }
}
