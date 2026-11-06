//! The machines' own commands (designs/desk-remote-machines-design.md §4,
//! §5, §6.1): listing them, a first look at an address, trusting its host
//! key, this computer's public key, adding, connecting again and removing.
//! The work is `desk_machine::fleet`'s, on blocking threads; here is where
//! it says things to the page (`machines-changed`, `machine-setup`), asks
//! natively, and gets the backend for this Desk's version.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use desk_core::machine_backend::{self, Arch, Backend, Source};
use desk_machine::fleet::{Fleet, Host, Listed, SetupEvent};
use desk_machine::hostkey::{TrustConfirm, TrustQuestion};
use desk_machine::setup::Person;
use tauri::{Emitter, Manager};

use crate::CommandResult;

/// What the fleet asks of the app.
pub struct AppHost {
    pub app: tauri::AppHandle,
    /// This Desk's version: what its machines run.
    pub version: String,
    /// Where backends are kept per version, checked each time they're used.
    pub cache: PathBuf,
    pub home: PathBuf,
}

impl AppHost {
    fn updater(&self, key: &str) -> Option<String> {
        let u = self.app.config().plugins.0.get("updater")?;
        match key {
            "pubkey" => u["pubkey"].as_str().map(str::to_string),
            _ => u["endpoints"][0].as_str().map(str::to_string),
        }
    }

    fn source() -> Source {
        let env = std::env::vars().collect();
        machine_backend::source(machine_backend::RELEASE_BUILD, &env)
    }
}

impl Host for AppHost {
    fn changed(&self) {
        let _ = self.app.emit("machines-changed", ());
    }

    fn setup(&self, event: &SetupEvent) {
        let _ = self.app.emit("machine-setup", event);
    }

    fn dropped(&self, id: &str) {
        if let Some(io) = self.app.try_state::<crate::machines::MachineIo>() {
            io.forget(id);
        }
    }

    fn wanted(&self) -> Result<String, String> {
        match Self::source() {
            Source::Release => Ok(self.version.clone()),
            Source::Development(folder) => {
                machine_backend::dev_version(&self.version, &folder).map_err(|e| e.to_string())
            }
        }
    }

    fn backend(&self, arch: Arch) -> Result<Backend, String> {
        match Self::source() {
            Source::Development(folder) => {
                machine_backend::development(&self.cache, &folder, &self.version, arch)
                    .map_err(|e| format!("Desk couldn't use the development backend: {e}"))
            }
            Source::Release => {
                let pubkey = self
                    .updater("pubkey")
                    .ok_or("This Desk has no key to check a backend with.")?;
                let endpoint = self
                    .updater("endpoint")
                    .ok_or("This Desk doesn't know where its releases are.")?;
                // https only, as the updater's own download, and no more
                // redirects than a release's asset needs.
                let client = reqwest::blocking::Client::builder()
                    .https_only(true)
                    .redirect(machine_backend::redirect_policy())
                    .timeout(std::time::Duration::from_secs(600))
                    .build()
                    .map_err(|e| e.to_string())?;
                // Each download stops at the most it may be (a signature's
                // far less than a tarball's).
                let fetch = |url: &str, max: u64| -> eyre::Result<Vec<u8>> {
                    let r = client.get(url).send()?.error_for_status()?;
                    read_capped(r, max)
                };
                machine_backend::release(
                    &self.cache,
                    &self.version,
                    arch,
                    &pubkey,
                    &endpoint,
                    fetch,
                )
                .map_err(|e| format!("Desk couldn't get its engine for that machine: {e}"))
            }
        }
    }

    fn person(&self) -> Person {
        person(&self.home)
    }
}

/// What `from` gives, up to `max` bytes: refused as soon as it gives more,
/// without reading the rest (a download larger than a backend can be).
pub fn read_capped(from: impl std::io::Read, max: u64) -> eyre::Result<Vec<u8>> {
    use std::io::Read as _;
    let mut got = Vec::new();
    from.take(max + 1).read_to_end(&mut got)?;
    if got.len() as u64 > max {
        eyre::bail!("the download is larger than a backend can be ({max} bytes)");
    }
    Ok(got)
}

/// The person's name and email, from their git settings (`[user]` in
/// `~/.gitconfig`), for a machine's service there; read, never run.
pub fn person(home: &Path) -> Person {
    let Ok(text) = std::fs::read_to_string(home.join(".gitconfig")) else {
        return Person::default();
    };
    let mut person = Person::default();
    let mut in_user = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_user = line.trim_start_matches('[').trim_end_matches(']').trim() == "user";
            continue;
        }
        if !in_user {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let v = v.trim().trim_matches('"').to_string();
        if v.is_empty() || v.chars().any(char::is_control) || v.len() > 200 {
            continue;
        }
        match k.trim() {
            "name" => person.name = Some(v),
            "email" => person.email = Some(v),
            _ => {}
        }
    }
    person
}

/// The question before trusting a machine's host key, as pairing's native
/// question asks: Cancel first, the default, what Return and Escape choose.
impl<R: tauri::Runtime> TrustConfirm for crate::pair_gate::NativeConfirm<R> {
    fn trust_key(&self, question: &TrustQuestion) -> bool {
        self.ask("Trust a machine", question.text(), "Trust Key")
    }
}

/// Runs `f` on a blocking thread.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> CommandResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn machines_list(fleet: tauri::State<'_, Arc<Fleet>>) -> Vec<Listed> {
    fleet.list()
}

#[tauri::command]
pub async fn machine_probe(
    fleet: tauri::State<'_, Arc<Fleet>>,
    target: String,
) -> CommandResult<desk_machine::probe::Probe> {
    let fleet = Arc::clone(&fleet);
    blocking(move || fleet.probe(&target)).await
}

#[tauri::command]
pub async fn machine_trust(
    fleet: tauri::State<'_, Arc<Fleet>>,
    target: String,
    fingerprint: String,
) -> CommandResult<()> {
    let fleet = Arc::clone(&fleet);
    blocking(move || fleet.trust(&target, &fingerprint)).await
}

#[tauri::command]
pub async fn machine_public_key(
    fleet: tauri::State<'_, Arc<Fleet>>,
) -> CommandResult<Option<String>> {
    let fleet = Arc::clone(&fleet);
    blocking(move || Ok(fleet.public_key())).await
}

#[tauri::command]
pub async fn machine_add(
    fleet: tauri::State<'_, Arc<Fleet>>,
    target: String,
    name: String,
) -> CommandResult<String> {
    let fleet = Arc::clone(&fleet);
    blocking(move || fleet.add(&target, &name)).await
}

#[tauri::command]
pub fn machine_reconnect(fleet: tauri::State<'_, Arc<Fleet>>, id: String) -> CommandResult<()> {
    fleet.inner().reconnect(&id)
}

#[tauri::command]
pub fn machine_remove(fleet: tauri::State<'_, Arc<Fleet>>, id: String) -> CommandResult<()> {
    fleet.remove(&id)
}

/// Signing in to ChatGPT on a machine: not yet.
pub fn chatgpt_refusal(name: &str) -> String {
    format!(
        "Signing in to ChatGPT on {name} isn't in Desk yet. Open a terminal on {name} and run codex login --device-auth there."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_person_is_read_from_their_git_settings() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".gitconfig"),
            "[core]\n\tname = not me\n[user]\n\tname = Ada Lovelace\n\temail = \"ada@example.com\"\n[alias]\n\temail = x\n",
        )
        .unwrap();
        let p = person(dir.path());
        assert_eq!(p.name.as_deref(), Some("Ada Lovelace"));
        assert_eq!(p.email.as_deref(), Some("ada@example.com"));
        assert_eq!(person(&dir.path().join("none")), Person::default());
    }

    #[test]
    fn a_download_is_stopped_once_it_is_larger_than_a_backend() {
        /// Endless bytes, counting how many were read.
        struct Endless(u64);
        impl std::io::Read for Endless {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                self.0 += buf.len() as u64;
                Ok(buf.len())
            }
        }
        let mut endless = Endless(0);
        let e = read_capped(&mut endless, 1000).unwrap_err();
        assert!(e.to_string().contains("larger than a backend"), "{e}");
        assert!(endless.0 <= 1001, "stopped reading: {}", endless.0);
        assert_eq!(read_capped(&b"abc"[..], 3).unwrap(), b"abc");
    }
}
