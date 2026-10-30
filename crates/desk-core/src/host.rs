//! Where Desk's backend runs, as the app sees it: on this computer itself,
//! or inside a WSL distro on Windows. Starting a program there and writing a
//! path for either side go through [`Host`], so nothing else needs to know
//! which it is.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::LINUX_HELPER_EXECUTABLE;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Host {
    Native,
    Wsl(Wsl),
}

/// A WSL distro the backend runs in, as setup found it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Wsl {
    pub distro: String,
    pub user: String,
    /// The person's home inside the distro, absolute (`/home/sarah`).
    pub home: String,
    /// Where Windows drives are mounted, with its trailing slash (`/mnt/`).
    pub automount: String,
}

/// WSL's own default for [`Wsl::automount`].
pub const DEFAULT_AUTOMOUNT: &str = "/mnt/";

/// A program to run, however this host runs programs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    pub program: PathBuf,
    pub args: Vec<String>,
}

impl Invocation {
    /// The command, with no console window flashing up on Windows.
    pub fn command(&self) -> std::process::Command {
        let mut command = std::process::Command::new(&self.program);
        command.args(&self.args);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        command
    }
}

impl Wsl {
    /// The backend's folder inside the distro.
    pub fn root(&self) -> String {
        format!("{}/.local/share/Desk", self.home.trim_end_matches('/'))
    }

    /// The installed versions of the backend's programs.
    pub fn bin(&self) -> String {
        format!("{}/bin", self.root())
    }

    /// Desk Helper inside the distro, through the `current` link setup flips.
    pub fn helper(&self) -> String {
        format!("{}/current/{LINUX_HELPER_EXECUTABLE}", self.bin())
    }

    fn wsl(&self, args: impl IntoIterator<Item = String>) -> Invocation {
        Invocation {
            program: "wsl.exe".into(),
            args: ["-d", &self.distro, "--cd", &self.home, "--exec"]
                .into_iter()
                .map(str::to_string)
                .chain(args)
                .collect(),
        }
    }

    /// The drive letter and the rest of a path under [`Wsl::automount`].
    fn on_drive<'a>(&self, backend: &'a str) -> Option<(char, &'a str)> {
        let rest = backend.strip_prefix(self.automount.as_str())?;
        let mut chars = rest.chars();
        let letter = chars.next().filter(char::is_ascii_alphabetic)?;
        let after = chars.as_str();
        (after.is_empty() || after.starts_with('/')).then_some((letter, after))
    }
}

/// A path written with either separator, as its parts.
fn parts(path: &str) -> impl Iterator<Item = &str> {
    path.split(['/', '\\']).filter(|p| !p.is_empty())
}

impl Host {
    pub fn invocation(&self, program: &str, args: &[&str]) -> Invocation {
        let args = args.iter().map(|a| a.to_string());
        match self {
            Host::Native => Invocation {
                program: program.into(),
                args: args.collect(),
            },
            Host::Wsl(w) => w.wsl(std::iter::once(program.to_string()).chain(args)),
        }
    }

    /// `script` run by a login shell, so the person's PATH and `~` apply.
    pub fn login_invocation(&self, script: &str) -> Invocation {
        self.invocation("/bin/sh", &["-lc", script])
    }

    /// A backend path as this computer's own file manager opens it.
    pub fn host_path(&self, backend: &str) -> PathBuf {
        match self {
            Host::Native => backend.into(),
            Host::Wsl(w) => match w.on_drive(backend) {
                Some((letter, rest)) => {
                    let rest: Vec<_> = parts(rest).collect();
                    format!("{}:\\{}", letter.to_ascii_uppercase(), rest.join("\\")).into()
                }
                None => {
                    let rest: Vec<_> = parts(backend).collect();
                    format!("\\\\wsl.localhost\\{}\\{}", w.distro, rest.join("\\")).into()
                }
            },
        }
    }

    /// A path the person picked, as the backend sees it; none for one it
    /// can't reach (a network share, another distro).
    pub fn backend_path(&self, picked: &Path) -> Option<String> {
        let picked = picked.to_string_lossy();
        let Host::Wsl(w) = self else {
            return Some(picked.into_owned());
        };
        let picked = picked
            .strip_prefix(r"\\?\UNC\")
            .map(|rest| format!(r"\\{rest}"))
            .unwrap_or_else(|| picked.strip_prefix(r"\\?\").unwrap_or(&picked).to_string());
        if let Some(unc) = picked.strip_prefix(r"\\") {
            let mut p = parts(unc);
            let server = p.next()?;
            let distro = p.next()?;
            let ours = (server.eq_ignore_ascii_case("wsl.localhost") || server == "wsl$")
                && distro.eq_ignore_ascii_case(&w.distro);
            return ours.then(|| format!("/{}", p.collect::<Vec<_>>().join("/")));
        }
        let mut chars = picked.chars();
        let letter = chars.next().filter(char::is_ascii_alphabetic)?;
        let rest = chars.as_str().strip_prefix(':')?;
        let rest: Vec<_> = parts(rest).collect();
        let drive = format!("{}{}", w.automount, letter.to_ascii_lowercase());
        Some(if rest.is_empty() {
            drive
        } else {
            format!("{drive}/{}", rest.join("/"))
        })
    }

    /// How a backend path is shown: `~/dev/acme-web` for one in the home
    /// inside WSL, `C:\Users\Sarah\dev` for one on a Windows drive, and
    /// natively as it is.
    pub fn display_path(&self, backend: &str) -> String {
        let Host::Wsl(w) = self else {
            return backend.to_string();
        };
        if w.on_drive(backend).is_some() {
            return self.host_path(backend).to_string_lossy().into_owned();
        }
        let home = w.home.trim_end_matches('/');
        match backend.strip_prefix(home) {
            Some("") => "~".into(),
            Some(rest) if rest.starts_with('/') => format!("~{rest}"),
            _ => backend.to_string(),
        }
    }

    /// The host of the process reading `env`: inside WSL when WSL says so
    /// (it sets `WSL_DISTRO_NAME` in every process it starts).
    pub fn running_here(env: &BTreeMap<String, String>) -> Host {
        match env.get("WSL_DISTRO_NAME") {
            Some(distro) => Host::Wsl(Wsl {
                distro: distro.clone(),
                user: env.get("USER").cloned().unwrap_or_default(),
                home: env.get("HOME").cloned().unwrap_or_default(),
                automount: DEFAULT_AUTOMOUNT.into(),
            }),
            None => Host::Native,
        }
    }
}

/// The variable WSL's launcher passes the Windows computer's name in.
pub const COMPUTER_NAME_ENV: &str = "DESK_COMPUTER_NAME";

#[cfg(test)]
mod tests {
    use super::*;

    fn ubuntu() -> Host {
        Host::Wsl(Wsl {
            distro: "Ubuntu".into(),
            user: "sarah".into(),
            home: "/home/sarah".into(),
            automount: DEFAULT_AUTOMOUNT.into(),
        })
    }

    #[test]
    fn programs_run_directly_here_and_through_wsl_exe_in_wsl() {
        assert_eq!(
            Host::Native.invocation("desk-helper", &["--stop"]),
            Invocation {
                program: "desk-helper".into(),
                args: vec!["--stop".into()],
            }
        );
        let i = ubuntu().invocation(
            "/home/sarah/.local/share/Desk/bin/current/desk-helper",
            &["connection", "--json"],
        );
        assert_eq!(i.program, PathBuf::from("wsl.exe"));
        assert_eq!(
            i.args,
            [
                "-d",
                "Ubuntu",
                "--cd",
                "/home/sarah",
                "--exec",
                "/home/sarah/.local/share/Desk/bin/current/desk-helper",
                "connection",
                "--json"
            ]
        );
    }

    #[test]
    fn a_login_script_runs_in_a_login_shell_on_either_host() {
        assert_eq!(
            Host::Native.login_invocation("echo ~").args,
            ["-lc", "echo ~"]
        );
        let i = ubuntu().login_invocation("claude --version");
        assert_eq!(
            i.args[4..],
            ["--exec", "/bin/sh", "-lc", "claude --version"]
        );
    }

    #[test]
    fn the_backend_lives_in_the_linux_home() {
        let Host::Wsl(w) = ubuntu() else {
            unreachable!()
        };
        assert_eq!(w.root(), "/home/sarah/.local/share/Desk");
        assert_eq!(
            w.helper(),
            "/home/sarah/.local/share/Desk/bin/current/desk-helper"
        );
    }

    #[test]
    fn paths_cross_between_windows_and_wsl() {
        let host = ubuntu();
        let table = [
            ("/home/sarah/x", r"\\wsl.localhost\Ubuntu\home\sarah\x"),
            ("/mnt/c/Users/Sarah/dev", r"C:\Users\Sarah\dev"),
            ("/mnt/d", r"D:\"),
            (
                "/home/sarah/dev/acme web/ünïcode",
                r"\\wsl.localhost\Ubuntu\home\sarah\dev\acme web\ünïcode",
            ),
        ];
        for (backend, windows) in table {
            assert_eq!(host.host_path(backend), PathBuf::from(windows), "{backend}");
            assert_eq!(
                host.backend_path(Path::new(windows)).as_deref(),
                Some(backend.trim_end_matches('/')),
                "{windows}"
            );
        }
    }

    #[test]
    fn older_and_verbatim_windows_forms_are_understood() {
        let host = ubuntu();
        for (picked, backend) in [
            (r"\\wsl$\Ubuntu\home\sarah\x", "/home/sarah/x"),
            (r"\\WSL.LOCALHOST\ubuntu\home\sarah", "/home/sarah"),
            (
                r"\\?\UNC\wsl.localhost\Ubuntu\home\sarah\x",
                "/home/sarah/x",
            ),
            (r"\\?\C:\Users\Sarah", "/mnt/c/Users/Sarah"),
            (r"c:/Users/Sarah/", "/mnt/c/Users/Sarah"),
        ] {
            assert_eq!(
                host.backend_path(Path::new(picked)).as_deref(),
                Some(backend),
                "{picked}"
            );
        }
    }

    #[test]
    fn a_share_or_another_distro_is_out_of_reach() {
        let host = ubuntu();
        for picked in [
            r"\\fileserver\team\docs",
            r"\\wsl.localhost\Debian\home\sarah",
            r"\\wsl$",
            "relative\\folder",
        ] {
            assert_eq!(host.backend_path(Path::new(picked)), None, "{picked}");
        }
    }

    #[test]
    fn automount_is_honoured() {
        let host = Host::Wsl(Wsl {
            automount: "/win/".into(),
            ..match ubuntu() {
                Host::Wsl(w) => w,
                Host::Native => unreachable!(),
            }
        });
        assert_eq!(host.host_path("/win/e/data"), PathBuf::from(r"E:\data"));
        assert_eq!(
            host.backend_path(Path::new(r"E:\data")).as_deref(),
            Some("/win/e/data")
        );
        assert_eq!(
            host.host_path("/mnt/c/x"),
            PathBuf::from(r"\\wsl.localhost\Ubuntu\mnt\c\x")
        );
    }

    #[test]
    fn paths_are_shown_the_way_the_person_knows_them() {
        let host = ubuntu();
        assert_eq!(
            host.display_path("/home/sarah/dev/acme-web"),
            "~/dev/acme-web"
        );
        assert_eq!(host.display_path("/home/sarah"), "~");
        assert_eq!(host.display_path("/home/sarahs/x"), "/home/sarahs/x");
        assert_eq!(
            host.display_path("/mnt/c/Users/Sarah/dev"),
            r"C:\Users\Sarah\dev"
        );
        assert_eq!(host.display_path("/opt/tools"), "/opt/tools");
        assert_eq!(
            Host::Native.display_path("/Users/sarah/dev"),
            "/Users/sarah/dev"
        );
        assert_eq!(
            Host::Native
                .backend_path(Path::new("/Users/sarah/dev"))
                .as_deref(),
            Some("/Users/sarah/dev")
        );
    }

    #[test]
    fn a_process_knows_when_wsl_started_it() {
        assert_eq!(Host::running_here(&BTreeMap::new()), Host::Native);
        let env = BTreeMap::from([
            ("WSL_DISTRO_NAME".to_string(), "Ubuntu-24.04".to_string()),
            ("USER".to_string(), "sarah".to_string()),
            ("HOME".to_string(), "/home/sarah".to_string()),
        ]);
        assert_eq!(
            Host::running_here(&env),
            Host::Wsl(Wsl {
                distro: "Ubuntu-24.04".into(),
                user: "sarah".into(),
                home: "/home/sarah".into(),
                automount: "/mnt/".into(),
            })
        );
    }

    #[test]
    fn the_host_is_kept_as_tagged_json() {
        assert_eq!(
            serde_json::to_value(ubuntu()).unwrap(),
            serde_json::json!({"kind": "wsl", "distro": "Ubuntu", "user": "sarah", "home": "/home/sarah", "automount": "/mnt/"})
        );
        assert_eq!(
            serde_json::from_value::<Host>(serde_json::json!({"kind": "native"})).unwrap(),
            Host::Native
        );
    }
}
