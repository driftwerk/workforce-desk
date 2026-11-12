//! A secret the person typed into Desk's own field (a machine's password,
//! a key's passphrase): wiped from memory when dropped, never printed.

use zeroize::Zeroizing;

/// The most a secret may be.
pub const MAX_SECRET: usize = 1024;

/// A secret the person typed: wiped from memory when dropped, and never
/// printed (`Debug` says only that it is one).
pub struct Secret(Zeroizing<String>);

impl Secret {
    /// `text`, unless it is empty, too long, or holds a line break (which
    /// would end it early as ssh reads it).
    pub fn new(text: Zeroizing<String>) -> Result<Secret, String> {
        if text.is_empty() {
            return Err("Type it first.".into());
        }
        if text.len() > MAX_SECRET || text.contains(['\n', '\r', '\0']) {
            return Err("That can't be a password.".into());
        }
        Ok(Secret(text))
    }

    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(…)")
    }
}
