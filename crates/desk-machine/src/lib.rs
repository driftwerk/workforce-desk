//! Desk on a machine of the person's own: a Linux computer (a build server,
//! a cloud VM) running Desk's backend, which Desk on this computer shows and
//! drives. Everything goes over the person's own `ssh`, so their
//! `~/.ssh/config` applies as it does in a terminal (a `Host` alias, its
//! `User`, `IdentityFile`, `ProxyJump` or `ProxyCommand`), and the machine
//! opens no port of its own.
//!
//! - [`ssh`] runs it, and says what went wrong in the person's words.
//! - [`admit`] is the check before a machine is added: the target, the
//!   person's yes, and a host key already known.
//! - [`tunnel`] keeps the one forward to the machine's hub open, from a
//!   Unix socket only the person can reach.
//! - [`fleet`] keeps the person's machines (`machines.json`), adds one
//!   ([`probe`], [`hostkey`], [`setup`]), and connects to each, upgrading
//!   one on an older Desk.
//! - [`callback`] forwards one sign-in's callback port, while it runs.
//! - [`link`] reads the machine's hub tokens over SSH, holds them only in
//!   memory, and hands them on to go only through the forward's socket.
//!
//! Tested against a fake `ssh` (`src/bin/fake-ssh.rs`) that answers from a
//! scenario and really forwards a port, as `ssh -L` does.

pub mod admit;
pub mod callback;
pub mod fleet;
pub mod hostkey;
pub mod link;
pub mod probe;
pub mod setup;
pub mod ssh;
pub mod tunnel;

pub use link::{Link, Machines};
pub use ssh::SshExe;
