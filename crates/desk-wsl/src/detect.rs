//! Finding a WSL distro Desk's backend can run in: WSL 2, x86_64 or arm64,
//! glibc 2.35 or newer, and a normal default user.

use desk_core::backend::glibc_supported;
use desk_core::host::{DEFAULT_AUTOMOUNT, Host, Wsl};
use serde::{Deserialize, Serialize};

use crate::run::WslExe;

/// Why Desk can't run in WSL here, or in one distro.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WslProblem {
    NotInstalled,
    NoDistro,
    Wsl1 { distro: String },
    Arch { found: String },
    OldLinux { glibc: String },
    RootUser { distro: String },
}

impl std::fmt::Display for WslProblem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WslProblem::NotInstalled => write!(f, "WSL isn't on this computer yet"),
            WslProblem::NoDistro => write!(f, "WSL has no Linux installed yet"),
            WslProblem::Wsl1 { distro } => {
                write!(f, "{distro} runs on WSL 1; Desk needs WSL 2")
            }
            WslProblem::Arch { found } => write!(f, "Desk doesn't run on {found} Linux"),
            WslProblem::OldLinux { glibc } => write!(
                f,
                "Desk needs Ubuntu 22.04 or newer, or Debian 12 (this one has glibc {glibc})"
            ),
            WslProblem::RootUser { distro } => write!(
                f,
                "Set a normal default user for {distro}; Desk won't run as root"
            ),
        }
    }
}

/// A distro as `wsl --list --verbose` lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Distro {
    pub name: String,
    pub state: String,
    pub version: u8,
    pub default: bool,
}

/// `wsl.exe`'s output as text: UTF-16LE when it has a BOM or NULs between
/// its letters (older WSL ignores `WSL_UTF8`), else UTF-8.
pub fn decode(bytes: &[u8]) -> String {
    let utf16 = bytes.starts_with(&[0xFF, 0xFE])
        || bytes.iter().skip(1).step_by(2).take(8).any(|&b| b == 0);
    if !utf16 {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    let body = bytes.strip_prefix(&[0xFF, 0xFE]).unwrap_or(bytes);
    let units: Vec<u16> = body
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&pair| u16::from_le_bytes(pair))
        .collect();
    String::from_utf16_lossy(&units)
}

/// `wsl --list --verbose`: the name first (distro names have no spaces),
/// the version last, and the state between (which, translated, can be
/// several words), with `*` before the default. The header row is
/// localised, so it is skipped by shape (its last word isn't a version).
pub fn parse_list(text: &str) -> Vec<Distro> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim_matches(|c: char| c.is_whitespace() || c == '\0');
            let (default, line) = match line.strip_prefix('*') {
                Some(rest) => (true, rest.trim_start()),
                None => (false, line),
            };
            let words: Vec<&str> = line.split_whitespace().collect();
            let [name, state @ .., version] = words.as_slice() else {
                return None;
            };
            let version = version.parse().ok()?;
            (!state.is_empty()).then(|| Distro {
                name: name.to_string(),
                state: state.join(" "),
                version,
                default,
            })
        })
        .collect()
}

/// What Desk reads inside a distro, one value a line: the machine, the
/// kernel, the user and their home, where Windows drives are mounted, and
/// the C library.
pub const PROBE: &str = "uname -m; uname -r; id -un; echo \"$HOME\"; wslpath -u 'C:\\' 2>/dev/null || echo; ldd --version 2>&1 | head -n 1";

/// A distro's answer to [`PROBE`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Probe {
    pub arch: String,
    pub kernel: String,
    pub user: String,
    pub home: String,
    pub automount: String,
    /// glibc's version; `musl` or the like for another C library.
    pub glibc: String,
}

/// `ldd --version`'s first line's version: its last word.
pub fn ldd_version(line: &str) -> String {
    line.split_whitespace()
        .last()
        .unwrap_or("unknown")
        .to_string()
}

/// Where drives are mounted, from `wslpath -u 'C:\'` (`/mnt/c/`).
pub fn automount_of(c_drive: &str) -> String {
    let c = c_drive.trim().trim_end_matches('/');
    match c.strip_suffix('c') {
        Some(root) if root.ends_with('/') => root.to_string(),
        _ => DEFAULT_AUTOMOUNT.to_string(),
    }
}

pub fn parse_probe(text: &str) -> Option<Probe> {
    let lines: Vec<&str> = text.lines().map(str::trim).collect();
    let [arch, kernel, user, home, c_drive, ldd, ..] = lines.as_slice() else {
        return None;
    };
    let glibc = if ldd.to_ascii_lowercase().contains("musl") {
        "musl".to_string()
    } else {
        ldd_version(ldd)
    };
    Some(Probe {
        arch: arch.to_string(),
        kernel: kernel.to_string(),
        user: user.to_string(),
        home: home.to_string(),
        automount: automount_of(c_drive),
        glibc,
    })
}

/// What keeps Desk from a WSL 2 distro, from what it said.
pub fn problem_of(distro: &Distro, probe: &Probe) -> Option<WslProblem> {
    if !matches!(probe.arch.as_str(), "x86_64" | "aarch64") {
        Some(WslProblem::Arch {
            found: probe.arch.clone(),
        })
    } else if !glibc_supported(&probe.glibc) {
        Some(WslProblem::OldLinux {
            glibc: probe.glibc.clone(),
        })
    } else if probe.user == "root" {
        Some(WslProblem::RootUser {
            distro: distro.name.clone(),
        })
    } else {
        None
    }
}

/// A distro, and whether Desk can run in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Found {
    pub distro: Distro,
    /// What it said, for a WSL 2 one that answered.
    pub probe: Option<Probe>,
    pub problem: Option<WslProblem>,
}

impl Found {
    /// The backend's host in this distro, when Desk can run there.
    pub fn host(&self) -> Option<Host> {
        let probe = self.probe.as_ref().filter(|_| self.problem.is_none())?;
        Some(Host::Wsl(Wsl {
            distro: self.distro.name.clone(),
            user: probe.user.clone(),
            home: probe.home.clone(),
            automount: probe.automount.clone(),
        }))
    }
}

/// WSL on this computer: its distros, or why there are none to use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Detection {
    pub problem: Option<WslProblem>,
    pub distros: Vec<Found>,
}

/// The distros `wsl --list --verbose` lists; none when WSL isn't there.
pub fn list(wsl: &WslExe) -> Vec<Distro> {
    wsl.run(&["--list", "--verbose"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| parse_list(&decode(&o.stdout)))
        .unwrap_or_default()
}

fn found(wsl: &WslExe, distro: Distro) -> Found {
    if distro.version != 2 {
        return Found {
            problem: Some(WslProblem::Wsl1 {
                distro: distro.name.clone(),
            }),
            probe: None,
            distro,
        };
    }
    let asked = wsl.run(&["-d", &distro.name, "--exec", "sh", "-c", PROBE]);
    let probe = asked
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| parse_probe(&decode(&o.stdout)));
    let problem = match &probe {
        Some(p) => problem_of(&distro, p),
        None => Some(WslProblem::OldLinux {
            glibc: "unknown".into(),
        }),
    };
    Found {
        distro,
        probe,
        problem,
    }
}

/// Looks for WSL and asks each WSL 2 distro what it is (which starts it).
pub fn detect(wsl: &WslExe) -> Detection {
    let present = wsl.run(&["--status"]).is_ok_and(|o| o.status.success());
    let distros = list(wsl);
    let problem = match (present, distros.is_empty()) {
        (false, true) => Some(WslProblem::NotInstalled),
        (true, true) => Some(WslProblem::NoDistro),
        (_, false) => None,
    };
    Detection {
        problem,
        distros: distros.into_iter().map(|d| found(wsl, d)).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &str = "  NAME            STATE           VERSION\r\n\
                        * Ubuntu-24.04    Running         2\r\n  \
                        Debian          Stopped         2\r\n  \
                        Ubuntu-20.04    Stopped         1\r\n";

    fn utf16(text: &str, bom: bool) -> Vec<u8> {
        let mut out = if bom { vec![0xFF, 0xFE] } else { Vec::new() };
        out.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
        out
    }

    #[test]
    fn the_list_is_read_whichever_encoding_wsl_answers_in() {
        let want = vec![
            Distro {
                name: "Ubuntu-24.04".into(),
                state: "Running".into(),
                version: 2,
                default: true,
            },
            Distro {
                name: "Debian".into(),
                state: "Stopped".into(),
                version: 2,
                default: false,
            },
            Distro {
                name: "Ubuntu-20.04".into(),
                state: "Stopped".into(),
                version: 1,
                default: false,
            },
        ];
        assert_eq!(parse_list(&decode(LIST.as_bytes())), want);
        assert_eq!(parse_list(&decode(&utf16(LIST, true))), want);
        assert_eq!(parse_list(&decode(&utf16(LIST, false))), want);
    }

    #[test]
    fn a_localised_header_is_skipped_by_its_shape() {
        let german = "  NAME      ZUSTAND      VERSION\n* Ubuntu    Wird ausgeführt    2\n";
        assert_eq!(
            parse_list(german),
            vec![Distro {
                name: "Ubuntu".into(),
                state: "Wird ausgeführt".into(),
                version: 2,
                default: true,
            }]
        );
        assert!(
            parse_list("Windows Subsystem for Linux has no installed distributions.\n").is_empty()
        );
    }

    fn probe(arch: &str, user: &str, ldd: &str) -> String {
        format!("{arch}\n6.6.36.6-microsoft-standard-WSL2\n{user}\n/home/{user}\n/mnt/c/\n{ldd}\n")
    }

    #[test]
    fn a_distro_says_what_it_is() {
        let p = parse_probe(&probe(
            "x86_64",
            "sarah",
            "ldd (Ubuntu GLIBC 2.39-0ubuntu8.3) 2.39",
        ))
        .unwrap();
        assert_eq!(
            p,
            Probe {
                arch: "x86_64".into(),
                kernel: "6.6.36.6-microsoft-standard-WSL2".into(),
                user: "sarah".into(),
                home: "/home/sarah".into(),
                automount: "/mnt/".into(),
                glibc: "2.39".into(),
            }
        );
        assert_eq!(automount_of("/win/c/\n"), "/win/");
        assert_eq!(automount_of(""), "/mnt/");
        assert_eq!(
            parse_probe(&probe("x86_64", "sarah", "musl libc (x86_64)"))
                .unwrap()
                .glibc,
            "musl"
        );
        assert_eq!(parse_probe("x86_64\n"), None);
    }

    #[test]
    fn each_problem_is_found_in_order() {
        let d = Distro {
            name: "Ubuntu".into(),
            state: "Running".into(),
            version: 2,
            default: true,
        };
        let check = |arch: &str, user: &str, ldd: &str| {
            problem_of(&d, &parse_probe(&probe(arch, user, ldd)).unwrap())
        };
        assert_eq!(check("x86_64", "sarah", "ldd (GNU libc) 2.36"), None);
        assert_eq!(
            check("armv7l", "sarah", "ldd (GNU libc) 2.36"),
            Some(WslProblem::Arch {
                found: "armv7l".into()
            })
        );
        assert_eq!(
            check("x86_64", "sarah", "ldd (Ubuntu GLIBC 2.31-0ubuntu9) 2.31"),
            Some(WslProblem::OldLinux {
                glibc: "2.31".into()
            })
        );
        assert_eq!(
            check("x86_64", "root", "ldd (GNU libc) 2.36"),
            Some(WslProblem::RootUser {
                distro: "Ubuntu".into()
            })
        );
    }

    #[test]
    fn a_usable_distro_is_a_backend_host() {
        let found = Found {
            distro: Distro {
                name: "Ubuntu".into(),
                state: "Running".into(),
                version: 2,
                default: true,
            },
            probe: parse_probe(&probe("x86_64", "sarah", "ldd 2.39")),
            problem: None,
        };
        assert_eq!(
            found.host(),
            Some(Host::Wsl(Wsl {
                distro: "Ubuntu".into(),
                user: "sarah".into(),
                home: "/home/sarah".into(),
                automount: "/mnt/".into(),
            }))
        );
        let refused = Found {
            problem: Some(WslProblem::RootUser {
                distro: "Ubuntu".into(),
            }),
            ..found
        };
        assert_eq!(refused.host(), None);
    }

    #[test]
    fn problems_are_said_plainly() {
        assert_eq!(
            WslProblem::Wsl1 {
                distro: "Ubuntu-20.04".into()
            }
            .to_string(),
            "Ubuntu-20.04 runs on WSL 1; Desk needs WSL 2"
        );
        assert!(
            WslProblem::RootUser {
                distro: "Ubuntu".into()
            }
            .to_string()
            .contains("won't run as root")
        );
        assert_eq!(
            serde_json::to_value(WslProblem::OldLinux {
                glibc: "2.31".into()
            })
            .unwrap(),
            serde_json::json!({"kind": "old_linux", "glibc": "2.31"})
        );
    }
}
