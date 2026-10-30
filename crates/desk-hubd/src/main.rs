//! `desk-hubd` — "Desk Helper" in the app bundle and `desk-helper` on
//! Linux — Desk's login item, run at login by launchd, systemd or, inside
//! WSL, by Desk Helper on Windows. Starts the local Postgres and the memory
//! store, writes the hub's config, and keeps the hub running with the
//! user's login environment and its secrets. Starts the PTY holder before
//! the hub, which keeps the hub's terminals through its restarts. Stops the
//! hub, the memory store and Postgres (never the holder) on SIGTERM, and
//! when an update replaces it, so the new one is started.
//!
//! Asked rather than run, it stops the one running (`--stop`), says how to
//! reach the hub (`connection --json`), checks it can run here (`--check`),
//! or removes everything it keeps (`--remove-everything`).

#[cfg(unix)]
mod bootstrap;
#[cfg(unix)]
mod commands;
#[cfg(unix)]
mod config;
#[cfg(unix)]
mod holder;
#[cfg(unix)]
mod memory;
#[cfg(unix)]
mod model;
#[cfg(unix)]
mod moving;
#[cfg(unix)]
mod supervise;

#[cfg(unix)]
fn main() -> eyre::Result<()> {
    use commands::Command;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let env = std::env::vars().collect();
    let paths = desk_core::Paths::new()?;
    match Command::parse(&args)? {
        Command::Run => supervise::run(paths, env),
        Command::Stop => commands::stop(&paths),
        Command::Connection => {
            println!("{}", commands::connection(&paths, &env)?);
            Ok(())
        }
        Command::RemoveEverything => commands::remove_everything(&paths, &env),
        Command::Check => {
            println!("{}", serde_json::to_string(&commands::check(&paths))?);
            Ok(())
        }
    }
}

#[cfg(not(unix))]
fn main() {
    eprintln!("desk-hubd runs on macOS and Linux; on Windows Desk runs it inside WSL");
    std::process::exit(2);
}
