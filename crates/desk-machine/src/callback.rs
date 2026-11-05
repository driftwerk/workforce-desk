//! Signing in on a machine as on this computer: the engine's sign-in there
//! (`claude setup-token`, run by the machine's hub) listens on a port of the
//! machine's loopback for its page to come back, and the page is opened
//! here. For the length of one sign-in, Desk itself listens on that one port
//! of this computer's loopback and carries each connection to the same port
//! on the machine's loopback, so approving it in the browser here finishes
//! it there, with no code to paste.
//!
//! - Only a page that is Claude's own and comes back to exactly
//!   `http://localhost:{port}/callback` on an unprivileged port is
//!   carried ([`direct_port`]), read as a browser reads it; the hub checks
//!   the same before Desk sees it. Every page Desk opens for a machine is
//!   checked by [`sign_in_page`].
//! - Desk binds `127.0.0.1:{port}` and `[::1]:{port}` itself, without
//!   `SO_REUSEADDR`, so it never shares a port with anything already on
//!   this computer (a service on `0.0.0.0:{port}` included): if either is
//!   taken, nothing is forwarded.
//! - Each connection goes to the machine through an `ssh -W` of its own,
//!   with Desk's fixed options: nothing listens anywhere else, and the
//!   person's config forwards nothing alongside it.
//! - It ends when dropped: when the sign-in does, when another begins on
//!   that machine, when Desk quits, or after `CALLBACK_FOR_SECS`.
//! - Nothing that passes through it is read or logged: the page's code goes
//!   from the browser to the engine's sign-in inside SSH.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use desk_core::machine::Machine;

use crate::ssh::SshExe;

/// The lowest port a page may come back to.
const LOWEST_PORT: u16 = 1024;
/// The most connections carried at once for one sign-in: a browser makes
/// one or two. More are closed rather than given an `ssh` each.
pub const MAX_CARRIED: usize = 8;
/// How often the listener looks for a new connection, or for its end.
const ACCEPT_EVERY: Duration = Duration::from_millis(50);

/// A sign-in page Desk opens: on exactly this host, at exactly one of these
/// paths, with a query only when `query` says so.
pub struct SignInPage {
    pub host: &'static str,
    pub paths: &'static [&'static str],
    pub query: bool,
}

/// The paths Claude Code's sign-in page is at (`claude setup-token` 2.1.318
/// shows `https://claude.com/cai/oauth/authorize?…`; earlier ones
/// `https://claude.ai/oauth/authorize?…`).
const CLAUDE_PATHS: &[&str] = &["/oauth/authorize", "/cai/oauth/authorize"];

/// Claude's sign-in pages: nothing else on its domains (a page someone
/// published there) is ever opened for a machine.
pub const CLAUDE_PAGES: &[SignInPage] = &[
    SignInPage {
        host: "claude.ai",
        paths: CLAUDE_PATHS,
        query: true,
    },
    SignInPage {
        host: "claude.com",
        paths: CLAUDE_PATHS,
        query: true,
    },
    SignInPage {
        host: "platform.claude.com",
        paths: CLAUDE_PATHS,
        query: true,
    },
];

/// Codex's device page: exactly `https://auth.openai.com/codex/device`.
pub const CODEX_PAGES: &[SignInPage] = &[SignInPage {
    host: "auth.openai.com",
    paths: &["/codex/device"],
    query: false,
}];

/// `said` as one of `pages`, read as a browser reads it (so a `\`, an `@`,
/// an escape or a `..` can't move its host or path): https, no user,
/// password, port or fragment, on exactly its host and path. None for
/// anything else.
pub fn sign_in_page(said: &str, pages: &[SignInPage]) -> Option<url::Url> {
    if said.len() > 4096 || said.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let page = url::Url::parse(said).ok()?;
    if page.scheme() != "https"
        || !page.username().is_empty()
        || page.password().is_some()
        || page.port().is_some()
        || page.fragment().is_some()
    {
        return None;
    }
    let Some(url::Host::Domain(host)) = page.host() else {
        return None;
    };
    let host = host.to_ascii_lowercase();
    pages
        .iter()
        .any(|p| {
            host == p.host && p.paths.contains(&page.path()) && (p.query || page.query().is_none())
        })
        .then_some(page)
}

/// The port `url` comes back to, when it is a sign-in page of Claude's own
/// that comes back to exactly `http://localhost:{port}/callback`, on an
/// unprivileged port; none for anything else.
pub fn direct_port(url: &str) -> Option<u16> {
    let page = sign_in_page(url, CLAUDE_PAGES)?;
    let mut redirects = page.query_pairs().filter(|(k, _)| k == "redirect_uri");
    let (_, redirect) = redirects.next()?;
    if redirects.next().is_some() {
        return None;
    }
    let back = url::Url::parse(&redirect).ok()?;
    let port = back.port()?;
    let exact = back.scheme() == "http"
        && back.host() == Some(url::Host::Domain("localhost"))
        && back.path() == "/callback"
        && back.query().is_none()
        && back.fragment().is_none()
        && back.username().is_empty()
        && back.password().is_none()
        && redirect == format!("http://localhost:{port}/callback");
    (exact && port >= LOWEST_PORT).then_some(port)
}

/// A listener on `at` that shares its port with nothing: no `SO_REUSEADDR`
/// (nor `SO_REUSEPORT`), and IPv6 alone on an IPv6 socket.
fn bind_alone(at: SocketAddr) -> std::io::Result<TcpListener> {
    use socket2::{Domain, Socket, Type};
    let domain = if at.is_ipv6() {
        Domain::IPV6
    } else {
        Domain::IPV4
    };
    let socket = Socket::new(domain, Type::STREAM, None)?;
    socket.set_reuse_address(false)?;
    if at.is_ipv6() {
        socket.set_only_v6(true)?;
    }
    socket.bind(&at.into())?;
    socket.listen(16)?;
    socket.set_nonblocking(true)?;
    Ok(socket.into())
}

/// Whether binding failed because this computer has no IPv6 loopback, which
/// leaves nothing to take there.
fn no_ipv6(e: &std::io::Error) -> bool {
    #[cfg(unix)]
    if matches!(
        e.raw_os_error(),
        Some(libc::EADDRNOTAVAIL | libc::EAFNOSUPPORT | libc::EPROTONOSUPPORT)
    ) {
        return true;
    }
    e.kind() == std::io::ErrorKind::AddrNotAvailable
}

/// One sign-in's callback port while it runs: ended when dropped.
pub struct CallbackForward {
    port: u16,
    stop: Arc<AtomicBool>,
    /// Each connection's `ssh -W`, to end with it.
    carriers: Arc<Mutex<Vec<Child>>>,
}

impl CallbackForward {
    /// Listens on `port` of this computer's loopback, IPv4 and IPv6, and
    /// carries each connection to `port` on `machine`'s loopback.
    pub fn open(ssh: &SshExe, machine: &Machine, port: u16) -> Result<Self, String> {
        if port < LOWEST_PORT {
            return Err("That sign-in page can't come back here.".into());
        }
        if cfg!(not(unix)) {
            return Err("Desk reaches machines from macOS and Linux.".into());
        }
        let taken = || {
            format!(
                "Another program on this computer is using port {port}, which the sign-in page comes back to."
            )
        };
        let v4 = bind_alone(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).map_err(|_| taken())?;
        let v6 = match bind_alone(SocketAddr::from((Ipv6Addr::LOCALHOST, port))) {
            Ok(l) => Some(l),
            Err(e) if no_ipv6(&e) => None,
            Err(_) => return Err(taken()),
        };
        let forward = Self {
            port,
            stop: Arc::new(AtomicBool::new(false)),
            carriers: Arc::default(),
        };
        let listeners: Vec<TcpListener> = std::iter::once(v4).chain(v6).collect();
        let (stop, carriers) = (Arc::clone(&forward.stop), Arc::clone(&forward.carriers));
        let (ssh, machine) = (ssh.clone(), machine.clone());
        std::thread::Builder::new()
            .name(format!("sign-in callback for {}", machine.name))
            .spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    let mut idle = true;
                    for l in &listeners {
                        if let Ok((browser, _)) = l.accept() {
                            idle = false;
                            carry(&ssh, &machine, port, browser, &carriers);
                        }
                    }
                    if idle {
                        std::thread::sleep(ACCEPT_EVERY);
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        tracing::info!(port, "a sign-in's page can come back");
        Ok(forward)
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

/// Carries one connection to the machine's `port` through an `ssh -W` of
/// its own. What passes is never read.
fn carry(
    ssh: &SshExe,
    machine: &Machine,
    port: u16,
    browser: TcpStream,
    carriers: &Mutex<Vec<Child>>,
) {
    {
        let mut held = carriers.lock().unwrap_or_else(|e| e.into_inner());
        held.retain_mut(|c| matches!(c.try_wait(), Ok(None)));
        if held.len() >= MAX_CARRIED {
            // Closed: no `ssh` for it.
            let _ = browser.shutdown(std::net::Shutdown::Both);
            return;
        }
    }
    let _ = browser.set_nonblocking(false);
    let mut command = ssh.command(&machine.stdio_forward(port));
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            command.pre_exec(|| {
                libc::setpgid(0, 0);
                #[cfg(target_os = "linux")]
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
                Ok(())
            });
        }
    }
    let Ok(mut child) = command.spawn() else {
        return;
    };
    let (Some(mut to_machine), Some(mut from_machine)) = (child.stdin.take(), child.stdout.take())
    else {
        let _ = child.kill();
        let _ = child.wait();
        return;
    };
    let Ok(mut up) = browser.try_clone() else {
        let _ = child.kill();
        let _ = child.wait();
        return;
    };
    let mut down = browser;
    {
        let mut held = carriers.lock().unwrap_or_else(|e| e.into_inner());
        // Ended ones are let go.
        held.retain_mut(|c| matches!(c.try_wait(), Ok(None)));
        held.push(child);
    }
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        while let Ok(n) = up.read(&mut buf) {
            if n == 0 || to_machine.write_all(&buf[..n]).is_err() {
                break;
            }
        }
        // Closing ssh's input ends its side of the channel.
    });
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut from_machine, &mut down);
        let _ = down.shutdown(std::net::Shutdown::Both);
    });
}

/// Ends `child` and the process group it leads.
fn end(child: &mut Child) {
    if !matches!(child.try_wait(), Ok(None)) {
        return;
    }
    #[cfg(unix)]
    if let Ok(pid) = libc::pid_t::try_from(child.id())
        && pid > 1
        // SAFETY: getpgid and kill have no memory preconditions.
        && unsafe { libc::getpgid(pid) } == pid
    {
        unsafe { libc::kill(-pid, libc::SIGTERM) };
    }
    let _ = child.kill();
    let _ = child.wait();
}

impl Drop for CallbackForward {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let mut held = self.carriers.lock().unwrap_or_else(|e| e.into_inner());
        held.iter_mut().for_each(end);
        held.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(redirect: &str) -> String {
        format!(
            "https://claude.com/cai/oauth/authorize?code=true&client_id=c&response_type=code&redirect_uri={redirect}&scope=user%3Ainference&state=s"
        )
    }

    #[test]
    fn only_a_claude_page_coming_back_to_a_localhost_callback_is_forwarded() {
        assert_eq!(
            direct_port(&page("http%3A%2F%2Flocalhost%3A34503%2Fcallback")),
            Some(34503)
        );
        for bad in [
            page("https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback"),
            page("http%3A%2F%2Fevil.example%3A34503%2Fcallback"),
            page("http%3A%2F%2Flocalhost%3A22%2Fcallback"),
            page("http%3A%2F%2Flocalhost%3A70000%2Fcallback"),
            page("http%3A%2F%2Flocalhost%3A34503%2Fcallback%2Fmore"),
            page("http%3A%2F%2Flocalhost%3A%2B34503%2Fcallback"),
            page("http%3A%2F%2F127.0.0.1%3A34503%2Fcallback"),
            page("http%3A%2F%2Flocalhost%3A34503%2Fcallback%3Fx%3D1"),
            format!(
                "{}&redirect_uri=http%3A%2F%2Flocalhost%3A2000%2Fcallback",
                page("http%3A%2F%2Flocalhost%3A34503%2Fcallback")
            ),
            "https://claude.com.evil.example/a?redirect_uri=http%3A%2F%2Flocalhost%3A34503%2Fcallback".into(),
            "https://claude.ai/public/artifacts/x?redirect_uri=http%3A%2F%2Flocalhost%3A34503%2Fcallback".into(),
            "https://user@claude.ai/a?redirect_uri=http%3A%2F%2Flocalhost%3A34503%2Fcallback".into(),
            "https://evil.example\\@claude.ai/a?redirect_uri=http%3A%2F%2Flocalhost%3A34503%2Fcallback".into(),
            "https://evil.example\\.claude.ai/a?redirect_uri=http%3A%2F%2Flocalhost%3A34503%2Fcallback".into(),
            "https://claude.ai:8443/a?redirect_uri=http%3A%2F%2Flocalhost%3A34503%2Fcallback".into(),
            "http://claude.ai/a?redirect_uri=http%3A%2F%2Flocalhost%3A34503%2Fcallback".into(),
            "https://claude.ai/a b?redirect_uri=http%3A%2F%2Flocalhost%3A34503%2Fcallback".into(),
        ] {
            assert_eq!(direct_port(&bad), None, "{bad}");
        }
    }

    #[test]
    fn a_machines_page_is_opened_only_on_its_engines_own_hosts() {
        assert!(sign_in_page("https://auth.openai.com/codex/device", CODEX_PAGES).is_some());
        assert!(
            sign_in_page(
                "https://claude.com/cai/oauth/authorize?code=true",
                CLAUDE_PAGES
            )
            .is_some()
        );
        assert!(
            sign_in_page(
                "https://platform.claude.com/oauth/authorize?code=true",
                CLAUDE_PAGES
            )
            .is_some()
        );
        assert!(
            sign_in_page("https://claude.ai/oauth/authorize?code=true", CLAUDE_PAGES).is_some()
        );
        for (bad, hosts) in [
            ("https://auth.openai.com/codex/device", CLAUDE_PAGES),
            ("https://claude.ai/oauth", CODEX_PAGES),
            (
                "https://evil.example\\@auth.openai.com/codex/device",
                CODEX_PAGES,
            ),
            (
                "https://auth.openai.com.evil.example/codex/device",
                CODEX_PAGES,
            ),
            ("https://platform.openai.com/codex/device", CODEX_PAGES),
            ("http://auth.openai.com/codex/device", CODEX_PAGES),
            ("javascript:alert(1)", CODEX_PAGES),
            ("file:///etc/passwd", CLAUDE_PAGES),
            ("https://auth.openai.com:444/codex/device", CODEX_PAGES),
            // Pages someone published on the engines' own domains.
            ("https://claude.ai/public/artifacts/abc", CLAUDE_PAGES),
            ("https://chatgpt.com/share/abc", CODEX_PAGES),
            ("https://auth.openai.com/codex/device?next=x", CODEX_PAGES),
            ("https://auth.openai.com/codex/device#x", CODEX_PAGES),
            (
                "https://claude.com/cai/oauth/authorize/../../public/x",
                CLAUDE_PAGES,
            ),
            ("https://www.claude.ai/oauth/authorize", CLAUDE_PAGES),
            ("https://claude.ai/oauth/code/callback", CLAUDE_PAGES),
        ] {
            assert!(sign_in_page(bad, hosts).is_none(), "{bad}");
        }
    }

    // Desk forwards from macOS and Linux only (Windows lets a port be taken
    // over another way, and refuses this outright: see `open`).
    #[cfg(unix)]
    #[test]
    fn a_port_something_here_holds_even_on_every_address_is_never_shared() {
        // A service on 0.0.0.0, which allows its port to be shared.
        let service = {
            use socket2::{Domain, Socket, Type};
            let s = Socket::new(Domain::IPV4, Type::STREAM, None).unwrap();
            s.set_reuse_address(true).unwrap();
            s.bind(&SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)).into())
                .unwrap();
            s.listen(1).unwrap();
            TcpListener::from(s)
        };
        let port = service.local_addr().unwrap().port();
        assert!(bind_alone(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).is_err());
        // And a port held on IPv6 loopback alone.
        if let Ok(v6) = TcpListener::bind((Ipv6Addr::LOCALHOST, 0)) {
            let port = v6.local_addr().unwrap().port();
            if bind_alone(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).is_ok() {
                assert!(bind_alone(SocketAddr::from((Ipv6Addr::LOCALHOST, port))).is_err());
            }
        }
    }
}
