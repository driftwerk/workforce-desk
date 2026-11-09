//! Finding out why an installer's download failed. Both installers hide the
//! reason behind one line ("Download failed"), so after such a failure a
//! short probe runs where the installer ran: a 1 MB slice of what it
//! downloads, and the free space in the home folder.

use super::Plan;

/// About what the Claude Code binary needs once downloaded and unpacked.
const NEEDED_KB: u64 = 300 * 1024;
/// Below this, a transfer that did start counts as stalled.
const SLOW_BYTES_PER_SEC: f64 = 50.0 * 1024.0;

/// Where a plan's installer downloads from, and a shell snippet that sets
/// `$url` to a file there worth fetching a slice of.
pub struct Target {
    pub host: &'static str,
    prelude: &'static str,
}

impl Plan {
    pub fn target(self) -> Target {
        match self {
            // The platform is worked out the way Anthropic's script does;
            // when `latest` can't be read, `latest` itself is probed and
            // shows the same failure.
            Plan::Claude => Target {
                host: "downloads.claude.ai",
                prelude: r#"base=https://downloads.claude.ai/claude-code-releases
arch=$(uname -m)
case "$arch" in x86_64|amd64) arch=x64;; arm64|aarch64) arch=arm64;; esac
if [ "$(uname -s)" = Darwin ]; then plat=darwin-$arch; else
  plat=linux-$arch
  if [ -f /lib/libc.musl-x86_64.so.1 ] || [ -f /lib/libc.musl-aarch64.so.1 ] || $t ldd /bin/ls 2>&1 | grep -q musl; then plat=$plat-musl; fi
fi
url=$base/latest
v=$(curl -fsSL --max-time 15 "$url" 2>/dev/null) && [ -n "$v" ] && url=$base/$v/$plat/claude"#,
            },
            // No binary URL is known here: the install script itself shows
            // whether the network and the host answer.
            Plan::Chatgpt => Target {
                host: "chatgpt.com",
                prelude: "url=https://chatgpt.com/codex/install.sh",
            },
        }
    }
}

impl Target {
    pub fn script(&self) -> String {
        format!(
            r#"t=; command -v timeout >/dev/null 2>&1 && t="timeout 10"
{}
out=$(curl -sS -o /dev/null -w '\nSTATS %{{http_code}} %{{size_download}} %{{speed_download}}' --max-time 20 -r 0-1048575 "$url" 2>&1)
echo "RC $?"
printf '%s\n' "$out"
echo "FREE $($t df -Pk "$HOME" 2>/dev/null | awk 'NR==2{{print $4}}')"
echo "HOME $HOME"
"#,
            self.prelude
        )
    }
}

/// The script as one line of plain characters that runs it in bash, so it
/// reaches a shell the same way whatever quoting `wsl.exe` or a Windows
/// command line would do to newlines and quotes.
pub fn wrapped(script: &str) -> String {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(script);
    format!("echo {b64} | base64 -d | bash")
}

/// Whether an installer's last line is about fetching its download, so the
/// probe is worth running.
pub fn is_download_failure(last: &str) -> bool {
    let l = last.to_lowercase();
    // Anthropic's installer says these two; curl itself says the third.
    ["download failed", "checksum verification failed", "curl: ("]
        .iter()
        .any(|s| l.contains(s))
}

#[derive(Debug, Default, PartialEq)]
pub struct Probe {
    pub curl_exit: Option<i32>,
    pub http: Option<u16>,
    pub bytes: u64,
    pub speed: f64,
    pub curl_error: String,
    pub free_kb: Option<u64>,
    pub home: String,
}

pub fn parse(output: &str) -> Probe {
    let mut p = Probe::default();
    for line in output.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("RC ") {
            p.curl_exit = v.trim().parse().ok();
        } else if let Some(v) = line.strip_prefix("STATS ") {
            let mut w = v.split_whitespace();
            p.http = w.next().and_then(|h| h.parse().ok()).filter(|h| *h != 0);
            p.bytes = w.next().and_then(|b| b.parse().ok()).unwrap_or(0);
            p.speed = w
                .next()
                .and_then(|s| s.replace(',', ".").parse().ok())
                .unwrap_or(0.0);
        } else if let Some(v) = line.strip_prefix("FREE ") {
            p.free_kb = v.trim().parse().ok();
        } else if let Some(v) = line.strip_prefix("HOME ") {
            p.home = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("curl:") {
            // "curl: (6) Could not resolve host: x" without the code.
            let v = v.trim();
            p.curl_error = match v.strip_prefix('(').and_then(|r| r.split_once(')')) {
                Some((_, rest)) => rest.trim().to_string(),
                None => v.to_string(),
            };
        }
    }
    p
}

#[derive(Debug, PartialEq)]
pub enum Diagnosis {
    /// Said plainly: the install can't work until this changes.
    Cause(String),
    /// The slice downloaded fine: whatever failed may not fail again.
    Healthy,
    /// The probe shows nothing; the installer's own line stands.
    Unknown,
}

fn size(kb: u64) -> String {
    if kb >= 1024 * 1024 {
        format!("{:.1} GB", kb as f64 / (1024.0 * 1024.0))
    } else {
        format!("{} MB", kb / 1024)
    }
}

pub fn diagnose(p: &Probe, host: &str) -> Diagnosis {
    if let Some(free) = p.free_kb.filter(|f| *f < NEEDED_KB) {
        let home = if p.home.is_empty() {
            "your home folder"
        } else {
            &p.home
        };
        return Diagnosis::Cause(format!(
            "Not enough disk space in {home}: {} free, about {} needed.",
            size(free),
            size(NEEDED_KB)
        ));
    }
    if let Some(http) = p.http.filter(|h| *h >= 400) {
        return Diagnosis::Cause(match http {
            403 | 407 | 451 => format!(
                "The download is blocked (HTTP {http}). A firewall or proxy may be in the way."
            ),
            _ => format!("The download server answered HTTP {http}."),
        });
    }
    let moving = p.bytes > 0 && p.speed >= SLOW_BYTES_PER_SEC;
    match p.curl_exit {
        Some(0) if p.http.is_some() && (moving || p.bytes >= 1024 * 1024) => Diagnosis::Healthy,
        Some(0) => Diagnosis::Cause("The download stalled. On a VPN, try with it off.".into()),
        // A timeout while bytes were flowing is only a slow link at the time.
        Some(28) if moving => Diagnosis::Healthy,
        Some(28) => Diagnosis::Cause("The download stalled. On a VPN, try with it off.".into()),
        Some(c) if c != 0 && !p.curl_error.is_empty() => {
            Diagnosis::Cause(format!("Couldn't reach {host}: {}", p.curl_error))
        }
        _ => Diagnosis::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "downloads.claude.ai";

    fn out(rc: i32, extra: &str, stats: &str, free: &str) -> String {
        format!("RC {rc}\n{extra}\nSTATS {stats}\nFREE {free}\nHOME /home/sarah\n")
    }

    #[test]
    fn parses_what_the_script_prints() {
        let p = parse(&out(
            6,
            "curl: (6) Could not resolve host: downloads.claude.ai",
            "000 0 0.000",
            "9000000",
        ));
        assert_eq!(p.curl_exit, Some(6));
        assert_eq!(p.http, None);
        assert_eq!(p.curl_error, "Could not resolve host: downloads.claude.ai");
        assert_eq!(p.free_kb, Some(9_000_000));
        assert_eq!(p.home, "/home/sarah");
    }

    #[test]
    fn unreachable_names_the_curl_error() {
        let p = parse(&out(
            7,
            "curl: (7) Failed to connect to downloads.claude.ai port 443: Connection refused",
            "000 0 0",
            "9000000",
        ));
        assert_eq!(
            diagnose(&p, HOST),
            Diagnosis::Cause("Couldn't reach downloads.claude.ai: Failed to connect to downloads.claude.ai port 443: Connection refused".into())
        );
    }

    #[test]
    fn an_http_error_is_said_with_its_code() {
        let p = parse(&out(0, "", "403 0 0", "9000000"));
        assert_eq!(
            diagnose(&p, HOST),
            Diagnosis::Cause(
                "The download is blocked (HTTP 403). A firewall or proxy may be in the way.".into()
            )
        );
        let p = parse(&out(0, "", "404 0 0", "9000000"));
        assert_eq!(
            diagnose(&p, HOST),
            Diagnosis::Cause("The download server answered HTTP 404.".into())
        );
    }

    #[test]
    fn a_timeout_or_a_crawl_is_a_stall() {
        let stall = Diagnosis::Cause("The download stalled. On a VPN, try with it off.".into());
        let p = parse(&out(
            28,
            "curl: (28) Operation timed out after 20001 milliseconds with 0 bytes received",
            "206 0 0.000",
            "9000000",
        ));
        assert_eq!(diagnose(&p, HOST), stall);
        let p = parse(&out(0, "", "206 20000 1000.000", "9000000"));
        assert_eq!(diagnose(&p, HOST), stall);
    }

    #[test]
    fn little_space_is_said_with_the_folder_and_sizes() {
        let p = parse(&out(0, "", "206 1048576 2000000.000", "120000"));
        assert_eq!(
            diagnose(&p, HOST),
            Diagnosis::Cause(
                "Not enough disk space in /home/sarah: 117 MB free, about 300 MB needed.".into()
            )
        );
    }

    #[test]
    fn a_slice_that_arrived_is_healthy() {
        let p = parse(&out(0, "", "206 1048576 2000000.000", "9000000"));
        assert_eq!(diagnose(&p, HOST), Diagnosis::Healthy);
        // Server ignored the range and the cap cut it off while flowing.
        let p = parse(&out(
            28,
            "curl: (28) Operation timed out",
            "200 30000000 1500000.000",
            "9000000",
        ));
        assert_eq!(diagnose(&p, HOST), Diagnosis::Healthy);
    }

    #[test]
    fn no_output_leaves_the_installers_own_line() {
        assert_eq!(diagnose(&parse(""), HOST), Diagnosis::Unknown);
    }

    #[test]
    fn the_script_travels_as_one_line_of_plain_characters() {
        let w = wrapped(&Plan::Claude.target().script());
        assert!(
            w.chars()
                .all(|c| c.is_ascii_alphanumeric() || "+/= |-".contains(c))
        );
        assert!(w.starts_with("echo ") && w.ends_with("| base64 -d | bash"));
    }

    #[test]
    fn slow_tools_in_the_script_are_capped() {
        let s = Plan::Claude.target().script();
        assert!(s.contains("$t df -Pk") && s.contains("$t ldd"));
    }

    #[test]
    fn only_download_lines_trigger_a_probe() {
        assert!(is_download_failure("Download failed"));
        assert!(is_download_failure("Checksum verification failed"));
        assert!(is_download_failure("curl: (56) Recv failure"));
        assert!(!is_download_failure("Unsupported architecture"));
        assert!(!is_download_failure("Could not verify checksum tool"));
    }

    #[test]
    fn each_plan_probes_its_own_host() {
        assert!(
            Plan::Claude
                .target()
                .script()
                .contains("downloads.claude.ai/claude-code-releases")
        );
        assert!(
            Plan::Chatgpt
                .target()
                .script()
                .contains("chatgpt.com/codex/install.sh")
        );
        assert!(Plan::Claude.target().script().contains("df -Pk"));
    }
}
