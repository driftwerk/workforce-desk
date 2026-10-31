//! Files in Desk's conversations, fetched from the hub whose agent holds
//! them with that hub's token, which never leaves this side: shown through
//! the `deskfile://localhost/<hub>/<agent>/<artifact>` scheme (ranges
//! forwarded, so audio and video seek), opened in their app, saved where the
//! person chooses, and uploaded from the page's own bytes.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use desk_core::Paths;
use desk_core::backend::Backend;
use percent_encoding::percent_decode_str;
use reqwest::{StatusCode, Url};
use tauri::http::{self, HeaderMap, HeaderName, HeaderValue, header};
use tokio::io::AsyncWriteExt;

use crate::hubs::{self, HubAccount};

/// The scheme the page shows files through.
pub const SCHEME: &str = "deskfile";

/// The most bytes one ranged request is answered with: a player asking for
/// the rest of a long video gets it in pieces, never buffered whole.
const RANGE_CHUNK: u64 = 2 * 1024 * 1024;

/// A file of a conversation: the hub, the agent whose store holds it, and
/// its artifact id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRef {
    pub hub: String,
    pub agent: String,
    pub artifact: String,
}

/// Why a file couldn't be fetched.
#[derive(Debug)]
enum Failure {
    /// No such hub, or nothing Desk could ask for.
    Unknown,
    /// The hub couldn't be reached.
    Unreachable(String),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unknown => f.write_str("That file's workspace isn't connected to Desk any more."),
            Self::Unreachable(why) => write!(f, "Couldn't reach the workspace: {why}"),
        }
    }
}

/// The hubs Desk is paired with, read once and again whenever they change
/// or one turns a token away, and the client every request shares.
pub struct Files {
    paths: Paths,
    backend: Backend,
    client: reqwest::Client,
    hubs: Mutex<Option<Arc<Vec<HubAccount>>>>,
}

impl Files {
    pub fn new(paths: Paths, backend: Backend) -> Self {
        Self {
            paths,
            backend,
            client: reqwest::Client::new(),
            hubs: Mutex::new(None),
        }
    }

    /// Forgets the hubs read, after one is paired or removed.
    pub fn forget(&self) {
        *self.hubs.lock().expect("hubs") = None;
    }

    fn hubs(&self) -> eyre::Result<Arc<Vec<HubAccount>>> {
        let mut kept = self.hubs.lock().expect("hubs");
        if let Some(hubs) = kept.as_ref() {
            return Ok(hubs.clone());
        }
        let read = Arc::new(hubs::accounts(&self.paths, &self.backend)?);
        *kept = Some(read.clone());
        Ok(read)
    }

    /// Hub `id`, read again when it isn't among those already read (it may
    /// have just been paired).
    fn hub(&self, id: &str) -> Option<HubAccount> {
        let find = |hubs: Arc<Vec<HubAccount>>| hubs.iter().find(|h| h.id == id).cloned();
        self.hubs().ok().and_then(find).or_else(|| {
            self.forget();
            self.hubs().ok().and_then(find)
        })
    }

    /// Sends `build`'s request to hub `id` with its token; a token the hub
    /// turns away is read again once (the local hub's is renewed by Desk
    /// Helper).
    async fn send(
        &self,
        id: &str,
        build: impl Fn(&HubAccount) -> Option<reqwest::RequestBuilder>,
    ) -> Result<reqwest::Response, Failure> {
        let build = &build;
        let attempt = |hub: HubAccount| async move {
            let request = build(&hub).ok_or(Failure::Unknown)?;
            request
                .bearer_auth(&hub.token)
                .send()
                .await
                .map_err(|e| Failure::Unreachable(e.without_url().to_string()))
        };
        let response = attempt(self.hub(id).ok_or(Failure::Unknown)?).await?;
        if response.status() != StatusCode::UNAUTHORIZED {
            return Ok(response);
        }
        self.forget();
        attempt(self.hub(id).ok_or(Failure::Unknown)?).await
    }

    async fn download(
        &self,
        file: &FileRef,
        range: Option<&str>,
    ) -> Result<reqwest::Response, Failure> {
        self.send(&file.hub, |hub| {
            let url = download_url(&hub.url, &file.agent, &file.artifact)?;
            let request = self.client.get(url);
            Some(match range {
                Some(range) => request.header(header::RANGE, bounded_range(range)),
                None => request,
            })
        })
        .await
    }

    /// What the scheme answers `request` with.
    async fn serve(&self, request: &http::Request<Vec<u8>>) -> http::Response<Vec<u8>> {
        let Some(file) = file_ref(request.uri()) else {
            return empty(http::StatusCode::NOT_FOUND);
        };
        let range = request
            .headers()
            .get(header::RANGE)
            .and_then(|v| v.to_str().ok());
        let response = match self.download(&file, range).await {
            Ok(response) => response,
            Err(Failure::Unknown) => return empty(http::StatusCode::NOT_FOUND),
            Err(Failure::Unreachable(why)) => {
                tracing::warn!(%why, hub = %file.hub, "a file's workspace is unreachable");
                return empty(http::StatusCode::BAD_GATEWAY);
            }
        };
        let status = response.status();
        let headers = forwarded(response.headers());
        let body = match response.bytes().await {
            Ok(body) => body.to_vec(),
            Err(e) => {
                tracing::warn!(error = %e.without_url(), "a file's download broke off");
                return empty(http::StatusCode::BAD_GATEWAY);
            }
        };
        headers
            .into_iter()
            .fold(
                http::Response::builder().status(status.as_u16()),
                |b, (k, v)| b.header(k, v),
            )
            .header(header::CONTENT_LENGTH, body.len())
            .header(header::CACHE_CONTROL, "private, max-age=3600")
            .header(header::CONTENT_SECURITY_POLICY, "sandbox")
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            .body(body)
            .unwrap_or_else(|_| empty(http::StatusCode::BAD_GATEWAY))
    }

    /// Writes the whole of `file` to `dest`, through a temporary file beside
    /// it, so `dest` is only ever complete.
    async fn save_to(&self, file: &FileRef, dest: &Path) -> Result<(), String> {
        let mut response = self.download(file, None).await.map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(refusal(response).await);
        }
        let partial = partial_path(dest);
        let written = async {
            let mut out = tokio::fs::File::create(&partial).await?;
            while let Some(chunk) = response.chunk().await.map_err(std::io::Error::other)? {
                out.write_all(&chunk).await?;
            }
            out.flush().await?;
            quarantine(&partial);
            tokio::fs::rename(&partial, dest).await
        }
        .await;
        if let Err(e) = written {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(format!("Couldn't save the file: {e}"));
        }
        Ok(())
    }
}

/// Marks a file fetched from a hub as downloaded from elsewhere, as
/// browsers do, so macOS treats what could run in it as untrusted; a volume
/// that keeps no such marks still gets the file.
#[cfg(target_os = "macos")]
fn quarantine(path: &Path) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    if let Err(e) = xattr::set(
        path,
        "com.apple.quarantine",
        format!("0081;{now:x};Desk;").as_bytes(),
    ) {
        tracing::warn!(error = %e, "a downloaded file couldn't be marked quarantined");
    }
}

#[cfg(not(target_os = "macos"))]
fn quarantine(_: &Path) {}

/// A response with no body.
fn empty(status: http::StatusCode) -> http::Response<Vec<u8>> {
    let mut response = http::Response::new(Vec::new());
    *response.status_mut() = status;
    response
}

/// The file a `deskfile://localhost/<hub>/<agent>/<artifact>` URL names,
/// each part percent-decoded; none for any other shape.
pub fn file_ref(uri: &http::Uri) -> Option<FileRef> {
    let decoded: Vec<String> = uri
        .path()
        .strip_prefix('/')?
        .split('/')
        .map(|part| {
            percent_decode_str(part)
                .decode_utf8()
                .ok()
                .map(|p| p.into_owned())
        })
        .collect::<Option<_>>()?;
    let usable = |p: &String| !p.is_empty() && p != "." && p != ".." && !p.contains('/');
    match decoded.as_slice() {
        [hub, agent, artifact] if [hub, agent, artifact].into_iter().all(usable) => Some(FileRef {
            hub: hub.clone(),
            agent: agent.clone(),
            artifact: artifact.clone(),
        }),
        _ => None,
    }
}

/// `base` with `segments` appended to its path, each encoded as one.
fn hub_url<'a>(base: &str, segments: impl IntoIterator<Item = &'a str>) -> Option<Url> {
    let mut url = Url::parse(base).ok()?;
    url.path_segments_mut()
        .ok()?
        .pop_if_empty()
        .extend(segments);
    Some(url)
}

/// Where hub `base` serves an agent's file.
pub fn download_url(base: &str, agent: &str, artifact: &str) -> Option<Url> {
    hub_url(base, ["api", "agents", agent, "attachments", artifact])
}

/// Where hub `base` takes a file for the agent's conversation on `channel`.
pub fn upload_url(base: &str, agent: &str, channel: &str, filename: &str) -> Option<Url> {
    let mut url = hub_url(base, ["api", "agents", agent, "attachments"])?;
    url.query_pairs_mut()
        .append_pair("channel", channel)
        .append_pair("filename", filename);
    Some(url)
}

/// `range` held to [`RANGE_CHUNK`] bytes when it is one open or long
/// `bytes=start-end` range; anything else (a suffix, several ranges) as is.
pub fn bounded_range(range: &str) -> String {
    let bounded = range
        .trim()
        .strip_prefix("bytes=")
        .and_then(|r| r.split_once('-'))
        .filter(|(start, end)| !start.is_empty() && !end.contains(','))
        .and_then(|(start, end)| {
            let start: u64 = start.trim().parse().ok()?;
            let last = start.checked_add(RANGE_CHUNK - 1)?;
            let end = match end.trim() {
                "" => last,
                end => end.parse::<u64>().ok()?.min(last),
            };
            Some(format!("bytes={start}-{end}"))
        });
    bounded.unwrap_or_else(|| range.to_string())
}

/// The headers of the hub's answer the page is given: what the file is,
/// and which part of it this is. Its length is the body's own.
pub fn forwarded(headers: &HeaderMap) -> Vec<(HeaderName, HeaderValue)> {
    [
        header::CONTENT_TYPE,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
    ]
    .into_iter()
    .filter_map(|name| headers.get(&name).map(|v| (name, v.clone())))
    .collect()
}

/// The names Windows keeps for its devices, whatever their extension.
const RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
    "COM8", "COM9", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// `name` as a file name of its own on any system: no folders, no
/// characters Windows refuses or control characters, not hidden, not ending
/// in a dot or a space, never a device's name, at most 200 characters;
/// `file` when nothing is left.
pub fn safe_filename(name: &str) -> String {
    let refused = |c: char| c.is_control() || "<>:\"/\\|?*".contains(c);
    let replaced: String = name
        .chars()
        .map(|c| if refused(c) { '_' } else { c })
        .collect();
    let trimmed = |s: &str| {
        s.trim()
            .trim_start_matches('.')
            .trim_end_matches(['.', ' '])
            .to_string()
    };
    let kept = trimmed(&trimmed(&replaced).chars().take(200).collect::<String>());
    let stem = kept.split('.').next().unwrap_or_default().trim_end();
    match kept.as_str() {
        "" => "file".into(),
        _ if RESERVED_NAMES.contains(&stem.to_ascii_uppercase().as_str()) => format!("_{kept}"),
        _ => kept,
    }
}

/// Where a download for `dest` is written until it is whole.
fn partial_path(dest: &Path) -> PathBuf {
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    dest.with_file_name(format!(".{name}.desk-download"))
}

/// What a hub that refused said: its JSON `error`, else the status line.
async fn refusal(response: reqwest::Response) -> String {
    let status = response.status();
    let said = response
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| v["error"].as_str().map(str::to_string))
        .filter(|e| !e.trim().is_empty());
    said.unwrap_or_else(|| format!("The workspace refused that ({status})."))
}

/// Answers the page's `deskfile:` requests.
pub fn protocol<R: tauri::Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    use tauri::Manager;
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let response = match app.try_state::<Files>() {
            Some(files) => files.serve(&request).await,
            None => empty(http::StatusCode::SERVICE_UNAVAILABLE),
        };
        responder.respond(response);
    });
}

type CommandResult<T> = Result<T, String>;

/// Downloads a file into Desk's cache (once) and opens it in its app.
#[tauri::command]
pub async fn attachment_open(
    app: tauri::AppHandle,
    files: tauri::State<'_, Files>,
    hub: String,
    agent: String,
    artifact: String,
    filename: String,
) -> CommandResult<()> {
    use tauri::Manager;
    use tauri_plugin_opener::OpenerExt;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("attachments")
        .join(safe_filename(&hub))
        .join(safe_filename(&agent))
        .join(safe_filename(&artifact));
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Couldn't make room for the file: {e}"))?;
    let path = dir.join(safe_filename(&filename));
    if !tokio::fs::try_exists(&path).await.unwrap_or(false) {
        files
            .save_to(
                &FileRef {
                    hub,
                    agent,
                    artifact,
                },
                &path,
            )
            .await?;
    }
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("Couldn't open the file: {e}"))
}

/// Saves a file where the person chose.
#[tauri::command]
pub async fn attachment_save(
    files: tauri::State<'_, Files>,
    hub: String,
    agent: String,
    artifact: String,
    path: PathBuf,
) -> CommandResult<()> {
    files
        .save_to(
            &FileRef {
                hub,
                agent,
                artifact,
            },
            &path,
        )
        .await
}

/// A header of an upload, percent-decoded.
fn upload_header(headers: &HeaderMap, name: &str) -> CommandResult<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| percent_decode_str(v).decode_utf8().ok())
        .map(|v| v.into_owned())
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| format!("The upload didn't say its {}.", &name["x-desk-".len()..]))
}

/// Uploads the page's bytes (the raw body) to an agent's conversation on its
/// hub, named by the `x-desk-hub`, `x-desk-agent`, `x-desk-channel` and
/// `x-desk-filename` headers; answers with what the hub said of the file.
#[tauri::command]
pub async fn attachment_upload(
    files: tauri::State<'_, Files>,
    request: tauri::ipc::Request<'_>,
) -> CommandResult<serde_json::Value> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("The upload carried no file.".into());
    };
    let headers = request.headers();
    let [hub, agent, channel, filename] = [
        "x-desk-hub",
        "x-desk-agent",
        "x-desk-channel",
        "x-desk-filename",
    ]
    .map(|name| upload_header(headers, name));
    let (hub, agent, channel, filename) = (hub?, agent?, channel?, filename?);
    let body = bytes::Bytes::copy_from_slice(bytes);
    let response = files
        .send(&hub, |account| {
            let url = upload_url(&account.url, &agent, &channel, &filename)?;
            Some(
                files
                    .client
                    .post(url)
                    .header(header::CONTENT_TYPE, "application/octet-stream")
                    .body(body.clone()),
            )
        })
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(refusal(response).await);
    }
    response.json().await.map_err(|e| {
        format!(
            "The workspace's answer couldn't be read: {}",
            e.without_url()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uri(s: &str) -> http::Uri {
        s.parse().unwrap()
    }

    #[test]
    fn a_file_url_names_its_hub_agent_and_artifact() {
        assert_eq!(
            file_ref(&uri(
                "deskfile://localhost/workforce-example-com/scout%20bot/art_1"
            )),
            Some(FileRef {
                hub: "workforce-example-com".into(),
                agent: "scout bot".into(),
                artifact: "art_1".into(),
            })
        );
        for bad in [
            "deskfile://localhost/local/scout",
            "deskfile://localhost/local/scout/art_1/more",
            "deskfile://localhost//scout/art_1",
            "deskfile://localhost/local/scout/..",
            "deskfile://localhost/local/a%2Fb/art_1",
            "deskfile://localhost/local/scout/%FF",
        ] {
            assert_eq!(file_ref(&uri(bad)), None, "{bad}");
        }
    }

    #[test]
    fn hub_urls_keep_each_part_one_segment() {
        assert_eq!(
            download_url("https://hub.example.com", "scout", "art_1")
                .unwrap()
                .as_str(),
            "https://hub.example.com/api/agents/scout/attachments/art_1"
        );
        assert_eq!(
            download_url("http://127.0.0.1:7000/", "a b", "x?y")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:7000/api/agents/a%20b/attachments/x%3Fy"
        );
        assert_eq!(
            upload_url(
                "https://hub.example.com",
                "scout",
                "desk:6f1c",
                "Q3 report.pdf"
            )
            .unwrap()
            .as_str(),
            "https://hub.example.com/api/agents/scout/attachments?channel=desk%3A6f1c&filename=Q3+report.pdf"
        );
        assert_eq!(download_url("not a url", "scout", "art_1"), None);
    }

    #[test]
    fn a_long_or_open_range_is_answered_in_pieces() {
        let mb2 = RANGE_CHUNK - 1;
        assert_eq!(bounded_range("bytes=0-1"), "bytes=0-1");
        assert_eq!(bounded_range("bytes=0-"), format!("bytes=0-{mb2}"));
        assert_eq!(
            bounded_range("bytes=100-999999999"),
            format!("bytes=100-{}", 100 + mb2)
        );
        for kept in [
            "bytes=-500",
            "bytes=0-1,5-9",
            "items=0-1",
            "bytes=x-",
            "bytes=18446744073709551615-",
        ] {
            assert_eq!(bounded_range(kept), kept);
        }
    }

    #[test]
    fn only_what_the_file_is_and_which_part_is_passed_on() {
        let mut headers = HeaderMap::new();
        for (k, v) in [
            ("content-type", "video/mp4"),
            ("content-range", "bytes 0-1/90"),
            ("accept-ranges", "bytes"),
            ("content-length", "2"),
            ("set-cookie", "s=1"),
            ("content-disposition", "attachment"),
        ] {
            headers.insert(HeaderName::from_static(k), HeaderValue::from_static(v));
        }
        let names: Vec<_> = forwarded(&headers).into_iter().map(|(k, _)| k).collect();
        assert_eq!(
            names,
            [
                header::CONTENT_TYPE,
                header::CONTENT_RANGE,
                header::ACCEPT_RANGES
            ]
        );
    }

    #[test]
    fn a_file_name_stays_one_file() {
        assert_eq!(safe_filename("report.pdf"), "report.pdf");
        assert_eq!(safe_filename("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(safe_filename(".hidden"), "hidden");
        assert_eq!(safe_filename(" a:b\n"), "a_b_");
        assert_eq!(safe_filename(".."), "file");
        assert_eq!(safe_filename("a<b>c\"d|e?f*g.txt"), "a_b_c_d_e_f_g.txt");
        assert_eq!(safe_filename("..\\..\\x"), "_.._x");
        assert_eq!(safe_filename("report. . "), "report");
        assert_eq!(safe_filename("CON"), "_CON");
        assert_eq!(safe_filename("nul.txt"), "_nul.txt");
        assert_eq!(safe_filename("lpt9 .tar.gz"), "_lpt9 .tar.gz");
        assert_eq!(safe_filename("console.log"), "console.log");
        assert_eq!(
            safe_filename(&format!("{}. x", "a".repeat(199))),
            "a".repeat(199)
        );
        assert_eq!(
            partial_path(Path::new("/tmp/x/report.pdf")),
            PathBuf::from("/tmp/x/.report.pdf.desk-download")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_downloaded_file_is_quarantined() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("run.command");
        std::fs::write(&path, "echo hi").unwrap();
        quarantine(&path);
        let mark = xattr::get(&path, "com.apple.quarantine").unwrap().unwrap();
        assert!(String::from_utf8(mark).unwrap().ends_with(";Desk;"));
    }

    #[test]
    fn an_upload_names_what_it_lacks() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-desk-filename",
            HeaderValue::from_static("Q3%20report.pdf"),
        );
        assert_eq!(
            upload_header(&headers, "x-desk-filename").unwrap(),
            "Q3 report.pdf"
        );
        assert_eq!(
            upload_header(&headers, "x-desk-channel").unwrap_err(),
            "The upload didn't say its channel."
        );
    }
}
