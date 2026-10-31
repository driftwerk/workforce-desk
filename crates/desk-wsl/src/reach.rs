//! Whether Windows reaches the hub inside WSL. WSL forwards ports bound to
//! the VM's loopback to Windows' (NAT mode) or shares loopback (mirrored
//! mode); either can be turned off, and a firewall can stand between.

use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use desk_core::host::{Host, Wsl};
use serde::Serialize;

use crate::install::quote;
use crate::run::WslExe;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reach {
    Ready,
    /// The hub isn't answering yet, inside WSL either.
    Starting,
    /// It answers inside WSL, but Windows can't get to it.
    PortUnreachable,
}

/// From where it stands on each side.
pub fn reach(from_windows: bool, from_wsl: bool) -> Reach {
    match (from_windows, from_wsl) {
        (true, _) => Reach::Ready,
        (false, true) => Reach::PortUnreachable,
        (false, false) => Reach::Starting,
    }
}

/// Whether something accepts a connection at `url`'s host and port: any
/// answer there means the port is reached.
pub fn connects(url: &str) -> bool {
    let address = url
        .split("://")
        .nth(1)
        .unwrap_or(url)
        .split('/')
        .next()
        .unwrap_or("");
    address
        .to_socket_addrs()
        .ok()
        .and_then(|mut a| a.next())
        .is_some_and(|a| TcpStream::connect_timeout(&a, Duration::from_secs(2)).is_ok())
}

/// Asks curl inside WSL for `url`; it prints `000` when nothing answers.
pub fn wsl_script(url: &str) -> String {
    format!(
        "curl -s -o /dev/null -m 5 -w '%{{http_code}}' {}",
        quote(url)
    )
}

/// Whether curl's answer is an HTTP status.
pub fn answered(said: &str) -> bool {
    let code = said.trim();
    code.len() == 3 && code.chars().all(|c| c.is_ascii_digit()) && code != "000"
}

/// Where the hub at `url` stands, from Windows and from inside `w`.
pub fn check(wsl: &WslExe, w: &Wsl, url: &str) -> Reach {
    if connects(url) {
        return Reach::Ready;
    }
    let inside = wsl
        .answer(&Host::Wsl(w.clone()).login_invocation(&wsl_script(url)))
        .is_ok_and(|said| answered(&said));
    reach(false, inside)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_reaching_it_is_enough_and_wsl_alone_is_a_port_problem() {
        assert_eq!(reach(true, false), Reach::Ready);
        assert_eq!(reach(false, true), Reach::PortUnreachable);
        assert_eq!(reach(false, false), Reach::Starting);
    }

    #[test]
    fn any_http_status_means_curl_reached_it() {
        assert!(answered("401"));
        assert!(answered("200\n"));
        assert!(!answered("000"));
        assert!(!answered("curl: not found"));
        assert_eq!(
            wsl_script("http://127.0.0.1:50412"),
            "curl -s -o /dev/null -m 5 -w '%{http_code}' 'http://127.0.0.1:50412'"
        );
    }

    #[test]
    fn a_listening_port_connects_and_a_closed_one_doesnt() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(connects(&format!("http://127.0.0.1:{port}")));
        // Not the port just let go: another connection can take it, or on
        // Linux the probe can connect to itself. Nothing listens on port 1.
        assert!(!connects("http://127.0.0.1:1"));
    }
}
