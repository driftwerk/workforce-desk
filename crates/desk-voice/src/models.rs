//! The speech models: fetched from sherpa-onnx's GitHub releases on first
//! use, checked against a pinned size and SHA-256, and unpacked to only the
//! files Desk reads.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use eyre::{Context, Result, bail, eyre};
use sha2::{Digest, Sha256};

pub struct Model {
    pub id: &'static str,
    pub sources: &'static [Source],
}

pub struct Source {
    pub url: &'static str,
    pub sha256: &'static str,
    pub size: u64,
    pub files: Files,
}

pub enum Files {
    /// The download is the file itself, saved under this name.
    Single(&'static str),
    /// A `.tar.bz2` with one top-level folder; only these members are kept.
    Archive(&'static [&'static str]),
}

pub const VAD: Model = Model {
    id: "silero-vad-v5",
    sources: &[Source {
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
        sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
        size: 643_854,
        files: Files::Single("silero_vad.onnx"),
    }],
};

pub const KWS: Model = Model {
    id: "kws-zipformer-gigaspeech-3.3M-2024-01-01",
    sources: &[Source {
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2",
        sha256: "f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a",
        size: 17_626_723,
        files: Files::Archive(&[
            "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
            "decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
            "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
            "tokens.txt",
            "bpe.model",
        ]),
    }],
};

pub const ASR: Model = Model {
    id: "parakeet-tdt-transducer-110m-en-int8",
    sources: &[Source {
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8.tar.bz2",
        sha256: "f628312e9fdf8686374cb01a69425c41732529d540860311f16f37cbc32cfe9b",
        size: 108_035_095,
        files: Files::Archive(&[
            "encoder.int8.onnx",
            "decoder.int8.onnx",
            "joiner.int8.onnx",
            "tokens.txt",
        ]),
    }],
};

pub const TTS: Model = Model {
    id: "kokoro-int8-en-v0_19",
    sources: &[
        Source {
            url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-en-v0_19.tar.bz2",
            sha256: "c9f0dd393615805b0bab050c340834d5e684e732aec91c0e860cd30e982c08bd",
            size: 103_248_205,
            files: Files::Archive(&["model.int8.onnx", "voices.bin", "tokens.txt"]),
        },
        Source {
            url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/lexicon-en-us.txt",
            sha256: "8b67ae549a465eee78f92ecb74644ad90c3c58ce65f19c68baf85878a10ef73a",
            size: 6_305_773,
            files: Files::Single("lexicon-en-us.txt"),
        },
    ],
};

pub const ALL: [&Model; 4] = [&VAD, &KWS, &ASR, &TTS];

/// What a model download has done so far, across everything missing.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Progress<'a> {
    pub model: &'a str,
    pub done: u64,
    pub total: u64,
}

impl Progress<'_> {
    pub fn fraction(&self) -> f32 {
        if self.total == 0 {
            1.0
        } else {
            (self.done as f64 / self.total as f64) as f32
        }
    }
}

/// `~/Library/Application Support/Desk/voice/models` (or under `DESK_HOME`).
pub fn default_dir(paths: &desk_core::Paths) -> PathBuf {
    paths.root.join("voice").join("models")
}

/// The folder the models live in.
#[derive(Debug, Clone)]
pub struct Models {
    root: PathBuf,
}

const MARKER: &str = ".installed";

impl Models {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn file(&self, model: &Model, name: &str) -> PathBuf {
        self.root.join(model.id).join(name)
    }

    pub fn file_str(&self, model: &Model, name: &str) -> String {
        self.file(model, name).to_string_lossy().into_owned()
    }

    pub fn installed(&self, model: &Model) -> bool {
        let dir = self.root.join(model.id);
        std::fs::read_to_string(dir.join(MARKER)).is_ok_and(|m| m == marker(model))
            && kept_files(model).all(|f| dir.join(f).is_file())
    }

    pub fn missing(&self, wanted: &[&'static Model]) -> Vec<&'static Model> {
        wanted
            .iter()
            .copied()
            .filter(|m| !self.installed(m))
            .collect()
    }

    /// Downloads whichever of `wanted` is missing, then removes anything in
    /// the folder that no model uses.
    pub fn ensure(
        &self,
        wanted: &[&'static Model],
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(Progress),
    ) -> Result<()> {
        std::fs::create_dir_all(&self.root)
            .with_context(|| format!("creating {}", self.root.display()))?;
        let missing = self.missing(wanted);
        let total = missing.iter().flat_map(|m| m.sources).map(|s| s.size).sum();
        let mut done = 0;
        for model in missing {
            self.install(model, cancel, &mut |n| {
                progress(Progress {
                    model: model.id,
                    done: done + n,
                    total,
                });
            })?;
            done += model.sources.iter().map(|s| s.size).sum::<u64>();
        }
        self.prune()
    }

    fn install(
        &self,
        model: &Model,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> Result<()> {
        let staging = self.root.join(format!(".{}.partial", model.id));
        remove(&staging)?;
        std::fs::create_dir_all(&staging)?;
        let mut before = 0;
        for source in model.sources {
            let download = staging.join(".download");
            fetch(source.url, &download, source, cancel, &mut |n| {
                progress(before + n)
            })
            .with_context(|| format!("downloading {}", source.url))?;
            match source.files {
                Files::Single(name) => std::fs::rename(&download, staging.join(name))?,
                Files::Archive(members) => {
                    unpack(&download, members, &staging)
                        .with_context(|| format!("unpacking {}", source.url))?;
                    std::fs::remove_file(&download)?;
                }
            }
            before += source.size;
        }
        std::fs::write(staging.join(MARKER), marker(model))?;
        let dir = self.root.join(model.id);
        remove(&dir)?;
        std::fs::rename(&staging, &dir)?;
        Ok(())
    }

    fn prune(&self) -> Result<()> {
        for entry in std::fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            if !ALL.iter().any(|m| name == m.id) {
                remove(&entry.path())?;
            }
        }
        Ok(())
    }
}

fn marker(model: &Model) -> String {
    model
        .sources
        .iter()
        .map(|s| s.sha256)
        .collect::<Vec<_>>()
        .join("\n")
}

fn kept_files(model: &Model) -> impl Iterator<Item = &'static str> {
    model.sources.iter().flat_map(|s| match s.files {
        Files::Single(name) => vec![name],
        Files::Archive(members) => members.to_vec(),
    })
}

fn remove(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(path)?,
        Ok(_) => std::fs::remove_file(path)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    Ok(())
}

fn fetch(
    url: &str,
    to: &Path,
    source: &Source,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> Result<()> {
    let response = ureq::get(url).call()?;
    let mut body = response.into_body().into_reader();
    let mut file = File::create(to)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    let mut n = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            bail!("cancelled");
        }
        let read = body.read(&mut buf)?;
        if read == 0 {
            break;
        }
        n += read as u64;
        if n > source.size {
            bail!("larger than the expected {} bytes", source.size);
        }
        hasher.update(&buf[..read]);
        file.write_all(&buf[..read])?;
        progress(n);
    }
    file.sync_all()?;
    verify(n, &hex(&hasher.finalize()), source)
}

fn verify(size: u64, sha256: &str, source: &Source) -> Result<()> {
    if size != source.size {
        bail!("got {size} bytes, expected {}", source.size);
    }
    if sha256 != source.sha256 {
        bail!("SHA-256 is {sha256}, expected {}", source.sha256);
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The member's name when it sits directly in the archive's one top-level
/// folder (`./top/name` or `top/name`); anything else is not a model file.
pub fn member_name(path: &Path) -> Option<&str> {
    let mut parts = path
        .components()
        .filter(|c| !matches!(c, Component::CurDir));
    match (parts.next(), parts.next(), parts.next()) {
        (Some(Component::Normal(_)), Some(Component::Normal(name)), None) => name.to_str(),
        _ => None,
    }
}

fn unpack(archive: &Path, members: &[&str], into: &Path) -> Result<()> {
    let mut tar = tar::Archive::new(bzip2::read::BzDecoder::new(File::open(archive)?));
    let mut found = Vec::new();
    for entry in tar.entries()? {
        let mut entry = entry?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry.path()?.into_owned();
        let Some(name) = member_name(&path).and_then(|n| members.iter().find(|m| **m == n)) else {
            continue;
        };
        let mut out = File::create(into.join(name))?;
        std::io::copy(&mut entry, &mut out)?;
        found.push(*name);
    }
    match members.iter().find(|m| !found.contains(m)) {
        Some(m) => Err(eyre!("{m} is not in the archive")),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn members_are_files_directly_in_the_top_folder() {
        assert_eq!(
            member_name(Path::new("./kokoro/model.onnx")),
            Some("model.onnx")
        );
        assert_eq!(
            member_name(Path::new("kokoro/tokens.txt")),
            Some("tokens.txt")
        );
        assert_eq!(member_name(Path::new("kokoro/test_wavs/0.wav")), None);
        assert_eq!(member_name(Path::new("tokens.txt")), None);
        assert_eq!(member_name(Path::new("kokoro/../../etc/passwd")), None);
        assert_eq!(member_name(Path::new("/abs/tokens.txt")), None);
    }

    #[test]
    fn a_download_must_match_its_pin() {
        let s = &VAD.sources[0];
        assert!(verify(s.size, s.sha256, s).is_ok());
        assert!(verify(s.size - 1, s.sha256, s).is_err());
        assert!(verify(s.size, &"0".repeat(64), s).is_err());
        assert_eq!(
            hex(&Sha256::digest(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn unpacks_only_the_listed_members() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("m.tar.bz2");
        {
            let bz = bzip2::write::BzEncoder::new(
                File::create(&archive).unwrap(),
                bzip2::Compression::fast(),
            );
            let mut tar = tar::Builder::new(bz);
            for (path, body) in [
                ("./top/keep.txt", "k"),
                ("./top/skip.txt", "s"),
                ("./top/sub/keep.txt", "x"),
            ] {
                let mut h = tar::Header::new_gnu();
                h.set_size(body.len() as u64);
                h.set_mode(0o644);
                h.set_cksum();
                tar.append_data(&mut h, path, body.as_bytes()).unwrap();
            }
            tar.into_inner().unwrap().finish().unwrap();
        }
        let out = dir.path().join("out");
        std::fs::create_dir(&out).unwrap();
        unpack(&archive, &["keep.txt"], &out).unwrap();
        assert_eq!(std::fs::read_to_string(out.join("keep.txt")).unwrap(), "k");
        assert!(!out.join("skip.txt").exists());
        assert!(unpack(&archive, &["absent.txt"], &out).is_err());
    }

    #[test]
    fn prune_keeps_only_known_models() {
        let dir = tempfile::tempdir().unwrap();
        let models = Models::new(dir.path());
        std::fs::create_dir_all(dir.path().join(VAD.id)).unwrap();
        std::fs::create_dir_all(dir.path().join("old-model")).unwrap();
        std::fs::write(dir.path().join(".stale.partial"), "").unwrap();
        models.prune().unwrap();
        assert!(dir.path().join(VAD.id).exists());
        assert!(!dir.path().join("old-model").exists());
        assert!(!dir.path().join(".stale.partial").exists());
    }

    #[test]
    fn a_model_is_installed_only_with_its_marker_and_files() {
        let dir = tempfile::tempdir().unwrap();
        let models = Models::new(dir.path());
        assert!(!models.installed(&VAD));
        std::fs::create_dir_all(dir.path().join(VAD.id)).unwrap();
        std::fs::write(models.file(&VAD, "silero_vad.onnx"), "x").unwrap();
        assert!(!models.installed(&VAD));
        std::fs::write(models.file(&VAD, MARKER), marker(&VAD)).unwrap();
        assert!(models.installed(&VAD));
        assert_eq!(models.missing(&ALL).len(), 3);
        assert!(models.missing(&[&VAD]).is_empty());
    }
}
