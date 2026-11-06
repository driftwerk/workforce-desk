//! A stand-in for `ssh` in tests: answers each call from the
//! `scenario.json` beside the path it was run by (each test puts it in a
//! folder of its own, and may rewrite it between steps), and notes every
//! call in its log.
//!
//! A scenario is `{"log": path, "hosts": [host…]}`. A host is reached by
//! its `target` (else ssh's own "Could not resolve hostname"), and has:
//! - `settings`: what `ssh -G` prints for it;
//! - `refuse`: `{stderr, code}`, what every connection to it says instead
//!   (an unknown host key, a locked key);
//! - `commands`: `[{contains, stdout, stderr, code}]`, the first whose
//!   `contains` is in the command line answering it;
//! - for `-L <socket>:127.0.0.1:<port>`, a real forward: it binds the Unix
//!   socket here (`0600`, removing one already there, as
//!   `StreamLocalBindUnlink` does; exiting 255 as `ExitOnForwardFailure`
//!   does when it can't), and pipes each connection to the port on this
//!   computer it names, closing one it can't reach as ssh does;
//! - for `-L 127.0.0.1:<here>:127.0.0.1:<there>`, a real TCP forward: it
//!   binds `127.0.0.1:<here>` (exiting 255 when it can't, as
//!   `ExitOnForwardFailure` does) and pipes each connection to `<there>`
//!   on this computer, or to `forward_to` when the host names one (the
//!   machine's loopback and this computer's are one in a test);
//! - for `-W 127.0.0.1:<there>`, its input and output carried to `<there>`
//!   on this computer (or `forward_to`), as ssh carries them to the
//!   machine's;
//! - `banner`: printed on its error output first, as a machine's banner is
//!   (one may claim anything);
//! - `listen: false`: a forward that never binds, only says things;
//! - `hang: true`: every connection to it (not `-G`) waits for good, as one
//!   to an address that drops its packets does;
//! - `exec`: `{home, path}`, to run each command for real instead, with
//!   `sh -c` in that home (as sshd runs it through the account's shell),
//!   only `HOME` and `PATH` (`path` first) set, and its input passed on;
//! - `host_key`: the key it shows (`ssh-ed25519 AAAA…`). A connection that
//!   may learn it (`StrictHostKeyChecking=accept-new`) writes it into the
//!   `UserKnownHostsFile` it was given and then is refused, as one signing
//!   in with nothing is; any other is checked against the first
//!   `userknownhostsfile` its `settings` name, as ssh checks it.

use std::io::Write;
#[cfg(unix)]
use std::net::TcpStream;

use serde::Deserialize;

#[derive(Deserialize)]
struct Scenario {
    log: std::path::PathBuf,
    hosts: Vec<Host>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Host {
    target: String,
    settings: String,
    refuse: Option<Said>,
    commands: Vec<Command>,
    banner: String,
    listen: Option<bool>,
    exec: Option<Exec>,
    host_key: Option<String>,
    forward_to: Option<u16>,
    hang: bool,
}

#[derive(Deserialize)]
struct Exec {
    home: std::path::PathBuf,
    path: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Said {
    stderr: String,
    code: i32,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Command {
    contains: String,
    stdout: String,
    stderr: String,
    code: i32,
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path =
        std::path::PathBuf::from(std::env::args_os().next().expect("the path it was run by"))
            .with_file_name("scenario.json");
    let scenario: Scenario =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("the scenario"))
            .expect("a scenario");
    let mut log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&scenario.log)
        .expect("the log");
    // One write per call: several at once (a listener's connections) would
    // otherwise interleave their lines.
    let line = format!("{}\n", serde_json::to_string(&args).expect("the call"));
    log.write_all(line.as_bytes()).expect("logging");
    drop(log);
    let dash = args
        .iter()
        .position(|a| a == "--")
        .unwrap_or_else(|| fail("fake ssh: no -- before the target", 2));
    let (options, rest) = (&args[..dash], &args[dash + 1..]);
    let target = rest
        .first()
        .unwrap_or_else(|| fail("fake ssh: no target", 2));
    let Some(host) = scenario.hosts.iter().find(|h| &h.target == target) else {
        fail(
            &format!("ssh: Could not resolve hostname {target}: Name or service not known"),
            255,
        )
    };
    if options.iter().any(|o| o == "-G") {
        print!("{}", host.settings);
        std::process::exit(0);
    }
    if host.hang {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    }
    eprint!("{}", host.banner);
    if let Some(key) = &host.host_key {
        check_host_key(options, target, key, &host.settings);
    }
    if let Some(refuse) = &host.refuse {
        fail(&refuse.stderr, refuse.code);
    }
    if let Some(i) = options.iter().position(|o| o == "-W") {
        stdio(&options[i + 1], host.forward_to);
    }
    if let Some(i) = options.iter().position(|o| o == "-L") {
        if host.listen == Some(false) {
            loop {
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
        }
        forward(&options[i + 1], host.forward_to);
    }
    let line = rest[1..].join(" ");
    if let Some(exec) = &host.exec {
        let status = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(&line)
            .env_clear()
            .env("HOME", &exec.home)
            .env("PATH", format!("{}:/usr/bin:/bin", exec.path))
            .current_dir(&exec.home)
            .status()
            .unwrap_or_else(|e| fail(&format!("sh: {e}"), 127));
        std::process::exit(status.code().unwrap_or(1));
    }
    let Some(answer) = host.commands.iter().find(|c| line.contains(&c.contains)) else {
        fail(&format!("sh: 1: {line}: not found"), 127);
    };
    print!("{}", answer.stdout);
    eprint!("{}", answer.stderr);
    std::process::exit(answer.code);
}

/// The value of `-o <name>=<value>`, if given.
fn option<'a>(options: &'a [String], name: &str) -> Option<&'a str> {
    options
        .windows(2)
        .filter(|w| w[0] == "-o")
        .find_map(|w| w[1].strip_prefix(name)?.strip_prefix('='))
}

/// As ssh checks the key `key` that `target` shows.
fn check_host_key(options: &[String], target: &str, key: &str, settings: &str) {
    let line = format!("{target} {key}");
    if option(options, "StrictHostKeyChecking") == Some("accept-new") {
        let file =
            option(options, "UserKnownHostsFile").unwrap_or_else(|| fail("fake ssh: no file", 2));
        std::fs::write(file, format!("{line}\n")).expect("the known hosts file");
        fail(
            &format!("dev@{target}: Permission denied (publickey)."),
            255,
        );
    }
    let known = settings
        .lines()
        .find_map(|l| l.strip_prefix("userknownhostsfile "))
        .and_then(|v| v.split_whitespace().next())
        .and_then(|f| std::fs::read_to_string(f).ok())
        .unwrap_or_default();
    let words = |l: &str| l.split_whitespace().take(3).collect::<Vec<_>>().join(" ");
    if known.lines().any(|l| words(l) == line) {
        return;
    }
    if known
        .lines()
        .any(|l| l.split_whitespace().next() == Some(target))
    {
        fail(
            &format!(
                "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key for {target} has changed and you have requested strict checking.\nHost key verification failed."
            ),
            255,
        );
    }
    fail(
        &format!(
            "No ED25519 host key is known for {target} and you have requested strict checking.\nHost key verification failed."
        ),
        255,
    );
}

fn fail(said: &str, code: i32) -> ! {
    eprintln!("{said}");
    std::process::exit(code);
}

/// `-W <to>:<there>`, for real: input and output carried to it.
#[cfg(unix)]
fn stdio(spec: &str, forward_to: Option<u16>) -> ! {
    let Some((to, there)) = spec.rsplit_once(':') else {
        fail(&format!("Bad stdio forwarding specification '{spec}'"), 255);
    };
    let there = forward_to.map_or_else(|| there.to_string(), |p| p.to_string());
    let Ok(conn) = TcpStream::connect(format!("{to}:{there}")) else {
        fail(
            "channel 0: open failed: connect failed: Connection refused",
            255,
        );
    };
    let mut up = conn.try_clone().expect("conn");
    let sending = std::thread::spawn(move || {
        let _ = std::io::copy(&mut std::io::stdin(), &mut up);
        let _ = up.shutdown(std::net::Shutdown::Write);
    });
    let mut down = conn;
    let _ = std::io::copy(&mut down, &mut std::io::stdout());
    let _ = std::io::stdout().flush();
    drop(sending);
    std::process::exit(0);
}

#[cfg(not(unix))]
fn stdio(_: &str, _: Option<u16>) -> ! {
    fail("fake ssh: -W needs Unix", 255);
}

/// `-L 127.0.0.1:<here>:127.0.0.1:<there>`, for real.
#[cfg(unix)]
fn forward_tcp(here: &str, there: &str) -> ! {
    let listener = match std::net::TcpListener::bind(here) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("bind [{here}]: {e}");
            fail("Could not request local forwarding.", 255);
        }
    };
    for client in listener.incoming() {
        let Ok(client) = client else { continue };
        let there = there.to_string();
        std::thread::spawn(move || match TcpStream::connect(&there) {
            Ok(to) => pipe_tcp(client, to),
            Err(_) => eprintln!("channel 2: open failed: connect failed: Connection refused"),
        });
    }
    std::process::exit(0);
}

#[cfg(unix)]
fn pipe_tcp(a: TcpStream, b: TcpStream) {
    let (mut a2, mut b2) = (a.try_clone().expect("a"), b.try_clone().expect("b"));
    let (mut a, mut b) = (a, b);
    let up = std::thread::spawn(move || {
        let _ = std::io::copy(&mut a, &mut b2);
        let _ = b2.shutdown(std::net::Shutdown::Write);
    });
    let _ = std::io::copy(&mut b, &mut a2);
    let _ = a2.shutdown(std::net::Shutdown::Write);
    let _ = up.join();
}

/// `-L <socket>:127.0.0.1:<there>`, for real.
#[cfg(unix)]
fn forward(spec: &str, forward_to: Option<u16>) -> ! {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;
    let parts: Vec<&str> = spec.split(':').collect();
    if let [bind, here, to, there] = parts[..]
        && bind == "127.0.0.1"
    {
        let there = forward_to.map_or_else(|| there.to_string(), |p| p.to_string());
        forward_tcp(&format!("{bind}:{here}"), &format!("{to}:{there}"));
    }
    let mut parts = spec.rsplitn(3, ':');
    let (Some(there), Some(to), Some(socket)) = (parts.next(), parts.next(), parts.next()) else {
        fail(&format!("Bad local forwarding specification '{spec}'"), 255);
    };
    let _ = std::fs::remove_file(socket);
    let listener = match UnixListener::bind(socket) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("unix_listener: cannot bind to path {socket}: {e}");
            fail("Could not request local forwarding.", 255);
        }
    };
    std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600)).expect("mode");
    let there = format!("{to}:{there}");
    for client in listener.incoming() {
        let Ok(client) = client else { continue };
        let there = there.clone();
        std::thread::spawn(move || match TcpStream::connect(&there) {
            Ok(hub) => pipe(client, hub),
            // ssh's channel open fails, and it closes the connection.
            Err(_) => eprintln!("channel 2: open failed: connect failed: Connection refused"),
        });
    }
    std::process::exit(0);
}

#[cfg(not(unix))]
fn forward(_: &str, _: Option<u16>) -> ! {
    fail("fake ssh: forwards need Unix sockets", 255);
}

#[cfg(unix)]
fn pipe(a: std::os::unix::net::UnixStream, b: TcpStream) {
    let (mut a2, mut b2) = (a.try_clone().expect("a"), b.try_clone().expect("b"));
    let (mut a, mut b) = (a, b);
    let up = std::thread::spawn(move || {
        let _ = std::io::copy(&mut a, &mut b2);
        let _ = b2.shutdown(std::net::Shutdown::Write);
    });
    let _ = std::io::copy(&mut b, &mut a2);
    let _ = a2.shutdown(std::net::Shutdown::Write);
    let _ = up.join();
}
