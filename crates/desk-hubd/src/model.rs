//! The embedding model the memory store runs: bge-base, as fastembed lists
//! it (`BAAI/bge-base-en-v1.5`, fetched from `Xenova/bge-base-en-v1.5`).
//!
//! Desk Helper fetches it, not the store: so that Desk can show how far it
//! has got, so that a lost connection picks up where it stopped, and so
//! that every file is the pinned one. It is laid out as the Hugging Face
//! cache fastembed reads (`models--Xenova--bge-base-en-v1.5/refs/main` and
//! `snapshots/<revision>/…`), so the store finds it there and never goes
//! to the network: after the first fetch it works offline.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use eyre::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The name the hub and the store know the model by.
pub const MODEL: &str = "BAAI/bge-base-en-v1.5";
/// Where fastembed fetches it from.
const REPO: &str = "Xenova/bge-base-en-v1.5";
/// The commit of `REPO` the files below are from.
const REVISION: &str = "4d6cd88e18e51a5e020c2c305726d76ada9c03cf";

pub struct ModelFile {
    pub name: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

/// What fastembed reads for bge-base: the ONNX model and its tokenizer.
pub const FILES: [ModelFile; 5] = [
    ModelFile {
        name: "onnx/model.onnx",
        size: 435_811_539,
        sha256: "9bc579acdba21c253c62a9bf866891355a63ffa3442b52c8a37d75b2ccb91848",
    },
    ModelFile {
        name: "tokenizer.json",
        size: 711_396,
        sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
    },
    ModelFile {
        name: "config.json",
        size: 717,
        sha256: "d83c21fa7366994560727112ef0a31d8a2ec1c280c2a3e66326fdb877f64c91e",
    },
    ModelFile {
        name: "special_tokens_map.json",
        size: 125,
        sha256: "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3",
    },
    ModelFile {
        name: "tokenizer_config.json",
        size: 366,
        sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
    },
];

/// Set as Desk Helper stops: a download under way stops at its next read,
/// keeping what it has to take up from there next time.
static STOPPING: AtomicBool = AtomicBool::new(false);

pub fn stop() {
    STOPPING.store(true, Ordering::Relaxed);
}

fn stopping() -> bool {
    STOPPING.load(Ordering::Relaxed)
}

/// Every file's bytes together: what a first start downloads.
pub fn total() -> u64 {
    FILES.iter().map(|f| f.size).sum()
}

fn repo_dir(models: &Path) -> PathBuf {
    models.join(format!("models--{}", REPO.replace('/', "--")))
}

fn snapshot(models: &Path) -> PathBuf {
    repo_dir(models).join("snapshots").join(REVISION)
}

fn reference(models: &Path) -> PathBuf {
    repo_dir(models).join("refs").join("main")
}

/// Whether the model is in `models` as the store will read it: the
/// reference names the pinned revision and every file is there at its size.
/// The reference is written last, once every file was checked.
pub fn installed(models: &Path) -> bool {
    std::fs::read_to_string(reference(models)).is_ok_and(|r| r.trim() == REVISION)
        && FILES.iter().all(|f| {
            std::fs::metadata(snapshot(models).join(f.name)).is_ok_and(|m| m.len() == f.size)
        })
}

/// What `model.json` says, for Desk to show.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum State {
    /// Fetching: `done` of `total` bytes.
    Downloading {
        done: u64,
        total: u64,
    },
    /// The last try failed; another follows.
    Waiting {
        done: u64,
        total: u64,
        error: String,
    },
    Ready,
}

pub fn write_state(path: &Path, state: &State) -> Result<()> {
    desk_core::write_private(path, &serde_json::to_string(state)?)
}

#[cfg(test)]
pub fn read_state(path: &Path) -> Option<State> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Where a file is fetched from.
pub trait Fetch {
    /// `name` of the pinned revision from byte `from` on, with how many bytes
    /// the answer holds from there; `None` when the server sends it whole.
    fn open(&self, name: &str, from: u64) -> Result<(Box<dyn Read>, Option<u64>)>;
}

/// Hugging Face, over HTTPS.
pub struct HuggingFace;

impl Fetch for HuggingFace {
    fn open(&self, name: &str, from: u64) -> Result<(Box<dyn Read>, Option<u64>)> {
        let url = format!("https://huggingface.co/{REPO}/resolve/{REVISION}/{name}");
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(30)))
            .timeout_recv_response(Some(Duration::from_secs(60)))
            .build()
            .into();
        let mut request = agent.get(&url);
        if from > 0 {
            request = request.header("Range", &format!("bytes={from}-"));
        }
        let response = request.call().with_context(|| format!("fetching {url}"))?;
        let resumed = from > 0 && response.status() == 206;
        let reader: Box<dyn Read> = Box::new(response.into_body().into_reader());
        Ok((reader, resumed.then_some(from)))
    }
}

/// Fetches whatever of the model `models` lacks, a file at a time, each
/// checked against its pinned size and SHA-256 before it takes its place.
/// A download that stopped part way is taken up from where it got to.
/// `progress` is told the bytes held so far, of [`total`].
pub fn ensure(models: &Path, fetch: &dyn Fetch, progress: &mut dyn FnMut(u64)) -> Result<()> {
    if installed(models) {
        progress(total());
        return Ok(());
    }
    let dir = snapshot(models);
    let mut before = 0;
    for file in &FILES {
        let target = dir.join(file.name);
        if !std::fs::metadata(&target).is_ok_and(|m| m.len() == file.size) {
            std::fs::create_dir_all(target.parent().expect("a file in a folder"))?;
            fetch_file(file, &target, fetch, &mut |n| progress(before + n))
                .with_context(|| format!("downloading {}", file.name))?;
        }
        before += file.size;
        progress(before);
    }
    let reference = reference(models);
    std::fs::create_dir_all(reference.parent().expect("refs"))?;
    std::fs::write(&reference, REVISION)?;
    Ok(())
}

fn fetch_file(
    file: &ModelFile,
    target: &Path,
    fetch: &dyn Fetch,
    progress: &mut dyn FnMut(u64),
) -> Result<()> {
    let part = target.with_extension("part");
    let held = std::fs::metadata(&part).map_or(0, |m| m.len());
    let held = if held >= file.size { 0 } else { held };
    let (mut body, resumed) = fetch.open(file.name, held)?;
    let mut hasher = Sha256::new();
    let mut out = if resumed == Some(held) && held > 0 {
        // The bytes already here count towards the checksum.
        let mut existing = File::open(&part)?;
        let mut buf = vec![0u8; 1 << 16];
        loop {
            let read = existing.read(&mut buf)?;
            if read == 0 {
                break;
            }
            hasher.update(&buf[..read]);
        }
        OpenOptions::new().append(true).open(&part)?
    } else {
        File::create(&part)?
    };
    let mut n = if resumed == Some(held) { held } else { 0 };
    let mut buf = vec![0u8; 1 << 16];
    loop {
        if stopping() {
            bail!("Desk Helper is stopping");
        }
        let read = body.read(&mut buf)?;
        if read == 0 {
            break;
        }
        n += read as u64;
        if n > file.size {
            let _ = std::fs::remove_file(&part);
            bail!("larger than the expected {} bytes", file.size);
        }
        hasher.update(&buf[..read]);
        out.write_all(&buf[..read])?;
        progress(n);
    }
    out.sync_all()?;
    if n < file.size {
        // Cut short: kept, to take up from here next time.
        bail!("the download stopped at {n} of {} bytes", file.size);
    }
    let sha256: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if sha256 != file.sha256 {
        let _ = std::fs::remove_file(&part);
        bail!("SHA-256 is {sha256}, expected {}", file.sha256);
    }
    std::fs::rename(&part, target)?;
    Ok(())
}

/// Fetches the model until it is in `models`, writing how far it has got to
/// `state` (at most a few times a second), and trying again with a growing
/// wait after a failure, as when the computer is offline. Blocking; whether the
/// model is here, which it is not when Desk Helper stopped first.
pub fn fetch_until_installed(models: &Path, state: &Path, fetch: &dyn Fetch) -> bool {
    let total = total();
    let mut wait = Duration::from_secs(15);
    loop {
        let mut done = 0;
        let mut written = Instant::now() - Duration::from_secs(1);
        let result = ensure(models, fetch, &mut |n| {
            done = n;
            if written.elapsed() >= Duration::from_millis(250) {
                written = Instant::now();
                let _ = write_state(state, &State::Downloading { done: n, total });
            }
        });
        match result {
            Ok(()) => {
                let _ = write_state(state, &State::Ready);
                tracing::info!(model = MODEL, "the memory store's model is ready");
                return true;
            }
            Err(_) if stopping() => return false,
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), retry_in = ?wait, "could not download the memory store's model");
                let _ = write_state(
                    state,
                    &State::Waiting {
                        done,
                        total,
                        error: format!("{e:#}"),
                    },
                );
                let until = Instant::now() + wait;
                while Instant::now() < until {
                    if stopping() {
                        return false;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
                wait = (wait * 2).min(Duration::from_secs(600));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// Serves given bytes for each file, cut short once if asked.
    struct Fake {
        bodies: HashMap<&'static str, Vec<u8>>,
        cut_once: Mutex<Option<(&'static str, usize)>>,
        asked: Mutex<Vec<(String, u64)>>,
    }

    impl Fetch for Fake {
        fn open(&self, name: &str, from: u64) -> Result<(Box<dyn Read>, Option<u64>)> {
            self.asked.lock().unwrap().push((name.into(), from));
            let body = &self.bodies[name];
            let mut bytes = body[from as usize..].to_vec();
            if let Some((cut, at)) = *self.cut_once.lock().unwrap()
                && cut == name
            {
                bytes.truncate(at);
            }
            *self.cut_once.lock().unwrap() = None;
            Ok((Box::new(std::io::Cursor::new(bytes)), Some(from)))
        }
    }

    fn sha(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    #[test]
    fn a_wrong_file_is_refused_and_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake {
            bodies: FILES
                .iter()
                .map(|f| (f.name, vec![0u8; f.size.min(10) as usize]))
                .collect(),
            cut_once: Mutex::new(None),
            asked: Mutex::new(Vec::new()),
        };
        let err = ensure(dir.path(), &fake, &mut |_| {}).unwrap_err();
        assert!(format!("{err:#}").contains("stopped") || format!("{err:#}").contains("SHA"));
        assert!(!installed(dir.path()));
    }

    #[test]
    fn a_file_cut_short_is_taken_up_where_it_stopped_and_checked() {
        let dir = tempfile::tempdir().unwrap();
        let file = ModelFile {
            name: "tokenizer.json",
            size: 1000,
            sha256: "",
        };
        let body: Vec<u8> = (0..1000u32).map(|i| (i % 251) as u8).collect();
        let file = ModelFile {
            sha256: Box::leak(sha(&body).into_boxed_str()),
            ..file
        };
        let fake = Fake {
            bodies: HashMap::from([("tokenizer.json", body.clone())]),
            cut_once: Mutex::new(Some(("tokenizer.json", 400))),
            asked: Mutex::new(Vec::new()),
        };
        let target = dir.path().join("tokenizer.json");
        assert!(fetch_file(&file, &target, &fake, &mut |_| {}).is_err());
        assert!(!target.exists());
        let mut seen = 0;
        fetch_file(&file, &target, &fake, &mut |n| seen = n).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), body);
        assert_eq!(seen, 1000);
        assert_eq!(
            *fake.asked.lock().unwrap(),
            vec![
                ("tokenizer.json".to_string(), 0),
                ("tokenizer.json".to_string(), 400)
            ]
        );
    }

    #[test]
    fn installed_needs_every_file_and_the_reference() {
        let dir = tempfile::tempdir().unwrap();
        let snap = snapshot(dir.path());
        for f in &FILES {
            let p = snap.join(f.name);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            File::create(&p).unwrap().set_len(f.size).unwrap();
        }
        assert!(!installed(dir.path()));
        std::fs::create_dir_all(reference(dir.path()).parent().unwrap()).unwrap();
        std::fs::write(reference(dir.path()), REVISION).unwrap();
        assert!(installed(dir.path()));
        assert!(
            dir.path()
                .join("models--Xenova--bge-base-en-v1.5/snapshots")
                .join(REVISION)
                .join("onnx/model.onnx")
                .is_file()
        );
    }

    #[test]
    fn the_state_desk_reads_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model.json");
        let s = State::Downloading {
            done: 5,
            total: total(),
        };
        write_state(&path, &s).unwrap();
        assert_eq!(read_state(&path), Some(s));
        assert!(
            std::fs::read_to_string(&path)
                .unwrap()
                .contains("\"state\":\"downloading\"")
        );
    }
}
