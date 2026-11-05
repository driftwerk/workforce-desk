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
//! - `banner`: printed on its error output first, as a machine's banner is
//!   (one may claim anything);
//! - `listen: false`: a forward that never binds, only says things.

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
    writeln!(log, "{}", serde_json::to_string(&args).expect("the call")).expect("logging");
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
    eprint!("{}", host.banner);
    if let Some(refuse) = &host.refuse {
        fail(&refuse.stderr, refuse.code);
    }
    if let Some(i) = options.iter().position(|o| o == "-L") {
        if host.listen == Some(false) {
            loop {
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
        }
        forward(&options[i + 1]);
    }
    let line = rest[1..].join(" ");
    let Some(answer) = host.commands.iter().find(|c| line.contains(&c.contains)) else {
        fail(&format!("sh: 1: {line}: not found"), 127);
    };
    print!("{}", answer.stdout);
    eprint!("{}", answer.stderr);
    std::process::exit(answer.code);
}

fn fail(said: &str, code: i32) -> ! {
    eprintln!("{said}");
    std::process::exit(code);
}

/// `-L <socket>:127.0.0.1:<there>`, for real.
#[cfg(unix)]
fn forward(spec: &str) -> ! {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;
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
fn forward(_: &str) -> ! {
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
