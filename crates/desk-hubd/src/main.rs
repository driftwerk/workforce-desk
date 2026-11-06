//! `desk-hubd` — "Desk Helper" in the app bundle and `desk-helper` on
//! Linux — Desk's login item, run at login by launchd, systemd or, inside
//! WSL, by Desk Helper on Windows. Starts the local Postgres and the memory
//! store, writes the hub's config, and keeps the hub running with the
//! user's login environment and its secrets. Starts the PTY holder before
//! the hub, which keeps the hub's terminals through its restarts. Stops the
//! hub, the memory store and Postgres (never the holder) on SIGTERM, and
//! when an update replaces it, so the new one is started.
//!
//! On a machine — a Linux box Desk on another computer drives over SSH —
//! it runs with `--machine`: its sessions are resumed after the box
//! restarts, and Desk's Claude Code plugin is in every session's
//! environment, since nobody's Desk there passes it.
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
mod handover;
#[cfg(unix)]
mod holder;
#[cfg(unix)]
mod memory;
#[cfg(unix)]
mod model;
#[cfg(unix)]
mod moving;
#[cfg(unix)]
mod programs;
#[cfg(unix)]
mod supervise;

#[cfg(unix)]
fn main() -> eyre::Result<()> {
    use commands::Command;
    // Desk Helper writes the local hub's secrets, and migrates them.
    desk_core::vault::writes_as(desk_core::vault::KeyOwner::Helper);
    let args: Vec<String> = std::env::args().skip(1).collect();
    // A release starts only the programs installed beside it.
    programs::check_args(&args)?;
    let env = std::env::vars().collect();
    let paths = desk_core::Paths::new()?;
    match Command::parse(&args)? {
        Command::Run { machine } => {
            // A release runs only from where Desk installs it.
            programs::check_place(&paths, &env)?;
            supervise::run(
                paths,
                env,
                if machine {
                    config::Mode::Machine
                } else {
                    config::Mode::Desktop
                },
            )
        }
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
