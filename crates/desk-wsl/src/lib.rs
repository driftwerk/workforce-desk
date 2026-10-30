//! Desk on Windows runs its backend — Desk Helper, the hub, its memory store
//! and Postgres — inside the person's WSL 2 distro, as the Linux build. This
//! crate finds a distro that can run it ([`detect`]), installs and updates
//! the backend there ([`install`]), and is `Desk Helper.exe` (its binary),
//! which keeps the backend running from Windows sign-in ([`launcher`],
//! [`startup`]).
//!
//! Everything but the registry and the named mutex is plain process work,
//! tested against a fake `wsl.exe` on every platform.

pub mod detect;
pub mod install;
pub mod launcher;
pub mod reach;
pub mod run;
pub mod startup;
pub mod wslconfig;

pub use detect::{Detection, Distro, Found, WslProblem, detect};
pub use run::WslExe;
