//! The page's way to show a remote picture an agent's markdown points at,
//! once the person asks: Desk fetches it (`desk_core::remote_image` says how,
//! and what it refuses) and the page draws the bytes from a `blob:` URL. The
//! page itself never fetches a remote image.

use std::sync::LazyLock;

use desk_core::remote_image::{FetchError, Fetcher};

/// One client for every picture, made on first use (after rustls has its
/// provider).
static FETCHER: LazyLock<Fetcher> = LazyLock::new(Fetcher::default);

/// The picture at `url` as the page reads it: the length of its meta's JSON
/// (four bytes, big-endian), that JSON (`{"mime": …}`, what its bytes say it
/// is), then the bytes. Refused or failed as `{kind, reason}`.
#[tauri::command]
pub async fn remote_image_fetch(url: String) -> Result<tauri::ipc::Response, FetchError> {
    let image = FETCHER.fetch(&url).await?;
    Ok(tauri::ipc::Response::new(framed(image.mime, &image.bytes)))
}

fn framed(mime: &str, body: &[u8]) -> Vec<u8> {
    let meta = serde_json::to_vec(&serde_json::json!({ "mime": mime })).expect("meta serializes");
    let mut out = Vec::with_capacity(4 + meta.len() + body.len());
    out.extend_from_slice(&u32::try_from(meta.len()).expect("small").to_be_bytes());
    out.extend_from_slice(&meta);
    out.extend_from_slice(body);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_answer_is_framed_as_the_page_reads_it() {
        let out = framed("image/png", b"PNG");
        let n = u32::from_be_bytes(out[..4].try_into().unwrap()) as usize;
        assert_eq!(&out[4..4 + n], br#"{"mime":"image/png"}"#);
        assert_eq!(&out[4 + n..], b"PNG");
    }
}
