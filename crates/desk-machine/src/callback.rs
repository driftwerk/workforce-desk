//! Signing in on a machine as on this computer: the engine's sign-in there
//! (`claude setup-token`, run by the machine's hub) listens on a port of the
//! machine's loopback for its page to come back, and the page is opened
//! here. For the length of one sign-in, that one port is forwarded from
//! this computer's loopback to the machine's, so approving it in the browser
//! here finishes it there, with no code to paste.
//!
//! - Only a page that is Claude's own and comes back to exactly
//!   `http://localhost:{port}/callback` on an unprivileged port is
//!   forwarded ([`direct_port`]); the hub checks the same before Desk sees it.
//! - The forward binds `127.0.0.1:{port}` alone, through its own `ssh` with
//!   Desk's fixed options, and refuses a port something here already holds.
//! - It ends when the sign-in does, when another begins on that machine,
//!   when Desk does, and by itself after `CALLBACK_FOR_SECS` whatever
//!   happens (its command is a `sleep`).
//! - Nothing that passes through it is read: the page's code goes from the
//!   browser to the engine's sign-in inside SSH.

use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

use desk_core::machine::Machine;

use crate::ssh::{self, SshExe};

/// The lowest port a page may come back to.
const LOWEST_PORT: u16 = 1024;
/// How long ssh has to connect and listen.
pub const READY_WITHIN: Duration = Duration::from_secs(20);

/// The hosts a sign-in page may be on.
fn sign_in_host(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if host.contains(['@', ':']) {
        return false;
    }
    ["claude.ai", "anthropic.com", "claude.com"]
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

/// A query value with its `%XX` escapes read.
fn decoded(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
                return None;
            }
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The port `url` comes back to, when it is a sign-in page of Claude's own
/// that comes back to exactly `http://localhost:{port}/callback`, on an
/// unprivileged port; none for anything else.
pub fn direct_port(url: &str) -> Option<u16> {
    if url.len() > 4096 || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    if !sign_in_host(url) {
        return None;
    }
    let query = url.split_once('?')?.1.split('#').next().unwrap_or_default();
    let mut redirects = query
        .split('&')
        .filter_map(|kv| kv.strip_prefix("redirect_uri="));
    let redirect = decoded(redirects.next()?)?;
    if redirects.next().is_some() {
        return None;
    }
    let port: u16 = redirect
        .strip_prefix("http://localhost:")?
        .strip_suffix("/callback")?
        .parse()
        .ok()?;
    (port >= LOWEST_PORT && redirect == format!("http://localhost:{port}/callback")).then_some(port)
}

/// Whether something on this computer already holds `port` on its loopback.
fn taken(port: u16) -> bool {
    TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).is_err()
}

/// One sign-in's forward, while it runs: ended when dropped.
pub struct CallbackForward {
    child: Child,
    port: u16,
}

impl CallbackForward {
    /// Forwards `port` here to `port` on `machine`'s loopback, and waits up
    /// to `wait` for it to listen. Blocking.
    pub fn open(
        ssh: &SshExe,
        machine: &Machine,
        port: u16,
        wait: Duration,
    ) -> Result<Self, String> {
        if port < LOWEST_PORT {
            return Err("That sign-in page can't come back here.".into());
        }
        if cfg!(not(unix)) {
            return Err("Desk reaches machines from macOS and Linux.".into());
        }
        // The forward of the person's config would be carried as well.
        ssh::no_forwards(machine, &ssh::settings(ssh, machine)?)?;
        if taken(port) {
            return Err(format!(
                "Another program on this computer is using port {port}, which the sign-in page comes back to."
            ));
        }
        let mut command = ssh.command(&machine.callback_forward(port));
        command.stdout(Stdio::null()).stderr(Stdio::piped());
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
        let child = command
            .spawn()
            .map_err(|e| format!("Desk couldn't run ssh: {e}"))?;
        let mut forward = Self { child, port };
        let deadline = Instant::now() + wait;
        loop {
            if let Ok(Some(_)) = forward.child.try_wait() {
                let mut said = String::new();
                if let Some(mut err) = forward.child.stderr.take() {
                    use std::io::Read;
                    let _ = err.read_to_string(&mut said);
                }
                return Err(ssh::problem(machine, said.as_bytes()));
            }
            // Listening once this computer can't take the port itself:
            // nothing is sent through it to find out.
            if taken(port) {
                tracing::info!(machine = %machine.name, port, "a sign-in's page can come back");
                return Ok(forward);
            }
            if Instant::now() > deadline {
                return Err(format!(
                    "Desk couldn't connect to {} in time.",
                    machine.name
                ));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Whether it still runs.
    pub fn running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

impl Drop for CallbackForward {
    fn drop(&mut self) {
        if !self.running() {
            return;
        }
        #[cfg(unix)]
        {
            let pid = self.child.id();
            if let Ok(pid) = libc::pid_t::try_from(pid)
                && pid > 1
                // SAFETY: getpgid and kill have no memory preconditions.
                && unsafe { libc::getpgid(pid) } == pid
            {
                unsafe { libc::kill(-pid, libc::SIGTERM) };
            }
        }
        let until = Instant::now() + Duration::from_secs(2);
        while Instant::now() < until && self.running() {
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
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
            format!(
                "{}&redirect_uri=http%3A%2F%2Flocalhost%3A2000%2Fcallback",
                page("http%3A%2F%2Flocalhost%3A34503%2Fcallback")
            ),
            "https://claude.com.evil.example/a?redirect_uri=http%3A%2F%2Flocalhost%3A34503%2Fcallback".into(),
            "https://user@claude.ai/a?redirect_uri=http%3A%2F%2Flocalhost%3A34503%2Fcallback".into(),
            "http://claude.ai/a?redirect_uri=http%3A%2F%2Flocalhost%3A34503%2Fcallback".into(),
            "https://claude.ai/a b?redirect_uri=http%3A%2F%2Flocalhost%3A34503%2Fcallback".into(),
        ] {
            assert_eq!(direct_port(&bad), None, "{bad}");
        }
    }
}
