//! The Linux backend a machine runs (a Linux box Desk drives over SSH), as
//! the app gets it before copying it there: the release's tarball for this
//! Desk's own version and the machine's architecture, checked against the
//! updater's minisign key every time it is used, and kept per version in
//! Desk's folder; or, in a development build, an unpacked backend folder
//! named by `DESK_MACHINE_BACKEND` (a CI `backend-linux-<arch>` artifact),
//! which nobody signed.
//!
//! The tarball holds `desk-helper`, `desk-agents`, `desk-memory` and
//! `claude-plugin/` at its top, with no folder around them: the machine's
//! install unpacks it as it is.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use base64::Engine;
use eyre::{Context, Result};
use minisign_verify::{PublicKey, Signature};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{LINUX_HELPER_EXECUTABLE, LINUX_HUB_EXECUTABLE, LINUX_MEMORY_EXECUTABLE};

/// Names an unpacked backend folder to install on machines instead of the
/// release's; read only by builds that aren't release builds.
pub const DEV_OVERRIDE_ENV: &str = "DESK_MACHINE_BACKEND";

/// Whether this is a release build, which never reads [`DEV_OVERRIDE_ENV`].
pub const RELEASE_BUILD: bool = !cfg!(debug_assertions);

/// What a backend holds at its top.
const PROGRAMS: [&str; 3] = [
    LINUX_HELPER_EXECUTABLE,
    LINUX_HUB_EXECUTABLE,
    LINUX_MEMORY_EXECUTABLE,
];
const PLUGIN: &str = "claude-plugin";

/// A machine's processor, as the release builds a backend for each.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Arch {
    X86_64,
    Aarch64,
}

impl Arch {
    /// From what `uname -m` says there.
    pub fn of_uname(said: &str) -> Option<Arch> {
        match said.trim() {
            "x86_64" | "amd64" => Some(Arch::X86_64),
            "aarch64" | "arm64" => Some(Arch::Aarch64),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Arch::X86_64 => "x86_64",
            Arch::Aarch64 => "aarch64",
        }
    }

    /// The ELF `e_machine` of its programs.
    fn elf_machine(self) -> u16 {
        match self {
            Arch::X86_64 => 62,
            Arch::Aarch64 => 183,
        }
    }
}

/// The release asset of the backend for `arch` at `version`.
pub fn asset_name(arch: Arch, version: &str) -> String {
    format!("desk-backend-linux-{}-{version}.tar.gz", arch.as_str())
}

/// Where the release of `version` keeps `asset`, beside the updater's
/// `latest.json` (`https://github.com/<repo>/releases/latest/download/latest.json`):
/// the same repository the app updates itself from.
pub fn release_url(updater_endpoint: &str, version: &str, asset: &str) -> Result<String> {
    let (repo, _) = updater_endpoint
        .strip_prefix("https://")
        .and_then(|rest| rest.split_once("/releases/"))
        .ok_or_else(|| {
            eyre::eyre!("the updater's address ({updater_endpoint}) isn't a GitHub release's")
        })?;
    if !plain(version) {
        eyre::bail!("{version:?} isn't a version Desk releases");
    }
    Ok(format!(
        "https://{repo}/releases/download/v{version}/{asset}"
    ))
}

/// Letters, digits and `.+-`, never `..`: safe in a path and a URL.
fn plain(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 64
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-'))
        && !version.starts_with(['.', '-'])
        && !version.contains("..")
}

fn base64_text(what: &str, b64: &str) -> Result<String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .with_context(|| format!("reading the {what}"))?;
    String::from_utf8(bytes).with_context(|| format!("reading the {what}"))
}

/// Checks `data` against its `.sig` (as `tauri signer sign` writes it) with
/// the updater's public key (`plugins.updater.pubkey`), as the updater
/// checks its own downloads; and that it was signed as `asset`, so one
/// release's tarball can't stand in for another's.
pub fn verify(pubkey: &str, asset: &str, data: &[u8], sig: &str) -> Result<()> {
    let key = PublicKey::decode(&base64_text("updater's public key", pubkey)?)
        .map_err(|e| eyre::eyre!("reading the updater's public key: {e}"))?;
    let signature = Signature::decode(&base64_text("backend's signature", sig)?)
        .map_err(|e| eyre::eyre!("reading the backend's signature: {e}"))?;
    key.verify(data, &signature, true)
        .map_err(|e| eyre::eyre!("the backend's signature doesn't match it: {e}"))?;
    // Read only once checked: the signature covers the trusted comment.
    let signed_as = signature
        .trusted_comment()
        .split('\t')
        .find_map(|field| field.strip_prefix("file:"));
    if signed_as != Some(asset) {
        eyre::bail!(
            "the backend was signed as {}, not {asset}",
            signed_as.unwrap_or("something unnamed")
        );
    }
    Ok(())
}

/// A backend ready to copy to a machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Backend {
    /// The version it installs as: the release's, or a development
    /// folder's (`<Desk's version>+dev.<hash>`).
    pub version: String,
    pub arch: Arch,
    pub tarball: PathBuf,
    /// Whether its signature was checked: false for a development folder.
    pub signed: bool,
}

/// Where the backend comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    Release,
    /// A development folder, unsigned.
    Development(PathBuf),
}

/// The release, unless a build that isn't a release build is given a
/// development folder in [`DEV_OVERRIDE_ENV`]. A release build ignores it,
/// and says so.
pub fn source(release_build: bool, env: &BTreeMap<String, String>) -> Source {
    let Some(folder) = env.get(DEV_OVERRIDE_ENV).filter(|v| !v.trim().is_empty()) else {
        return Source::Release;
    };
    if release_build {
        tracing::warn!("{DEV_OVERRIDE_ENV} is set but this is a release build; it is ignored");
        return Source::Release;
    }
    Source::Development(folder.into())
}

/// Writes `bytes` to `path` whole or not at all.
fn write_atomically(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path.parent().expect("a file in a folder");
    std::fs::create_dir_all(dir)?;
    let partial = path.with_extension("partial");
    std::fs::write(&partial, bytes).with_context(|| format!("writing {}", partial.display()))?;
    std::fs::rename(&partial, path).with_context(|| format!("writing {}", path.display()))
}

/// The release's backend for `version` and `arch`: from `cache/<version>`
/// when it is there and its signature still checks, else fetched with
/// `fetch` (a URL to its bytes), checked, then kept there. Nothing that
/// fails the check is kept or used.
pub fn release(
    cache: &Path,
    version: &str,
    arch: Arch,
    pubkey: &str,
    updater_endpoint: &str,
    mut fetch: impl FnMut(&str) -> Result<Vec<u8>>,
) -> Result<Backend> {
    let asset = asset_name(arch, version);
    let url = release_url(updater_endpoint, version, &asset)?;
    let dir = cache.join(version);
    let tarball = dir.join(&asset);
    let sig_path = dir.join(format!("{asset}.sig"));
    let backend = Backend {
        version: version.to_string(),
        arch,
        tarball: tarball.clone(),
        signed: true,
    };
    if let (Ok(data), Ok(sig)) = (std::fs::read(&tarball), std::fs::read_to_string(&sig_path)) {
        match verify(pubkey, &asset, &data, &sig) {
            Ok(()) => return Ok(backend),
            Err(e) => {
                tracing::warn!(error = %e, "the kept backend doesn't check; fetching it again")
            }
        }
    }
    let sig = fetch(&format!("{url}.sig")).with_context(|| format!("downloading {asset}.sig"))?;
    let sig = String::from_utf8(sig).context("reading the backend's signature")?;
    let data = fetch(&url).with_context(|| format!("downloading {asset}"))?;
    verify(pubkey, &asset, &data, &sig)?;
    write_atomically(&tarball, &data)?;
    write_atomically(&sig_path, sig.as_bytes())?;
    Ok(backend)
}

/// What the files of a backend folder hash to: its programs and plugin,
/// each file's path (from the folder) and contents, in path order.
fn folder_hash(folder: &Path) -> Result<String> {
    fn files(dir: &Path, into: &mut Vec<PathBuf>) -> Result<()> {
        for entry in std::fs::read_dir(dir).with_context(|| format!("reading {}", dir.display()))? {
            let path = entry?.path();
            if path.is_dir() {
                files(&path, into)?;
            } else {
                into.push(path);
            }
        }
        Ok(())
    }
    let mut all: Vec<PathBuf> = PROGRAMS.iter().map(|p| folder.join(p)).collect();
    files(&folder.join(PLUGIN), &mut all)?;
    let mut named: Vec<(String, PathBuf)> = all
        .into_iter()
        .map(|p| {
            let rel = p.strip_prefix(folder).unwrap_or(&p);
            (rel.to_string_lossy().replace('\\', "/"), p)
        })
        .collect();
    named.sort();
    let mut hash = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    for (rel, path) in named {
        hash.update(rel.as_bytes());
        hash.update([0]);
        let mut file =
            std::fs::File::open(&path).with_context(|| format!("reading {}", path.display()))?;
        hash.update(file.metadata()?.len().to_le_bytes());
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hash.update(&buf[..n]);
        }
    }
    let digest = hash.finalize();
    Ok(digest[..6].iter().map(|b| format!("{b:02x}")).collect())
}

/// The version a development folder installs as: this Desk's version and
/// the folder's hash, so it never matches a release (the next one installs
/// over it) and a changed folder installs again.
pub fn dev_version(desk_version: &str, folder: &Path) -> Result<String> {
    let base = desk_version
        .split_once('+')
        .map_or(desk_version, |(v, _)| v);
    let version = format!("{base}+dev.{}", folder_hash(folder)?);
    if !plain(&version) {
        eyre::bail!("{version:?} isn't a version Desk installs");
    }
    Ok(version)
}

/// Whether `program` is a Linux program for `arch`.
fn built_for(program: &Path, arch: Arch) -> Result<bool> {
    let mut head = [0u8; 20];
    std::fs::File::open(program)
        .and_then(|mut f| f.read_exact(&mut head))
        .with_context(|| format!("reading {}", program.display()))?;
    Ok(head[..4] == *b"\x7fELF" && u16::from_le_bytes([head[18], head[19]]) == arch.elf_machine())
}

/// A development folder's backend, packed as a release's is into
/// `cache/<its version>`. Its signature isn't checked: nobody signed it,
/// which the log says, as the person is told where they add a machine.
pub fn development(cache: &Path, folder: &Path, desk_version: &str, arch: Arch) -> Result<Backend> {
    for p in PROGRAMS {
        if !folder.join(p).is_file() {
            eyre::bail!("{} has no {p}", folder.display());
        }
    }
    if !folder.join(PLUGIN).is_dir() {
        eyre::bail!("{} has no {PLUGIN}", folder.display());
    }
    if !built_for(&folder.join(LINUX_HELPER_EXECUTABLE), arch)? {
        eyre::bail!(
            "{} isn't a backend for {} machines",
            folder.display(),
            arch.as_str()
        );
    }
    let version = dev_version(desk_version, folder)?;
    tracing::warn!(
        folder = %folder.display(),
        %version,
        "installing a development backend on machines; its signature isn't checked"
    );
    let asset = asset_name(arch, &version);
    let tarball = cache.join(&version).join(&asset);
    if !tarball.is_file() {
        let dir = tarball.parent().expect("a file in a folder");
        std::fs::create_dir_all(dir)?;
        let partial = tarball.with_extension("partial");
        // macOS's tar would add `._` files for extended attributes.
        let out = std::process::Command::new("tar")
            .env("COPYFILE_DISABLE", "1")
            .arg("-czf")
            .arg(&partial)
            .arg("-C")
            .arg(folder)
            .args(PROGRAMS)
            .arg(PLUGIN)
            .output()
            .context("running tar")?;
        if !out.status.success() {
            let _ = std::fs::remove_file(&partial);
            eyre::bail!(
                "packing {}: {}",
                folder.display(),
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        std::fs::rename(&partial, &tarball)?;
    }
    Ok(Backend {
        version,
        arch,
        tarball,
        signed: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const DATA: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/machine_backend");
    /// Made with `tauri signer generate` and `tauri signer sign` (Desk's
    /// Tauri CLI) and a throwaway key, whose private half was never kept.
    const SIGNED: &str = "desk-backend-linux-x86_64-0.3.0.tar.gz";
    const ENDPOINT: &str = "https://github.com/acme/desk/releases/latest/download/latest.json";

    fn data(name: &str) -> Vec<u8> {
        std::fs::read(Path::new(DATA).join(name)).unwrap()
    }
    fn text(name: &str) -> String {
        String::from_utf8(data(name)).unwrap()
    }

    #[test]
    fn a_backend_signed_with_the_key_is_accepted() {
        verify(
            &text("test.key.pub"),
            SIGNED,
            &data(SIGNED),
            &text(&format!("{SIGNED}.sig")),
        )
        .unwrap();
    }

    #[test]
    fn a_changed_backend_another_key_or_another_name_is_refused() {
        let sig = text(&format!("{SIGNED}.sig"));
        let mut changed = data(SIGNED);
        *changed.last_mut().unwrap() ^= 1;
        let e = verify(&text("test.key.pub"), SIGNED, &changed, &sig).unwrap_err();
        assert!(format!("{e:#}").contains("doesn't match"), "{e:#}");
        assert!(verify(&text("other.key.pub"), SIGNED, &data(SIGNED), &sig).is_err());
        // Signed as the x86_64 tarball of 0.3.0, it is no other.
        let e = verify(
            &text("test.key.pub"),
            "desk-backend-linux-aarch64-0.3.0.tar.gz",
            &data(SIGNED),
            &sig,
        )
        .unwrap_err();
        assert!(
            format!("{e:#}").contains(&format!("was signed as {SIGNED}")),
            "{e:#}"
        );
        assert!(verify(&text("test.key.pub"), SIGNED, &data(SIGNED), "not base64").is_err());
        assert!(verify("bm9wZQ==", SIGNED, &data(SIGNED), &sig).is_err());
    }

    #[test]
    fn the_updaters_key_is_one_this_reads() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../../../src-tauri/tauri.conf.json")).unwrap();
        let key = conf["plugins"]["updater"]["pubkey"].as_str().unwrap();
        PublicKey::decode(&base64_text("key", key).unwrap()).unwrap();
        let endpoint = conf["plugins"]["updater"]["endpoints"][0].as_str().unwrap();
        assert_eq!(
            release_url(endpoint, "0.3.0", &asset_name(Arch::Aarch64, "0.3.0")).unwrap(),
            "https://github.com/driftwerk/workforce-desk/releases/download/v0.3.0/desk-backend-linux-aarch64-0.3.0.tar.gz"
        );
    }

    #[test]
    fn the_asset_is_beside_the_updaters_latest_json() {
        assert_eq!(
            release_url(ENDPOINT, "0.3.0", SIGNED).unwrap(),
            "https://github.com/acme/desk/releases/download/v0.3.0/desk-backend-linux-x86_64-0.3.0.tar.gz"
        );
        assert!(release_url("http://github.com/acme/desk/releases/x", "0.3.0", SIGNED).is_err());
        assert!(release_url("https://example.com/latest.json", "0.3.0", SIGNED).is_err());
        assert!(release_url(ENDPOINT, "../0.3.0", SIGNED).is_err());
        assert_eq!(Arch::of_uname("x86_64\n"), Some(Arch::X86_64));
        assert_eq!(Arch::of_uname("arm64"), Some(Arch::Aarch64));
        assert_eq!(Arch::of_uname("riscv64"), None);
    }

    /// Answers the release's two files, counting what it was asked.
    struct Server {
        asked: RefCell<Vec<String>>,
        tarball: Vec<u8>,
    }

    impl Server {
        fn new(tarball: Vec<u8>) -> Self {
            Self {
                asked: RefCell::default(),
                tarball,
            }
        }
        fn fetch(&self, url: &str) -> Result<Vec<u8>> {
            self.asked.borrow_mut().push(url.to_string());
            Ok(if url.ends_with(".sig") {
                data(&format!("{SIGNED}.sig"))
            } else {
                self.tarball.clone()
            })
        }
    }

    #[test]
    fn a_release_is_fetched_once_checked_and_kept_per_version() {
        let dir = tempfile::tempdir().unwrap();
        let key = text("test.key.pub");
        let server = Server::new(data(SIGNED));
        let got = release(dir.path(), "0.3.0", Arch::X86_64, &key, ENDPOINT, |u| {
            server.fetch(u)
        })
        .unwrap();
        assert_eq!(got.tarball, dir.path().join("0.3.0").join(SIGNED));
        assert!(got.signed);
        assert_eq!(std::fs::read(&got.tarball).unwrap(), data(SIGNED));
        assert_eq!(server.asked.borrow().len(), 2);
        assert!(
            server.asked.borrow()[0]
                .ends_with("/v0.3.0/desk-backend-linux-x86_64-0.3.0.tar.gz.sig")
        );
        // Kept, and checked again rather than trusted.
        release(dir.path(), "0.3.0", Arch::X86_64, &key, ENDPOINT, |u| {
            server.fetch(u)
        })
        .unwrap();
        assert_eq!(server.asked.borrow().len(), 2, "taken from the cache");
        std::fs::write(&got.tarball, b"changed on disk").unwrap();
        release(dir.path(), "0.3.0", Arch::X86_64, &key, ENDPOINT, |u| {
            server.fetch(u)
        })
        .unwrap();
        assert_eq!(
            server.asked.borrow().len(),
            4,
            "a kept file that fails is fetched again"
        );
        assert_eq!(std::fs::read(&got.tarball).unwrap(), data(SIGNED));
    }

    #[test]
    fn a_download_that_fails_the_check_is_neither_kept_nor_used() {
        let dir = tempfile::tempdir().unwrap();
        let server = Server::new(b"someone else's backend".to_vec());
        let e = release(
            dir.path(),
            "0.3.0",
            Arch::X86_64,
            &text("test.key.pub"),
            ENDPOINT,
            |u| server.fetch(u),
        )
        .unwrap_err();
        assert!(format!("{e:#}").contains("doesn't match"), "{e:#}");
        assert!(!dir.path().join("0.3.0").join(SIGNED).exists());
        let other = release(
            dir.path(),
            "0.3.0",
            Arch::X86_64,
            &text("other.key.pub"),
            ENDPOINT,
            |u| Server::new(data(SIGNED)).fetch(u),
        );
        assert!(other.is_err(), "signed with another key");
        assert!(!dir.path().join("0.3.0").join(SIGNED).exists());
    }

    #[test]
    fn the_override_is_read_only_by_a_development_build() {
        let env = BTreeMap::from([(DEV_OVERRIDE_ENV.to_string(), "/x/backend".to_string())]);
        assert_eq!(
            source(false, &env),
            Source::Development("/x/backend".into())
        );
        assert_eq!(
            source(true, &env),
            Source::Release,
            "ignored in a release build"
        );
        assert_eq!(source(false, &BTreeMap::new()), Source::Release);
        let blank = BTreeMap::from([(DEV_OVERRIDE_ENV.to_string(), " ".to_string())]);
        assert_eq!(source(false, &blank), Source::Release);
        // The tests are a debug build, as `tauri dev` is; a release build is
        // `tauri build`'s.
        assert_eq!(RELEASE_BUILD, !cfg!(debug_assertions));
    }

    /// A backend folder as a CI artifact unpacks: programs for `machine`
    /// (an ELF header is all the check reads) and the plugin.
    fn folder(dir: &Path, machine: u16) -> PathBuf {
        let f = dir.join("backend-linux");
        std::fs::create_dir_all(f.join("claude-plugin/hooks")).unwrap();
        std::fs::write(f.join("claude-plugin/hooks/hooks.json"), "{}").unwrap();
        let mut elf = b"\x7fELF\x02\x01\x01\0\0\0\0\0\0\0\0\0\x02\0".to_vec();
        elf.extend(machine.to_le_bytes());
        elf.extend(b"rest of the program");
        for p in PROGRAMS {
            std::fs::write(f.join(p), &elf).unwrap();
        }
        f
    }

    #[test]
    fn a_development_folder_is_named_by_its_contents() {
        let dir = tempfile::tempdir().unwrap();
        let f = folder(dir.path(), 62);
        let v = dev_version("0.3.0", &f).unwrap();
        assert!(
            v.starts_with("0.3.0+dev.") && v.len() == "0.3.0+dev.".len() + 12,
            "{v}"
        );
        assert_eq!(dev_version("0.3.0", &f).unwrap(), v, "the same every time");
        // Junk beside it changes nothing; the plugin does.
        std::fs::write(f.join(".DS_Store"), "x").unwrap();
        assert_eq!(dev_version("0.3.0", &f).unwrap(), v);
        std::fs::write(f.join("claude-plugin/hooks/hooks.json"), "{\"a\":1}").unwrap();
        assert_ne!(dev_version("0.3.0", &f).unwrap(), v);
    }

    #[test]
    fn a_development_folder_is_packed_unsigned_for_its_architecture() {
        let dir = tempfile::tempdir().unwrap();
        let f = folder(dir.path(), 62);
        let cache = dir.path().join("cache");
        let got = development(&cache, &f, "0.3.0", Arch::X86_64).unwrap();
        assert!(!got.signed);
        assert!(got.version.starts_with("0.3.0+dev."));
        assert_eq!(
            got.tarball,
            cache
                .join(&got.version)
                .join(asset_name(Arch::X86_64, &got.version))
        );
        let listed = std::process::Command::new("tar")
            .arg("-tzf")
            .arg(&got.tarball)
            .output()
            .unwrap();
        let mut names: Vec<String> = String::from_utf8_lossy(&listed.stdout)
            .lines()
            .map(|l| l.trim_end_matches('/').to_string())
            .collect();
        names.sort();
        assert_eq!(
            names,
            [
                "claude-plugin",
                "claude-plugin/hooks",
                "claude-plugin/hooks/hooks.json",
                "desk-agents",
                "desk-helper",
                "desk-memory"
            ]
        );
        let e = development(&cache, &f, "0.3.0", Arch::Aarch64).unwrap_err();
        assert!(format!("{e:#}").contains("aarch64"), "{e:#}");
        std::fs::remove_file(f.join("desk-memory")).unwrap();
        assert!(development(&cache, &f, "0.3.0", Arch::X86_64).is_err());
    }
}
