//! A link a program prints in a terminal, clicked (`open_terminal_link`):
//! decided and asked about here, not by the page. Claude's and OpenAI's
//! sign-in pages open at once; any other web page only after a native
//! question showing the address it really goes to (an OSC 8 link's text can
//! say anything); this computer's own and its network's addresses, and
//! anything not http(s), never open.

use std::net::IpAddr;

use url::{Host, Url};

use crate::CommandResult;

/// The sign-in pages Claude Code and Codex print.
const SIGN_IN_HOSTS: [&str; 5] = [
    "claude.ai",
    "claude.com",
    "anthropic.com",
    "openai.com",
    "chatgpt.com",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Link {
    Open(Url),
    Ask(Url),
    Refuse,
}

fn private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let [a, b, ..] = v.octets();
            v.is_loopback()
                || v.is_private()
                || v.is_link_local()
                || v.is_unspecified()
                || v.is_broadcast()
                || (a == 100 && (64..=127).contains(&b))
        }
        IpAddr::V6(v) => {
            if let Some(v4) = v.to_ipv4_mapped() {
                return private_ip(IpAddr::V4(v4));
            }
            let seg = v.segments();
            // `::a.b.c.d` (IPv4-compatible) and NAT64's `64:ff9b::a.b.c.d`
            // carry an IPv4 address: as private as it is.
            let embedded = |s: &[u16]| {
                std::net::Ipv4Addr::new(
                    (s[6] >> 8) as u8,
                    s[6] as u8,
                    (s[7] >> 8) as u8,
                    s[7] as u8,
                )
            };
            if seg[..6] == [0; 6] && !v.is_loopback() && !v.is_unspecified() {
                return private_ip(IpAddr::V4(embedded(&seg)));
            }
            if seg[..6] == [0x64, 0xff9b, 0, 0, 0, 0] || seg[..2] == [0x64, 0xff9b] {
                return true;
            }
            let first = seg[0];
            v.is_loopback()
                || v.is_unspecified()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
        }
    }
}

/// The link question's own back-off: after a No, none for 10 s, doubling
/// with each No in a row, up to 15 minutes.
static QUESTION: Asked = Asked::with_quiet(std::time::Duration::from_secs(10));

struct AskState {
    open: bool,
    nos: u32,
    quiet_until: Option<std::time::Instant>,
}

pub struct Asked {
    state: std::sync::Mutex<AskState>,
    quiet: std::time::Duration,
}

pub struct Asking<'a>(&'a Asked);

impl Asked {
    pub const fn with_quiet(quiet: std::time::Duration) -> Self {
        Self {
            state: std::sync::Mutex::new(AskState {
                open: false,
                nos: 0,
                quiet_until: None,
            }),
            quiet,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, AskState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn start(&self) -> Result<Asking<'_>, String> {
        let mut st = self.lock();
        if st.open {
            return Err("Desk is already asking about a link.".into());
        }
        if st
            .quiet_until
            .is_some_and(|u| u > std::time::Instant::now())
        {
            return Err("You said no to a link a moment ago: try again in a little while.".into());
        }
        st.open = true;
        Ok(Asking(self))
    }

    pub fn answered(&self, yes: bool) {
        let mut st = self.lock();
        if yes {
            st.nos = 0;
            st.quiet_until = None;
        } else {
            st.nos = st.nos.saturating_add(1);
            let wait = self
                .quiet
                .saturating_mul(1 << (st.nos - 1).min(16))
                .min(std::time::Duration::from_secs(15 * 60));
            st.quiet_until = Some(std::time::Instant::now() + wait);
        }
    }
}

impl Drop for Asking<'_> {
    fn drop(&mut self) {
        self.0.lock().open = false;
    }
}

/// What clicking `link` does.
pub fn decide(link: &str) -> Link {
    let Ok(url) = Url::parse(link) else {
        return Link::Refuse;
    };
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Link::Refuse;
    }
    let name = match url.host() {
        // A trailing dot names the same host (`localhost.`, `printer.local.`).
        Some(Host::Domain(d)) => d.trim_end_matches('.').to_ascii_lowercase(),
        Some(Host::Ipv4(ip)) => {
            return if private_ip(IpAddr::V4(ip)) {
                Link::Refuse
            } else {
                Link::Ask(url)
            };
        }
        Some(Host::Ipv6(ip)) => {
            return if private_ip(IpAddr::V6(ip)) {
                Link::Refuse
            } else {
                Link::Ask(url)
            };
        }
        None => return Link::Refuse,
    };
    let local = name == "localhost"
        || [".localhost", ".local", ".internal", ".lan", ".home.arpa"]
            .iter()
            .any(|s| name.ends_with(s))
        || !name.contains('.');
    if local {
        return Link::Refuse;
    }
    let sign_in = SIGN_IN_HOSTS
        .iter()
        .any(|h| name == *h || name.ends_with(&format!(".{h}")));
    if url.scheme() == "https" && sign_in {
        Link::Open(url)
    } else {
        Link::Ask(url)
    }
}

/// Opens `url`, a link clicked in a terminal, as [`decide`] says: at once,
/// after the person's yes to a native question naming its real address, or
/// not at all. True when it opened.
#[tauri::command]
pub async fn open_terminal_link(app: tauri::AppHandle, url: String) -> CommandResult<bool> {
    use tauri_plugin_opener::OpenerExt;
    let url = match decide(&url) {
        Link::Refuse => return Ok(false),
        Link::Open(u) => u,
        Link::Ask(u) => {
            // One question at a time, and none for a while after a No, so a
            // program printing links can't stream dialogs.
            let _asking = QUESTION.start()?;
            let confirm = crate::pair_gate::NativeConfirm(app.clone());
            let text = format!(
                "A program in a terminal links to:\n\n{}\n\nOpen it in your browser?",
                u.as_str()
            );
            let yes = tauri::async_runtime::spawn_blocking(move || {
                confirm.ask("Open this page?", text, "Open")
            })
            .await
            .unwrap_or(false);
            QUESTION.answered(yes);
            if !yes {
                return Ok(false);
            }
            u
        }
    };
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_claudes_and_openais_sign_in_pages_open_at_once() {
        for page in [
            "https://claude.ai/oauth/authorize?x=1",
            "https://auth.openai.com/codex/device",
            "https://console.anthropic.com/x",
            "https://claude.com/cai/oauth/authorize?code=true",
        ] {
            assert!(matches!(decide(page), Link::Open(_)), "{page}");
        }
        for asked in [
            "https://claude.ai.evil.example/x",
            "http://claude.ai/x",
            "https://example.com/claude.ai",
            "https://8.8.8.8/",
        ] {
            assert!(matches!(decide(asked), Link::Ask(_)), "{asked}");
        }
        assert_eq!(
            decide("https://example.com/page"),
            Link::Ask(Url::parse("https://example.com/page").unwrap())
        );
    }

    #[test]
    fn a_no_quietens_the_question_for_a_while_and_a_yes_clears_it() {
        let q = Asked::with_quiet(std::time::Duration::from_secs(60));
        let open = q.start().ok().unwrap();
        assert!(q.start().err().unwrap().contains("already asking"));
        q.answered(false);
        drop(open);
        assert!(q.start().err().unwrap().contains("a moment ago"));
        q.answered(true);
        assert!(q.start().is_ok());
    }

    #[test]
    fn local_and_odd_links_never_open() {
        for refused in [
            "http://localhost:3000/",
            "http://127.0.0.1:8080/api",
            "http://[::1]/",
            "http://10.0.3.14/",
            "http://192.168.1.1/",
            "http://172.20.0.2/",
            "http://169.254.169.254/latest/meta-data",
            "http://100.64.0.1/",
            "http://[fd00::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[::127.0.0.1]/",
            "http://[::10.0.0.1]/",
            "http://[64:ff9b::7f00:1]/",
            "http://localhost./",
            "http://printer.local./",
            "http://devbox./",
            "http://devbox/",
            "http://printer.local/",
            "https://user:pw@claude.ai/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ssh://devbox",
            "not a link",
        ] {
            assert_eq!(decide(refused), Link::Refuse, "{refused}");
        }
    }
}
